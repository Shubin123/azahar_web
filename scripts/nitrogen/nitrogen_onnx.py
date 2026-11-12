#!/usr/bin/env python3
"""
nitrogen_onnx.py — NVIDIA NitroGen as ONNX graphs for the page's AI player.

This repository never ships NVIDIA's weights. web/azahar_ai_worker.js downloads ng.pt from
huggingface.co (the revision pinned below) when the player asks for it, checks every tensor
it uses against the CRC32 recorded in the manifest, quantizes it, and lays the result out as
the manifest says. This script writes the graphs and that manifest, converts ng.pt exactly the
way the browser does (the browser's bytes must match these byte for byte), and runs the model
for nitrogen_validate.py.

The graphs are the inference path of NVIDIA's NitroGen code (github.com/MineDojo/NitroGen,
nitrogen/flow_matching_transformer) rewritten as ONNX operators, in two parts:

  encoder   pixel_values [1,3,256,256] -> the keys and values [1,16,256,64] the DiT's 4
            cross-attention blocks read from the image (SigLIP2-large, then the 4 VL
            self-attention blocks), which do not change while the actions are denoised.
  denoise   flow matching: Gaussian noise [1,18,25] -> the 18 actions, all the Euler steps
            (16 in NVIDIA's config, --steps) in one graph.

They use ONNX Runtime's fused SkipLayerNormalization (with the residual add) and FastGelu
kernels; attention is MatMul and Softmax, which WebGPU runs several times faster than
ONNX Runtime's MultiHeadAttention kernel. With --half the encoder computes in float16 (its
256-token matrix products run about 1.5 times faster on WebGPU); the denoiser stays float32.

Variants: f32 keeps every weight as float32 (to check the graphs against NVIDIA's code);
q8 and q4 store the linear layers' weights as MatMulNBits blocks of 32 with a float32 scale
each (symmetric: zero point 2^(bits-1)), and everything else as float32. With --smooth
(nitrogen_calibrate.py's activation-aware scales) a layer's input is multiplied by 1/s in
the graph and its weights' columns by s before they are quantized; s ships as smooth.bin.

  python3 scripts/nitrogen/nitrogen_onnx.py build --ckpt ng.pt --variants q8   (the page's model)
  python3 scripts/nitrogen/nitrogen_onnx.py build --ckpt ng.pt --variants f32 --out tmp_test/ai_reference
  python3 scripts/nitrogen/nitrogen_onnx.py build --ckpt ng.pt --variants q4 --smooth smooth.npz \
      [--rule '^vision_encoder=8' --name q4v8] --out DIR
  python3 scripts/nitrogen/nitrogen_onnx.py convert --ckpt ng.pt --variant q8 --out DIR
"""

import argparse
import hashlib
import json
import math
import os
import pickle
import re
import struct
import sys
import zipfile
import zlib
from collections import OrderedDict

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
DEFAULT_OUT = os.path.join(PROJECT_ROOT, 'web', 'vendor', 'nitrogen')

SOURCE = {
    'repo': 'nvidia/NitroGen',
    'revision': '584c8dded734d032f07a4bcc0ccb330e703298c4',
    'file': 'ng.pt',
    'size': 1974723762,
    'sha256': 'a266f5fb9c7dbdcdf97216558d2d82075a9a994b824cda69afa9fd3280260a81',
    'modelCard': 'https://huggingface.co/nvidia/NitroGen',
    'license': 'NVIDIA License: non-commercial research use only',
    'licenseUrl': 'https://huggingface.co/nvidia/NitroGen/blob/main/LICENSE',
    'code': 'https://github.com/MineDojo/NitroGen',
}
SOURCE['url'] = f"https://huggingface.co/{SOURCE['repo']}/resolve/{SOURCE['revision']}/{SOURCE['file']}"

# nitrogen/shared.py: the order of the model's 21 button outputs.
BUTTONS = ['BACK', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_UP', 'EAST', 'GUIDE',
           'LEFT_SHOULDER', 'LEFT_THUMB', 'LEFT_TRIGGER', 'NORTH', 'RIGHT_BOTTOM', 'RIGHT_LEFT',
           'RIGHT_RIGHT', 'RIGHT_SHOULDER', 'RIGHT_THUMB', 'RIGHT_TRIGGER', 'RIGHT_UP', 'SOUTH',
           'START', 'WEST']

HIDDEN = 1024
HEADS = 16
HEAD_DIM = 64
IMAGE_TOKENS = 256
ACTION_HORIZON = 18
ACTION_DIM = 25
INFERENCE_STEPS = 16
TIMESTEP_BUCKETS = 1000
SIGLIP_LAYERS = 24
VL_LAYERS = 4
DIT_LAYERS = 8
# interleave_self_attention: even DiT blocks attend to the image, odd ones to the actions.
CROSS_BLOCKS = [b for b in range(DIT_LAYERS) if b % 2 == 0]
BLOCK = 32
# Attention's 1/sqrt(head size), folded into the query projection (exact: a power of two).
ATTENTION_SCALE = HEAD_DIM ** -0.5
VARIANTS = {'f32': None, 'q8': 8, 'q4': 4}
WEIGHT_ALIGN = 64
# The light expert (nitrogen_light_expert.py): SigLIP-base/16's width and its layers to -2.
LIGHT_WIDTH = 768
LIGHT_LAYERS = 11
LIGHT_TOWER = {'repo': 'google/siglip-base-patch16-224', 'revision': '7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed',
               'license': 'Apache-2.0'}


# ── ng.pt ─────────────────────────────────────────────────────────────

class _Storage:
    def __init__(self, name):
        self.name = name


def _rebuild_tensor(storage, storage_offset, size, stride, *_):
    return {'storage': storage, 'offset': storage_offset, 'shape': list(size), 'stride': list(stride)}


class _CheckpointUnpickler(pickle.Unpickler):
    """Reads data.pkl without running anything from it: tensors become their storage
    references, and only the plain containers a state dict uses are built."""
    STORAGE_DTYPES = {'FloatStorage': 'float32'}

    def find_class(self, module, name):
        if (module, name) == ('torch._utils', '_rebuild_tensor_v2'):
            return _rebuild_tensor
        if (module, name) == ('collections', 'OrderedDict'):
            return OrderedDict
        if module == 'torch' and name in self.STORAGE_DTYPES:
            return _Storage(name)
        raise pickle.UnpicklingError(f'unexpected global {module}.{name}')

    def persistent_load(self, pid):
        kind, storage, key, _location, numel = pid
        assert kind == 'storage'
        return {'key': key, 'dtype': self.STORAGE_DTYPES[storage.name], 'numel': numel}


