#!/usr/bin/env python3
"""
nitrogen_dataset_frames.py — gameplay frames from NVIDIA's NitroGen dataset, for training
nitrogen_light_expert.py on many games rather than the few this repository can run.

The dataset (huggingface.co/datasets/nvidia/NitroGen, CC BY-NC 4.0, research and
development only) holds per-frame gamepad actions for 20-second chunks of public gameplay
videos, and each chunk's metadata names its video (a YouTube URL and time range), the game
area and the overlays (the controller overlay the actions were read from, webcams, ...).
It holds no images, so this script:

  1. reads the metadata and actions at the head of every shard (a range request each),
  2. keeps chunks with actions_processed.parquet (NVIDIA's quality filtering) and, as the
     dataset card asks, drops idle frames: a frame is kept only when the player holds a
     button or moves a stick on at least half of the frames within a second of it,
  3. downloads just those chunks' 20 seconds of video (yt-dlp, at most 480 lines),
  4. blacks out the overlays, crops the game area and resamples it to 256x256 with box
     filtering, as azahar_ai_player.js does with the 3DS top screen.

Frames go to OUT/<video id>/input_NNNN.png with frames.json (source URL, time and game of
each frame). Keep them under the ignored tmp_test: they are frames of other people's
videos, never publish them.

  python3 scripts/nitrogen/nitrogen_dataset_frames.py --cache CACHE --out tmp_test/ai_frames/nitrogen_ds
"""

import argparse
import concurrent.futures
import glob
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

import numpy as np

DATASET = 'https://huggingface.co/datasets/nvidia/NitroGen/resolve/b171bc8ed2e3c311e9305ebb993c56ef565ab509'
SHARDS = 100
BUTTONS = ('back', 'dpad_down', 'dpad_left', 'dpad_right', 'dpad_up', 'east', 'guide', 'left_shoulder',
           'left_thumb', 'left_trigger', 'north', 'right_shoulder', 'right_thumb', 'right_trigger', 'south',
           'start', 'west')
STICK_REST = 0.1        # a stick within this of the centre on both axes is at rest
FPS = 60                # chunk_size 1200 frames over 20 s


def fetch_heads(cache, head_bytes):
    """The metadata and actions of the chunks in the first `head_bytes` of every shard."""
    for shard in range(SHARDS):
        target = os.path.join(cache, f'SHARD_{shard:04d}')
        if os.path.isdir(target):
            continue
        request = urllib.request.Request(f'{DATASET}/actions/SHARD_{shard:04d}.tar.gz',
                                         headers={'Range': f'bytes=0-{head_bytes - 1}'})
        with urllib.request.urlopen(request) as response:
            data = response.read()
        partial = target + '.partial'
        os.makedirs(partial, exist_ok=True)
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r|gz') as archive:
                for member in archive:
                    if member.isfile() and os.path.basename(member.name) in (
                            'metadata.json', 'actions_processed.parquet'):
                        # Only these two files, written under their chunk's name.
                        chunk = os.path.basename(os.path.dirname(member.name))
                        os.makedirs(os.path.join(partial, chunk), exist_ok=True)
                        with open(os.path.join(partial, chunk, os.path.basename(member.name)), 'wb') as f:
                            f.write(archive.extractfile(member).read())
        except (tarfile.ReadError, EOFError, OSError):
            pass                                                # the range ends inside a file
        os.rename(partial, target)
        print(f'  shard {shard}: {len(os.listdir(target))} chunks', flush=True)


def chunks_in(cache):
    """Every complete chunk: (video id, chunk id, metadata, actions file), by video."""
    videos = {}
    for path in sorted(glob.glob(os.path.join(cache, 'SHARD_*', '*', 'actions_processed.parquet'))):
        try:
            with open(os.path.join(os.path.dirname(path), 'metadata.json')) as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        videos.setdefault(meta['original_video']['video_id'], []).append((meta['chunk_id'], meta, path))
    return videos


