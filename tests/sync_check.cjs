/**
 * sync_check.cjs
 * Checks that linked consoles show the same game state: samples matching screen
 * regions on each console (for Mario Kart 7, the racer portraits in its ranking
 * list) and reports how often every region agreed. Shared by multiplayer.test.cjs
 * (one console per browser) and split_screen.test.cjs (consoles in frames of one page).
 */
'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Average colour of an image region, sampled on a grid, decoded in the page.
async function regionSignatures(page, png, rects) {
    return page.evaluate(async (dataUrl, rects) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return rects.map(([x, y, w, h]) => {
            const data = context.getImageData(Math.round(x * image.width), Math.round(y * image.height),
                Math.max(1, Math.round(w * image.width)), Math.max(1, Math.round(h * image.height))).data;
            const grid = [];
            const cols = 4, rows = 4, width = Math.max(1, Math.round(w * image.width)), height = Math.max(1, Math.round(h * image.height));
            for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
                const px = Math.floor((gx + 0.5) * width / cols), py = Math.floor((gy + 0.5) * height / rows);
                const i = (py * width + px) * 4;
                grid.push(data[i], data[i + 1], data[i + 2]);
            }
            return grid;
        });
    }, `data:image/png;base64,${png}`, rects);
}

// Each console's screen and keys: a page per console by default. `place` maps regions given in
// the native 400x480 frame to where that console's canvas shows them.
const pageIo = {
    shoot: async page => (await page.$('#canvas')).screenshot({ encoding: 'base64' }),
    hold: (page, key, down) => (down ? page.keyboard.down(key) : page.keyboard.up(key)),
    place: async (page, rects) => rects,
};

// While both consoles play, compares what each shows in matching screen regions
// (for Mario Kart 7, the racer portraits in its ranking list). Returns the share
// of samples where every region agreed.
async function checkSync(host, guest, sync, io = pageIo) {
    // Sample the middle of each row so per-console decorations at its edges (Mario Kart 7
    // highlights the local player's row) do not count as disagreement.
    const inset = sync.rowInset ?? 0.1;
    const rects = Array.from({ length: sync.rows }, (_, row) =>
        [sync.x, sync.y + (row + inset) * sync.rowHeight, sync.width, sync.rowHeight * (1 - 2 * inset)]);
    // The rows only mean something once the screen shows distinct entries in them
    // (not a loading or blank panel), so wait for that on both consoles first.
    const variety = grids => {
        let total = 0, pairs = 0;
        for (let i = 0; i < grids.length; i++) for (let j = i + 1; j < grids.length; j++, pairs++) {
            total += grids[i].reduce((sum, value, k) => sum + Math.abs(value - grids[j][k]), 0) / grids[i].length;
        }
        return total / pairs;
    };
    // Readiness looks at whole rows, which differ from each other more than the sampled centres.
    const readyRects = Array.from({ length: sync.rows }, (_, row) =>
        [sync.readyX ?? sync.x, sync.y + row * sync.rowHeight, sync.readyWidth ?? sync.width, sync.rowHeight * 0.8]);
    const readyBy = Date.now() + (sync.readyTimeoutMs || 120000);
    for (;;) {
        const shots = await Promise.all([host, guest].map(io.shoot));
        const grids = await Promise.all([regionSignatures(host, shots[0], await io.place(host, readyRects)),
            regionSignatures(guest, shots[1], await io.place(guest, readyRects))]);
        if (grids.every(g => variety(g) > (sync.minVariety ?? 25))) break;
        if (Date.now() > readyBy) {
            throw new Error('the consoles never reached the synced scene (both stayed on a blank or loading screen)');
        }
        await sleep(3000);
    }
    for (const side of [host, guest]) for (const key of sync.holdKeys || []) await io.hold(side, key, true);
    let agreed = 0;
    const details = [];
    for (let sample = 0; sample < sync.samples; sample++) {
        await sleep(sync.intervalMs);
        const shots = await Promise.all([host, guest].map(io.shoot));
        const [a, b] = await Promise.all([regionSignatures(host, shots[0], await io.place(host, rects)),
            regionSignatures(guest, shots[1], await io.place(guest, rects))]);
        const differing = a.map((grid, row) => grid.reduce((sum, value, i) => sum + Math.abs(value - b[row][i]), 0) / grid.length)
            .map((distance, row) => [row + 1, Math.round(distance)]).filter(([, distance]) => distance > sync.threshold);
        // Close racers can swap places between two snapshots taken milliseconds apart.
        if (sync.rows - differing.length >= (sync.minRowsAgree ?? sync.rows)) agreed++;
        details.push(differing.length ? differing.map(([row, d]) => `${row}:${d}`).join(' ') : 'ok');
    }
    for (const side of [host, guest]) for (const key of sync.holdKeys || []) await io.hold(side, key, false);
    return { share: agreed / sync.samples, details };
}

module.exports = { regionSignatures, checkSync, pageIo };
