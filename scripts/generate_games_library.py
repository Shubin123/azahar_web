#!/usr/bin/env python3
"""
generate_games_library.py

Fetches and generates the full games catalog from:
https://archive.org/metadata/3ds-decrypted-roms321com

Processes all games available under all/*.zip and extracts:
- Title, Region, Languages, File Size
- Direct 3DS download URL
- Internet Archive view_archive URL
- Internet Archive direct view_archive .3ds stream URL
Outputs to web/games_library.json.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request

METADATA_URL = "https://archive.org/metadata/3ds-decrypted-roms321com"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
OUTPUT_FILE = os.path.join(PROJECT_ROOT, "web", "games_library.json")
CACHE_FILE = os.path.join(PROJECT_ROOT, "tmp_test", "archive_metadata_cache.json")

def fetch_metadata():
    if os.path.exists(CACHE_FILE):
        print(f"Reading cached metadata from {CACHE_FILE}...")
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Cache read failed ({e}), fetching fresh metadata...")

    print(f"Fetching metadata from {METADATA_URL}...")
    req = urllib.request.Request(METADATA_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)

    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)
    print(f"Cached metadata to {CACHE_FILE}")
    return data

def parse_region(name):
    matches = re.findall(r"\(([^)]+)\)", name)
    for part in matches:
        part_clean = part.strip()
        for reg in ["USA", "Europe", "Japan", "World", "Korea", "Taiwan", "China", "Australia",
                    "Germany", "France", "Spain", "Italy", "Netherlands", "Russia"]:
            if reg in part_clean:
                return reg
    return "Other"

def parse_languages(name):
    matches = re.findall(r"\(([^)]+)\)", name)
    known = {"En", "Ja", "Fr", "De", "Es", "It", "Nl", "Pt", "Ru", "Ko", "Zh", "Sv", "No", "Da", "Fi"}
    for part in matches:
        langs = [l.strip() for l in part.split(",")]
        if any(l in known for l in langs):
            return langs
    return []

def clean_title(name):
    # Remove parentheses and brackets
    title = re.sub(r"[\(\[][^\)\]]+[\)\]]", "", name).strip()
    # Normalize multiple whitespace
    title = re.sub(r"\s+", " ", title).strip()
    return title if title else name

def format_size(bytes_val):
    if bytes_val < 1024 * 1024:
        return f"{bytes_val / 1024:.1f} KB"
    elif bytes_val < 1024 * 1024 * 1024:
        return f"{bytes_val / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_val / (1024 * 1024 * 1024):.2f} GB"

def main():
    metadata = fetch_metadata()
    files = [f for f in metadata.get("files", []) if f.get("format") == "ZIP" and f.get("name", "").startswith("all/")]
    print(f"Found {len(files)} zip files under all/.")

    games = []
    for f in files:
        zip_path = f["name"] # e.g. "all/100% Pascal Sensei - Kanpeki Paint Bombers (Japan).zip"
        zip_filename = zip_path[4:] # strip "all/"
        base_name = zip_filename[:-4] if zip_filename.endswith(".zip") else zip_filename
        rom_filename = f"{base_name} Decrypted.3ds"

        region = parse_region(base_name)
        languages = parse_languages(base_name)
        title = clean_title(base_name)
        size_bytes = int(f.get("size", 0))

        # Safe URL encoding
        encoded_zip = urllib.parse.quote(zip_filename)
        encoded_rom = urllib.parse.quote(rom_filename)

        download_url = f"https://archive.org/download/3ds-decrypted-roms321com/all/{encoded_zip}/{encoded_rom}"
        archive_url = f"https://ia800707.us.archive.org/view_archive.php?archive=/32/items/3ds-decrypted-roms321com/all/{encoded_zip}&file={encoded_rom}"
        view_archive_url = f"https://ia800707.us.archive.org/view_archive.php?archive=/32/items/3ds-decrypted-roms321com/all/{encoded_zip}"

        games.append({
            "title": title,
            "fullName": base_name,
            "region": region,
            "languages": languages,
            "zipName": zip_filename,
            "romName": rom_filename,
            "size": size_bytes,
            "sizeFormatted": format_size(size_bytes),
            "downloadUrl": download_url,
            "archiveUrl": archive_url,
            "viewArchiveUrl": view_archive_url,
            "crc32": f.get("crc32"),
            "md5": f.get("md5")
        })

    # Sort alphabetically by title
    games.sort(key=lambda g: (g["title"].lower(), g["region"]))
    for idx, g in enumerate(games):
        g["id"] = idx + 1

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "version": 1,
            "collection": "3ds-decrypted-roms321com",
            "source": "https://archive.org/download/3ds-decrypted-roms321com/all/",
            "viewArchiveBase": "https://ia800707.us.archive.org/view_archive.php?archive=/32/items/3ds-decrypted-roms321com/all/",
            "total": len(games),
            "generatedAt": "2026-09-22",
            "games": games
        }, f, indent=2, ensure_ascii=False)

    print(f"Generated {OUTPUT_FILE} with {len(games)} games ({os.path.getsize(OUTPUT_FILE)} bytes).")

if __name__ == "__main__":
    main()
