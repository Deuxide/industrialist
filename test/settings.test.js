// Settings persistence: the target and options are saved under their own
// key (never in the recipe library's key), restored on load, and a shared
// link in the URL takes priority over the saved settings.
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./harness.js');

function fakeElements() {
    const els = {};
    const make = () => ({
        value: '', checked: false, textContent: '', innerHTML: '', hidden: false,
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
        removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }
    });
    return { els, get: id => (els[id] = els[id] || make()) };
}

function appWithDom() {
    const app = h.loadApp();
    const dom = fakeElements();
    app.ctx.document.getElementById = id => dom.get(id);
    return { ...app, els: dom.els, dom };
}

test('saveSettings writes its own key and leaves the recipe library key alone', () => {
    const { ctx, call, dom } = appWithDom();
    Object.assign(dom.get('targetItem'), { value: 'steel' });
    Object.assign(dom.get('targetQty'), { value: '5' });
    Object.assign(dom.get('targetTime'), { value: '2' });
    Object.assign(dom.get('currentBank'), { value: '100' });
    Object.assign(dom.get('advancedToggle'), { checked: true });

    call('saveSettings()');

    const saved = JSON.parse(call("localStorage.getItem('industrialist.settings')"));
    assert.strictEqual(saved.item, 'steel');
    assert.strictEqual(saved.qty, '5');
    assert.strictEqual(saved.time, '2');
    assert.strictEqual(saved.bank, '100');
    assert.strictEqual(saved.advanced, true);
    assert.strictEqual(call("localStorage.getItem('factoryRecipes')"), null, 'library key untouched');
});

test('restoreSettings fills the fields from the saved settings', () => {
    const { call, dom } = appWithDom();
    call(`localStorage.setItem('industrialist.settings', JSON.stringify({
        item: 'cement', qty: '3', time: '60', bank: '500', advanced: true, view: 'text', dir: 'DOWN' }))`);

    call('restoreSettings()');

    assert.strictEqual(dom.get('targetItem').value, 'cement');
    assert.strictEqual(dom.get('targetQty').value, '3');
    assert.strictEqual(dom.get('targetTime').value, '60');
    assert.strictEqual(dom.get('currentBank').value, '500');
    assert.strictEqual(dom.get('advancedToggle').checked, true);
});

test('restoreSettings ignores corrupt or missing data', () => {
    const { call, dom } = appWithDom();
    call(`localStorage.setItem('industrialist.settings', '{not json')`);
    assert.doesNotThrow(() => call('restoreSettings()'));
    call(`localStorage.removeItem('industrialist.settings')`);
    assert.doesNotThrow(() => call('restoreSettings()'));
    assert.strictEqual(dom.get('targetItem').value, '');
});

test('a shared link in the URL takes priority; no link reports false', () => {
    const { call } = appWithDom();
    assert.strictEqual(call('restoreStateFromHash()'), false, 'empty hash');

    call(`location.hash = '#t=steel&q=2'`);
    assert.strictEqual(call('restoreStateFromHash()'), true, 'hash with a target');
});