def index_checkpoint(path):
    """Where each tensor of ng.pt lies in the file, and the checkpoint's config."""
    with zipfile.ZipFile(path) as archive, open(path, 'rb') as raw:
        infos = archive.infolist()
        prefix = infos[0].filename.split('/')[0]
        entries = {}
        for info in infos:
            assert info.compress_type == zipfile.ZIP_STORED, info.filename
            raw.seek(info.header_offset)
            header = raw.read(30)
            signature, name_len, extra_len = (struct.unpack('<I', header[:4])[0],
                                              *struct.unpack('<HH', header[26:30]))
            assert signature == 0x04034b50, info.filename
            entries[info.filename] = {
                'header': info.header_offset,
                'offset': info.header_offset + 30 + name_len + extra_len,
                'length': info.file_size,
                'crc32': info.CRC,
            }
        with archive.open(f'{prefix}/data.pkl') as pkl:
            checkpoint = _CheckpointUnpickler(pkl).load()
    tensors = {}
    for name, tensor in checkpoint['model'].items():
        storage = tensor['storage']
        shape = tensor['shape']
        expected_stride = [int(np.prod(shape[i + 1:])) for i in range(len(shape))]
        assert tensor['stride'] == expected_stride, f'{name} is not contiguous'
        entry = f"{prefix}/data/{storage['key']}"
        assert storage['dtype'] == 'float32'
        tensors[name] = {
            'entry': entry,
            'offset': tensor['offset'],
            'shape': shape,
            'numel': int(np.prod(shape)),
        }
    return {'entries': entries, 'tensors': tensors, 'config': checkpoint['ckpt_config'],
            'size': os.path.getsize(path)}


def read_tensor(path, index, name):
    tensor = index['tensors'][name]
    entry = index['entries'][tensor['entry']]
    with open(path, 'rb') as raw:
        raw.seek(entry['offset'] + tensor['offset'] * 4)
        data = raw.read(tensor['numel'] * 4)
    return np.frombuffer(data, dtype='<f4').reshape(tensor['shape'])


def check_config(config):
    model = config['model_cfg']
    expected = {
        'hidden_size': HIDDEN, 'action_dim': ACTION_DIM, 'action_horizon': ACTION_HORIZON,
        'num_inference_timesteps': INFERENCE_STEPS, 'num_timestep_buckets': TIMESTEP_BUCKETS,
        'vision_encoder_name': 'google/siglip2-large-patch16-256', 'add_pos_embed': True,
    }
    for key, value in expected.items():
        assert model[key] == value, (key, model[key])
    assert model['diffusion_model_cfg']['num_layers'] == DIT_LAYERS
    assert model['diffusion_model_cfg']['interleave_self_attention'] is True
    assert model['vl_self_attention_cfg']['num_layers'] == VL_LAYERS
    assert config['tokenizer_cfg']['game_mapping_cfg'] is None
    assert config['tokenizer_cfg']['old_layout'] is False
    assert config['modality_cfg']['frame_per_sample'] == 1


# ── Quantization (web/azahar_ai_worker.js does the same arithmetic) ───

