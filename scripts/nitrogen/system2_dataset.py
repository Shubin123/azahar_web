#!/usr/bin/env python3
"""
system2_dataset.py — training data for the planner (System 2, web/azahar_ai_planner.js) from
NVIDIA's NitroGen dataset: what human players did next, at the planner's scale.

The planner looks every few seconds and sets NitroGen's course: which way to head, which
button to favour, and whether a menu or dialogue needs working instead. For moments of the
dataset's gameplay clips (nitrogen_dataset_frames.py's cache: each chunk's metadata, its
per-frame actions and its 20 seconds of video), this writes the frame as the planner sees a
3DS game (the game area, overlays blacked out, fitted into the 400x240 top screen above an
empty bottom screen) with what the player did over the next LOOK seconds:

  move   the way the player headed (left stick and d-pad on average): left, right, up, down,
         or none when neither moved much
  press  the face button pressed most (A, B, X or Y, as the planner names NitroGen's east,
         south, north and west buttons), or none
  menu   yes when the player only pressed buttons while the picture stood nearly still (a
         menu or a dialogue, most likely), else no

and the game's name (the planner is told it, and what the player wants, in its notes). Games
are split by name: those matching --test-games (and one in twelve other named games, by hash)
are held out for testing, and of the clips with no game named, one video in ten. Moments are taken only where the player is mostly active (the dataset card's
idle filtering).

Samples go to OUT/samples.jsonl and OUT/images/; frames of other people's videos: keep them
under the ignored tmp_test, never publish them.

  python3 scripts/nitrogen/system2_dataset.py --cache ~/nitrogen-data/ngds60 --out tmp_test/system2/ds
"""

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nitrogen_dataset_frames import BUTTONS, FPS, STICK_REST, chunks_in  # noqa: E402

LOOK = 3.0                  # seconds of play a label covers
MOVE_MIN = 0.2              # average heading below this on both axes: none
FACE = {'east': 'A', 'south': 'B', 'north': 'X', 'west': 'Y'}
STILL = 3.0                 # mean change (0-255) between a frame and one a second later below which the picture stands still
CHUNK_FRAMES = 20 * FPS


def held(df, name):
    return df[name].to_numpy() > 0 if name in df.columns else np.zeros(len(df), dtype=bool)


def labels(df, start, sticks):
    """What the player did from frame `start` for LOOK seconds: (move, press, moved, pressed)."""
    end = start + int(LOOK * FPS)
    x = sticks[start:end, 0].mean() + held(df, 'dpad_right')[start:end].mean() - held(df, 'dpad_left')[start:end].mean()
    y = sticks[start:end, 1].mean() + held(df, 'dpad_down')[start:end].mean() - held(df, 'dpad_up')[start:end].mean()
    move = 'none'
    if max(abs(x), abs(y)) >= MOVE_MIN:
        move = ('right' if x > 0 else 'left') if abs(x) >= abs(y) else ('down' if y > 0 else 'up')
    best, best_key = 'none', (0, 0.0)
    for name, button in FACE.items():
        pressed = held(df, name)[start:end]
        presses = int(pressed[0]) + int(np.count_nonzero(pressed[1:] & ~pressed[:-1]))
        key = (presses, float(pressed.mean()))
        if presses and (presses >= 2 or key[1] >= 0.2) and key > best_key:
            best, best_key = button, key
    moved = float(np.abs(sticks[start:end]).max(1).mean() + sum(held(df, d)[start:end].mean() for d in
                  ('dpad_up', 'dpad_down', 'dpad_left', 'dpad_right')))
    return move, best, moved, best_key[0]


