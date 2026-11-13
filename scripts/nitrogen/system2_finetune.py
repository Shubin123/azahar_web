#!/usr/bin/env python3
"""
system2_finetune.py — fine-tunes the planner (System 2, web/azahar_ai_planner.js) for game
instructions: Liquid AI's LFM2.5-VL-450M (LFM Open License v1.0), with LoRA on the linear
layers of its language model, learns to answer the browser planner's own questions about a
game screen and the player's notes (is a menu waiting, which way to head, which button to
press) as human players acted (system2_dataset.py's samples of NVIDIA's NitroGen dataset).

The notes it trains on are what the widget's notes hold in play: nothing, the game's name,
the name with a task for the next seconds (what the player then did: so a task in the notes
is followed), or the name with a vague aim. The prompt is the worker's
(azahar_ai_planner_worker.js: its system text, notes line and numbered questions) and the
answer its numbered list, so the browser asks the fine-tuned model exactly as it asks the
original. The vision tower, the projector, the embeddings and the norms stay as they are:
only the decoder's linear layers change, so the browser runs the ONNX model it already
downloads with a decoder graph that adds each layer's LoRA branch (export).

  eval    how often each answer matches what the player did, on --split (test: games held
          out), for the original model (--lora omitted) or a fine-tuned one
  train   LoRA fine-tuning (--out DIR)
  export  the fine-tuned decoder graph for the browser: the ONNX decoder's graph with each
          changed layer's LoRA branch beside it (its 4-bit weights stay in the original file)

  python3 scripts/nitrogen/system2_finetune.py train --data tmp_test/system2/ds --out CKPT
  python3 scripts/nitrogen/system2_finetune.py eval --data tmp_test/system2/ds [--lora CKPT]
"""

import argparse
import functools
import json
import math
import os
import random
import re
import time

import numpy as np
import torch

MODEL = 'LiquidAI/LFM2.5-VL-450M'
REVISION = 'fc6221ca597f3315e4f82fc2df606783267b34ba'
# The browser's ONNX build of it (web/azahar_ai_planner_worker.js pins the same).
ONNX_REVISION = '24e63007ff1aaafbde27c89eb01a0513f4f61482'

# The worker's prompt (web/azahar_ai_planner_worker.js), word for word.
SYSTEM = ('You plan for an AI playing a Nintendo 3DS game. The image shows the top screen (400x240) above '
          'the bottom touch screen (320x240, centred below it). A fast reflex model presses the buttons moment to '
          'moment; every few seconds you look and set its course.')
QUESTIONS = [
    'Is a menu, a dialogue box or a button on the bottom screen waiting for the player? (yes or no)',
    'Which way should the player move now to make progress? (left, right, up, down or none)',
    'Which one button should the player press now? (A, B, X, Y or none)',
]
GOAL_QUESTION = 'In five words or fewer, what should the player do next?'
MOVES = ['up', 'down', 'left', 'right', 'none']
PRESSES = ['A', 'B', 'X', 'Y', 'none']


def prompt(notes, with_goal):
    questions = QUESTIONS + ([GOAL_QUESTION] if with_goal else [])
    return (f'Notes from the player (quest log, task at hand, manual): {notes.strip() or "none"}\n'
            'Answer each question in a word or two, as a numbered list.\n' +
            '\n'.join(f'{i + 1}. {text}' for i, text in enumerate(questions)))


# ── Notes and answers ────────────────────────────────────────────

HEADINGS = {
    'right': ['Head right.', 'Go right.', 'Keep moving right.', 'Make your way to the right.'],
    'left': ['Head left.', 'Go left.', 'Keep moving left.', 'Go back to the left.'],
    'up': ['Go up.', 'Head up the screen.', 'Move forward.', 'Go north.'],
    'down': ['Go down.', 'Head down the screen.', 'Come back down.', 'Go south.'],
    'none': ['Stay where you are.', 'Hold your position.', 'No need to move.'],
}
BUTTON_TASKS = ['Use {b}.', 'Press {b} a lot here.', '{b} is the button to use now.', 'Keep pressing {b}.']
MENU_TASKS = ['A menu or a dialogue is open: work through it.', 'Read the text and confirm.', 'Choose in the menu.']
AIMS = ['Make progress.', 'Keep going.', 'Explore the area.', 'Reach the next area.', 'Play well.']
GOALS = {'right': 'head right', 'left': 'head left', 'up': 'go up', 'down': 'go down', 'none': 'hold position'}


