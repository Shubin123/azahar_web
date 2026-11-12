#!/usr/bin/env python3
"""
nitrogen_calibrate.py — activation-aware scales for NitroGen's 4-bit linear layers.

A few input channels of SigLIP2's layers carry activations tens to hundreds of times larger
than the rest, and plain 4-bit blocks cannot hold the weights those channels multiply.
As AWQ does (Lin et al., 2023), each group of linear layers that read the same input gets
a per-channel scale s: the graph multiplies the input by 1/s and the weights' columns are
multiplied by s before they are quantized, which leaves the float result unchanged and
gives the busiest channels more of the 4-bit range. s = a^alpha (a: the channel's mean
|activation| on calibration frames, normalized by sqrt(max * min)), with alpha chosen per
group from 0, 0.1, ..., 1 to minimize the layer outputs' error on those frames; alpha 0
means no scaling.

NVIDIA's model runs on the GPU (MPS or CUDA). The calibration frames come from
tests/ai_frames.cjs and must not be the frames tests/ai_player.test.cjs checks the result
on. The page ships the 8-bit model, which needs no scales; these were for the 4-bit
attempts (see README).

  python3 scripts/nitrogen/nitrogen_calibrate.py --ckpt ng.pt --nitrogen-src NitroGen \\
      --frames CALIBRATION_FRAMES --out smooth.npz
"""

import argparse
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nitrogen_onnx as ng  # noqa: E402
import nitrogen_validate as nv  # noqa: E402

ALPHAS = [round(0.1 * i, 1) for i in range(11)]
ROWS_PER_CALL = 16      # activation rows kept per forward call: the largest, then random ones


def group_of(module):
    """The input group a quantized linear belongs to (nitrogen_onnx.py's smooth groups),
    or None for layers kept in float32."""
    if module in ('action_encoder.W1', 'action_decoder.layer2'):
        return None
    if re.fullmatch(r'model\.transformer_blocks\.\d+\.norm1\.linear|model\.proj_out_1', module):
        return 'temb_act'
    match = re.fullmatch(r'(model\.transformer_blocks\.(\d+))\.attn1\.to_(k|v)', module)
    if match and int(match.group(2)) in ng.CROSS_BLOCKS:
        return 'vl.cross_kv'
    module = re.sub(r'\.self_attn\.(q|k|v)_proj$', '.self_attn.qkv', module)
    module = re.sub(r'\.attn1\.to_(q|k|v)$', '.attn1.qkv', module)
    return module


def collect(official, frames, seed):
    """Inputs of every quantized linear layer while the model acts on `frames`."""
    import torch
    from nitrogen.flow_matching_transformer.nitrogen import CategorySpecificLinear
    rng = np.random.default_rng(seed)
    rows, sums, counts, weights = {}, {}, {}, {}

    def hook(name, group):
        def record(_module, inputs, _output):
            x = inputs[0].detach().float().cpu().reshape(-1, inputs[0].shape[-1])
            sums[group] = sums.get(group, 0) + x.abs().sum(0).numpy().astype(np.float64)
            counts[group] = counts.get(group, 0) + x.shape[0]
            norms = x.norm(dim=1).numpy()
            keep = list(np.argsort(norms)[-4:])
            others = np.setdiff1d(np.arange(x.shape[0]), keep)
            keep += list(rng.choice(others, size=min(len(others), ROWS_PER_CALL - len(keep)), replace=False))
            rows.setdefault(group, []).append(x[keep].numpy())
        return record

    handles = []
    for name, module in official.model.named_modules():
        if isinstance(module, (torch.nn.Linear, CategorySpecificLinear)):
            group = group_of(name)
            if group is None or name.startswith('vision_encoder.head'):
                continue
            weight = module.weight if isinstance(module, torch.nn.Linear) else module.W[0].T
            weights.setdefault(group, []).append((name, weight.detach().float().cpu().numpy()))
            if len(weights[group]) == 1:
                handles.append(module.register_forward_hook(hook(name, group)))
    try:
        for _, image in frames:
            start_noise = rng.standard_normal((1, ng.ACTION_HORIZON, ng.ACTION_DIM)).astype(np.float32)
            official.act(nv.pixel_values(image), start_noise)
    finally:
        for handle in handles:
            handle.remove()
    return {g: (np.concatenate(rows[g]), (sums[g] / counts[g]).astype(np.float32), weights[g]) for g in rows}


def scales_for(a, alpha):
    s = np.power(np.maximum(a, 1e-8), alpha, dtype=np.float32)
    return (s / np.sqrt(s.max() * s.min())).astype(np.float32)


def output_error(x, weights, s, bits):
    import torch
    total = 0.0
    xt = torch.from_numpy(x)
    for _, w in weights:
        n, k = w.shape
        scaled = (w * s[None, :]).astype(np.float32)
        packed, scale = ng.quantize_blocks(scaled, bits)
        effective = ng.dequantize_blocks(packed, scale, bits, k) / s[None, :]
        total += float(torch.linalg.matrix_norm(xt @ torch.from_numpy(w - effective).T) ** 2)
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ckpt', required=True)
    parser.add_argument('--nitrogen-src', required=True)
    parser.add_argument('--frames', required=True)
    parser.add_argument('--bits', type=int, default=4)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    started = time.time()
    frames = nv.load_frames(args.frames, 10000)
    official = nv.Official(args.nitrogen_src, args.ckpt)
    groups = collect(official, frames, args.seed)
    print(f'{len(frames)} frames, {len(groups)} groups, {time.time() - started:.0f}s', flush=True)
    result, report = {}, []
    for group, (x, a, weights) in sorted(groups.items()):
        errors = {alpha: output_error(x, weights, scales_for(a, alpha), args.bits) for alpha in ALPHAS}
        best = min(errors, key=errors.get)
        report.append((group, best, errors[0.0], errors[best]))
        if best > 0:
            result[group] = scales_for(a, best)
    for group, best, plain, scaled in report:
        print(f'{group:58s} alpha {best:.1f}  error {plain:.4g} -> {scaled:.4g}')
    np.savez(args.out, **result)
    print(f'{len(result)} of {len(groups)} groups scaled; {time.time() - started:.0f}s')


if __name__ == '__main__':
    sys.exit(main())
