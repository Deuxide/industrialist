// Golden tests: for every output item in Recipes.json, the text tree and the
// graph model must come out exactly as recorded. A refactor that changes
// either shows up here.
//
// Regenerate after an intentional change:  UPDATE_GOLDEN=1 node --test test/
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness.js');

const GOLDEN = path.join(__dirname, 'golden', 'targets.json');
const TEXT_DIR = path.join(__dirname, 'golden', 'text');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
// Targets whose full text tree is stored, so a diff can be read by eye.
const FULL_TEXT = ['silicon', '12-karat-gold', 'cement'];

const raw = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'Recipes.json'), 'utf8'));
const boot = h.loadApp();
const library = boot.call('convertImportedData(__args.raw)', { raw });
const app = h.loadApp({ recipes: library });

const targets = app.call(
    `[...new Set(recipes.flatMap(r => Object.keys(r.outputs || {})))].sort()`
);

// Mirrors calculateAll(true) for one target: colours reset, solve, render the
// text tree, then build the graph (in that order, as the app does).
function snapshot(target) {
    app.call('sharedColorAssignments.clear(); usedSharedColors.clear();');
    const data = app.call('runLogic(__args.t, 1, 60)', { t: target });
    const text = h.renderTree(app.call, target, data);
    const graph = app.call('buildGraphDataRoot(__args.d, __args.t)', { d: data, t: target });
    return {
        text,
        textHash: h.sha256(text),
        graph: JSON.stringify(graph),
        graphHash: h.sha256(JSON.stringify(graph)),
        nodes: graph.nodes.length,
        edges: graph.edges.length
    };
}

const recorded = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
const fresh = {};

targets.forEach(target => {
    test(`golden: ${target}`, () => {
        const s = snapshot(target);
        fresh[target] = { text: s.textHash, graph: s.graphHash, nodes: s.nodes, edges: s.edges };

        if (FULL_TEXT.includes(target)) {
            const file = path.join(TEXT_DIR, `${target}.html`);
            if (UPDATE) fs.writeFileSync(file, s.text);
            else assert.strictEqual(s.text, fs.readFileSync(file, 'utf8'), 'text tree changed');
        }

        if (UPDATE) return;
        const want = recorded[target];
        assert.ok(want, `no golden recorded for ${target}; run with UPDATE_GOLDEN=1`);
        assert.strictEqual(s.textHash, want.text, 'text tree changed');
        assert.strictEqual(s.graphHash, want.graph, `graph model changed (${s.nodes} nodes, ${s.edges} edges)`);
    });
});

after(() => {
    if (!UPDATE) return;
    const sorted = Object.fromEntries(Object.keys(fresh).sort().map(k => [k, fresh[k]]));
    fs.writeFileSync(GOLDEN, JSON.stringify(sorted, null, 1) + '\n');
    console.log(`wrote ${Object.keys(sorted).length} golden entries`);
});

test('golden set covers every output item', () => {
    assert.ok(targets.length >= 200, `only ${targets.length} output items`);
});
