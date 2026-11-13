#!/usr/bin/env python3
"""
nitrogen_lean.py — a leaner, faster NitroGen that keeps NVIDIA's own weights.

The light expert (nitrogen_light_expert.py) replaced NitroGen's image encoder with a small
one trained on a few games, and did not generalize to a game it never saw. NitroGen's
generalization lives in its SigLIP2-large weights (40,000 hours, 1,000+ games), so this
keeps them and cuts the work they do instead:

  pool    before encoder layer k the 16x16 grid of image tokens is averaged 2x2 to 8x8: the
          layers before k see all 256 tokens, the rest, the VL layers and the denoiser's
          cross-attention see 64 (neither uses position embeddings, so any count works)
  tome    token merging (ToMe, Bolya et al. 2023): after each layer from k on, the r most
          similar token pairs (bipartite soft matching) are merged, weighted by size

`compare` runs each variant against NitroGen itself as a policy on frame sets (as
tests/ai_common.cjs's distributionChecks do): how often each 3DS key is held and where the
sticks go, over independent noise draws, against NitroGen's own difference between two
sets of draws, and how varied the draws are; and times each variant's encoder.

  python3 scripts/nitrogen/nitrogen_lean.py compare --ckpt ng.pt --nitrogen-src NitroGen \\
      --frames tmp_test/ai_frames/valid --frames tmp_test/ai_frames/nsmb2_level \\
      --variant pool:8 --variant tome:4:8
"""

import argparse
import copy
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nitrogen_light_expert as le  # noqa: E402  (Policy, distance, variety, pixel_batch)
import nitrogen_validate as nv  # noqa: E402

GRID = 16


def pool_tokens(x):
    """[B, 256, C] on the 16x16 grid to [B, 64, C]: each 2x2 block averaged."""
    b, n, c = x.shape
    side = int(round(n ** 0.5))
    grid = x.transpose(1, 2).reshape(b, c, side, side)
    return F.avg_pool2d(grid, 2).flatten(2).transpose(1, 2)


def tome_merge(x, size, r):
    """ToMe's bipartite soft matching: tokens alternate into sets A and B, each A token is
    matched to its most similar B token (cosine), and the r best-matched A tokens are
    averaged into their B tokens, weighted by how many tokens each already stands for."""
    if r <= 0:
        return x, size
    a, b = x[:, ::2], x[:, 1::2]
    scores = F.normalize(a, dim=-1) @ F.normalize(b, dim=-1).transpose(1, 2)
    best, partner = scores.max(-1)                       # each A token's best B
    order = best.argsort(-1, descending=True)
    merged, kept = order[:, :r], order[:, r:]
    sa, sb = size[:, ::2], size[:, 1::2]
    batch = torch.arange(x.shape[0], device=x.device)[:, None]
    dst = partner[batch, merged]                          # [B, r] B indices
    weighted_b = b * sb
    weighted_b = weighted_b.scatter_add(1, dst[..., None].expand(-1, -1, x.shape[-1]),
                                        (a * sa)[batch, merged])
    sb = sb.scatter_add(1, dst[..., None], sa[batch, merged])
    b = weighted_b / sb
    return torch.cat([a[batch, kept], b], 1), torch.cat([sa[batch, kept], sb], 1)


def encode(official, pixels, variant, student=None):
    """NitroGen's image features (SigLIP2-large's last hidden state) with `variant`:
    None (as NVIDIA's code), ('pool', k), ('tome', r, k) or ('student',) (`student`, a
    trained PooledStudent, from its layer on)."""
    if variant and variant[0] == 'student':
        return student(front_tokens(official, pixels, student.k))
    vision = official.model.vision_encoder
    x = vision.embeddings(pixels)
    size = torch.ones(x.shape[0], x.shape[1], 1, device=x.device, dtype=x.dtype)
    for index, layer in enumerate(vision.encoder.layers):
        if variant and variant[0] == 'pool' and index == variant[1]:
            x = pool_tokens(x)
        x = layer(x, None)
        if variant and variant[0] == 'tome' and index >= variant[2]:
            x, size = tome_merge(x, size, variant[1])
    return vision.post_layernorm(x)


