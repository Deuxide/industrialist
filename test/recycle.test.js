// Recycle (byproduct) handling in the graph model, on a hand-built fixture.
//
// Recipe M makes gear (1/s) and also yields waste (0.5/s) as a byproduct.
// The target's recipe T consumes gear (1/s) and waste (2/s). The graph must
// show only what M actually supplies as a recycle edge; any remainder is a
// raw input. The text tree uses the same rules, so both are checked.
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./harness.js');

const EPS = 1e-6;

function fixture({ wasteSupplied, withSource }) {
    const treeData = {
        target: [{
            recipeId: 'T', machine: 'Assembler', count: 1,
            allOutputs: { target: 1 },
            inputs: [{ itemName: 'gear', rate: 1 }, { itemName: 'waste', rate: 2 }]
        }],
        gear: [{
            recipeId: 'M', machine: 'Mill', count: 1,
            allOutputs: { gear: 1, waste: 0.5 },
            inputs: []
        }]
    };
    const byproductSupplied = wasteSupplied > 0 ? { waste: wasteSupplied } : {};
    const byproductSource = withSource ? { waste: { recipeId: 'M', machineName: 'Mill' } } : {};
    return {
        treeData,
        flowTotals: { target: 1, gear: 1, waste: 2 },
        sharedItems: new Set(),
        byproductSupplied,
        byproductSource
    };
}

function graphFor(data) {
    const { ctx, call } = h.loadApp();
    const graph = call('buildGraphDataRoot(__args.data, "target")', { data });
    return { graph: JSON.parse(JSON.stringify(graph)), call };
}

function rawNodes(graph) {
    return graph.nodes.filter(n => n.kind === 'raw' && n.itemName === 'waste');
}
function recycleEdges(graph) {
    return graph.edges.filter(e => e.isRecycleEdge);
}

test('partly supplied byproduct: recycle edge for the supplied part, raw node for the rest', () => {
    const { graph, call } = graphFor(fixture({ wasteSupplied: 0.5, withSource: true }));

    const recycle = recycleEdges(graph);
    assert.strictEqual(recycle.length, 1, 'one recycle edge');
    assert.ok(Math.abs(recycle[0].rate - 0.5) < EPS, `recycle rate 0.5, got ${recycle[0].rate}`);
    assert.strictEqual(recycle[0].itemName, 'waste');

    const raws = rawNodes(graph);
    assert.strictEqual(raws.length, 1, 'one raw node for the unsupplied remainder');
    assert.ok(Math.abs(raws[0].rate - 1.5) < EPS, `raw rate 1.5, got ${raws[0].rate}`);
    assert.deepStrictEqual(raws[0].partialRecycle, { amount: 0.5, machine: 'Mill' });

    // The recycle edge must come from M's machine node, not from the raw node.
    const millId = graph.nodes.find(n => n.kind === 'machine' && n.recipeId === 'M').id;
    assert.strictEqual(recycle[0].from, millId);

    // Text tree agrees: partly recycled, with the same amounts.
    const text = h.renderTree(call, 'target', fixture({ wasteSupplied: 0.5, withSource: true }));
    assert.match(text, /partly recycled from mill/i);
});

test('fully supplied byproduct: recycle edge at the full rate, no raw node', () => {
    const { graph } = graphFor(fixture({ wasteSupplied: 2, withSource: true }));

    const recycle = recycleEdges(graph);
    assert.strictEqual(recycle.length, 1);
    assert.ok(Math.abs(recycle[0].rate - 2) < EPS, `recycle rate 2, got ${recycle[0].rate}`);
    assert.strictEqual(rawNodes(graph).length, 0, 'no raw node when fully supplied');
});

test('no byproduct supply: plain raw node at the full rate, no recycle edge', () => {
    const { graph } = graphFor(fixture({ wasteSupplied: 0, withSource: true }));

    assert.strictEqual(recycleEdges(graph).length, 0);
    const raws = rawNodes(graph);
    assert.strictEqual(raws.length, 1);
    assert.ok(Math.abs(raws[0].rate - 2) < EPS, `raw rate 2, got ${raws[0].rate}`);
    assert.strictEqual(raws[0].partialRecycle, undefined);
});