def game_name(sample, titles):
    game = sample['game']
    if game and game not in ('other', 'unknown') and not re.fullmatch(r'game_\d+|_untitled.*|inscreva.*', game):
        return game.replace('__', ': ').replace('_', ' ').strip().title()
    return titles.get(sample['video'], '').strip()


def notes_for(sample, titles, rng, kind=None):
    """Notes as the widget might hold them, and which kind: none, game, task, aim."""
    name = game_name(sample, titles)
    kind = kind or rng.choices(['none', 'game', 'task', 'aim'], [0.15, 0.45, 0.25, 0.15])[0]
    game = f'Game: {name}.' if name else ''
    if kind == 'none' or (kind == 'game' and not game):
        return '', 'none'
    if kind == 'game':
        return game, kind
    if kind == 'aim':
        return f'{game} {rng.choice(AIMS)}'.strip(), kind
    parts = []
    if sample['menu'] == 'yes':
        parts.append(rng.choice(MENU_TASKS))
    if sample['move'] != 'none' or rng.random() < 0.3:
        parts.append(rng.choice(HEADINGS[sample['move']]))
    if sample['press'] != 'none':
        parts.append(rng.choice(BUTTON_TASKS).format(b=sample['press']))
    rng.shuffle(parts)
    return f'{game} Task: {" ".join(parts) or rng.choice(AIMS)}'.strip(), kind


# Instructions a game shows on screen (a tip on the bottom screen, a dialogue box on the top
# one): drawn onto a frame, they decide the answer, so the planner learns to read and follow
# them. A dialogue's "to continue" or "to talk" is a dialogue waiting: a menu.
SCREEN_PRESS = ['Press {b} to {verb}!', 'Use {b} to {verb}.', '{b}: {verb}', 'Press {b} to {verb}']
SCREEN_VERBS = ['jump', 'attack', 'dash', 'shoot', 'open the door', 'pick it up', 'continue', 'talk']
SCREEN_MOVE = ['Go {d}!', 'Head {d} to the exit.', 'Move {d} to continue.', 'The goal is {d}.']
SCREEN_WORDS = {'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right'}


# Other wordings and looks, never trained on (the evaluation's 'screen-new').
NEW_PRESS = ['Tap {b} to {verb}', 'Hit {b} and {verb}!', '{verb}: button {b}', 'Hold {b} to {verb}.']
NEW_VERBS = ['climb', 'swim', 'grab the ledge', 'throw', 'skip', 'read the sign']
NEW_MOVE = ['Exit: {d}', 'Keep going {d}!', 'Walk {d}.', 'Your target lies {d}.']


def on_screen(image, sample, rng, new=False):
    """`image` with an instruction drawn on it, and the sample as that instruction answers it
    (`new`: in wordings, colours, sizes and places training never shows)."""
    from PIL import ImageDraw, ImageFont
    image = image.copy()
    sample = dict(sample)
    if rng.random() < 0.6:
        button, verb = rng.choice(PRESSES[:4]), rng.choice(NEW_VERBS if new else SCREEN_VERBS)
        text = rng.choice(NEW_PRESS if new else SCREEN_PRESS).format(b=button, verb=verb)
        sample['press'] = button
        sample['menu'] = 'yes' if verb in ('continue', 'talk') else 'no'
        sample['shown'] = 'press'
    else:
        move = rng.choice(list(SCREEN_WORDS))
        text = rng.choice(NEW_MOVE if new else SCREEN_MOVE).format(d=SCREEN_WORDS[move])
        sample['move'] = move
        sample['menu'] = 'no'
        sample['shown'] = 'move'
    font = ImageFont.load_default(size=rng.choice([14, 24] if new else [16, 18, 20]))
    draw = ImageDraw.Draw(image)
    width = draw.textlength(text, font=font)
    if new:
        box = (60, 8 + rng.randrange(30), 340, 0)                       # a banner across the top
    elif rng.random() < 0.5:
        box = (40 + 12, 300 + rng.randrange(60), 360 - 12, 0)          # a tip on the bottom screen
    else:
        box = (10, 168 + rng.randrange(20), 390, 0)                     # a dialogue box on the top one
    x0, y0, x1, _ = box
    y1 = y0 + font.size + 20
    fill, ink = ((250, 240, 200), (60, 30, 10)) if new else ((20, 20, 40), (255, 255, 255))
    draw.rounded_rectangle((x0, y0, x1, y1), radius=8, fill=fill, outline=(230, 230, 230), width=2)
    draw.text(((x0 + x1 - width) / 2, y0 + 10), text, font=font, fill=ink)
    return image, sample


