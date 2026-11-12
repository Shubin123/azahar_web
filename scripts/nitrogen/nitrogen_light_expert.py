#!/usr/bin/env python3
"""
nitrogen_light_expert.py — a light vision expert for NitroGen, after Laya-Vision.

NitroGen's image encoder (SigLIP2-large, 316M parameters, 256 tokens) is most of the time a
decision takes. Laya-Vision (huggingface.co/ZeraG07/laya-vision) puts a frozen SigLIP-base/16
tower (google/siglip-base-patch16-224, layer -2) and a small trained projector in front of
Laya. This fuses the same front end into NitroGen as a second, light expert of a mixture:

  light expert   the SigLIP-base/16 tower, run at 256 px (its 16x16 grid then lines up with
                 SigLIP2-large's), layer -2, and an adapter (an input LayerNorm and a
                 projection to 1024, as Laya-Vision's projector, then 2 transformer layers and
                 a LayerNorm) trained to give the features NitroGen's encoder gives
  heavy expert   NitroGen's own SigLIP2-large
  gate           per frame, from the light expert's pooled tower features, the predicted
                 error of the light expert's actions; frames above a threshold also run the
                 heavy expert, so most decisions run only the light expert's weights

Everything after the image features (NitroGen's VL layers and action denoiser) is
unchanged. Training runs on the GPU (MPS or CUDA) on augmented emulator frames (crops,
colour shifts, flips, frame mixes) with NVIDIA's encoder as the teacher. First the adapter
learns on the frozen tower (--stage adapter). Then (--stage tune, from --init) the tower's
layers from TUNED_FROM on learn too, and the loss also takes in NitroGen's frozen VL layers
and the action velocities its denoiser predicts at the states the page's 4 Euler steps
visit, so the light expert learns what changes the actions rather than every feature. The
gate learns from frames the light expert did not train on. Then NitroGen with the mixture
is compared with NitroGen as a policy on held-out frames, as tests/ai_common.cjs's
distributionChecks do.

  python3 scripts/nitrogen/nitrogen_light_expert.py --ckpt ng.pt --nitrogen-src NitroGen \\
      --tower SIGLIP_BASE_DIR --train tmp_test/ai_frames/train --train tmp_test/ai_frames/calib \\
      --valid tmp_test/ai_frames/valid --pool POOL_DIR --out light_expert.pt
  python3 scripts/nitrogen/nitrogen_light_expert.py ... --stage tune --init light_expert.pt \\
      --out light_expert_tuned.pt
"""

import argparse
import copy
import glob
import hashlib
import json
import math
import os
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nitrogen_onnx as ng  # noqa: E402
import nitrogen_validate as nv  # noqa: E402

HIDDEN = 1024
TOWER_WIDTH = 768
TUNED_FROM = 5          # the tower's layers before this one stay frozen (their output is pooled)
TOWER_LAYERS = 11       # layer -2 of SigLIP-base's 12