def moments(df, sticks, count, spacing):
    """Up to `count` frames, `spacing` apart, where the player is mostly active within a
    second either side and LOOK seconds of the chunk follow."""
    active = np.zeros(len(df), dtype=bool)
    for button in BUTTONS:
        active |= held(df, button)
    active |= np.abs(sticks).max(1) > STICK_REST
    window = np.convolve(active.astype(np.float32), np.ones(2 * FPS + 1) / (2 * FPS + 1), mode='same')
    last = len(df) - int(LOOK * FPS) - FPS
    candidates = [i for i in np.flatnonzero(window >= 0.5) if FPS // 2 <= i < last]
    picked = []
    for i in candidates[::max(1, len(candidates) // (8 * count))]:
        if all(abs(i - p) >= spacing for p in picked):
            picked.append(int(i))
    return picked[::max(1, len(picked) // count)][:count]


def frame_at(clip, seconds, ffmpeg):
    from PIL import Image
    result = subprocess.run([ffmpeg, '-v', 'error', '-ss', f'{seconds:.3f}', '-i', clip, '-frames:v', '1',
                             '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True)
    if result.returncode or not result.stdout:
        return None
    return Image.open(io.BytesIO(result.stdout)).convert('RGB')


def game_area(image, meta):
    """The overlays blacked out and the game area cropped, at the video's resolution."""
    pixels = np.asarray(image).copy()
    height, width = pixels.shape[:2]
    source_height, source_width = meta['original_video']['resolution']
    x, y, w, h = meta.get('bbox_controller_overlay') or (0, 0, 0, 0)
    sx, sy = width / source_width, height / source_height
    pixels[int(y * sy):int(np.ceil((y + h) * sy)), int(x * sx):int(np.ceil((x + w) * sx))] = 0
    for box in meta.get('bbox_others') or []:
        pixels[int(box['ytl'] * height):int(np.ceil(box['ybr'] * height)),
               int(box['xtl'] * width):int(np.ceil(box['xbr'] * width))] = 0
    area = meta.get('bbox_game_area')
    if area:
        pixels = pixels[int(area['ytl'] * height):int(np.ceil(area['ybr'] * height)),
                        int(area['xtl'] * width):int(np.ceil(area['xbr'] * width))]
    return pixels


def planner_view(pixels):
    """The game fitted into the top screen (400x240) of the planner's 400x480 view."""
    from PIL import Image
    image = Image.fromarray(pixels)
    scale = min(400 / image.width, 240 / image.height)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    view = Image.new('RGB', (400, 480))
    view.paste(image.resize(size, Image.BOX), ((400 - size[0]) // 2, (240 - size[1]) // 2))
    return view


UNNAMED = re.compile(r'^(other|unknown|game_\d+|_untitled.*|inscreva.*)$')


def held_out(game, video, pattern):
    """Games matching `pattern` and one in twelve other named games; of the clips the dataset
    names no game for, one video in ten."""
    if pattern.search(game):
        return True
    if UNNAMED.match(game):
        return int(hashlib.sha1(video.encode()).hexdigest(), 16) % 10 == 0
    return int(hashlib.sha1(game.lower().encode()).hexdigest(), 16) % 12 == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cache', required=True, help='nitrogen_dataset_frames.py\'s cache (heads/ and clips/)')
    parser.add_argument('--out', required=True)
    parser.add_argument('--per-clip', type=int, default=6)
    parser.add_argument('--test-games', default=r'mario|pok[eé]mon',
                        help='games held out for testing (regex), besides one in twelve by hash')
    parser.add_argument('--jobs', type=int, default=6)
    parser.add_argument('--limit', type=int, help='at most this many chunks (a quick look)')
    parser.add_argument('--resplit', action='store_true', help='only split OUT/samples.jsonl again')
    args = parser.parse_args()
    if args.resplit:
        path, test_games = os.path.join(args.out, 'samples.jsonl'), re.compile(args.test_games, re.IGNORECASE)
        rows = [json.loads(line) for line in open(path)]
        for row in rows:
            row['split'] = 'test' if held_out(row['game'], row['video'], test_games) else 'train'
        with open(path, 'w') as f:
            f.writelines(json.dumps(row) + '\n' for row in rows)
        print(f'{sum(r["split"] == "test" for r in rows)} of {len(rows)} samples held out')
        return
    import imageio_ffmpeg
    import polars as pl
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    test_games = re.compile(args.test_games, re.IGNORECASE)
    clips = os.path.join(args.cache, 'clips')
    images = os.path.join(args.out, 'images')
    os.makedirs(images, exist_ok=True)
    chunks = {}
    for video, entries in chunks_in(os.path.join(args.cache, 'heads')).items():
        for chunk_id, meta, actions in entries:
            clip = os.path.join(clips, f'{video}_{chunk_id}.mp4')
            if os.path.exists(clip):
                chunks[(video, chunk_id)] = (meta, actions, clip)
    print(f'{len(chunks)} chunks with video', flush=True)
    keys = sorted(chunks)
    if args.limit:
        keys = keys[::max(1, len(keys) // args.limit)][:args.limit]

    def take(key):
        meta, actions, clip = chunks[key]
        df = pl.read_parquet(actions)
        if len(df) < CHUNK_FRAMES // 2:
            return []
        sticks = np.array(df['j_left'].to_list(), dtype=np.float32).reshape(len(df), 2)
        game = meta.get('game') or 'unknown'
        out = []
        for index in moments(df, sticks, args.per_clip, int(2.5 * FPS)):
            now, later = frame_at(clip, index / FPS, ffmpeg), frame_at(clip, (index + FPS) / FPS, ffmpeg)
            if now is None or later is None:
                continue
            area, area_later = game_area(now, meta), game_area(later, meta)
            if area.size == 0 or area.shape != area_later.shape:
                continue
            change = float(np.abs(area.astype(np.int16) - area_later.astype(np.int16)).mean())
            move, press, moved, presses = labels(df, index, sticks)
            menu = 'yes' if moved < 0.05 and presses >= 1 and change < STILL else 'no'
            name = f'{key[0]}_{key[1]}_{index:04d}.jpg'
            planner_view(area).save(os.path.join(images, name), quality=93)
            out.append({'image': f'images/{name}', 'game': game, 'video': key[0], 'chunk': key[1], 'frame': index,
                        'move': move, 'press': press, 'menu': menu, 'change': round(change, 2),
                        'split': 'test' if held_out(game, key[0], test_games) else 'train'})
        return out

    written = 0
    with open(os.path.join(args.out, 'samples.jsonl'), 'w') as f, \
            concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for done, samples in enumerate(pool.map(take, keys), 1):
            for sample in samples:
                f.write(json.dumps(sample) + '\n')
            written += len(samples)
            if done % 200 == 0 or done == len(keys):
                print(f'  {done}/{len(keys)} chunks, {written} samples', flush=True)
    print(f'Saved {written} samples in {args.out}', flush=True)


if __name__ == '__main__':
    main()