class PooledStudent(torch.nn.Module):
    """NitroGen's vision encoder from layer k on, and its post-LayerNorm, on the 2x2-pooled
    tokens; the layers before k are NVIDIA's own, shared with the teacher."""

    def __init__(self, vision, k):
        super().__init__()
        self.k = k
        self.layers = copy.deepcopy(vision.encoder.layers[k:])
        self.post_layernorm = copy.deepcopy(vision.post_layernorm)

    def forward(self, front):
        x = pool_tokens(front)
        for layer in self.layers:
            x = layer(x, None)
        return self.post_layernorm(x)


def front_tokens(official, pixels, k):
    """NitroGen's image tokens after its first k encoder layers (256 of them)."""
    vision = official.model.vision_encoder
    x = vision.embeddings(pixels)
    for layer in vision.encoder.layers[:k]:
        x = layer(x, None)
    return x


def back_tokens(official, x, k):
    vision = official.model.vision_encoder
    for layer in vision.encoder.layers[k:]:
        x = layer(x, None)
    return vision.post_layernorm(x)


def distill(args):
    """Trains a PooledStudent with NitroGen as its teacher: the action velocities NitroGen's
    frozen denoiser predicts from the student's features, at the states of the teacher's own
    Euler steps from fresh noise, against the teacher's (in units of how much they change
    with another frame, as nitrogen_light_expert.py's PolicyLoss), plus the VL layers'
    output against the teacher's, pooled the same way. EMA weights, as NVIDIA's training."""
    official = nv.Official(args.nitrogen_src, args.ckpt)
    device = official.device
    official.model.requires_grad_(False)
    policy = le.Policy(official, args.steps)
    student = PooledStudent(official.model.vision_encoder, args.pool_from).to(device)
    student.requires_grad_(True)
    ema = copy.deepcopy(student).requires_grad_(False)
    images = le.frames_in(args.train)
    print(f'{len(images)} training frames; student: layers {args.pool_from}-23 on 64 tokens, '
          f'{sum(p.numel() for p in student.parameters()) / 1e6:.0f}M parameters', flush=True)
    optimizer = torch.optim.AdamW(student.parameters(), lr=args.lr, weight_decay=0.001)
    warmup = max(1, args.iterations // 20)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda i: min(1.0, (i + 1) / warmup) *
                                                 (1.0 if i < 0.8 * args.iterations else
                                                  max(0.05, (args.iterations - i) / (0.2 * args.iterations))))
    scaler = torch.amp.GradScaler('cuda')
    rng = np.random.default_rng(0)

    def teacher_targets(pixels):
        with torch.no_grad(), torch.autocast('cuda', dtype=torch.float16):
            front = front_tokens(official, pixels, args.pool_from)
            vl = policy.vl(back_tokens(official, front, args.pool_from)).float()
            states, velocities = policy.trajectory(vl, args.draws)
        return front, vl, [s.float() for s in states], [v.float() for v in velocities]

    # Loss scales, from one batch: the VL output's spread per channel, and how much the
    # velocity changes when another frame is shown, per Euler step.
    with torch.no_grad():
        pixels = le.pixel_batch(images[rng.choice(len(images), min(64, len(images)), replace=False)], device)
        _, vl, states, velocities = teacher_targets(pixels)
        vl_scale = pool_tokens(vl).reshape(-1, vl.shape[-1]).std(0) + 1e-3
        other = vl.roll(1, 0).repeat_interleave(args.draws, 0)
        velocity_scale = [(policy.velocity(other, s, t) - v).pow(2).mean()
                          for s, t, v in zip(states, policy.times, velocities)]
    started = time.time()
    for step in range(args.iterations):
        pick = rng.choice(len(images), args.batch, replace=False)
        pixels = le.pixel_batch(le.augment(images[pick], rng), device)
        front, vl_t, states, targets = teacher_targets(pixels)
        with torch.autocast('cuda', dtype=torch.float16):
            vl_s = policy.vl(student(front.float())).float()
            repeated = vl_s.repeat_interleave(args.draws, 0)
            velocity_loss = sum((policy.velocity(repeated, states[k], policy.times[k]).float() - targets[k]).pow(2).mean()
                                / velocity_scale[k] for k in range(len(states))) / len(states)
            vl_loss = (((vl_s - pool_tokens(vl_t)) / vl_scale) ** 2).mean()
            loss = velocity_loss + args.vl_weight * vl_loss
        optimizer.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
        scaler.step(optimizer)
        scaler.update()
        schedule.step()
        with torch.no_grad():
            decay = min(args.ema, (step + 1) / (step + 10))
            for e, p in zip(ema.parameters(), student.parameters()):
                e.lerp_(p, 1 - decay)
        if step % 50 == 0 or step == args.iterations - 1:
            print(f'  step {step + 1}/{args.iterations}: velocity {velocity_loss.item():.4f} vl {vl_loss.item():.4f} '
                  f'lr {schedule.get_last_lr()[0]:.2e} ({time.time() - started:.0f} s)', flush=True)
        if (step + 1) % 500 == 0 or step == args.iterations - 1:
            torch.save({'student': ema.state_dict(), 'pool_from': args.pool_from, 'steps': step + 1}, args.out)
    print(f'saved {args.out}', flush=True)