class Block(torch.nn.Module):
    """A pre-norm transformer layer (SigLIP's shape: attention, then a GELU-tanh MLP)."""

    def __init__(self, width=HIDDEN, heads=16):
        super().__init__()
        self.norm1 = torch.nn.LayerNorm(width, eps=1e-6)
        self.qkv = torch.nn.Linear(width, 3 * width)
        self.out = torch.nn.Linear(width, width)
        self.norm2 = torch.nn.LayerNorm(width, eps=1e-6)
        self.fc1 = torch.nn.Linear(width, 4 * width)
        self.fc2 = torch.nn.Linear(4 * width, width)
        self.heads = heads

    def forward(self, x):
        b, t, w = x.shape
        q, k, v = self.qkv(self.norm1(x)).reshape(b, t, 3, self.heads, w // self.heads).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, t, w)
        x = x + self.out(a)
        return x + self.fc2(F.gelu(self.fc1(self.norm2(x)), approximate='tanh'))


class Adapter(torch.nn.Module):
    """Laya-Vision's projector (input LayerNorm, projection), then context, into NitroGen's
    image feature space (SigLIP2-large after its post-LayerNorm)."""

    def __init__(self, layers=2):
        super().__init__()
        self.norm_in = torch.nn.LayerNorm(TOWER_WIDTH)
        self.proj = torch.nn.Linear(TOWER_WIDTH, HIDDEN)
        self.blocks = torch.nn.ModuleList([Block() for _ in range(layers)])
        self.norm_out = torch.nn.LayerNorm(HIDDEN, eps=1e-6)

    def forward(self, tower):
        x = self.proj(self.norm_in(tower))
        for block in self.blocks:
            x = block(x)
        return self.norm_out(x)


class Gate(torch.nn.Module):
    """The light expert's predicted feature error for a frame, from its pooled tower tokens."""

    def __init__(self):
        super().__init__()
        self.net = torch.nn.Sequential(torch.nn.LayerNorm(2 * TOWER_WIDTH), torch.nn.Linear(2 * TOWER_WIDTH, 256),
                                       torch.nn.GELU(), torch.nn.Linear(256, 1))

    def forward(self, tower):
        return self.net(torch.cat([tower.mean(1), tower.std(1)], dim=-1)).squeeze(-1)


def load_tower(path, device):
    from transformers import SiglipVisionModel
    tower = SiglipVisionModel.from_pretrained(path).to(device).eval()
    for p in tower.parameters():
        p.requires_grad_(False)
    return tower


def tower_front(tower, pixels):
    """SigLIP-base/16 at 256 px (position embeddings interpolated), its frozen layers."""
    x = tower.vision_model.embeddings(pixels, interpolate_pos_encoding=True)
    for layer in tower.vision_model.encoder.layers[:TUNED_FROM]:
        x = layer(x, None)
    return x


def tower_features(tower, pixels):
    """SigLIP-base/16 at 256 px, layer -2, as Laya-Vision reads it."""
    x = tower_front(tower, pixels)
    for layer in tower.vision_model.encoder.layers[TUNED_FROM:TOWER_LAYERS]:
        x = layer(x, None)
    return x


class LightExpert(torch.nn.Module):
    """The tower's layers from TUNED_FROM to layer -2 (trained in --stage tune), then the adapter."""

    def __init__(self, tower):
        super().__init__()
        self.layers = copy.deepcopy(tower.vision_model.encoder.layers[TUNED_FROM:TOWER_LAYERS])
        self.adapter = Adapter()

    def forward(self, front):
        """Image features and layer -2's tokens (the gate's input) from the frozen layers' output."""
        x = front
        for layer in self.layers:
            x = layer(x, None)
        return self.adapter(x), x


def teacher_features(official, pixels):
    """NitroGen's image features: SigLIP2-large's last hidden state (after post_layernorm)."""
    return official.model.vision_encoder(pixels)['last_hidden_state']


def frames_in(directories):
    from PIL import Image
    images = []
    for directory in directories:
        for path in sorted(glob.glob(os.path.join(directory, '**', 'input_*.png'), recursive=True)):
            images.append(np.asarray(Image.open(path).convert('RGB')))
    return np.stack(images)


def augment(images, rng):
    """One augmented 256x256 image per input: a random crop, colour shift, flip, or a mix of two."""
    out = np.empty_like(images)
    n = len(images)
    for i, image in enumerate(images):
        img = torch.from_numpy(image).permute(2, 0, 1).float()
        scale, aspect = rng.uniform(0.55, 1.0), math.exp(rng.uniform(-0.25, 0.25))
        h = int(min(256, round(256 * math.sqrt(scale / aspect))))
        w = int(min(256, round(256 * math.sqrt(scale * aspect))))
        y, x = rng.integers(0, 257 - h), rng.integers(0, 257 - w)
        img = F.interpolate(img[None, :, y:y + h, x:x + w], size=(256, 256), mode='bilinear', antialias=True,
                            align_corners=False)[0]
        if rng.random() < 0.5:
            img = img.flip(-1)
        img = img * rng.uniform(0.75, 1.25) + rng.uniform(-25, 25)                      # contrast, brightness
        gray = img.mean(0, keepdim=True)
        img = gray + (img - gray) * rng.uniform(0.6, 1.4)                               # saturation
        if rng.random() < 0.3:                                                           # mix in a band of another frame
            other = torch.from_numpy(images[rng.integers(n)]).permute(2, 0, 1).float()
            if rng.random() < 0.5:
                y0 = rng.integers(0, 192); img[:, y0:y0 + 64] = other[:, y0:y0 + 64]
            else:
                x0 = rng.integers(0, 192); img[:, :, x0:x0 + 64] = other[:, :, x0:x0 + 64]
        out[i] = img.clamp(0, 255).round().byte().permute(1, 2, 0).numpy()
    return out


def pixel_batch(images, device):
    return torch.from_numpy(np.stack([nv.pixel_values(img)[0] for img in images])).to(device)


def build_pool(official, tower, images, copies, seed, device, directory, batch=16):
    """The frozen tower layers' output and the teacher's features for `copies` augmentations
    of every image (the first copy the image itself), float16 files in `directory`, reused
    when they were made from the same images."""
    meta = {'images': hashlib.sha256(images.tobytes()).hexdigest(), 'copies': copies, 'seed': seed,
            'tuned_from': TUNED_FROM}
    n = copies * len(images)
    shapes = {'front': (n, 256, TOWER_WIDTH), 'teacher': (n, 256, HIDDEN)}
    meta_path = os.path.join(directory, 'pool.json')
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            if json.load(f) == meta:
                return tuple(np.memmap(os.path.join(directory, f'{name}.f16'), np.float16, 'r', shape=shape)
                             for name, shape in shapes.items())
    os.makedirs(directory, exist_ok=True)
    pool = {name: np.memmap(os.path.join(directory, f'{name}.f16'), np.float16, 'w+', shape=shape)
            for name, shape in shapes.items()}
    rng = np.random.default_rng(seed)
    row = 0
    with torch.no_grad():
        for copy_index in range(copies):
            batch_images = images if copy_index == 0 else augment(images, rng)
            for start in range(0, len(batch_images), batch):
                pixels = pixel_batch(batch_images[start:start + batch], device)
                pool['front'][row:row + len(pixels)] = tower_front(tower, pixels).half().cpu().numpy()
                pool['teacher'][row:row + len(pixels)] = teacher_features(official, pixels).half().cpu().numpy()
                row += len(pixels)
    for array in pool.values():
        array.flush()
    with open(meta_path, 'w') as f:
        json.dump(meta, f)
    return pool['front'], pool['teacher']


def rows(array, pick, device):
    return torch.from_numpy(array[np.sort(pick)]).to(device).float()


def feature_loss(student, teacher, scale):
    """Mean squared error per channel in units of the teacher's spread, plus cosine error per token."""
    return (((student - teacher) / scale) ** 2).mean() + (1 - F.cosine_similarity(student, teacher, dim=-1)).mean()


class PolicyLoss:
    """How far the light expert's features move NitroGen's actions: its frozen VL layers'
    output, and the velocities its denoiser predicts at the states NitroGen's own Euler steps
    visit from `draws` noises, against the teacher's. The velocity error is in units of how
    much the velocity changes when another frame is shown (1: as wrong as a random frame)."""

    def __init__(self, policy, reference, draws):
        """`reference`: teacher features of some frames, for the scales of the losses."""
        self.policy, self.draws = policy, draws
        with torch.no_grad():
            vl = policy.vl(reference)
            self.vl_scale = vl.reshape(-1, vl.shape[-1]).std(0) + 1e-3
            states, velocities = policy.trajectory(vl, draws)
            other = vl.roll(1, 0).repeat_interleave(draws, 0)
            self.velocity_scale = torch.stack([(policy.velocity(other, state, t) - v).pow(2).mean()
                                               for state, t, v in zip(states, policy.times, velocities)])

    def __call__(self, features, teacher_features, steps=None):
        """The VL loss, and each frame's velocity error at Euler steps `steps` (all by default)."""
        policy = self.policy
        steps = range(len(policy.times)) if steps is None else steps
        vl = policy.vl(features)
        with torch.no_grad():
            target_vl = policy.vl(teacher_features)
            states, targets = policy.trajectory(target_vl, self.draws, max(steps) + 1)
        vl_loss = (((vl - target_vl) / self.vl_scale) ** 2).mean()
        repeated = vl.repeat_interleave(self.draws, 0)
        velocity_loss = sum((policy.velocity(repeated, states[k], policy.times[k]) - targets[k]).pow(2).mean((1, 2))
                            / self.velocity_scale[k] for k in steps) / len(steps)
        return vl_loss, velocity_loss.reshape(-1, self.draws).mean(1)


def train_light(light, policy_loss, front, teacher, scale, device, epochs, tune, batch, feature_weight=1.0,
                lr=4e-4, tower_lr=4e-5):
    """--stage adapter: the adapter alone, on features; --stage tune: also the tower's layers
    from TUNED_FROM, on features (times `feature_weight`), VL output and action velocities."""
    light.layers.requires_grad_(tune)
    groups = [{'params': light.adapter.parameters(), 'lr': lr}]
    if tune:
        groups.append({'params': light.layers.parameters(), 'lr': tower_lr})
    steps = epochs * math.ceil(len(front) / batch)
    optimizer = torch.optim.AdamW(groups, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=[g['lr'] for g in groups], total_steps=steps,
                                                   pct_start=0.05)
    light.train()
    started, step = time.time(), 0
    for epoch in range(epochs):
        order = np.random.default_rng(epoch).permutation(len(front))
        totals = np.zeros(3)
        for start in range(0, len(order), batch):
            pick = np.sort(order[start:start + batch])
            x, y = rows(front, pick, device), rows(teacher, pick, device)
            features, _ = light(x)
            losses = [feature_loss(features, y, scale)]
            if tune:                                            # one Euler step per batch, in turn
                vl_loss, velocity_loss = policy_loss(features, y, [step % len(policy_loss.policy.times)])
                losses += [vl_loss, velocity_loss.mean()]
            loss = sum(losses) if not tune else feature_weight * losses[0] + losses[1] + losses[2]
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            schedule.step()
            totals[:len(losses)] += [l.item() * len(pick) for l in losses]
            step += 1
            if step % 100 == 0:
                print(f'  step {step}/{steps}: features {losses[0].item():.4f}'
                      + (f' vl {losses[1].item():.4f} velocity {losses[2].item():.4f}' if tune else '')
                      + f' ({time.time() - started:.0f} s)', flush=True)
        print(f'  epoch {epoch + 1}/{epochs}: features {totals[0] / len(order):.4f}'
              + (f' vl {totals[1] / len(order):.4f} velocity {totals[2] / len(order):.4f}' if tune else '')
              + f' ({time.time() - started:.0f} s)', flush=True)
    light.eval()


@torch.no_grad()
def frame_errors(light, policy_loss, front, teacher, device, batch=16):
    """Each sample's action velocity error (the gate's target) and layer -2 tokens."""
    errors, tokens = [], []
    for start in range(0, len(front), batch):
        pick = np.arange(start, min(start + batch, len(front)))
        features, t = light(rows(front, pick, device))
        errors.append(policy_loss(features, rows(teacher, pick, device))[1].cpu())
        tokens.append(t.half().cpu())
    return torch.cat(errors), torch.cat(tokens)


def train_gate(tokens, errors, device, epochs=300):
    gate = Gate().to(device)
    target = torch.log(errors).to(device)
    optimizer = torch.optim.AdamW(gate.parameters(), lr=1e-3, weight_decay=0.01)
    x = tokens.to(device).float()
    for _ in range(epochs):
        loss = F.mse_loss(gate(x), target)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    return gate


# ── NitroGen as a policy, with the mixture ─────────────────────────────

PAD = {'SOUTH': 'B', 'EAST': 'A', 'WEST': 'Y', 'NORTH': 'X', 'LEFT_SHOULDER': 'L', 'RIGHT_SHOULDER': 'R',
       'LEFT_TRIGGER': 'ZL', 'RIGHT_TRIGGER': 'ZR', 'DPAD_UP': 'Up', 'DPAD_DOWN': 'Down', 'DPAD_LEFT': 'Left',
       'DPAD_RIGHT': 'Right'}


def keys(step):
    """The 3DS keys azahar_ai_player.js holds for one action (Start, Select and HOME off)."""
    held = {PAD[b] for i, b in enumerate(ng.BUTTONS) if step[i] > 0.5 and b in PAD}
    lx, ly, rx, ry = np.clip(step[21:25] * 2 - 1, -1, 1)
    for value, minus, plus in ((lx, 'CircleLeft', 'CircleRight'), (ly, 'CircleUp', 'CircleDown'),
                               (rx, 'CLeft', 'CRight'), (ry, 'CUp', 'CDown')):
        if value < -0.3:
            held.add(minus)
        elif value > 0.3:
            held.add(plus)
    if 0.3 < float(np.hypot(lx, ly)) < 0.75:
        held.add('CircleHalf')
    return frozenset(held)


class Policy:
    """NitroGen's VL layers and denoiser on given image features (gradients pass to the
    features; NitroGen's weights stay frozen)."""

    def __init__(self, official, steps):
        self.model, self.device, self.steps = official.model, official.device, steps
        self.model.requires_grad_(False)
        self.times = ng.timesteps(steps)
        self.position = self.model.position_embedding(torch.arange(ng.ACTION_HORIZON, device=self.device))

    def vl(self, features):
        return self.model.vl_self_attention_model(features)

    def velocity(self, vl, actions, t):
        m, n = self.model, len(actions)
        embodiment = torch.zeros(n, dtype=torch.long, device=self.device)
        a = m.action_encoder(actions, torch.full((n,), float(t), device=self.device), embodiment) + self.position
        out = m.model(hidden_states=a, encoder_hidden_states=vl,
                      timestep=torch.full((n,), t, dtype=torch.long, device=self.device))
        return m.action_decoder(out, embodiment)

    @torch.no_grad()
    def trajectory(self, vl, draws, steps=None):
        """The states and velocities of `draws` Euler trajectories per frame from fresh noise,
        over the first `steps` steps."""
        vl = vl.repeat_interleave(draws, 0)
        actions = torch.randn(len(vl), ng.ACTION_HORIZON, ng.ACTION_DIM, device=self.device)
        states, velocities = [], []
        for t in self.times[:steps]:
            states.append(actions)
            velocities.append(self.velocity(vl, actions, t))
            actions = actions + velocities[-1] / self.steps
        return states, velocities

    @torch.no_grad()
    def act(self, features, draws, seed):
        """`draws` action chunks for one frame's features [1, 256, 1024], Euler steps from noise."""
        vl = self.vl(features.expand(draws, -1, -1))
        gen = torch.Generator().manual_seed(seed)
        actions = torch.randn(draws, ng.ACTION_HORIZON, ng.ACTION_DIM, generator=gen).to(self.device)
        for t in self.times:
            actions = actions + self.velocity(vl, actions, t) / self.steps
        return actions.float().cpu().numpy()


def distance(a, b):
    """tests/ai_common.cjs's distributionDistance: key-frequency and stick-mean differences."""
    keys_d = sticks_d = cells = 0
    for fa, fb in zip(a, b):
        for s in range(ng.ACTION_HORIZON):
            ca, cb = {}, {}
            for d in fa:
                for k in keys(d[s]):
                    ca[k] = ca.get(k, 0) + 1
            for d in fb:
                for k in keys(d[s]):
                    cb[k] = cb.get(k, 0) + 1
            keys_d += sum(abs(ca.get(k, 0) / len(fa) - cb.get(k, 0) / len(fb)) for k in set(ca) | set(cb))
            ma = np.mean([np.clip(d[s][21:25] * 2 - 1, -1, 1) for d in fa], 0)
            mb = np.mean([np.clip(d[s][21:25] * 2 - 1, -1, 1) for d in fb], 0)
            sticks_d += np.abs(ma - mb).mean()
            cells += 1
    return keys_d / cells, sticks_d / cells


def variety(sets):
    """tests/ai_common.cjs's variety: how often two draws of a frame hold different keys."""
    different = pairs = 0
    for draws in sets:
        for s in range(ng.ACTION_HORIZON):
            held = [keys(d[s]) for d in draws]
            for i in range(len(held)):
                for j in range(i + 1, len(held)):
                    different += held[i] != held[j]
                    pairs += 1
    return different / pairs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ckpt', required=True)
    parser.add_argument('--nitrogen-src', required=True)
    parser.add_argument('--tower', required=True, help='google/siglip-base-patch16-224 (Laya-Vision\'s tower)')
    parser.add_argument('--train', action='append', required=True)
    parser.add_argument('--valid', required=True)
    parser.add_argument('--pool', required=True, help='directory for the training features (float16 files)')
    parser.add_argument('--stage', choices=('adapter', 'tune'), default='adapter')
    parser.add_argument('--init', help='start from the light expert in this file')
    parser.add_argument('--copies', type=int, default=10, help='augmented copies of each training frame')
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--train-draws', type=int, default=2, help='noises per frame in the policy loss')
    parser.add_argument('--feature-weight', type=float, default=1.0,
                        help='--stage tune: weight of the feature loss against the VL and velocity losses')
    parser.add_argument('--draws', type=int, default=8)
    parser.add_argument('--steps', type=int, default=4, help='denoising steps of the policies compared')
    parser.add_argument('--valid-frames', type=int, default=48)
    parser.add_argument('--out', required=True)
    parser.add_argument('--load', action='store_true', help='evaluate the experts already in --out')
    args = parser.parse_args()
    torch.manual_seed(0)
    # The tower first: nitrogen_validate.Official makes SiglipVisionModel.from_pretrained
    # build NVIDIA's encoder offline.
    tower = load_tower(args.tower, nv.device())
    official = nv.Official(args.nitrogen_src, args.ckpt)
    device = official.device
    policy = Policy(official, args.steps)
    light, gate = LightExpert(tower).to(device), Gate().to(device)
    scale = None
    if args.load or args.init:
        saved = torch.load(args.out if args.load else args.init, map_location='cpu', weights_only=True)
        if 'light' in saved:
            light.load_state_dict(saved['light'])
        else:                                                   # an adapter trained on the frozen tower
            light.adapter.load_state_dict(saved['adapter'])
        gate.load_state_dict(saved['gate'])
        scale = saved['scale'].to(device)

    if not args.load:
        images = frames_in(args.train)
        rng = np.random.default_rng(0)
        order = rng.permutation(len(images))
        gate_images, light_images = images[order[:len(images) // 5]], images[order[len(images) // 5:]]
        print(f'{len(light_images)} frames for the light expert, {len(gate_images)} for the gate', flush=True)
        started = time.time()
        front, teacher = build_pool(official, tower, light_images, args.copies, 1, device,
                                    os.path.join(args.pool, 'light'))
        gate_front, gate_teacher = build_pool(official, tower, gate_images, 3, 2, device,
                                              os.path.join(args.pool, 'gate'))
        print(f'{len(front)} training samples, {len(gate_front)} for the gate ({time.time() - started:.0f} s)',
              flush=True)
        if scale is None:
            scale = rows(teacher, np.arange(0, len(teacher), max(1, len(teacher) // 256)), device)
            scale = scale.reshape(-1, HIDDEN).std(0) + 1e-3
        policy_loss = PolicyLoss(policy, rows(teacher, np.arange(0, len(teacher), max(1, len(teacher) // 64)),
                                              device), args.train_draws)
        train_light(light, policy_loss, front, teacher, scale, device, args.epochs, args.stage == 'tune', args.batch,
                    args.feature_weight)
        errors, tokens = frame_errors(light, policy_loss, gate_front, gate_teacher, device)
        gate = train_gate(tokens, errors, device)
        torch.save({'light': light.state_dict(), 'gate': gate.state_dict(), 'scale': scale.cpu(),
                    'tuned_from': TUNED_FROM, 'stage': args.stage,
                    'tower': 'google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed'}, args.out)
    light.eval()
    gate.eval()

    # Held-out frames: NitroGen's features, the light expert's, the gate's prediction and
    # the light expert's actual action error.
    valid = [img for _, img in nv.load_frames(args.valid, args.valid_frames)]
    heavy, light_features, predicted = [], [], []
    with torch.no_grad():
        for img in valid:
            pixels = pixel_batch([img], device)
            features, tokens = light(tower_front(tower, pixels))
            heavy.append(teacher_features(official, pixels))
            light_features.append(features)
            predicted.append(gate(tokens).item())
        valid_loss = PolicyLoss(policy, torch.cat(heavy), 8)
        actual = [valid_loss(l, h)[1].item() for l, h in zip(light_features, heavy)]
    cosine = np.mean([F.cosine_similarity(l, h, dim=-1).mean().item() for l, h in zip(light_features, heavy)])
    print(f'held-out features: cosine {cosine:.4f}; action error {np.mean(actual):.4f}; gate vs actual error '
          f'correlation {np.corrcoef(predicted, actual)[0, 1]:.3f}', flush=True)

    def sample(features_for, base):
        return [policy.act(features_for(i), args.draws, base + i) for i in range(len(valid))]
    reference_a = sample(lambda i: heavy[i], 10_000)
    reference_b = sample(lambda i: heavy[i], 20_000)
    self_keys, self_sticks = distance(reference_a, reference_b)
    reference_variety = variety([np.concatenate([a, b]) for a, b in zip(reference_a, reference_b)])
    print(f'NitroGen against itself (other seeds): keys {self_keys:.4f} sticks {self_sticks:.4f}, variety '
          f'{reference_variety:.4f}', flush=True)
    for routing, error in (('gate', predicted), ('oracle', actual)):
        order = np.argsort(error)
        for heavy_share in (0.0, 0.1, 0.25, 0.5):
            if routing == 'oracle' and heavy_share == 0:
                continue
            use_heavy = set(order[len(order) - int(round(heavy_share * len(order))):].tolist()) if heavy_share else set()
            mixture = sample(lambda i: heavy[i] if i in use_heavy else light_features[i], 30_000)
            k, s = distance(reference_a, mixture)
            v = variety(mixture) / reference_variety
            ok = k <= 1.25 * self_keys and s <= 1.25 * self_sticks and 0.8 <= v <= 1.25
            print(f'mixture ({routing}), heavy expert on {int(heavy_share * 100)}% of frames: keys {k:.4f} '
                  f'({k / self_keys:.2f}x) sticks {s:.4f} ({s / self_sticks:.2f}x) variety {v:.3f}x -> '
                  f'{"PASS" if ok else "FAIL"}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
