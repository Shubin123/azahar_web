#!/usr/bin/env python3
"""
nitrogen_light_expert.py — a light vision expert for NitroGen, after Laya-Vision.

NitroGen's image encoder (SigLIP2-large, 316M parameters, 256 tokens) is most of the time a
decision takes. Laya-Vision (huggingface.co/ZeraG07/laya-vision) puts a frozen SigLIP-base/16
tower (google/siglip-base-patch16-224, layer -2) and a small trained projector in front of
Laya. This fuses the same front end into NitroGen as a second, light expert of a mixture:

  light expert   the frozen SigLIP-base/16 tower, run at 256 px (its 16x16 grid then lines
                 up with SigLIP2-large's), layer -2, and an adapter (an input LayerNorm and a
                 projection to 1024, as Laya-Vision's projector, then 2 transformer layers and
                 a LayerNorm) trained to give the features NitroGen's encoder gives
  heavy expert   NitroGen's own SigLIP2-large
  gate           per frame, from the light expert's pooled tower features, the predicted
                 error of the light expert's features; frames above a threshold also run the
                 heavy expert, so most decisions run only the light expert's weights

Everything after the image features (NitroGen's VL layers and action denoiser) is
unchanged. Training runs on the GPU (MPS or CUDA): the adapter learns on augmented emulator
frames (crops, colour shifts, flips, frame mixes) with NVIDIA's encoder as the teacher; the
gate learns from frames the adapter did not train on. Then NitroGen with the mixture is
compared with NitroGen as a policy on held-out frames, as tests/ai_common.cjs's
distributionChecks do.

  python3 scripts/nitrogen/nitrogen_light_expert.py --ckpt ng.pt --nitrogen-src NitroGen \\
      --tower SIGLIP_BASE_DIR --train tmp_test/ai_frames/train --train tmp_test/ai_frames/calib \\
      --valid tmp_test/ai_frames/valid --out light_expert.pt
"""

import argparse
import glob
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


def tower_features(tower, pixels):
    """SigLIP-base/16 at 256 px (position embeddings interpolated), layer -2, as Laya-Vision reads it."""
    out = tower(pixel_values=pixels, output_hidden_states=True, interpolate_pos_encoding=True)
    return out.hidden_states[-2]


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


@torch.no_grad()
def build_pool(official, tower, images, copies, seed, device, batch=16):
    """Tower and teacher features of `copies` augmentations of every image (the first copy
    the image itself), in float16."""
    rng = np.random.default_rng(seed)
    pool_tower, pool_teacher = [], []
    for copy in range(copies):
        batch_images = images if copy == 0 else augment(images, rng)
        for start in range(0, len(batch_images), batch):
            pixels = pixel_batch(batch_images[start:start + batch], device)
            pool_tower.append(tower_features(tower, pixels).half().cpu())
            pool_teacher.append(teacher_features(official, pixels).half().cpu())
    return torch.cat(pool_tower), torch.cat(pool_teacher)


def feature_loss(student, teacher, scale):
    """Mean squared error per channel in units of the teacher's spread, plus cosine error per token."""
    return (((student - teacher) / scale) ** 2).mean() + (1 - F.cosine_similarity(student, teacher, dim=-1)).mean()


def train_adapter(tower_pool, teacher_pool, device, epochs, batch=32):
    adapter = Adapter().to(device)
    scale = teacher_pool.float().reshape(-1, HIDDEN).std(0).to(device) + 1e-3
    steps = epochs * math.ceil(len(tower_pool) / batch)
    optimizer = torch.optim.AdamW(adapter.parameters(), lr=4e-4, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=4e-4, total_steps=steps, pct_start=0.05)
    started = time.time()
    for epoch in range(epochs):
        order = torch.randperm(len(tower_pool))
        total = 0.0
        for start in range(0, len(order), batch):
            pick = order[start:start + batch]
            x, y = tower_pool[pick].to(device).float(), teacher_pool[pick].to(device).float()
            loss = feature_loss(adapter(x), y, scale)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            schedule.step()
            total += loss.item() * len(pick)
        if epoch % 5 == 0 or epoch == epochs - 1:
            print(f'  epoch {epoch + 1}/{epochs}: loss {total / len(order):.4f} ({time.time() - started:.0f} s)', flush=True)
    return adapter, scale


@torch.no_grad()
def frame_errors(adapter, tower_pool, teacher_pool, scale, device, batch=32):
    errors = []
    for start in range(0, len(tower_pool), batch):
        x, y = tower_pool[start:start + batch].to(device).float(), teacher_pool[start:start + batch].to(device).float()
        errors.append((((adapter(x) - y) / scale) ** 2).mean((1, 2)).cpu())
    return torch.cat(errors)