def answer(sample, with_goal):
    lines = [f'1. {sample["menu"]}', f'2. {sample["move"]}', f'3. {sample["press"]}']
    if with_goal:
        goal = 'work the menu' if sample['menu'] == 'yes' else GOALS[sample['move']]
        if sample['press'] != 'none' and sample['menu'] != 'yes':
            goal += f', press {sample["press"]}'
        lines.append(f'4. {goal}')
    return '\n'.join(lines)


# The worker's reading of an answer (its choice() and numbered lines).
def choice(text, allowed):
    words = re.findall(r'[a-z]+', (text or '').lower())
    found = {w for w in words if w in [a.lower() for a in allowed]}
    if len(found) != 1:
        return None
    word = found.pop()
    return next(a for a in allowed if a.lower() == word)


def read_answer(text):
    answers = {}
    for line in text.split('\n'):
        match = re.match(r'^\s*(\d+)\s*[.):-]\s*(.*)$', line)
        if match:
            answers[int(match.group(1))] = match.group(2).strip()
    return {'parsed': len(answers) >= 2, 'menu': 'yes' if choice(answers.get(1), ['yes', 'no']) == 'yes' else 'no',
            'move': choice(answers.get(2), MOVES) or 'none', 'press': choice(answers.get(3), PRESSES[:4]) or 'none'}


# ── Model ────────────────────────────────────────────────────────

def load(device, lora=None, trainable=False, rank=16):
    from transformers import AutoProcessor, AutoModelForImageTextToText
    processor = AutoProcessor.from_pretrained(MODEL, revision=REVISION)
    model = AutoModelForImageTextToText.from_pretrained(MODEL, revision=REVISION, torch_dtype=torch.float32).to(device)
    if lora:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, lora, is_trainable=trainable)
    elif trainable:
        from peft import LoraConfig, get_peft_model
        targets = sorted({name.split('.')[-1] for name, module in model.named_modules()
                          if isinstance(module, torch.nn.Linear) and '.language_model.' in name and 'lm_head' not in name})
        model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05,
                                                 target_modules=rf'.*language_model.*\.({"|".join(targets)})'))
        model.print_trainable_parameters()
    return processor, model


def chat(processor, notes, with_goal, target=None):
    messages = [{'role': 'system', 'content': [{'type': 'text', 'text': SYSTEM}]},
                {'role': 'user', 'content': [{'type': 'image'}, {'type': 'text', 'text': prompt(notes, with_goal)}]}]
    text = processor.apply_chat_template(messages, add_generation_prompt=True)
    return text if target is None else (text, target + '<|im_end|>')


def encode(processor, image, notes, with_goal, target, menu=True):
    """Input ids, labels and image inputs for one sample. Labels: the answer, or without
    `menu` the answer after its first line (whether a menu waits), which the model then keeps
    its own judgement on."""
    prefix, completion = chat(processor, notes, with_goal, target)
    full = processor(images=[image], text=prefix + completion, return_tensors='pt', add_special_tokens=False)
    first_line = '' if menu else completion[:completion.index('\n') + 1]
    start = processor(images=[image], text=prefix + first_line, return_tensors='pt',
                      add_special_tokens=False)['input_ids'].shape[1]
    labels = full['input_ids'].clone()
    labels[:, :start] = -100
    full['labels'] = labels
    return full


def collate(encoded, pad_id):
    """Samples encoded one by one, as one batch: text padded on the right; the images (all
    400x480, so the same patches) stacked."""
    length = max(e['input_ids'].shape[1] for e in encoded)
    batch = {}
    for key, fill in (('input_ids', pad_id), ('attention_mask', 0), ('labels', -100)):
        batch[key] = torch.cat([torch.nn.functional.pad(e[key], (0, length - e[key].shape[1]), value=fill)
                                for e in encoded])
    for key in encoded[0]:
        if key not in batch:
            batch[key] = torch.cat([e[key] for e in encoded])
    return batch


def samples(data, split):
    with open(os.path.join(data, 'samples.jsonl')) as f:
        rows = [json.loads(line) for line in f]
    return [r for r in rows if r['split'] == split]


def titles_of(data):
    titles = {}
    path = os.path.join(data, '..', 'titles.tsv')
    if os.path.exists(path):
        for line in open(path, encoding='utf-8'):
            video, _, title = line.rstrip('\n').replace('\\t', '\t').partition('\t')
            titles[video] = title
    return titles