class OneStepHead(torch.nn.Module):
    """NitroGen's action head (action encoder, DiT, action decoder) taking one step: from a
    noise straight to the actions, trained to land where NitroGen's own Euler steps from the
    same noise land (flow-map distillation), so each noise still gives its own draw."""

    def __init__(self, model):
        super().__init__()
        self.action_encoder = copy.deepcopy(model.action_encoder)
        self.dit = copy.deepcopy(model.model)
        self.action_decoder = copy.deepcopy(model.action_decoder)
        with torch.no_grad():
            position = model.position_embedding(torch.arange(18, device=next(model.parameters()).device))
        self.register_buffer('position', position.detach().clone())

    def forward(self, vl, noise):
        n = len(noise)
        embodiment = torch.zeros(n, dtype=torch.long, device=noise.device)
        a = self.action_encoder(noise, torch.zeros(n, device=noise.device), embodiment) + self.position
        out = self.dit(hidden_states=a, encoder_hidden_states=vl,
                       timestep=torch.zeros(n, dtype=torch.long, device=noise.device))
        return noise + self.action_decoder(out, embodiment)


def distill_head(args):
    """Trains a OneStepHead: from NitroGen's own image features (unchanged encoder and VL
    layers), one step from each noise to the actions NitroGen's --steps Euler steps reach
    from it. EMA weights."""
    official = nv.Official(args.nitrogen_src, args.ckpt)
    device = official.device
    official.model.requires_grad_(False)
    policy = le.Policy(official, args.steps)
    head = OneStepHead(official.model).to(device)
    head.requires_grad_(True)
    ema = copy.deepcopy(head).requires_grad_(False)
    images = le.frames_in(args.train)
    print(f'{len(images)} training frames; one-step head: {sum(p.numel() for p in head.parameters()) / 1e6:.0f}M '
          f'parameters, against {args.steps} Euler steps', flush=True)
    optimizer = torch.optim.AdamW(head.parameters(), lr=args.lr, weight_decay=0.001)
    warmup = max(1, args.iterations // 20)
    schedule = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda i: min(1.0, (i + 1) / warmup) *
                                                 (1.0 if i < 0.8 * args.iterations else
                                                  max(0.05, (args.iterations - i) / (0.2 * args.iterations))))
    scaler = torch.amp.GradScaler('cuda')
    rng = np.random.default_rng(1)
    started = time.time()
    for step in range(args.iterations):
        pick = rng.choice(len(images), args.batch, replace=False)
        pixels = le.pixel_batch(le.augment(images[pick], rng), device)
        with torch.no_grad(), torch.autocast('cuda', dtype=torch.float16):
            vl = policy.vl(official.model.vision_encoder(pixels)['last_hidden_state']).float()
            vl = vl.repeat_interleave(args.draws, 0)
            noise = torch.randn(len(vl), 18, 25, device=device)
            target = noise
            for t in policy.times:
                target = target + policy.velocity(vl, target, t).float() / args.steps
        with torch.autocast('cuda', dtype=torch.float16):
            loss = (head(vl, noise).float() - target.float()).pow(2).mean()
        optimizer.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
        scaler.step(optimizer)
        scaler.update()
        schedule.step()
        with torch.no_grad():
            decay = min(args.ema, (step + 1) / (step + 10))
            for e, p in zip(ema.parameters(), head.parameters()):
                e.lerp_(p, 1 - decay)
        if step % 50 == 0 or step == args.iterations - 1:
            print(f'  step {step + 1}/{args.iterations}: action error {loss.item():.5f} '
                  f'lr {schedule.get_last_lr()[0]:.2e} ({time.time() - started:.0f} s)', flush=True)
        if (step + 1) % 500 == 0 or step == args.iterations - 1:
            torch.save({'head': ema.state_dict(), 'steps': step + 1, 'teacher_steps': args.steps}, args.out)
    print(f'saved {args.out}', flush=True)


