#!/usr/bin/env node
/**
 * Prepare a local .3ds/.cci dump for use as an Azahar Web test title.
 *
 * Some decrypted dumps carry plaintext ExeFS/RomFS but never had the NCCH
 * `NoCrypto` flag set, so the loader still reports them as encrypted and
 * refuses to boot. This verifies the content really is plaintext and then
 * sets that flag on every NCCH partition, writing an independent copy into
 * test_games/ (the source dump is never modified).
 *
 * Usage:
 *   node tests/prepare_rom.cjs <source.3ds> [--out test_games/<name>.3ds] [--check]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_UNIT = 0x200;

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
const checkOnly = args.includes('--check');
const outIdx = args.indexOf('--out');
if (!src) {
    console.error('Usage: node tests/prepare_rom.cjs <source.3ds> [--out PATH] [--check]');
    process.exit(2);
}

/** Read the NCSD partition table: [{ index, offset, length }] for non-empty slots. */
function partitions(fd) {
    const head = Buffer.alloc(0x200);
    fs.readSync(fd, head, 0, 0x200, 0);
    if (head.toString('latin1', 0x100, 0x104) !== 'NCSD') {
        throw new Error('Not an NCSD/CCI image (missing NCSD magic at 0x100)');
    }
    const out = [];
    for (let i = 0; i < 8; i++) {
        const offset = head.readUInt32LE(0x120 + i * 8) * MEDIA_UNIT;
        const length = head.readUInt32LE(0x124 + i * 8) * MEDIA_UNIT;
        if (length) out.push({ index: i, offset, length });
    }
    return out;
}

/**
 * Decide whether a partition's content is already plaintext.
 *
 * An encrypted NCCH has an encrypted ExeFS header too, so a readable ".code"
 * (or any printable filename) in the first ExeFS entry is a reliable tell.
 * ExeFS-less partitions (manual, DLP) fall back to the RomFS IVFC magic.
 */
function inspect(fd, part) {
    const ncch = Buffer.alloc(0x200);
    fs.readSync(fd, ncch, 0, 0x200, part.offset);
    if (ncch.toString('latin1', 0x100, 0x104) !== 'NCCH') return null;

    const flags = ncch.subarray(0x188, 0x190);
    const exefsOff = ncch.readUInt32LE(0x1a0) * MEDIA_UNIT;
    const romfsOff = ncch.readUInt32LE(0x1b0) * MEDIA_UNIT;

    let plaintext = null;
    if (exefsOff) {
        const hdr = Buffer.alloc(0x10);
        fs.readSync(fd, hdr, 0, 0x10, part.offset + exefsOff);
        const name = hdr.toString('latin1', 0, 8).replace(/\0+$/, '');
        plaintext = /^[\x20-\x7e]+$/.test(name) && name.length > 0;
    } else if (romfsOff) {
        const hdr = Buffer.alloc(4);
        fs.readSync(fd, hdr, 0, 4, part.offset + romfsOff);
        plaintext = hdr.toString('latin1') === 'IVFC';
    }

    return {
        ...part,
        productCode: ncch.toString('latin1', 0x150, 0x160).replace(/\0+$/, ''),
        cryptoMethod: flags[3],
        fixedKey: !!(flags[7] & 0x01),
        noCrypto: !!(flags[7] & 0x04),
        seedCrypto: !!(flags[7] & 0x20),
        plaintext,
    };
}

const fd = fs.openSync(src, 'r');
const found = partitions(fd).map(p => inspect(fd, p)).filter(Boolean);
fs.closeSync(fd);

if (!found.length) throw new Error('No NCCH partitions found');

console.log(`Source: ${src}`);
for (const p of found) {
    console.log(`  partition ${p.index} @ ${p.offset.toString(16)}  ${p.productCode || '(no product code)'}` +
        `  crypto=0x${p.cryptoMethod.toString(16)}` +
        `  noCrypto=${p.noCrypto}` +
        `  content=${p.plaintext === null ? 'unknown' : p.plaintext ? 'plaintext' : 'ENCRYPTED'}`);
}

// Only the first partition (the executable CXI) is booted. Manual and DLP
// CFAs are frequently left encrypted by dump tools; that is harmless, so they
// warn rather than fail, and keep their real flags so any access fails cleanly
// instead of reading garbage as plaintext.
const [boot, ...extras] = found;
if (boot.plaintext === false) {
    console.error('\nFAIL: the executable partition holds real encrypted content.');
    console.error('Decrypt the dump first (GodMode9 on the console); header flags alone cannot fix it.');
    process.exit(1);
}
const encryptedExtras = extras.filter(p => p.plaintext === false);
if (encryptedExtras.length) {
    console.log(`\nNote: ${encryptedExtras.length} non-executable partition(s) ` +
        `(${encryptedExtras.map(p => p.index).join(', ')}) are still encrypted. ` +
        'These are the e-manual/DLP CFAs and are not booted; leaving their flags untouched.');
}

const needsFlag = boot.noCrypto ? [] : [boot];
if (!needsFlag.length) {
    console.log('\nExecutable partition already flagged NoCrypto — usable as-is.');
}
if (checkOnly) process.exit(0);

const out = outIdx >= 0 ? path.resolve(args[outIdx + 1])
    : path.join(ROOT, 'test_games', path.basename(src).replace(/\s+/g, '_'));

fs.mkdirSync(path.dirname(out), { recursive: true });
if (path.resolve(out) === path.resolve(src)) throw new Error('Refusing to overwrite the source dump');
fs.copyFileSync(src, out);

if (needsFlag.length) {
    const wfd = fs.openSync(out, 'r+');
    for (const p of needsFlag) {
        const flags = Buffer.alloc(8);
        fs.readSync(wfd, flags, 0, 8, p.offset + 0x188);
        flags[3] = 0;          // standard-key crypto method, now moot
        flags[7] |= 0x04;      // NoCrypto
        flags[7] &= ~0x20;     // clear seed crypto
        fs.writeSync(wfd, flags, 0, 8, p.offset + 0x188);
    }
    fs.closeSync(wfd);
    console.log(`\nSet NoCrypto on ${needsFlag.length} partition(s).`);
}
console.log(`Wrote ${out} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
