// Import validation, input parsing, escaping of user text, and colour
// determinism. Runs the real script.js in the sandbox (see harness.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const h = require('./harness.js');

const raw = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'Recipes.json'), 'utf8'));
const HOSTILE = '<img src=x onerror=alert(1)>';

// ---------- import: shape and validation ----------

test('the bundled Recipes.json converts and passes validation', () => {
    const { call } = h.loadApp();
    const problem = call('validateImportedRecipes(convertImportedData(__args.raw))', { raw });
    assert.strictEqual(problem, null);
});

test('convertImportedData: native export is used as-is; junk is rejected', () => {
    const { call } = h.loadApp();
    const native = { recipes: [{ id: 1, name: 'M', inputs: {}, outputs: { a: 1 } }] };
    const out = call('convertImportedData(__args.v)', { v: native });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, 'M');

    assert.strictEqual(call('convertImportedData(__args.v)', { v: { hello: 1 } }), null);
    assert.strictEqual(call('convertImportedData(__args.v)', { v: 'nope' }), null);
});

test('validateImportedRecipes explains the first problem and accepts good input', () => {
    const { call } = h.loadApp();
    const check = v => call('validateImportedRecipes(__args.v)', { v });
    const good = { id: 1, name: 'M', inputs: { a: 1 }, outputs: { b: 2 } };

    assert.strictEqual(check([good]), null);
    assert.match(check([]), /no recipes/);
    assert.match(check({}), /no recipe list/);
    assert.match(check([null]), /not an object/);
    assert.match(check([{ ...good, name: '  ' }]), /no machine name/);
    assert.match(check([{ ...good, id: undefined }]), /"M" has no id/);
    assert.match(check([{ ...good, outputs: [1] }]), /"M" has invalid outputs/);
    assert.match(check([{ ...good, inputs: { a: NaN } }]), /"M" has invalid inputs/);
    assert.match(check([{ ...good, outputs: { b: -1 } }]), /"M" has invalid outputs/);
});

// ---------- parseItems ----------

test('parseItems: "qty item" pairs are divided by time', () => {
    const { call } = h.loadApp();
    const out = call('parseItems("2 coal, 6 water", 2)');
    assert.deepStrictEqual({ ...out }, { coal: 1, water: 3 });
});

test('parseItems: multi-word items and repeats add up', () => {
    const { call } = h.loadApp();
    const out = call('parseItems("1 water free gas, 1 water free gas", 1)');
    assert.deepStrictEqual({ ...out }, { 'water free gas': 2 });
});

test('parseItems: an entry without a numeric quantity is skipped, not NaN', () => {
    const { call } = h.loadApp();
    const out = call('parseItems("x steel, 1 iron", 1)');
    assert.deepStrictEqual({ ...out }, { iron: 1 });
    assert.ok(!Object.values(out).some(Number.isNaN));
});

// ---------- user text is never injected as markup ----------

test('a hostile machine/item name stays text in the Recipe Library', () => {
    const recipes = [{
        id: 1, name: HOSTILE, inputs: { coal: 1 }, outputs: { [HOSTILE]: 1 },
        origTime: 1, power: 0, cost: 0, rawIn: '1 coal', rawOut: `1 ${HOSTILE}`,
        isVariableTime: false, disabled: false
    }];
    const { ctx, call } = h.loadApp({ recipes });

    const els = {
        recipeDisplay: { innerHTML: '' }, recipeCount: { textContent: '' },
        recipeSearch: { value: '' }, disabledPillCount: { textContent: '' }
    };
    ctx.document.getElementById = id => els[id] || null;
    call('displayRecipes()');

    assert.ok(!/<img/i.test(els.recipeDisplay.innerHTML), 'no live <img> in the list');
    assert.ok(els.recipeDisplay.innerHTML.includes('&lt;img'), 'name is shown escaped');
});

test('a hostile item name stays text in the Text Tree', () => {
    const recipes = [{
        id: 1, name: 'Maker', inputs: { [HOSTILE]: 1 }, outputs: { widget: 1 },
        origTime: 1, power: 0, cost: 0, rawIn: `1 ${HOSTILE}`, rawOut: '1 widget',
        isVariableTime: false, disabled: false
    }];
    const { call } = h.loadApp({ recipes });
    const data = call('runLogic("widget", 1, 1)');
    const text = h.renderTree(call, "widget", data);

    assert.ok(!/<img/i.test(text), 'no live <img> in the tree');
    assert.ok(text.includes('&lt;img'));
});

test('a hostile name stays text in a graph node', () => {
    const { ctx, call } = h.loadApp();
    vm.runInContext(fs.readFileSync(path.join(h.ROOT, 'dag-layout.js'), 'utf8'), ctx);

    const node = {
        id: 'm1', kind: 'machine', label: HOSTILE, itemName: HOSTILE, recipeId: 'r1',
        count: 1, exactCount: 1, outputs: [{ itemName: HOSTILE, rate: 1 }],
        inputSummary: HOSTILE, isShared: false, sharedColor: null, recycledSourceColor: null
    };
    const svg = call('dagNodeTemplate(__args.node, {x:0,y:0,w:220,h:60}, true)', { node });
    assert.ok(!/<img/i.test(svg), 'no live <img> in the SVG');
    assert.ok(svg.includes('&lt;img'));
});

// ---------- colour determinism ----------

test('shared-item colours are the same across independent loads', () => {
    const pick = () => {
        const { call } = h.loadApp();
        return call('["copper", "iron", "water"].map(i => getSharedItemColor(i))');
    };
    const a = [...pick()];
    const b = [...pick()];
    assert.deepStrictEqual(a, b);
    a.forEach(c => assert.match(c, /^#[0-9a-fA-F]{6}$/));
});