def parse_variant(text):
    kind, *values = text.split(':')
    return (kind, *map(int, values))


def describe(variant):
    if variant is None:
        return 'NitroGen'
    if variant[0] == 'student':
        return f'distilled student ({variant[1]})'
    if variant[0] == 'pool':
        return f'pool 2x2 from layer {variant[1]} (256 -> 64 tokens)'
    return f'ToMe r={variant[1]} from layer {variant[2]} ({256 - variant[1] * (24 - variant[2])} tokens at the end)'


@torch.no_grad()
def encoder_ms(official, variant, device, student=None, repeats=20):
    pixels = torch.randn(1, 3, 256, 256, device=device)
    for _ in range(3):
        encode(official, pixels, variant, student)
    torch.cuda.synchronize()
    started = time.time()
    for _ in range(repeats):
        encode(official, pixels, variant, student)
    torch.cuda.synchronize()
    return (time.time() - started) / repeats * 1000


def compare(args):
    official = nv.Official(args.nitrogen_src, args.ckpt)
    device = official.device
    policy = le.Policy(official, args.steps)
    variants = [None] + [parse_variant(v) for v in args.variant]
    students = {}
    for path in args.student:
        saved = torch.load(path, map_location='cpu', weights_only=True)
        student = PooledStudent(official.model.vision_encoder, saved['pool_from']).to(device).eval()
        student.load_state_dict(saved['student'])
        variant = ('student', f'{os.path.basename(path)}, pool from layer {saved["pool_from"]}, {saved["steps"]} steps')
        students[variant] = student
        variants.append(variant)
    for variant in variants:
        print(f'{describe(variant)}: encoder {encoder_ms(official, variant, device, students.get(variant)):.1f} ms '
              f'on {device}', flush=True)
    # One-step heads: each sampled on NitroGen's own features and on every student's.
    heads = {}
    for path in args.head:
        saved = torch.load(path, map_location='cpu', weights_only=True)
        head = OneStepHead(official.model).to(device).eval()
        head.load_state_dict(saved['head'])
        heads[f'{os.path.basename(path)}, {saved["steps"]} steps'] = head
    runs = [(i, None) for i in range(1, len(variants))]
    runs += [(i, name) for name in heads for i in [0] + [j for j, v in enumerate(variants) if v and v[0] == 'student']]

    @torch.no_grad()
    def one_step(head, features, draws, seed):
        vl = policy.vl(features.expand(draws, -1, -1))
        noise = torch.randn(draws, 18, 25, generator=torch.Generator().manual_seed(seed)).to(device)
        return head(vl, noise).float().cpu().numpy()
    for frames_dir in args.frames:
        frames = [img for _, img in nv.load_frames(frames_dir, args.frames_per_set)]
        print(f'== {frames_dir}: {len(frames)} frames', flush=True)
        with torch.no_grad():
            features = {i: [encode(official, le.pixel_batch([img], device), variants[i], students.get(variants[i]))
                            for img in frames] for i in range(len(variants))}
        def sample(feats, base, head=None):
            if head is None:
                return [policy.act(f, args.draws, base + j) for j, f in enumerate(feats)]
            return [one_step(heads[head], f, args.draws, base + j) for j, f in enumerate(feats)]
        reference_a = sample(features[0], 10_000)
        reference_b = sample(features[0], 20_000)
        self_keys, self_sticks = le.distance(reference_a, reference_b)
        reference_variety = le.variety([np.concatenate([a, b]) for a, b in zip(reference_a, reference_b)])
        print(f'  NitroGen against itself: keys {self_keys:.4f} sticks {self_sticks:.4f} variety {reference_variety:.4f}',
              flush=True)
        for i, head in runs:
            drawn = sample(features[i], 30_000, head)
            k, s = le.distance(reference_a, drawn)
            v = le.variety(drawn) / reference_variety
            ok = k <= 1.25 * self_keys and s <= 1.25 * self_sticks and 0.8 <= v <= 1.25
            cosine = np.mean([F.cosine_similarity(features[i][j].mean(1), features[0][j].mean(1), dim=-1).item()
                              for j in range(len(frames))])
            name = describe(variants[i]) + (f' + one-step head ({head})' if head else '')
            print(f'  {name}: keys {k / self_keys:.2f}x sticks {s / self_sticks:.2f}x variety {v:.3f}x '
                  f'(pooled feature cosine {cosine:.3f}) -> {"PASS" if ok else "FAIL"}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('compare', help='variants against NitroGen as policies, and their encoder time')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--nitrogen-src', required=True)
    p.add_argument('--frames', action='append', required=True)
    p.add_argument('--frames-per-set', type=int, default=48)
    p.add_argument('--variant', action='append', default=[], help='pool:K or tome:R:K')
    p.add_argument('--student', action='append', default=[], help='a distilled student (distill --out)')
    p.add_argument('--head', action='append', default=[], help='a one-step head (distill-head --out)')
    p.add_argument('--draws', type=int, default=8)
    p.add_argument('--steps', type=int, default=4)
    p = sub.add_parser('distill', help='train a pooled student with NitroGen as its teacher')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--nitrogen-src', required=True)
    p.add_argument('--train', action='append', required=True, help='folders of input_*.png frames')
    p.add_argument('--pool-from', type=int, default=8)
    p.add_argument('--iterations', type=int, default=3000)
    p.add_argument('--batch', type=int, default=16)
    p.add_argument('--draws', type=int, default=2, help='noises per frame in the velocity loss')
    p.add_argument('--steps', type=int, default=4)
    p.add_argument('--lr', type=float, default=2e-5)
    p.add_argument('--vl-weight', type=float, default=0.5)
    p.add_argument('--ema', type=float, default=0.999)
    p.add_argument('--out', required=True)
    p = sub.add_parser('distill-head', help='train a one-step action head with NitroGen as its teacher')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--nitrogen-src', required=True)
    p.add_argument('--train', action='append', required=True, help='folders of input_*.png frames')
    p.add_argument('--iterations', type=int, default=3000)
    p.add_argument('--batch', type=int, default=16)
    p.add_argument('--draws', type=int, default=8, help='noises per frame')
    p.add_argument('--steps', type=int, default=4, help='the teacher\'s Euler steps')
    p.add_argument('--lr', type=float, default=3e-5)
    p.add_argument('--ema', type=float, default=0.999)
    p.add_argument('--out', required=True)
    args = parser.parse_args()
    torch.manual_seed(0)
    if args.command == 'compare':
        compare(args)
    elif args.command == 'distill':
        distill(args)
    else:
        distill_head(args)


if __name__ == '__main__':
    sys.exit(main())
