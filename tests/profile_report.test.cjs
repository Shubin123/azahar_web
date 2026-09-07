'use strict';
const assert = require('node:assert/strict');
const { summarize } = require('./profile_report.cjs');
const node = (id, functionName, children = []) => ({ id, callFrame: { functionName }, children });
const profile = {
    nodes: [node(1, '(root)', [2, 4]), node(2, 'wasm-function[9]', [3]),
        node(3, 'wasm-function[9]'), node(4, '(idle)')],
    samples: [3, 2, 4], timeDeltas: [100, 200, 700],
};
const result = summarize(profile, '9:Shader::Run');
assert.equal(result.sampledMs, 1);
const shader = result.functions.find(row => row.name === 'Shader::Run');
assert.equal(shader.selfPct, 30);
assert.equal(shader.inclusivePct, 30);
assert.equal(result.functions.find(row => row.name === '(root)').inclusivePct, 100);
assert.equal(summarize({ nodes: [], samples: [], timeDeltas: [] }).sampledMs, 0);
assert.throws(() => summarize({ ...profile, timeDeltas: [] }), /timeDeltas/);
console.log('CPU profile report tests passed');