# ── Commands ─────────────────────────────────────────────────────

def evaluate(args):
    from PIL import Image
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    processor, model = load(device, args.lora)
    model.eval()
    rows = samples(args.data, args.split)
    rows = random.Random(0).sample(rows, min(len(rows), args.limit))
    titles = titles_of(args.data)
    results = {}
    started = time.time()
    for kind in args.notes.split(','):
        tally = {'parsed': 0, 'menu': 0, 'move': 0, 'press': 0, 'move_set': 0, 'move_set_n': 0, 'n': 0, 'followed': 0}
        rng = random.Random(1)
        for row in rows:
            image = Image.open(os.path.join(args.data, row['image'])).convert('RGB')
            if kind.startswith('screen'):
                image, row = on_screen(image, row, rng, new=kind == 'screen-new')
            notes, _ = notes_for(row, titles, rng, 'game' if kind.startswith('screen') else kind)
            inputs = processor(images=[image], text=chat(processor, notes, False), return_tensors='pt',
                               add_special_tokens=False).to(device)
            with torch.no_grad(), torch.autocast(device, dtype=torch.float16, enabled=device == 'cuda'):
                out = model.generate(**inputs, max_new_tokens=24, do_sample=False)
            text = processor.batch_decode(out[:, inputs['input_ids'].shape[1]:], skip_special_tokens=True)[0]
            read = read_answer(text)
            tally['n'] += 1
            tally['parsed'] += read['parsed']
            for key in ('menu', 'move', 'press'):
                tally[key] += read[key] == row[key]
            if row['move'] != 'none':
                tally['move_set_n'] += 1
                tally['move_set'] += read['move'] == row['move']
            if 'shown' in row:
                tally['followed'] += read[row['shown']] == row[row['shown']]
        n = tally['n']
        results[kind] = {'samples': n, 'parsed': tally['parsed'] / n, 'menu': tally['menu'] / n,
                         'move': tally['move'] / n, 'move (when the player moved)': tally['move_set'] / max(1, tally['move_set_n']),
                         'press': tally['press'] / n, **({'on-screen instruction followed': tally['followed'] / n}
                                                          if kind.startswith('screen') else {})}
        print(f'notes {kind}: ' + ', '.join(f'{k} {v:.3f}' if isinstance(v, float) else f'{k} {v}'
                                            for k, v in results[kind].items()), flush=True)
    # What always answering the most common label would score.
    for key in ('menu', 'move', 'press'):
        common = max(set(r[key] for r in rows), key=lambda v: sum(r[key] == v for r in rows))
        print(f'  always "{common}" for {key}: {sum(r[key] == common for r in rows) / len(rows):.3f}')
    print(f'{time.time() - started:.0f} s', flush=True)
    if args.json:
        with open(args.json, 'w') as f:
            json.dump({'lora': args.lora, 'split': args.split, 'results': results}, f, indent=1)


def train(args):
    from PIL import Image
    device = 'cuda'
    processor, model = load(device, args.resume, trainable=True, rank=args.rank)
    rows = samples(args.data, 'train')
    titles = titles_of(args.data)
    if args.balance:
        # Moments where the player moved, twice: "none" is the most common heading, and a
        # model can settle on it.
        rows = rows + [row for row in rows if row['move'] != 'none']
    print(f'{len(rows)} training samples', flush=True)
    rng = random.Random(0)
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
    total = args.max_steps or args.epochs * len(rows) // args.batch
    warmup = max(1, total // 20)
    schedule = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda step: min(1.0, (step + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(1.0, step / total))))
    scaler = torch.amp.GradScaler('cuda')
    pad_id = processor.tokenizer.pad_token_id if processor.tokenizer.pad_token_id is not None else 0
    model.train()
    step, started, losses = 0, time.time(), []
    for epoch in range(args.epochs):
        order = list(range(len(rows)))
        rng.shuffle(order)
        for first in range(0, len(order) - args.batch + 1, args.batch):
            optimizer.zero_grad(set_to_none=True)
            encoded = []
            for index in order[first:first + args.batch]:
                row = rows[index]
                image = Image.open(os.path.join(args.data, row['image'])).convert('RGB')
                if rng.random() < args.on_screen:
                    image, row = on_screen(image, row, rng)
                notes, _ = notes_for(row, titles, rng)
                with_goal = rng.random() < 0.3
                encoded.append(encode(processor, image, notes, with_goal, answer(row, with_goal), menu=not args.keep_menu))
            for part in range(0, len(encoded), args.micro):
                inputs = {k: v.to(device) for k, v in collate(encoded[part:part + args.micro], pad_id).items()}
                share = inputs['labels'].shape[0] / len(encoded)
                with torch.autocast('cuda', dtype=torch.float16):
                    loss = model(**inputs).loss * share
                scaler.scale(loss).backward()
                losses.append(loss.item() / share)
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(optimizer)
            scaler.update()
            schedule.step()
            step += 1
            if step % 25 == 0 or step == total:
                print(f'  epoch {epoch + 1} step {step}/{total}: loss {np.mean(losses[-25:]):.4f} '
                      f'lr {schedule.get_last_lr()[0]:.2e} ({time.time() - started:.0f} s)', flush=True)
            if step % 500 == 0:
                model.save_pretrained(args.out)
            if step >= total:
                break
        if step >= total:
            break
    model.save_pretrained(args.out)
    print(f'saved {args.out}', flush=True)