def train_gate(tower_pool, errors, device, epochs=300):
    gate = Gate().to(device)
    target = torch.log(errors).to(device)
    optimizer = torch.optim.AdamW(gate.parameters(), lr=1e-3, weight_decay=0.01)
    x = tower_pool.to(device).float()
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
    """NitroGen's VL layers and denoiser on given image features."""

    def __init__(self, official, steps):
        self.model, self.device, self.steps = official.model, official.device, steps

    @torch.no_grad()
    def act(self, features, draws, seed):
        """`draws` action chunks for one frame's features [1, 256, 1024], Euler steps from noise."""
        m = self.model
        vl = m.vl_self_attention_model(features.expand(draws, -1, -1))
        gen = torch.Generator().manual_seed(seed)
        actions = torch.randn(draws, ng.ACTION_HORIZON, ng.ACTION_DIM, generator=gen).to(self.device)
        embodiment = torch.zeros(draws, dtype=torch.long, device=self.device)
        position = m.position_embedding(torch.arange(ng.ACTION_HORIZON, device=self.device))
        for t in ng.timesteps(self.steps):
            a = m.action_encoder(actions, torch.full((draws,), float(t), device=self.device), embodiment) + position
            out = m.model(hidden_states=a, encoder_hidden_states=vl,
                          timestep=torch.full((draws,), t, dtype=torch.long, device=self.device))
            actions = actions + m.action_decoder(out, embodiment) / self.steps
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
    parser.add_argument('--copies', type=int, default=10, help='augmented copies of each training frame')
    parser.add_argument('--epochs', type=int, default=30)
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

    if args.load:
        saved = torch.load(args.out, map_location='cpu', weights_only=True)
        adapter, gate = Adapter().to(device).eval(), Gate().to(device).eval()
        adapter.load_state_dict(saved['adapter'])
        gate.load_state_dict(saved['gate'])
        scale = saved['scale'].to(device)
    else:
        images = frames_in(args.train)
        rng = np.random.default_rng(0)
        order = rng.permutation(len(images))
        gate_images, adapter_images = images[order[:len(images) // 5]], images[order[len(images) // 5:]]
        print(f'{len(adapter_images)} frames for the adapter, {len(gate_images)} for the gate', flush=True)
        started = time.time()
        tower_pool, teacher_pool = build_pool(official, tower, adapter_images, args.copies, 1, device)
        print(f'{len(tower_pool)} training samples ({time.time() - started:.0f} s)', flush=True)
        adapter, scale = train_adapter(tower_pool, teacher_pool, device, args.epochs)
        del tower_pool, teacher_pool
        gate_tower, gate_teacher = build_pool(official, tower, gate_images, 3, 2, device)
        gate = train_gate(gate_tower, frame_errors(adapter, gate_tower, gate_teacher, scale, device), device)
        torch.save({'adapter': adapter.state_dict(), 'gate': gate.state_dict(), 'scale': scale.cpu(),
                    'tower': 'google/siglip-base-patch16-224@7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed'}, args.out)
    adapter.eval()

    # Held-out frames: NitroGen's features, the light expert's, and the gate's prediction.
    valid = [img for _, img in nv.load_frames(args.valid, args.valid_frames)]
    heavy, light, predicted, actual = [], [], [], []
    with torch.no_grad():
        for img in valid:
            pixels = pixel_batch([img], device)
            t = tower_features(tower, pixels)
            heavy.append(teacher_features(official, pixels))
            light.append(adapter(t))
            predicted.append(gate(t).item())
            actual.append((((light[-1] - heavy[-1]) / scale) ** 2).mean().item())
    cosine = np.mean([F.cosine_similarity(l, h, dim=-1).mean().item() for l, h in zip(light, heavy)])
    print(f'held-out features: cosine {cosine:.4f}; gate vs actual error correlation '
          f'{np.corrcoef(predicted, actual)[0, 1]:.3f}', flush=True)

    policy = Policy(official, args.steps)
    def sample(features_for, base):
        return [policy.act(features_for(i), args.draws, base + i) for i in range(len(valid))]
    reference_a = sample(lambda i: heavy[i], 10_000)
    reference_b = sample(lambda i: heavy[i], 20_000)
    self_keys, self_sticks = distance(reference_a, reference_b)
    reference_variety = variety([np.concatenate([a, b]) for a, b in zip(reference_a, reference_b)])
    print(f'NitroGen against itself (other seeds): keys {self_keys:.4f} sticks {self_sticks:.4f}, variety '
          f'{reference_variety:.4f}', flush=True)
    order = np.argsort(predicted)
    for heavy_share in (0.0, 0.25, 0.5):
        use_heavy = set(order[len(order) - int(round(heavy_share * len(order))):].tolist()) if heavy_share else set()
        mixture = sample(lambda i: heavy[i] if i in use_heavy else light[i], 30_000)
        k, s = distance(reference_a, mixture)
        v = variety(mixture) / reference_variety
        ok = k <= 1.25 * self_keys and s <= 1.25 * self_sticks and 0.8 <= v <= 1.25
        print(f'mixture, heavy expert on {int(heavy_share * 100)}% of frames: keys {k:.4f} ({k / self_keys:.2f}x) '
              f'sticks {s:.4f} ({s / self_sticks:.2f}x) variety {v:.3f}x -> {"PASS" if ok else "FAIL"}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