def active_frames(actions_path, count, spacing=2 * FPS):
    """Up to `count` frame indices, at least `spacing` apart, where the player is mostly
    active (holding a button or moving a stick) within a second either side."""
    import polars as pl
    df = pl.read_parquet(actions_path)
    pressed = np.zeros(len(df), dtype=bool)
    for button in BUTTONS:
        if button in df.columns:
            pressed |= df[button].to_numpy() > 0
    for stick in ('j_left', 'j_right'):
        values = np.array(df[stick].to_list(), dtype=np.float32).reshape(len(df), 2)
        pressed |= np.abs(values).max(1) > STICK_REST
    window = np.convolve(pressed.astype(np.float32), np.ones(2 * FPS + 1) / (2 * FPS + 1), mode='same')
    candidates = np.flatnonzero(window >= 0.5)
    candidates = candidates[(candidates >= FPS // 2) & (candidates < len(df) - FPS // 2)]
    picked = []
    for index in candidates[np.linspace(0, len(candidates) - 1, min(len(candidates), 4 * count)).astype(int)]:
        if all(abs(index - p) >= spacing for p in picked):
            picked.append(int(index))
    picked = picked[::max(1, len(picked) // count)][:count]
    return picked, float(pressed.mean())


def download(url, start, end, path, ffmpeg):
    if os.path.exists(path):
        return True
    result = subprocess.run([sys.executable, '-m', 'yt_dlp', '-q', '--no-warnings', '--ffmpeg-location', ffmpeg,
                             '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]', '--download-sections',
                             f'*{start}-{end}', '-o', path, url], capture_output=True, text=True)
    return result.returncode == 0 and os.path.exists(path)


def frame_at(clip, seconds, ffmpeg):
    from PIL import Image
    result = subprocess.run([ffmpeg, '-v', 'error', '-ss', f'{seconds:.3f}', '-i', clip, '-frames:v', '1',
                             '-f', 'image2pipe', '-vcodec', 'png', '-'], capture_output=True)
    if result.returncode or not result.stdout:
        return None
    return Image.open(io.BytesIO(result.stdout)).convert('RGB')


def game_view(image, meta):
    """The overlays blacked out, the game area cropped, 256x256 by box filtering."""
    from PIL import Image
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
    return Image.fromarray(pixels).resize((256, 256), Image.BOX)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cache', required=True, help='directory for the shards\' metadata, actions and clips')
    parser.add_argument('--out', required=True)
    parser.add_argument('--head-bytes', type=int, default=4_000_000, help='bytes read from the start of each shard')
    parser.add_argument('--chunks-per-video', type=int, default=3)
    parser.add_argument('--frames-per-chunk', type=int, default=4)
    parser.add_argument('--videos', type=int, help='at most this many videos (spread over the shards)')
    parser.add_argument('--exclude-games', help='leave out chunks whose game name matches this (regex), e.g. to keep '
                        'a game held out of training')
    parser.add_argument('--jobs', type=int, default=6)
    args = parser.parse_args()
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    heads = os.path.join(args.cache, 'heads')
    os.makedirs(heads, exist_ok=True)
    fetch_heads(heads, args.head_bytes)
    videos = chunks_in(heads)
    print(f'{len(videos)} videos, {sum(len(c) for c in videos.values())} chunks with processed actions', flush=True)

    if args.exclude_games:
        pattern = re.compile(args.exclude_games, re.IGNORECASE)
        videos = {video: chunks for video, chunks in videos.items()
                  if not any(pattern.search(meta.get('game') or '') for _, meta, _ in chunks)}
    names = sorted(videos)
    if args.videos:
        names = [names[i] for i in np.linspace(0, len(names) - 1, min(len(names), args.videos)).astype(int)]
    plan = []
    for video, chunks in ((name, videos[name]) for name in names):
        chunks.sort(key=lambda c: c[0])
        for _, meta, actions in [chunks[i] for i in
                                 np.linspace(0, len(chunks) - 1, min(len(chunks), args.chunks_per_video)).astype(int)]:
            frames, activity = active_frames(actions, args.frames_per_chunk)
            if frames:
                plan.append((video, meta, frames, activity))
    print(f'{len(plan)} chunks with active play, {sum(len(p[2]) for p in plan)} frames', flush=True)

    clips = os.path.join(args.cache, 'clips')
    os.makedirs(clips, exist_ok=True)

    def take(item):
        video, meta, frames, activity = item
        source = meta['original_video']
        clip = os.path.join(clips, f'{video}_{meta["chunk_id"]}.mp4')
        if not download(source['url'], source['start_time'], source['end_time'], clip, ffmpeg):
            return item, []
        return item, [(index, frame_at(clip, index / FPS, ffmpeg)) for index in frames]

    saved, failed = {}, 0
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for done, ((video, meta, _, activity), images) in enumerate(pool.map(take, plan), 1):
            images = [(index, image) for index, image in images if image is not None]
            failed += not images
            directory = os.path.join(args.out, video)
            os.makedirs(directory, exist_ok=True)
            entries = saved.setdefault(video, [])
            for index, image in images:
                name = f'{len(entries):04d}'
                game_view(image, meta).save(os.path.join(directory, f'input_{name}.png'))
                entries.append({'name': name, 'url': meta['original_video']['url'], 'game': meta['game'],
                                'chunk': meta['chunk_id'],
                                'seconds': meta['original_video']['start_time'] + index / FPS,
                                'chunkActivity': round(activity, 3)})
            if done % 25 == 0 or done == len(plan):
                print(f'  {done}/{len(plan)} chunks, {sum(len(e) for e in saved.values())} frames, '
                      f'{failed} not downloaded', flush=True)
    for video, entries in saved.items():
        if entries:
            with open(os.path.join(args.out, video, 'frames.json'), 'w') as f:
                json.dump({'dataset': DATASET, 'license': 'CC BY-NC 4.0', 'frames': entries}, f, indent=1)
    print(f'Saved {sum(len(e) for e in saved.values())} frames of {sum(1 for e in saved.values() if e)} videos '
          f'in {args.out}', flush=True)


if __name__ == '__main__':
    sys.exit(main())