# The language model's linear layers by their names in the ONNX decoder.
ONNX_NAMES = {'conv.in_proj': 'conv_in_proj', 'conv.out_proj': 'conv_out_proj', 'feed_forward.w1': 'mlp_gate_proj',
              'feed_forward.w3': 'mlp_up_proj', 'feed_forward.w2': 'mlp_down_proj', 'self_attn.q_proj': 'attn_q_proj',
              'self_attn.k_proj': 'attn_k_proj', 'self_attn.v_proj': 'attn_v_proj', 'self_attn.out_proj': 'attn_o_proj'}


def onnx_name(module):
    """layers.0.feed_forward.w1 -> model_layers_0_mlp_gate_proj_MatMul_weight."""
    layer, rest = re.match(r'layers\.(\d+)\.(.*)', module).groups()
    return f'model_layers_{layer}_{ONNX_NAMES[rest]}_MatMul_weight'


@functools.lru_cache(maxsize=1)
def onnx_initializers(model_path):
    import onnx
    return {t.name: t for t in onnx.load(model_path).graph.initializer}


def dequantize(model_path, name):
    """A MatMulNBits weight of the ONNX decoder (4 bits, blocks of 32 along K, zero points) as N x K."""
    from onnx import numpy_helper
    tensors = onnx_initializers(model_path)
    q = numpy_helper.to_array(tensors[name + '_quant'])            # N x blocks x 16 bytes
    scales = numpy_helper.to_array(tensors[name + '_scales']).astype(np.float32).reshape(q.shape[0], -1)
    zp = numpy_helper.to_array(tensors[name + '_zp']).reshape(q.shape[0], -1)
    low, high = q & 15, q >> 4
    values = np.stack([low, high], -1).reshape(q.shape[0], q.shape[1], 32).astype(np.float32)
    zero = np.stack([zp & 15, zp >> 4], -1).reshape(q.shape[0], -1)[:, :q.shape[1]].astype(np.float32)
    return ((values - zero[:, :, None]) * scales[:, :, None]).reshape(q.shape[0], -1)


def verify_names(onnx_path):
    """Each ONNX weight against the model's own (the right pairing: cosine near 1)."""
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open
    path = hf_hub_download(MODEL, 'model.safetensors', revision=REVISION)
    worst = 1.0
    with safe_open(path, 'pt') as f:
        for key in f.keys():
            match = re.match(r'model\.language_model\.(layers\.\d+\..*)\.weight$', key)
            if not match or match.group(1).split('.', 2)[2] not in ONNX_NAMES:
                continue
            ours = f.get_tensor(key).float().numpy()
            theirs = dequantize(onnx_path, onnx_name(match.group(1)))[:, :ours.shape[1]]
            cosine = float((ours * theirs).sum() / np.linalg.norm(ours) / np.linalg.norm(theirs))
            worst = min(worst, cosine)
            if cosine < 0.98:
                print(f'  {key} vs {onnx_name(match.group(1))}: cosine {cosine:.4f}')
    print(f'ONNX names: worst cosine {worst:.4f}', flush=True)
    return worst


