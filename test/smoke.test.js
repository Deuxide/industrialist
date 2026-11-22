// Smoke run over every output item in Recipes.json: the solver and both
// views must finish without throwing, and no rate may be NaN or infinite.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness.js');

const raw = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'Recipes.json'), 'utf8'));
const boot = h.loadApp();
const library = boot.call('convertImportedData(__args.raw)', { raw });
const app = h.loadApp({ recipes: library });
const targets = app.call(`[...new Set(recipes.flatMap(r => Object.keys(r.outputs || {})))].sort()`);

test(`all ${targets.length} output items solve with finite rates in both views`, () => {
    const bad = [];
    for (const target of targets) {
        app.call('sharedColorAssignments.clear(); usedSharedColors.clear();');
        const data = app.call('runLogic(__args.t, 1, 60)', { t: target });
        const text = h.renderTree(app.call, target, data);
        const graph = app.call('buildGraphDataRoot(__args.d, __args.t)', { d: data, t: target });

        if (/NaN|Infinity/.test(text)) bad.push(`${target}: NaN/Infinity in text`);
        for (const e of graph.edges) {
            if (!Number.isFinite(e.rate)) bad.push(`${target}: edge rate ${e.rate}`);
        }
        for (const n of graph.nodes) {
            if (n.rate !== undefined && !Number.isFinite(n.rate)) bad.push(`${target}: node rate ${n.rate}`);
        }
    }
    assert.deepStrictEqual(bad, []);
});