def quantize_blocks(weight, bits):
    """MatMulNBits blocks of a [N, K] float32 matrix along K: per block of BLOCK values a
    float32 scale amax / qmax (the division in float32), q = round-half-even(w / scale)
    clamped to [-2^(bits-1), qmax], stored as q + 2^(bits-1) (the default zero point)."""
    weight = np.ascontiguousarray(weight, dtype=np.float32)
    n, k = weight.shape
    blocks = weight.reshape(n, k // BLOCK, BLOCK)
    qmax = np.float32(2 ** (bits - 1) - 1)
    scale = (np.abs(blocks).max(axis=2) / qmax).astype(np.float32)
    divisor = np.where(scale == 0, np.float32(1), scale).astype(np.float32)
    q = np.rint((blocks / divisor[..., None]).astype(np.float32))
    q = np.clip(q, -qmax - 1, qmax).astype(np.int32) + 2 ** (bits - 1)
    q = q.astype(np.uint8)
    if bits == 4:
        q = q[..., 0::2] | (q[..., 1::2] << 4)
    return q.reshape(n, k // BLOCK, BLOCK * bits // 8), scale.reshape(-1)


def dequantize_blocks(packed, scale, bits, k):
    n = packed.shape[0]
    if bits == 4:
        low, high = packed & 0x0F, packed >> 4
        q = np.stack([low, high], axis=-1).reshape(n, k // BLOCK, BLOCK)
    else:
        q = packed.reshape(n, k // BLOCK, BLOCK)
    values = (q.astype(np.float32) - 2 ** (bits - 1)) * scale.reshape(n, k // BLOCK, 1)
    return values.reshape(n, k)


# ── Graph construction ────────────────────────────────────────────────

class Graph:
    def __init__(self, name, bits, smooth=None, rules=(), half=False):
        self.name = name
        self.bits = bits
        # float16 activations: every float32 initializer is cast (ONNX Runtime folds the casts
        # when the session is created), so the stored weights stay the same.
        self.half = half
        self.casts = {}
        self.rules = rules           # (module regex, bits) overriding `bits`
        self.smooth = smooth or {}   # input group -> per-channel scale s
        self.scaled_inputs = {}
        self.nodes = []
        self.constants = []
        self.weights = []   # initializers whose bytes come from ng.pt
        self.weight_names = set()
        self.count = 0
        self.const_cache = {}
        # Reshapes keep the first dimension as it is (0) rather than 1: the denoiser takes a
        # batch of noises (several draws for one image).
        self.batch = 1

    def tmp(self, base):
        self.count += 1
        return f'{base}__{self.count}'

    def op(self, op_type, inputs, domain='', name=None, outputs=1, out=None, **attrs):
        """`outputs`: how many outputs, or a list of which of them to name (None: unused)."""
        if out:
            names = [out]
        elif isinstance(outputs, int):
            names = [self.tmp(name or op_type) for _ in range(outputs)]
        else:
            names = [self.tmp(name or op_type) if wanted else '' for wanted in outputs]
        self.nodes.append(helper.make_node(op_type, inputs, names, domain=domain or None, **attrs))
        if not isinstance(outputs, int):
            return [n for n in names if n]
        return names[0] if len(names) == 1 else names

    def ms(self, op_type, inputs, **kwargs):
        return self.op(op_type, inputs, domain='com.microsoft', **kwargs)

    def const(self, array, name=None):
        array = np.asarray(array)
        key = (array.dtype.str, array.shape, array.tobytes())
        if key not in self.const_cache:
            const_name = name or f'const__{len(self.const_cache)}'
            self.constants.append(numpy_helper.from_array(array, const_name))
            self.const_cache[key] = const_name
        return self.const_cache[key]

    def param(self, name):
        """A float32 initializer in the graph's float type."""
        if not self.half:
            return name
        if name not in self.casts:
            self.casts[name] = self.op('Cast', [name], to=TensorProto.FLOAT16)
        return self.casts[name]

    def fconst(self, value, name=None):
        return self.const(np.asarray(value, np.float16 if self.half else np.float32), name)

    def weight(self, name, src, op, shape, dtype, **extra):
        if name not in self.weight_names:
            self.weight_names.add(name)
            self.weights.append({'name': name, 'src': src, 'op': op, 'shape': list(shape), 'dtype': dtype, **extra})
        return name

    def f32(self, src, shape=None, rows=None, scale=None):
        """A float32 tensor of ng.pt as it is (or its first `rows` rows), times `scale`."""
        return self.param(self.scaled(self.weight(src, src, 'f32', shape, 'float32', **({'rows': rows} if rows else {})),
                                      scale))

    def bias(self, prefix, n, transposed=False, scale=None):
        return self.f32(f'{prefix}.b' if transposed else f'{prefix}.bias', [n], scale=scale)

    def matmul(self, x, prefix, k, n, transposed=False, group=None, bias=False, scale=None):
        """x @ W^T for torch's Linear (W [n, k]), plus its bias if `bias`; `transposed`:
        NitroGen's CategorySpecificLinear, which keeps W as [1, k, n] and b as [1, n]. `group`:
        the layers reading the same input (nitrogen_calibrate.py's groups), the module itself
        by default. `scale`: a power of two the result is multiplied by, folded into the
        weights (exactly, and once, when the session is created)."""
        w_src = f'{prefix}.W' if transposed else f'{prefix}.weight'
        group = group or prefix
        bits = next((b for pattern, b in self.rules if re.match(pattern, prefix)), self.bits)
        if bits and k % BLOCK == 0:
            smooth = group if group in self.smooth else None
            if smooth:
                # One 1/s per input, shared by the group's layers.
                if (x, group) not in self.scaled_inputs:
                    inverse = (np.float32(1) / self.smooth[group]).astype(np.float32)
                    self.scaled_inputs[(x, group)] = self.op('Mul', [x, self.fconst(inverse, f'smooth_inv.{group}')])
                x = self.scaled_inputs[(x, group)]
            packed = self.weight(f'{w_src}.q{bits}', w_src, f'q{bits}',
                                 [n, k // BLOCK, BLOCK * bits // 8], 'uint8',
                                 transpose=transposed, k=k, n=n, smooth=smooth,
                                 scales=f'{w_src}.scales', scalesShape=[n * k // BLOCK])
            inputs = [x, packed, self.param(self.scaled(f'{w_src}.scales', scale))]
            if bias:
                # MatMulNBits adds the bias itself (its optional input 5).
                inputs += ['', '', self.bias(prefix, n, transposed, scale)]
            return self.ms('MatMulNBits', inputs, name='MatMulNBits', K=k, N=n, bits=bits, block_size=BLOCK,
                           accuracy_level=0)
        # torch's [n, k] becomes the [k, n] MatMul takes; CategorySpecificLinear's already is.
        w = self.weight(f'{w_src}.kn', w_src, 'f32' if transposed else 'f32T', [k, n], 'float32')
        y = self.op('MatMul', [x, self.param(self.scaled(w, scale))])
        return self.op('Add', [y, self.bias(prefix, n, transposed, scale)]) if bias else y

    def scaled(self, value, scale):
        """A float32 initializer times `scale`, before any cast to float16: ONNX Runtime
        folds it when the session is created (it has no float16 CPU kernels to fold with)."""
        return self.op('Mul', [value, self.const(np.float32(scale))]) if scale else value

    def linear(self, x, prefix, k, n, transposed=False, group=None, scale=None):
        return self.matmul(x, prefix, k, n, transposed, group, bias=True, scale=scale)

    def norm_params(self, prefix, width=HIDDEN):
        """A LayerNorm's scale and shift: a module's, (scale, shift) tensors, or none."""
        if isinstance(prefix, tuple):
            return prefix
        if prefix:
            return self.f32(f'{prefix}.weight', [width]), self.f32(f'{prefix}.bias', [width])
        return self.fconst(np.ones(width), f'ones_{width}'), self.fconst(np.zeros(width), f'zeros_{width}')

    def layer_norm(self, x, eps, prefix=None, width=HIDDEN):
        return self.op('LayerNormalization', [x, *self.norm_params(prefix, width)], axis=-1, epsilon=eps)

    def skip_layer_norm(self, x, skip, bias, eps, prefix=None, width=HIDDEN):
        """LayerNorm(x + skip + bias) and that sum (the residual stream), in one kernel."""
        gamma, beta = self.norm_params(prefix, width)
        return self.ms('SkipLayerNormalization', [x, skip, gamma, beta, bias], outputs=[True, False, False, True],
                       epsilon=eps)

    def attention(self, q, k_t, v, width=HIDDEN):
        """Multi-head attention of q [1, S, width] (already multiplied by 1/sqrt(64), see
        ATTENTION_SCALE) over keys k_t [1, heads, 64, L] and values v [1, heads, L, 64]. (As
        MatMul and Softmax it is several times faster on WebGPU than ONNX Runtime's
        MultiHeadAttention kernel.)"""
        probs = self.op('Softmax', [self.op('MatMul', [self.heads(q, width=width), k_t])], axis=-1)
        out = self.op('Transpose', [self.op('MatMul', [probs, v])], perm=[0, 2, 1, 3])
        return self.op('Reshape', [out, self.const(np.array([self.batch, -1, width], np.int64))])

    def self_attention(self, h, prefix, names, group, width=HIDDEN):
        """Attention of h over itself, with the q, k and v projections `names` under `prefix`."""
        q, k, v = (self.linear(h, f'{prefix}.{name}', width, width, group=group, scale=scale)
                   for name, scale in zip(names, (ATTENTION_SCALE, None, None)))
        return self.attention(q, self.keys_t(k, width=width), self.heads(v, width=width), width)

    def heads(self, x, out=None, width=HIDDEN):
        """[1, S, width] -> [1, width / 64, S, 64]"""
        x = self.op('Reshape', [x, self.const(np.array([self.batch, -1, width // HEAD_DIM, HEAD_DIM], np.int64))])
        return self.op('Transpose', [x], perm=[0, 2, 1, 3], out=out)

    def keys_t(self, x, out=None, width=HIDDEN):
        """[1, S, width] -> [1, width / 64, 64, S]"""
        x = self.op('Reshape', [x, self.const(np.array([self.batch, -1, width // HEAD_DIM, HEAD_DIM], np.int64))])
        return self.op('Transpose', [x], perm=[0, 2, 3, 1], out=out)

    def silu(self, x):
        return self.op('Mul', [x, self.op('Sigmoid', [x])])

    def model(self, inputs, outputs):
        graph = helper.make_graph(self.nodes, self.name, inputs, outputs, self.constants)
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17),
                                                        helper.make_opsetid('com.microsoft', 1)],
                                  producer_name='azahar_web nitrogen_onnx.py')
        model.ir_version = 9
        return model


def transformer_blocks(g, x, blocks, eps, attend, last, width=HIDDEN):
    """Pre-norm transformer blocks (SigLIP's encoder layers, diffusers' BasicTransformerBlock)
    with each residual add folded into the next LayerNorm. blocks: per block, its norms
    (norm1, norm2: module names, (scale, shift) tensors, or None) and the module names of
    its attention output (out) and feed-forward (fc1, fc2). `attend(h, block)` gives the
    attention's output before its output projection. `last(down, sum, bias)` turns the
    final residual stream (as SkipLayerNorm's operands) into the result."""
    h = g.layer_norm(x, eps, blocks[0]['norm1'], width)
    for index, block in enumerate(blocks):
        out = block['out']
        attended = g.matmul(attend(h, index), out, width, width)
        h, x = g.skip_layer_norm(attended, x, g.bias(out, width), eps, block['norm2'], width)
        h = g.ms('FastGelu', [g.matmul(h, block['fc1'], width, 4 * width), g.bias(block['fc1'], 4 * width)])
        down = g.matmul(h, block['fc2'], 4 * width, width)
        if index + 1 < len(blocks):
            h, x = g.skip_layer_norm(down, x, g.bias(block['fc2'], width), eps, blocks[index + 1]['norm1'], width)
        else:
            return last(down, x, g.bias(block['fc2'], width))


def build_encoder(bits, smooth=None, rules=(), half=False, image_size=256):
    """`image_size` below the 256 SigLIP2 was trained at gives fewer image tokens, with its
    16x16 grid of position embeddings resized bicubically, as Hugging Face's
    interpolate_pos_encoding does."""
    g = Graph('nitrogen_encoder', bits, smooth, rules, half)
    side = image_size // 16
    tokens = side * side
    pixels = 'pixel_values'
    # SiglipVisionEmbeddings: a 16x16/16 convolution, then learned position embeddings.
    conv_w = g.f32('vision_encoder.embeddings.patch_embedding.weight', [HIDDEN, 3, 16, 16])
    conv_b = g.f32('vision_encoder.embeddings.patch_embedding.bias', [HIDDEN])
    x = g.op('Cast', [pixels], to=TensorProto.FLOAT16) if half else pixels
    x = g.op('Conv', [x, conv_w, conv_b], kernel_shape=[16, 16], strides=[16, 16])
    x = g.op('Reshape', [x, g.const(np.array([1, HIDDEN, tokens], np.int64))])
    x = g.op('Transpose', [x], perm=[0, 2, 1])
    src = 'vision_encoder.embeddings.position_embedding.weight'
    positions = g.weight(src, src, 'f32', [IMAGE_TOKENS, HIDDEN], 'float32')
    if tokens != IMAGE_TOKENS:
        # In float32, before any cast: ONNX Runtime folds it when the session is created.
        grid = g.op('Transpose', [g.op('Reshape', [positions, g.const(np.array([1, 16, 16, HIDDEN], np.int64))])],
                    perm=[0, 3, 1, 2])
        grid = g.op('Resize', [grid, '', '', g.const(np.array([1, HIDDEN, side, side], np.int64))], mode='cubic',
                    cubic_coeff_a=-0.75, coordinate_transformation_mode='half_pixel')
        positions = g.op('Reshape', [g.op('Transpose', [grid], perm=[0, 2, 3, 1]),
                                     g.const(np.array([tokens, HIDDEN], np.int64))])
    x = g.op('Add', [x, g.param(positions)])

    # SigLIP2's 24 encoder layers, then its post-LayerNorm (eps 1e-6).
    siglip = [f'vision_encoder.encoder.layers.{layer}' for layer in range(SIGLIP_LAYERS)]
    blocks = [{'norm1': f'{p}.layer_norm1', 'out': f'{p}.self_attn.out_proj', 'norm2': f'{p}.layer_norm2',
               'fc1': f'{p}.mlp.fc1', 'fc2': f'{p}.mlp.fc2'} for p in siglip]
    vision = transformer_blocks(
        g, x, blocks, 1e-6,
        attending(g, [(f'{p}.self_attn', ('q_proj', 'k_proj', 'v_proj')) for p in siglip]),
        lambda down, x, bias: g.skip_layer_norm(down, x, bias, 1e-6, 'vision_encoder.post_layernorm')[0])
    outputs = encoder_tail(g, vision, tokens, half)
    inputs = [helper.make_tensor_value_info(pixels, TensorProto.FLOAT, [1, 3, image_size, image_size])]
    return g, g.model(inputs, outputs)


def attending(g, names, width=HIDDEN):
    """transformer_blocks' `attend` for self-attention blocks: per block, (module, its q, k
    and v projections' names)."""
    def attend(h, index):
        p, qkv = names[index]
        return g.self_attention(h, p, qkv, f'{p}.qkv', width)
    return attend


def encoder_tail(g, vision, tokens, half):
    """From image features [1, tokens, 1024]: NitroGen's 4 VL self-attention blocks, then the
    keys and values its DiT's cross-attention blocks read (the encoder graphs' outputs)."""
    # The 4 VL self-attention blocks (diffusers BasicTransformerBlock, affine LayerNorms).
    mixing = [f'vl_self_attention_model.transformer_blocks.{layer}' for layer in range(VL_LAYERS)]
    blocks = [{'norm1': f'{p}.norm1', 'out': f'{p}.attn1.to_out.0', 'norm2': f'{p}.norm3',
               'fc1': f'{p}.ff.net.0.proj', 'fc2': f'{p}.ff.net.2'} for p in mixing]
    vl = transformer_blocks(
        g, vision, blocks, 1e-5,
        attending(g, [(f'{p}.attn1', ('to_q', 'to_k', 'to_v')) for p in mixing]),
        lambda down, x, bias: g.op('Add', [g.op('Add', [down, bias]), x]))
    outputs = []
    # What the DiT's cross-attention blocks read from vl, already split into heads (the keys
    # transposed), in float32 for the denoiser.
    to_float = (lambda x, name: g.op('Cast', [x], to=TensorProto.FLOAT, out=name)) if half else \
        (lambda x, name: g.op('Identity', [x], out=name))
    for block in CROSS_BLOCKS:
        p = f'model.transformer_blocks.{block}.attn1'
        to_float(g.keys_t(g.linear(vl, f'{p}.to_k', HIDDEN, HIDDEN, group='vl.cross_kv')), f'k{block}')
        to_float(g.heads(g.linear(vl, f'{p}.to_v', HIDDEN, HIDDEN, group='vl.cross_kv')), f'v{block}')
        outputs += [helper.make_tensor_value_info(f'k{block}', TensorProto.FLOAT, [1, HEADS, HEAD_DIM, tokens]),
                    helper.make_tensor_value_info(f'v{block}', TensorProto.FLOAT, [1, HEADS, tokens, HEAD_DIM])]
    return outputs


def build_light(bits, half):
    """The light expert (nitrogen_light_expert.py): SigLIP-base/16 at 256 px to layer -2,
    the adapter into NitroGen's image feature space, then NitroGen's own VL blocks and cross
    keys and values (encoder_tail), and the gate: the predicted error of these actions, from
    the tower's tokens. Its own weights are named light:... (light_tensors)."""
    g = Graph('nitrogen_light_encoder', bits, half=half)
    width = LIGHT_WIDTH
    pixels = 'pixel_values'
    conv_w = g.f32('light:tower.patch_embedding.weight', [width, 3, 16, 16])
    conv_b = g.f32('light:tower.patch_embedding.bias', [width])
    x = g.op('Cast', [pixels], to=TensorProto.FLOAT16) if half else pixels
    x = g.op('Conv', [x, conv_w, conv_b], kernel_shape=[16, 16], strides=[16, 16])
    x = g.op('Transpose', [g.op('Reshape', [x, g.const(np.array([1, width, IMAGE_TOKENS], np.int64))])],
             perm=[0, 2, 1])
    x = g.op('Add', [x, g.f32('light:tower.position_embedding.256', [IMAGE_TOKENS, width])])
    layers = [f'light:tower.layers.{layer}' for layer in range(LIGHT_LAYERS)]
    blocks = [{'norm1': f'{p}.layer_norm1', 'out': f'{p}.self_attn.out_proj', 'norm2': f'{p}.layer_norm2',
               'fc1': f'{p}.mlp.fc1', 'fc2': f'{p}.mlp.fc2'} for p in layers]
    tokens = transformer_blocks(
        g, x, blocks, 1e-6, attending(g, [(f'{p}.self_attn', ('q_proj', 'k_proj', 'v_proj')) for p in layers], width),
        lambda down, x, bias: g.op('Add', [g.op('Add', [down, bias]), x]), width)
    # The adapter: Laya-Vision's projector (LayerNorm, Linear), 2 pre-norm blocks, a LayerNorm.
    h = g.linear(g.layer_norm(tokens, 1e-5, 'light:adapter.norm_in', width), 'light:adapter.proj', width, HIDDEN)
    adapter = [f'light:adapter.blocks.{block}' for block in range(2)]
    blocks = [{'norm1': f'{p}.norm1', 'out': f'{p}.out', 'norm2': f'{p}.norm2', 'fc1': f'{p}.fc1', 'fc2': f'{p}.fc2'}
              for p in adapter]
    vision = transformer_blocks(
        g, h, blocks, 1e-6, attending(g, [(p, ('q', 'k', 'v')) for p in adapter]),
        lambda down, x, bias: g.skip_layer_norm(down, x, bias, 1e-6, 'light:adapter.norm_out')[0])
    outputs = encoder_tail(g, vision, IMAGE_TOKENS, half)

    # The gate, in float32 throughout: the tokens' mean and (unbiased) spread over the image,
    # a LayerNorm, Linear, exact GELU, Linear.
    raw = lambda src, shape, op='f32': g.weight(src if op == 'f32' else f'{src}.kn', src, op, shape, 'float32')
    t = g.op('Cast', [tokens], to=TensorProto.FLOAT) if half else tokens
    mean = g.op('ReduceMean', [t], axes=[1], keepdims=1)
    spread = g.op('ReduceSum', [g.op('Mul', [g.op('Sub', [t, mean])] * 2), g.const(np.array([1], np.int64))],
                  keepdims=0)
    spread = g.op('Sqrt', [g.op('Mul', [spread, g.const(np.float32(1 / (IMAGE_TOKENS - 1)))])])
    pooled = g.op('Concat', [g.op('Squeeze', [mean, g.const(np.array([1], np.int64))]), spread], axis=-1)
    h = g.op('LayerNormalization', [pooled, raw('light:gate.norm.weight', [2 * width]),
                                    raw('light:gate.norm.bias', [2 * width])], axis=-1, epsilon=1e-5)
    h = g.op('Add', [g.op('MatMul', [h, raw('light:gate.fc1.weight', [2 * width, 256], 'f32T')]),
                     raw('light:gate.fc1.bias', [256])])
    h = g.op('Mul', [g.op('Mul', [h, g.const(np.float32(0.5))]),
                     g.op('Add', [g.op('Erf', [g.op('Mul', [h, g.const(np.float32(2 ** -0.5))])]),
                                  g.const(np.float32(1))])])
    g.op('Add', [g.op('MatMul', [h, raw('light:gate.fc2.weight', [256, 1], 'f32T')]),
                 raw('light:gate.fc2.bias', [1])], out='gate')
    outputs.append(helper.make_tensor_value_info('gate', TensorProto.FLOAT, [1, 1]))
    inputs = [helper.make_tensor_value_info(pixels, TensorProto.FLOAT, [1, 3, 256, 256])]
    return g, g.model(inputs, outputs)


def timestep_constants(steps=INFERENCE_STEPS):
    """Per denoising step, the two sinusoidal encodings of its timestep, computed with the
    torch operations NVIDIA's code uses: the action encoder's [sin, cos] (1024) and the DiT
    timestep embedding's input (diffusers get_timestep_embedding, 256 channels,
    flip_sin_to_cos, downscale_freq_shift 1)."""
    import torch
    half = HIDDEN // 2
    action_freqs = (-torch.arange(half, dtype=torch.float) * (torch.log(torch.tensor(10000.0)) / half)).exp()
    exponent = -math.log(10000) * torch.arange(start=0, end=128, dtype=torch.float32) / (128 - 1)
    time_freqs = torch.exp(exponent)
    constants = []
    for t in timesteps(steps):
        tau = torch.tensor([float(t)]).unsqueeze(-1) * action_freqs
        tau = torch.cat([torch.sin(tau), torch.cos(tau)], dim=-1)
        proj = torch.tensor([t])[:, None].float() * time_freqs[None, :]
        proj = torch.cat([torch.sin(proj), torch.cos(proj)], dim=-1)
        proj = torch.cat([proj[:, 128:], proj[:, :128]], dim=-1)
        constants.append((tau.numpy().astype(np.float32), proj.numpy().astype(np.float32)))
    return constants


# The layers fed only by the timestep stay float32: ONNX Runtime folds them into constants
# when the session is created, which it does not do for MatMulNBits.
TIMESTEP_ONLY = [(r'model\.timestep_encoder\.', 0), (r'model\.transformer_blocks\.\d+\.norm1\.linear$', 0),
                 (r'model\.proj_out_1$', 0)]


def build_denoise(bits, smooth=None, rules=(), steps=INFERENCE_STEPS, image_size=256):
    """All `steps` Euler steps of NitroGen.get_action from `noise` to the actions (NVIDIA's
    config takes 16; GR00T's flow-matching action head, which NitroGen's follows, takes 4).
    Everything that depends only on the step's timestep (its encodings, the DiT's timestep
    embedding and each block's AdaLayerNorm scale and shift) has constant inputs, so ONNX
    Runtime computes it once when the session is created. `noise` is a batch: several draws
    for the same image (their actions differ), in one run."""
    g = Graph('nitrogen_denoise', bits, smooth, TIMESTEP_ONLY + list(rules))
    g.batch = 0
    actions = 'noise'
    one = g.fconst(1.0, 'one')

    def split(y):
        return g.op('Split', [y, g.const(np.array([HIDDEN, HIDDEN], np.int64))], axis=-1, outputs=2)

    flat = g.const(np.array([HIDDEN], np.int64))

    def modulation(scale, shift):
        """x * (1 + scale) + shift, as AdaLayerNorm and the DiT's output apply them to a
        LayerNorm without affine parameters: that LayerNorm's own scale and shift."""
        return (g.op('Reshape', [g.op('Add', [scale, one]), flat]), g.op('Reshape', [shift, flat]))

    dit = [f'model.transformer_blocks.{block}' for block in range(DIT_LAYERS)]
    # ONNX Runtime's graph capture (azahar_ai_worker.js) cannot replay a batched MatMul that
    # reads a graph input directly, so the image's keys and values are copied once.
    image = {name: g.op('Add', [name, g.fconst(0.0)]) for block in CROSS_BLOCKS for name in (f'k{block}', f'v{block}')}
    for step, (tau, proj) in enumerate(timestep_constants(steps)):
        # MultiEmbodimentActionEncoder (embodiment 0)
        a = g.linear(actions, 'action_encoder.W1', ACTION_DIM, HIDDEN, transposed=True)
        tau = g.const(np.broadcast_to(tau[:, None, :], (1, ACTION_HORIZON, HIDDEN)).copy(), f'tau.{step}')
        x = g.op('Concat', [a, g.op('Expand', [tau, g.op('Shape', [a])])], axis=-1)
        x = g.silu(g.linear(x, 'action_encoder.W2', 2 * HIDDEN, HIDDEN, transposed=True))
        x = g.linear(x, 'action_encoder.W3', HIDDEN, HIDDEN, transposed=True)
        # The 18 action tokens' learned positions (the table has 1024 rows).
        x = g.op('Add', [x, g.f32('position_embedding.weight', [ACTION_HORIZON, HIDDEN], rows=ACTION_HORIZON)])
        # DiT timestep embedding (TimestepEmbedding: linear, SiLU, linear), SiLU'd for the norms.
        temb = g.linear(g.const(proj, f'time_proj.{step}'), 'model.timestep_encoder.timestep_embedder.linear_1', 256, HIDDEN)
        temb = g.silu(g.linear(g.silu(temb), 'model.timestep_encoder.timestep_embedder.linear_2', HIDDEN, HIDDEN))
        blocks = []
        for p in dit:
            # AdaLayerNorm: scale first, then shift. The feed-forward's norm has no modulation.
            scale, shift = split(g.linear(temb, f'{p}.norm1.linear', HIDDEN, 2 * HIDDEN, group='temb_act'))
            blocks.append({'norm1': modulation(scale, shift), 'out': f'{p}.attn1.to_out.0',
                           'norm2': None, 'fc1': f'{p}.ff.net.0.proj', 'fc2': f'{p}.ff.net.2'})

        def attend(h, index):
            p = dit[index]
            group = f'{p}.attn1.qkv'
            if index in CROSS_BLOCKS:
                # interleave_self_attention: even blocks attend to the image's keys/values.
                q = g.linear(h, f'{p}.attn1.to_q', HIDDEN, HIDDEN, group=group, scale=ATTENTION_SCALE)
                return g.attention(q, image[f'k{index}'], image[f'v{index}'])
            return g.self_attention(h, f'{p}.attn1', ('to_q', 'to_k', 'to_v'), group)

        # DiT output: norm_out (eps 1e-6) with shift first, then scale; proj_out_2.
        shift, scale = split(g.linear(temb, 'model.proj_out_1', HIDDEN, 2 * HIDDEN, group='temb_act'))
        x = transformer_blocks(
            g, x, blocks, 1e-5, attend,
            lambda down, x, bias: g.skip_layer_norm(down, x, bias, 1e-6, modulation(scale, shift))[0])
        x = g.linear(x, 'model.proj_out_2', HIDDEN, HIDDEN)
        # CategorySpecificMLP action decoder: the velocity; then the Euler step.
        # ReLU as Max(x, 0): the same values, and graph capture can replay it (not Relu).
        x = g.op('Max', [g.linear(x, 'action_decoder.layer1', HIDDEN, HIDDEN, transposed=True), g.fconst(0.0)])
        # The velocity times the step size, folded into the last layer (exactly, for a power of two).
        step_velocity = g.linear(x, 'action_decoder.layer2', HIDDEN, ACTION_DIM, transposed=True,
                                 scale=1.0 / steps)
        last = step == steps - 1
        actions = g.op('Add', [actions, step_velocity], out='actions' if last else None)
    inputs = [helper.make_tensor_value_info('noise', TensorProto.FLOAT, ['draws', ACTION_HORIZON, ACTION_DIM])]
    for block in CROSS_BLOCKS:
        tokens = (image_size // 16) ** 2
        inputs += [helper.make_tensor_value_info(f'k{block}', TensorProto.FLOAT, [1, HEADS, HEAD_DIM, tokens]),
                   helper.make_tensor_value_info(f'v{block}', TensorProto.FLOAT, [1, HEADS, tokens, HEAD_DIM])]
    outputs = [helper.make_tensor_value_info('actions', TensorProto.FLOAT, ['draws', ACTION_HORIZON, ACTION_DIM])]
    return g, g.model(inputs, outputs)


def timesteps(steps=INFERENCE_STEPS):
    """NitroGen.get_action's discretized flow times for `steps` Euler steps."""
    return [int(i / float(steps) * TIMESTEP_BUCKETS) for i in range(steps)]


# ── Weight layout and conversion ──────────────────────────────────────

def layout_weights(graph, model, index, weights_file, smooth_offsets):
    """Points the graph's ng.pt initializers at offsets in `weights_file` and returns the
    manifest's description of each (what to read from ng.pt and how to transform it)."""
    offset = 0
    specs = []
    externals = []

    def place(name, nbytes, dims, dtype):
        nonlocal offset
        offset = (offset + WEIGHT_ALIGN - 1) // WEIGHT_ALIGN * WEIGHT_ALIGN
        tensor = TensorProto(name=name, data_type=dtype, dims=dims)
        tensor.data_location = TensorProto.EXTERNAL
        for key, value in (('location', weights_file), ('offset', str(offset)), ('length', str(nbytes))):
            entry = tensor.external_data.add()
            entry.key, entry.value = key, value
        externals.append(tensor)
        placed = {'offset': offset, 'length': nbytes}
        offset += nbytes
        return placed

    for w in graph.weights:
        src = index['tensors'][w['src']]
        spec = {'name': w['name'], 'src': w['src'], 'op': w['op'], 'shape': w['shape']}
        if w['op'] in ('q4', 'q8'):
            bits = int(w['op'][1])
            n, k = w['n'], w['k']
            spec.update({'k': k, 'n': n, 'transpose': w['transpose'], 'bits': bits, 'block': BLOCK})
            if w.get('smooth'):
                spec['smooth'] = {'group': w['smooth'], **smooth_offsets[w['smooth']]}
            spec['data'] = place(w['name'], n * k * bits // 8, w['shape'], TensorProto.UINT8)
            spec['scales'] = place(w['scales'], n * (k // BLOCK) * 4, w['scalesShape'], TensorProto.FLOAT)
            spec['scalesName'] = w['scales']
            expected = [k, n] if w['transpose'] else [n, k]
            assert src['shape'][-2:] == expected and src['numel'] == n * k, (w['src'], src['shape'])
        else:
            rows = w.get('rows')
            numel = int(np.prod(w['shape']))
            if rows:
                spec['rows'] = rows
                assert src['shape'][1:] == w['shape'][1:]
            else:
                assert src['numel'] == numel, (w['src'], src['shape'], w['shape'])
            if w['op'] == 'f32T':
                assert src['shape'] == w['shape'][::-1]
            spec['data'] = place(w['name'], numel * 4, w['shape'], TensorProto.FLOAT)
        specs.append(spec)
    model.graph.initializer.extend(externals)
    return specs, offset


def convert_tensor(spec, value, smooth=None):
    """The bytes the manifest asks for, from one ng.pt tensor (as float32). `smooth`:
    the variant's smooth.bin as float32."""
    if spec['op'] in ('q4', 'q8'):
        matrix = value.reshape(-1, value.shape[-1])
        if spec['transpose']:
            matrix = matrix.T
        if spec.get('smooth'):
            start = spec['smooth']['offset'] // 4
            matrix = (matrix * smooth[None, start:start + spec['k']]).astype(np.float32)
        packed, scales = quantize_blocks(matrix, spec['bits'])
        return [(spec['data'], packed.tobytes()), (spec['scales'], scales.astype('<f4').tobytes())]
    if spec['op'] == 'f32T':
        value = value.T
    elif spec.get('rows'):
        value = value[:spec['rows']]
    else:
        value = value.reshape(spec['shape'])
    return [(spec['data'], np.ascontiguousarray(value, dtype='<f4').tobytes())]


def convert_blobs(ckpt, manifest, model_dir, index=None):
    """Each graph's weights file from ng.pt, the way the browser makes it."""
    index = index or index_checkpoint(ckpt)
    smooth = None
    if manifest.get('smooth'):
        smooth = np.fromfile(os.path.join(model_dir, manifest['smooth']['file']), dtype='<f4')
    blobs = {}
    for graph_name, graph in manifest['graphs'].items():
        blob = bytearray(graph['weightsSize'])
        for spec in graph['tensors']:
            value = read_tensor(ckpt, index, spec['src'])
            for placed, data in convert_tensor(spec, value, smooth):
                assert len(data) == placed['length'], spec['name']
                blob[placed['offset']:placed['offset'] + placed['length']] = data
        blobs[graph_name] = blob
    return blobs


def convert(ckpt, model_dir, out_dir):
    """Writes each graph's weights file from ng.pt, the way the browser does."""
    with open(os.path.join(model_dir, 'manifest.json')) as f:
        manifest = json.load(f)
    os.makedirs(out_dir, exist_ok=True)
    digests = {}
    for graph_name, blob in convert_blobs(ckpt, manifest, model_dir).items():
        with open(os.path.join(out_dir, manifest['graphs'][graph_name]['weights']), 'wb') as f:
            f.write(blob)
        digests[graph_name] = hashlib.sha256(blob).hexdigest()
    return digests


def light_tensors(light_ckpt, tower_dir):
    """The light expert's weights as float32 arrays, by their light:... names: the frozen
    tower layers from google/siglip-base-patch16-224, the trained ones, adapter and gate from
    nitrogen_light_expert.py's file."""
    import torch
    from safetensors.numpy import load_file
    tower = {k[len('vision_model.'):]: v.astype(np.float32) for k, v in
             load_file(os.path.join(tower_dir, 'model.safetensors')).items() if k.startswith('vision_model.')}
    saved = torch.load(light_ckpt, map_location='cpu', weights_only=True)
    trained = {k: v.float().numpy() for k, v in saved['light'].items()}
    tuned_from = saved.get('tuned_from', LIGHT_LAYERS)
    out = {'light:tower.patch_embedding.weight': tower['embeddings.patch_embedding.weight'],
           'light:tower.patch_embedding.bias': tower['embeddings.patch_embedding.bias']}
    # Hugging Face's interpolate_pos_encoding: the 14x14 grid, bicubic, to 16x16.
    grid = torch.from_numpy(tower['embeddings.position_embedding.weight']).reshape(1, 14, 14, LIGHT_WIDTH)
    grid = torch.nn.functional.interpolate(grid.permute(0, 3, 1, 2), size=(16, 16), mode='bicubic',
                                           align_corners=False)
    out['light:tower.position_embedding.256'] = grid.permute(0, 2, 3, 1).reshape(IMAGE_TOKENS, LIGHT_WIDTH).numpy()
    for layer in range(LIGHT_LAYERS):
        if layer >= tuned_from:
            prefix, source = f'layers.{layer - tuned_from}.', trained
        else:
            prefix, source = f'encoder.layers.{layer}.', tower
        for key, value in source.items():
            if key.startswith(prefix):
                out[f'light:tower.layers.{layer}.{key[len(prefix):]}'] = value
    for key, value in trained.items():
        if key.startswith('adapter.') and '.qkv.' not in key:
            out[f'light:{key}'] = value
        elif '.qkv.' in key:
            # Block's fused projection: queries, keys, then values (all heads each).
            block, kind = key.split('.qkv.')
            for index, name in enumerate(('q', 'k', 'v')):
                out[f'light:{block}.{name}.{kind}'] = value[index * HIDDEN:(index + 1) * HIDDEN]
    for name, index in (('norm', 0), ('fc1', 1), ('fc2', 3)):
        for kind in ('weight', 'bias'):
            out[f'light:gate.{name}.{kind}'] = saved['gate'][f'net.{index}.{kind}'].float().numpy()
    return out, saved


def gate_predictions(light_ckpt, tower_dir, frames_dir):
    """The gate's predictions on a set of frames (nitrogen_light_expert.py's modules)."""
    import torch
    sys.path.insert(0, SCRIPT_DIR)
    import nitrogen_light_expert as le
    import nitrogen_validate as nv
    device = nv.device()
    tower = le.load_tower(tower_dir, device)
    light, gate = le.LightExpert(tower).to(device).eval(), le.Gate().to(device).eval()
    saved = torch.load(light_ckpt, map_location='cpu', weights_only=True)
    light.load_state_dict(saved['light'])
    gate.load_state_dict(saved['gate'])
    predicted = []
    with torch.no_grad():
        images = le.frames_in([frames_dir])
        for start in range(0, len(images), 16):
            _, tokens = light(le.tower_front(tower, le.pixel_batch(images[start:start + 16], device)))
            predicted += gate(tokens).float().cpu().tolist()
    return np.array(predicted)


def add_light(model_dir, light_ckpt, tower_dir, gate_frames, heavy_share):
    """Writes the light expert's graph and weights next to a variant's NitroGen graphs and
    describes them in its manifest. Its NitroGen weights (the VL blocks and cross keys and
    values) are the encoder's: the graph reads them from encoder.weights, where the
    encoder's own graph does, so nothing more is converted from ng.pt."""
    with open(os.path.join(model_dir, 'manifest.json')) as f:
        manifest = json.load(f)
    assert manifest['model']['imageSize'] == 256
    bits = manifest['quantization']['bits'] if manifest['quantization'] else None
    graph, model = build_light(bits, manifest['encoderFloat'] == 'float16')
    shared = {}
    for spec in manifest['graphs']['encoder']['tensors']:
        shared[spec['name']] = spec['data']
        if 'scalesName' in spec:
            shared[spec['scalesName']] = spec['scales']
    tensors, saved = light_tensors(light_ckpt, tower_dir)
    # Two files, each under GitHub's 100 MB limit: the tower's, then the adapter's and gate's.
    files = {'light_tower.weights': bytearray(), 'light_adapter.weights': bytearray()}
    externals = []

    def external(name, location, placed, dims, dtype):
        tensor = TensorProto(name=name, data_type=dtype, dims=dims)
        tensor.data_location = TensorProto.EXTERNAL
        for key, value in (('location', location), ('offset', str(placed['offset'])),
                           ('length', str(placed['length']))):
            entry = tensor.external_data.add()
            entry.key, entry.value = key, value
        externals.append(tensor)

    def place(blob, data):
        blob.extend(b'\0' * (-len(blob) % WEIGHT_ALIGN))
        placed = {'offset': len(blob), 'length': len(data)}
        blob.extend(data)
        return placed

    for w in graph.weights:
        quantized = w['op'] in ('q4', 'q8')
        if not w['src'].startswith('light:'):
            external(w['name'], manifest['graphs']['encoder']['weights'], shared[w['name']], w['shape'],
                     TensorProto.UINT8 if quantized else TensorProto.FLOAT)
            if quantized:
                external(w['scales'], manifest['graphs']['encoder']['weights'], shared[w['scales']],
                         w['scalesShape'], TensorProto.FLOAT)
            continue
        file = 'light_tower.weights' if w['src'].startswith('light:tower.') else 'light_adapter.weights'
        value = tensors[w['src']]
        spec = {'name': w['name'], 'op': w['op'], 'shape': w['shape']}
        if quantized:
            n, k = w['n'], w['k']
            assert value.shape == (n, k), (w['src'], value.shape)
            spec.update({'k': k, 'n': n, 'transpose': False, 'bits': int(w['op'][1]), 'block': BLOCK,
                         'data': {}, 'scales': {}})
        else:
            spec['data'] = {}
        (data, packed), *scales = convert_tensor(spec, value)
        external(w['name'], file, place(files[file], packed), w['shape'],
                 TensorProto.UINT8 if quantized else TensorProto.FLOAT)
        for _, values in scales:
            external(w['scales'], file, place(files[file], values), w['scalesShape'], TensorProto.FLOAT)
    model.graph.initializer.extend(externals)
    with open(os.path.join(model_dir, 'light.onnx'), 'wb') as f:
        f.write(model.SerializeToString())
    for file, blob in files.items():
        assert len(blob) < 100e6, (file, len(blob))
        with open(os.path.join(model_dir, file), 'wb') as f:
            f.write(blob)
    predicted = gate_predictions(light_ckpt, tower_dir, gate_frames)
    quantiles = {f'{q:.2f}': float(np.quantile(predicted, q)) for q in (0.5, 0.75, 0.9, 0.95)}
    with open(light_ckpt, 'rb') as f:
        trained_sha = hashlib.sha256(f.read()).hexdigest()
    manifest['light'] = {
        'onnx': 'light.onnx', 'shares': manifest['graphs']['encoder']['weights'],
        'weights': [{'file': file, 'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}
                    for file, blob in files.items()],
        'weightsSize': sum(len(blob) for blob in files.values()),
        'tower': {**LIGHT_TOWER, 'layers': LIGHT_LAYERS, 'trainedFrom': saved.get('tuned_from')},
        'trained': {'script': 'scripts/nitrogen/nitrogen_light_expert.py', 'sha256': trained_sha,
                    'license': 'trained from NitroGen\'s outputs: NVIDIA License, non-commercial'},
        # Frames whose predicted error is above the threshold also run NitroGen's encoder.
        'gate': {'heavyShare': heavy_share, 'threshold': float(np.quantile(predicted, 1 - heavy_share)),
                 'quantiles': quantiles, 'frames': len(predicted)},
    }
    with open(os.path.join(model_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print(f'light expert: {manifest["light"]["weightsSize"] / 1e6:.1f} MB of its own weights, gate threshold '
          f'{manifest["light"]["gate"]["threshold"]:.3f} (heavy expert on {heavy_share:.0%} of {len(predicted)} frames)')


def build(ckpt, out_root, variants, smooth_path=None, rules=(), name=None, half=False, steps=INFERENCE_STEPS,
          image_size=256):
    index = index_checkpoint(ckpt)
    check_config(index['config'])
    smooth = dict(np.load(smooth_path)) if smooth_path else {}
    for variant in variants:
        bits = VARIANTS[variant]
        out_dir = os.path.join(out_root, name or variant)
        os.makedirs(out_dir, exist_ok=True)
        variant_smooth = smooth if bits else {}
        # smooth.bin: every scaled group's s, one after another.
        smooth_offsets, smooth_parts, offset = {}, [], 0
        for group in sorted(variant_smooth):
            values = variant_smooth[group].astype('<f4')
            smooth_offsets[group] = {'offset': offset, 'length': values.nbytes}
            smooth_parts.append(values.tobytes())
            offset += values.nbytes
        manifest = {
            'format': 1,
            'variant': name or variant,
            'source': SOURCE,
            'quantization': ({'method': 'MatMulNBits', 'bits': bits, 'block': BLOCK, 'symmetric': True,
                              'scale': 'float32 amax / (2^(bits-1) - 1)', 'rounding': 'half to even',
                              'rules': [{'modules': pattern, 'bits': b} for pattern, b in rules]}
                             if bits else None),
            'encoderFloat': 'float16' if half else 'float32',
            'model': {
                'imageSize': image_size, 'actionHorizon': ACTION_HORIZON, 'actionDim': ACTION_DIM,
                'inferenceSteps': steps, 'timesteps': timesteps(steps), 'buttons': BUTTONS,
                'crossBlocks': CROSS_BLOCKS, 'pixelScale': 1 / 127.5, 'pixelOffset': -1.0,
                'buttonThreshold': 0.5,
            },
            'graphs': {},
            'entries': {},
        }
        if variant_smooth:
            manifest['smooth'] = {'file': 'smooth.bin', 'size': offset, 'groups': len(smooth_offsets),
                                  'method': 'activation-aware per-channel scales (nitrogen_calibrate.py)'}
            with open(os.path.join(out_dir, 'smooth.bin'), 'wb') as f:
                f.write(b''.join(smooth_parts))
        used_entries = set()
        for graph_name, builder in (('encoder', build_encoder), ('denoise', build_denoise)):
            graph, model = builder(bits, variant_smooth, rules, half, image_size) if builder is build_encoder else \
                builder(bits, variant_smooth, rules, steps, image_size)
            weights_file = f'{graph_name}.weights'
            specs, size = layout_weights(graph, model, index, weights_file, smooth_offsets)
            onnx_file = f'{graph_name}.onnx'
            with open(os.path.join(out_dir, onnx_file), 'wb') as f:
                f.write(model.SerializeToString())
            for spec in specs:
                src = index['tensors'][spec['src']]
                spec['entry'] = src['entry']
                spec['srcOffset'] = src['offset']
                spec['srcShape'] = src['shape']
                used_entries.add(src['entry'])
            manifest['graphs'][graph_name] = {'onnx': onnx_file, 'weights': weights_file,
                                              'weightsSize': size, 'tensors': specs}
        for name in sorted(used_entries, key=lambda e: index['entries'][e]['offset']):
            manifest['entries'][name] = index['entries'][name]
        # What the browser's conversion must produce, byte for byte.
        for graph_name, blob in convert_blobs(ckpt, manifest, out_dir, index).items():
            manifest['graphs'][graph_name]['weightsSha256'] = hashlib.sha256(blob).hexdigest()
        with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
            json.dump(manifest, f, indent=1)
        sizes = {g: m['weightsSize'] for g, m in manifest['graphs'].items()}
        print(f'{variant}: {sum(sizes.values()) / 1e6:.1f} MB of weights {sizes}, '
              f'{len(used_entries)} ng.pt tensors')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('build', help='write the graphs and manifests')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--out', default=DEFAULT_OUT)
    p.add_argument('--variants', default='q8', help='comma-separated: f32,q8,q4')
    p.add_argument('--smooth', help="nitrogen_calibrate.py's scales for the quantized variants")
    p.add_argument('--rule', action='append', default=[], metavar='REGEX=BITS',
                   help='quantize the modules matching REGEX with BITS instead (repeatable)')
    p.add_argument('--name', help="the output folder and manifest variant (default: the variant's)")
    p.add_argument('--half', action='store_true', help='compute the encoder in float16')
    p.add_argument('--steps', type=int, default=INFERENCE_STEPS, help='Euler steps in the denoiser')
    p.add_argument('--image-size', type=int, default=256, help='the input image\'s side (a multiple of 16)')
    p = sub.add_parser('light', help="add nitrogen_light_expert.py's light expert to a built variant")
    p.add_argument('--model', required=True, help='the variant\'s folder (its manifest.json)')
    p.add_argument('--light', required=True, help='nitrogen_light_expert.py\'s output')
    p.add_argument('--tower', required=True, help='google/siglip-base-patch16-224 (its model.safetensors)')
    p.add_argument('--gate-frames', required=True, help='frames (input_*.png) that set the gate\'s threshold')
    p.add_argument('--heavy-share', type=float, default=0.1, help='share of such frames the heavy expert sees')
    p = sub.add_parser('convert', help="write the weights files from ng.pt as the browser does")
    p.add_argument('--ckpt', required=True)
    p.add_argument('--model', default=DEFAULT_OUT)
    p.add_argument('--variant', default='q8')
    p.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.command == 'build':
        rules = [(rule.rsplit('=', 1)[0], int(rule.rsplit('=', 1)[1])) for rule in args.rule]
        build(args.ckpt, args.out, args.variants.split(','), args.smooth, rules, args.name, args.half, args.steps,
              args.image_size)
    elif args.command == 'light':
        add_light(args.model, args.light, args.tower, args.gate_frames, args.heavy_share)
    else:
        print(json.dumps(convert(args.ckpt, os.path.join(args.model, args.variant), args.out), indent=1))


if __name__ == '__main__':
    sys.exit(main())