def export(args):
    """The fine-tuned planner's decoder graph for the browser: the pinned q4f16 decoder's graph
    with, beside each MatMulNBits layer the LoRA changed, its low-rank branch (x A^T B^T,
    float16, its weights in the graph) added to the layer's output. Its 4-bit weights stay in
    the original .onnx_data, which the graph still names: requantizing the weights with the
    LoRA folded in loses it (its changes are far finer than 4-bit steps)."""
    import onnx
    from onnx import helper, numpy_helper
    from safetensors.torch import load_file
    if verify_names(args.onnx) < 0.98:
        raise SystemExit('the ONNX decoder\'s weights do not pair with the model\'s')
    with open(os.path.join(args.lora, 'adapter_config.json')) as f:
        config = json.load(f)
    scale = config['lora_alpha'] / config['r']
    weights = load_file(os.path.join(args.lora, 'adapter_model.safetensors'))
    lora = {}
    for key in sorted(k for k in weights if k.endswith('lora_A.weight')):
        # base_model.model.model.language_model.layers.0.conv.in_proj.lora_A.weight
        name = onnx_name(re.search(r'language_model\.(layers\.\d+\..*)\.lora_A', key).group(1))
        a = weights[key].float().numpy()                                          # r x K
        b = weights[key.replace('lora_A', 'lora_B')].float().numpy() * scale      # N x r
        lora[name] = (a.T.astype(np.float16), b.T.astype(np.float16))
    model = onnx.load(args.onnx, load_external_data=False)
    graph = model.graph
    nodes, done = [], 0
    for node in graph.node:
        nodes.append(node)
        name = node.input[1][:-len('_quant')] if node.op_type == 'MatMulNBits' else None
        if name not in lora:
            continue
        down, up = lora[name]
        assert down.shape[0] == onnx.helper.get_attribute_value(next(a for a in node.attribute if a.name == 'K'))
        output = node.output[0]
        node.output[0] = f'{output}/base'
        graph.initializer.extend([numpy_helper.from_array(down, f'{name}_lora_down'),
                                  numpy_helper.from_array(up, f'{name}_lora_up')])
        nodes += [helper.make_node('MatMul', [node.input[0], f'{name}_lora_down'], [f'{output}/lora_down'],
                                   name=f'{node.name}/lora_down'),
                  helper.make_node('MatMul', [f'{output}/lora_down', f'{name}_lora_up'], [f'{output}/lora_up'],
                                   name=f'{node.name}/lora_up'),
                  helper.make_node('Add', [f'{output}/base', f'{output}/lora_up'], [output], name=f'{node.name}/lora_add')]
        done += 1
    assert done == len(lora), (done, len(lora))
    del graph.node[:]
    graph.node.extend(nodes)
    # The original weights stay external, in decoder_model_merged_q4f16.onnx_data as before.
    onnx.save(model, args.out)
    print(f'{done} layers with their LoRA branch, {os.path.getsize(args.out) / 1e6:.1f} MB: {args.out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    e = sub.add_parser('eval')
    e.add_argument('--data', required=True)
    e.add_argument('--lora')
    e.add_argument('--split', default='test')
    e.add_argument('--limit', type=int, default=400)
    e.add_argument('--notes', default='game,task', help='kinds of notes to evaluate with (none, game, task, aim), or '
                   'screen: the game\'s name, and an instruction drawn on the frame (on_screen); screen-new: '
                   'the same in wordings and looks training never shows')
    e.add_argument('--json')
    t = sub.add_parser('train')
    t.add_argument('--data', required=True)
    t.add_argument('--out', required=True)
    t.add_argument('--resume')
    t.add_argument('--epochs', type=int, default=2)
    t.add_argument('--batch', type=int, default=16)
    t.add_argument('--micro', type=int, default=8, help='samples per forward pass')
    t.add_argument('--lr', type=float, default=2e-4)
    t.add_argument('--rank', type=int, default=16)
    t.add_argument('--max-steps', type=int, help='stop after this many steps (a quick look)')
    t.add_argument('--balance', action='store_true', help='moments where the player moved twice')
    t.add_argument('--on-screen', type=float, default=0.0,
                   help='share of frames with an instruction drawn on them (on_screen), which the answer follows')
    t.add_argument('--keep-menu', action='store_true', help='leave the menu answer out of the loss (the dataset is '
                   'gameplay: trained, the model learns to say no menu waits during play)')
    x = sub.add_parser('export')
    x.add_argument('--lora', required=True)
    x.add_argument('--out', required=True)
    x.add_argument('--onnx', '--verify-onnx', dest='onnx', required=True,
                   help='the pinned q4f16 ONNX decoder, its .onnx_data beside it (to check the names pair)')
    args = parser.parse_args()
    {'eval': evaluate, 'train': train, 'export': export}[args.command](args)


if __name__ == '__main__':
    main()
