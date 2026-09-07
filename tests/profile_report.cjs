'use strict';

// Usage: node tests/profile_report.cjs capture.cpuprofile [matching.html.symbols]
// Symbol maps MUST come from the same link as the profiled WASM artifact.
const fs = require('node:fs');

function summarize(profile, symbolText = '') {
    const symbols = new Map(symbolText.split(/\r?\n/).flatMap(line => {
        const match = /^(\d+):(.*)$/.exec(line);
        return match ? [[Number(match[1]), match[2]]] : [];
    }));
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parents = new Map();
    for (const node of profile.nodes) {
        for (const child of node.children || []) parents.set(child, node.id);
    }
    const nameOf = node => {
        const name = node.callFrame.functionName || '(anonymous)';
        const match = /^(?:wasm-function\[(\d+)\]|\$(\d+))$/.exec(name);
        return match ? symbols.get(Number(match[1] || match[2])) || name : name;
    };
    const rows = new Map();
    let totalUs = 0;
    for (let i = 0; i < (profile.samples || []).length; i++) {
        const elapsed = profile.timeDeltas?.[i];
        if (!Number.isFinite(elapsed) || elapsed < 0) {
            throw new Error('Profile requires nonnegative timeDeltas for every sample');
        }
        totalUs += elapsed;
        let id = profile.samples[i];
        let leaf = true;
        const seenNames = new Set();
        const seenIds = new Set();
        while (id !== undefined) {
            if (seenIds.has(id)) throw new Error('Cycle in profile call tree');
            seenIds.add(id);
            const node = nodes.get(id);
            if (!node) throw new Error(`Missing profile node ${id}`);
            const name = nameOf(node);
            if (!rows.has(name)) rows.set(name, { name, selfUs: 0, inclusiveUs: 0 });
            const row = rows.get(name);
            if (leaf) row.selfUs += elapsed;
            // Recursive calls count once in a function's inclusive total.
            if (!seenNames.has(name)) row.inclusiveUs += elapsed;
            seenNames.add(name);
            leaf = false;
            id = parents.get(id);
        }
    }
    return {
        sampledMs: totalUs / 1000,
        samples: profile.samples?.length || 0,
        functions: [...rows.values()].map(row => ({
            name: row.name,
            selfMs: row.selfUs / 1000,
            selfPct: totalUs ? row.selfUs * 100 / totalUs : 0,
            inclusiveMs: row.inclusiveUs / 1000,
            inclusivePct: totalUs ? row.inclusiveUs * 100 / totalUs : 0,
        })).sort((a, b) => b.selfMs - a.selfMs),
    };
}

if (require.main === module) {
    const [capture, symbols] = process.argv.slice(2);
    if (!capture) throw new Error('Usage: profile_report.cjs capture.cpuprofile [matching.html.symbols]');
    const report = summarize(JSON.parse(fs.readFileSync(capture, 'utf8')),
        symbols ? fs.readFileSync(symbols, 'utf8') : '');
    console.log(JSON.stringify(report, null, 2));
}

module.exports = { summarize };
