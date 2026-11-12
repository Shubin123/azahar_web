#!/usr/bin/env python3
"""
nitrogen_validate.py — checks that the float32 graphs reproduce NVIDIA's NitroGen code.

tests/ai_player.test.cjs validates the quantized model in the browser against these float32
graphs on emulator framebuffers; this is what makes them a fair stand-in for NVIDIA's
model. On a few frames (tests/ai_frames.cjs's input_*.png) and the same starting noise,
NVIDIA's NitroGen.get_action (github.com/MineDojo/NitroGen, run on the GPU: MPS or CUDA)
and the float32 graphs (nitrogen_onnx.py --variants f32, in ONNX Runtime) must give the
same 18 actions up to float rounding.

  python3 scripts/nitrogen/nitrogen_validate.py --ckpt ng.pt --nitrogen-src NitroGen \\
      --graphs tmp_test/ai_reference/f32 --frames tmp_test/ai_frames/valid [--limit 8]
"""

import argparse
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nitrogen_onnx as ng  # noqa: E402

MAX_ABS = 2e-3


def load_frames(directory, limit):
    from PIL import Image
    files = sorted(glob.glob(os.path.join(directory, '**', 'input_*.png'), recursive=True))
    # Spread the frames over every scene rather than taking the first ones.
    files = files[::max(1, len(files) // limit)][:limit]
    frames = []
    for path in files:
        image = np.asarray(Image.open(path).convert('RGB'))
        assert image.shape == (256, 256, 3), (path, image.shape)
        frames.append((os.path.relpath(path, directory), image))
    return frames


def pixel_values(image):
    """The page's preprocessing: RGB / 127.5 - 1, channels first (SigLIP2's processor:
    rescale 1/255, normalize mean 0.5 std 0.5, at 256x256 already)."""
    return (image.astype(np.float32) / np.float32(127.5) - np.float32(1)).transpose(2, 0, 1)[None]


def device():
    import torch
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cuda' if torch.cuda.is_available() else 'cpu'


class Official:
    """NVIDIA's model class, loaded from its source tree without network access."""

    def __init__(self, src, ckpt):
        import torch
        sys.path.insert(0, src)
        from transformers import SiglipVisionConfig, SiglipVisionModel

        def local_siglip(name, *args, **kwargs):
            assert name == 'google/siglip2-large-patch16-256', name
            # The checkpoint holds every weight; only the architecture is needed here.
            return SiglipVisionModel(SiglipVisionConfig(hidden_size=1024, image_size=256, intermediate_size=4096,
                                                        num_attention_heads=16, num_hidden_layers=24, patch_size=16))
        SiglipVisionModel.from_pretrained = staticmethod(local_siglip)
        from nitrogen.cfg import CkptConfig
        from nitrogen.flow_matching_transformer.nitrogen import NitroGen
        from nitrogen.mm_tokenizers import NitrogenTokenizer
        checkpoint = torch.load(ckpt, map_location='cpu', weights_only=True)
        config = CkptConfig.model_validate(checkpoint['ckpt_config'])
        self.device = device()
        self.model = NitroGen(config=config.model_cfg, game_mapping=None)
        self.model.load_state_dict(checkpoint['model'])
        self.model.eval().to(self.device)
        config.tokenizer_cfg.training = False
        self.tokenizer = NitrogenTokenizer(config.tokenizer_cfg)
        self.torch = torch

    def act(self, pixels, start_noise):
        """inference_session.py's _predict_flowmatching for one frame (cfg_scale 1), with
        get_action's starting noise replaced by `start_noise`."""
        torch = self.torch
        data = self.tokenizer.encode({'frames': torch.from_numpy(pixels),
                                      'dropped_frames': torch.zeros(1, dtype=torch.bool), 'game': None})
        for key, value in data.items():
            if isinstance(value, torch.Tensor):
                data[key] = value.unsqueeze(0).to(self.device)
            elif isinstance(value, np.ndarray):
                data[key] = torch.tensor(value).unsqueeze(0).to(self.device)
            else:
                data[key] = [value]
        randn = torch.randn
        torch.randn = lambda *args, **kwargs: torch.from_numpy(start_noise).to(kwargs.get('device', self.device))
        try:
            with torch.inference_mode():
                out = self.model.get_action(data)
        finally:
            torch.randn = randn
        return out['action_tensor'][0].float().cpu().numpy()


class Graphs:
    def __init__(self, directory):
        import onnxruntime as ort
        self.sessions = {}
        for graph in ('encoder', 'denoise'):
            with open(os.path.join(directory, f'{graph}.onnx'), 'rb') as f:
                model_bytes = f.read()
            # The weights file is handed over in memory, as the page does.
            weights = np.fromfile(os.path.join(directory, f'{graph}.weights'), dtype=np.uint8)
            options = ort.SessionOptions()
            options.log_severity_level = 3
            options.add_external_initializers_from_files_in_memory([f'{graph}.weights'], [weights], [weights.size])
            self.sessions[graph] = ort.InferenceSession(model_bytes, options, providers=['CPUExecutionProvider'])

    def act(self, pixels, start_noise):
        encoded = self.sessions['encoder'].run(None, {'pixel_values': pixels})
        names = [o.name for o in self.sessions['encoder'].get_outputs()]
        feeds = {name: value for name, value in zip(names, encoded) if name != 'vl'}
        return self.sessions['denoise'].run(None, {'noise': start_noise.astype(np.float32), **feeds})[0][0]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ckpt', required=True)
    parser.add_argument('--nitrogen-src', required=True, help='a checkout of github.com/MineDojo/NitroGen')
    parser.add_argument('--graphs', required=True, help='the float32 graphs (nitrogen_onnx.py build --variants f32)')
    parser.add_argument('--frames', required=True)
    parser.add_argument('--limit', type=int, default=8)
    args = parser.parse_args()
    started = time.time()
    with open(os.path.join(args.graphs, 'manifest.json')) as f:
        manifest = json.load(f)
    assert manifest['variant'] == 'f32', 'compare the float32 graphs'
    # The graphs' weights, converted from ng.pt as the browser does.
    for graph_name, blob in ng.convert_blobs(args.ckpt, manifest, args.graphs).items():
        assert hashlib.sha256(blob).hexdigest() == manifest['graphs'][graph_name]['weightsSha256']
        with open(os.path.join(args.graphs, manifest['graphs'][graph_name]['weights']), 'wb') as f:
            f.write(blob)
    frames = load_frames(args.frames, args.limit)
    official = Official(args.nitrogen_src, args.ckpt)
    graphs = Graphs(args.graphs)
    rng = np.random.default_rng(0)
    worst = 0.0
    for name, image in frames:
        pixels = pixel_values(image)
        start_noise = rng.standard_normal((1, ng.ACTION_HORIZON, ng.ACTION_DIM)).astype(np.float32)
        difference = float(np.max(np.abs(official.act(pixels, start_noise) - graphs.act(pixels, start_noise))))
        worst = max(worst, difference)
        print(f'{name}: max |NVIDIA - graphs| = {difference:.2e}')
    ok = worst <= MAX_ABS
    print(f'{"PASS" if ok else "FAIL"}: {len(frames)} frames, NVIDIA on {official.device}, '
          f'largest difference {worst:.2e} (limit {MAX_ABS}), {time.time() - started:.0f} s')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
