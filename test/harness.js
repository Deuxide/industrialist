// Loads the real script.js into a sandbox with stub browser objects, so the
// tests exercise the same functions the page runs (solver, text tree, graph
// model) without a browser. Nothing here is shipped with the app.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function stubElement() {
    return {
        value: '', checked: false, innerHTML: '', innerText: '', textContent: '',
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, appendChild() {}, removeChild() {},
        addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
        querySelectorAll() { return []; }, closest() { return null; }, hasChildNodes() { return false; },
        click() {}, focus() {}
    };
}

// Pinned clock: recipe ids are built from Date.now(), so tests must not
// see the wall clock or the ids (and the HTML) change on every run.
const FIXED_NOW = 1700000000000;
class FixedDate extends Date {
    constructor(...args) { args.length ? super(...args) : super(FIXED_NOW); }
    static now() { return FIXED_NOW; }
}

function createSandbox() {
    const storage = new Map();
    const ctx = {
        // The solver logs "no producer" warnings for raw inputs; the tests
        // do not need them. Errors still go to stderr.
        console: { log() {}, info() {}, warn() {}, debug() {}, error: console.error },
        Math, JSON, Set, Map, Array, Object, String, Number, Boolean, Symbol,
        parseFloat, parseInt, isNaN, isFinite, Infinity, NaN, Error, TypeError, Date: FixedDate,
        URLSearchParams, Blob: class {}, Image: class {},
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        setTimeout: () => 0,
        localStorage: {
            getItem: k => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: k => storage.delete(k)
        },
        location: { hash: '' },
        history: { replaceState() {} },
        alert: () => {},
        document: {
            getElementById: () => null,
            createElement: () => stubElement(),
            createElementNS: () => stubElement(),
            body: stubElement(),
            head: stubElement(),
            styleSheets: []
        },
        matchMedia: () => ({ matches: false })
    };
    ctx.window = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    return ctx;
}

// Returns an object with the app's functions, bound to a fresh sandbox.
// `recipes` (optional) is a list in the native format; it is installed as
// the library the solver sees.
function loadApp({ recipes } = {}) {
    const ctx = createSandbox();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8'), ctx, { filename: 'script.js' });
    const call = (expr, extra = {}) => {
        Object.assign(ctx, { __args: extra });
        return vm.runInContext(expr, ctx);
    };
    if (recipes) {
        ctx.__library = recipes;
        call('recipes = __library;');
    }
    return { ctx, call };
}

// Same argument list calculateAll() passes to renderNode for the root.
function renderTree(call, target, data) {
    return call(
        `renderNode(__args.treeData, __args.target, __args.flow[__args.target], __args.flow, 0, true, "", new Set(), new Set(), __args.shared, __args.bp, __args.src)`,
        {
            treeData: data.treeData, target, flow: data.flowTotals,
            shared: data.sharedItems, bp: data.byproductSupplied, src: data.byproductSource
        }
    );
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { loadApp, renderTree, sha256, ROOT };
