let recipes = JSON.parse(localStorage.getItem('factoryRecipes')) || [];

window.onload = () => {
    const recipeDisplay = document.getElementById('recipeDisplay');
    if (recipeDisplay) {
        recipeDisplay.addEventListener('click', (event) => {
            const actionEl = event.target.closest('[data-recipe-action]');
            if (!actionEl) return;

            const action = actionEl.dataset.recipeAction;
            const id = actionEl.dataset.recipeId;

            if (action === 'toggle') toggleRecipeDisabled(id);
            if (action === 'edit') editRecipe(id);
            if (action === 'delete') deleteRecipe(id);
        });
    }

    displayRecipes();
    restoreStateFromHash();
};


function exportData() {
    const data = {
        recipes: recipes
    };

    const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: 'application/json' }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `industrialist-recipes-${new Date().toISOString().slice(0, 10)}.json`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

// ---- Inline messages (replaces alert()) ----
// One banner, always in the DOM (see index.html). Text is set with
// textContent, so messages can carry user-supplied names safely.
let _bannerTimer = null;

function showBanner(message, kind = 'error') {
    const el = document.getElementById('appBanner');
    if (!el) {
        console.error(message);
        return;
    }
    const text = el.querySelector('.app-banner-text');
    if (text) text.textContent = message;
    el.className = `app-banner app-banner--${kind}`;
    el.hidden = false;
    clearTimeout(_bannerTimer);
    if (kind === 'info') _bannerTimer = setTimeout(hideBanner, 5000);
}

function hideBanner() {
    const el = document.getElementById('appBanner');
    if (el) el.hidden = true;
}

// Log the detail, show a short sentence to the person.
function reportError(prefix, err) {
    console.error(err);
    const detail = err && err.message ? err.message : String(err);
    showBanner(`${prefix}: ${detail}`);
}

// Checks that an imported library has the shape the solver relies on.
// Returns null when it is fine, otherwise a sentence describing the first
// problem found.
function validateImportedRecipes(list) {
    if (!Array.isArray(list)) return 'the file has no recipe list.';
    if (list.length === 0) return 'the file contains no recipes.';

    const isRateMap = obj =>
        obj && typeof obj === 'object' && !Array.isArray(obj) &&
        Object.values(obj).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);

    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const where = `recipe ${i + 1}`;
        if (!r || typeof r !== 'object') return `${where} is not an object.`;
        if (typeof r.name !== 'string' || !r.name.trim()) return `${where} has no machine name.`;
        const label = `"${r.name}"`;
        if (r.id === undefined || r.id === null || r.id === '') return `${label} has no id.`;
        if (!isRateMap(r.inputs)) return `${label} has invalid inputs.`;
        if (!isRateMap(r.outputs)) return `${label} has invalid outputs.`;
    }
    return null;
}

function importData() {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return; // dialog cancelled / no file chosen

        const reader = new FileReader();

        reader.onerror = () => showBanner('Could not read that file.');

        reader.onload = event => {
            let imported;
            try {
                imported = JSON.parse(event.target.result);
            } catch (err) {
                console.error(err);
                showBanner('Import cancelled: the file is not valid JSON.');
                return;
            }

            const converted = convertImportedData(imported);
            if (converted === null) {
                showBanner(
                    "Import cancelled: unrecognised recipe format. Expected this app's " +
                    "{ recipes: [...] } export, or a flat list of recipe entries."
                );
                return;
            }

            const problem = validateImportedRecipes(converted);
            if (problem) {
                showBanner(`Import cancelled: ${problem} Your recipes were not changed.`);
                return;
            }

            // Importing replaces the whole library, so confirm before
            // discarding one that already exists.
            if (recipes.length > 0 && !confirm(
                `Replace your ${recipes.length} saved recipe(s) with ${converted.length} from this file?\n\n` +
                'Export first if you want to keep the current library.')) {
                return;
            }

            recipes = converted;
            displayRecipes();

            try {
                saveData();
                showBanner(`Import successful: loaded ${recipes.length} recipe(s).`, 'info');
            } catch (err) {
                console.error(err);
                showBanner('Recipes loaded for this session, but could not be saved in this browser (storage full?).');
            }
        };

        reader.readAsText(file);
    };

    input.click();
}


// =========================================================
// IMPORT FORMAT DETECTION / CONVERSION
// =========================================================
//
// Two supported shapes:
//
// 1) NATIVE FORMAT — this app's own export:
//      { "recipes": [ { id, name, inputs, outputs, origTime,
//                        power, cost, rawIn, rawOut }, ... ] }
//    Used as-is.
//
// 2) "Recipes.json" FORMAT — a flat array where each element is
//    a single-key object: { "<output-item>": { "<rate>": {
//        Inputs: [...], InputAmounts: [...],
//        Outputs: [...], OutputAmounts: [...],
//        Time: <seconds>, Machine: "<machine name>"
//    } } }.
//    Critically, a recipe with N outputs appears N TIMES in the
//    array — once per output item, each time wrapped under a
//    different top-level key but with IDENTICAL Inputs/Outputs/
//    Machine/Time data. These duplicates must be merged back
//    into ONE recipe per distinct (Machine, Inputs, Outputs,
//    Time) combination before import, or the app would build
//    the same machine multiple times over for one real recipe.
//
//    This format has no build-cost field (only Machine/Time/
//    Inputs/Outputs), so `cost` imports as 0. It DOES carry a
//    per-recipe power figure in the "MF" field (this game's power
//    unit, "Mamy Flux") — see parseMF() below for how that's
//    turned into `power`.
//

function convertImportedData(imported) {

    // --- Shape 1: native format ---
    if (imported && Array.isArray(imported.recipes)) {
        return imported.recipes;
    }

    // --- Shape 2: flat Recipes.json format ---
    if (Array.isArray(imported)) {
        const looksLikeFlatFormat =
            imported.length === 0 ||
            (
                typeof imported[0] === 'object' &&
                imported[0] !== null &&
                Object.values(imported[0]).some(
                    v => v && typeof v === 'object' &&
                        Object.values(v).some(
                            entry => entry && typeof entry === 'object' &&
                                'Machine' in entry && 'Inputs' in entry && 'Outputs' in entry
                        )
                )
            );

        if (looksLikeFlatFormat) {
            return convertFlatRecipeFormat(imported);
        }
    }

    return null;
}


// =========================================================
// PARSE "MF" POWER STRINGS (Mamy Flux — this game's power unit)
// =========================================================
//
// Seen in the wild across this dataset's 81 distinct MF strings:
//   "21kMF"        -> 21,000 MF
//   "1.25MMF"      -> 1,250,000 MF   (M = million here, not milli)
//   "1.2GMF"       -> 1,200,000,000 MF
//   "0MF"          -> 0
//   "100KMF"       -> case-insensitive suffix, same as "100kMF"
//   "-7kMF"        -> NEGATIVE: this recipe's machine is a
//                     generator (e.g. Coal Generator, Steam
//                     Turbine) that PRODUCES power rather than
//                     consuming it. Kept as a negative `power`
//                     value rather than clamped to 0, so power
//                     totals across a tree can net generators
//                     against consumers.
//   "2.86kMF\n"    -> stray trailing whitespace/newline in the
//                     source data — trimmed before parsing.
//   "750kMF/s"     -> stray "/s" suffix on an otherwise normal
//                     value — stripped before parsing (this
//                     field is already implicitly a rate, so the
//                     "/s" doesn't change the number itself).
//   "Maxwell"      -> not a real MF value at all (junk/placeholder
//                     data on one joke recipe in the source file).
//                     Falls back to 0 rather than throwing, so one
//                     bad row doesn't break the whole import.
//   null / missing -> falls back to 0.
//
function parseMF(mfValue) {
    if (mfValue === null || mfValue === undefined) return 0;

    const cleaned = String(mfValue)
        .trim()
        .replace(/\/s$/i, ''); // strip a stray rate suffix if present

    const match = cleaned.match(/^(-?[\d.]+)\s*([kKmMgG]?)MF$/);
    if (!match) return 0; // e.g. "Maxwell" — not a parseable MF value

    const magnitude = parseFloat(match[1]);
    if (!Number.isFinite(magnitude)) return 0;

    const suffix = match[2].toLowerCase();
    const multiplier =
        suffix === 'k' ? 1e3 :
        suffix === 'm' ? 1e6 :
        suffix === 'g' ? 1e9 :
        1;

    return magnitude * multiplier;
}


function convertFlatRecipeFormat(flatList) {

    // Dedupe identical recipes that appear once per output item.
    // Key on the full recipe signature so two genuinely different
    // recipes that happen to share a machine name don't collide.
    const seen = new Map();

    flatList.forEach(entry => {
        if (!entry || typeof entry !== 'object') return;

        for (const outputKey in entry) {
            const rateMap = entry[outputKey];
            if (!rateMap || typeof rateMap !== 'object') continue;

            for (const rateKey in rateMap) {
                const r = rateMap[rateKey];
                if (!r || typeof r !== 'object') continue;
                if (!Array.isArray(r.Inputs) || !Array.isArray(r.Outputs)) continue;

                // Some duplicate entries for the same underlying recipe
                // list Inputs/Outputs in a DIFFERENT array order (seen in
                // the wild: "water-free-gas, water, crude-oil" vs
                // "crude-oil, water, water-free-gas" for the identical
                // Condenser recipe). Sort name+amount pairs together
                // before hashing so these still collapse into one
                // recipe instead of being kept as false duplicates.
                const inputPairs = (r.Inputs || [])
                    .map((name, idx) => [name, (r.InputAmounts || [])[idx]])
                    .sort((a, b) => a[0].localeCompare(b[0]));

                const outputPairs = (r.Outputs || [])
                    .map((name, idx) => [name, (r.OutputAmounts || [])[idx]])
                    .sort((a, b) => a[0].localeCompare(b[0]));

                const signature = JSON.stringify({
                    m: r.Machine,
                    i: inputPairs,
                    o: outputPairs,
                    t: r.Time
                });

                if (seen.has(signature)) continue;
                seen.set(signature, r);
            }
        }
    });

    const converted = [];
    let autoId = Date.now();

    seen.forEach(r => {
        // Time === -1 shows up on ~10 recipes in this dataset (Steam
        // Cracking Plant, Coal Liquefaction Plant, Alloyer, etc.) —
        // it means the real process time is VARIABLE, dependent on
        // something the flat export doesn't capture (steam
        // temperature, for most of them). It is NOT a literal "-1
        // seconds." `r.Time || 1` used to let -1 slip through as a
        // real divisor (since -1 is truthy), silently negating every
        // input/output rate for these recipes. Guard explicitly:
        // treat any non-positive Time as "unknown," skip rate math
        // entirely (store 0 rather than a fabricated number), and
        // flag the recipe so the UI can call it out instead of
        // quietly producing wrong math.
        const hasVariableTime = !r.Time || r.Time <= 0;
        const time = hasVariableTime ? 1 : r.Time; // divisor only; origTime below keeps the real flag

        const inputs = {};
        const inputParts = [];
        (r.Inputs || []).forEach((name, idx) => {
            const amt = (r.InputAmounts && r.InputAmounts[idx]) || 0;
            const key = name.toLowerCase();
            inputs[key] = (inputs[key] || 0) + (hasVariableTime ? 0 : amt / time);
            inputParts.push(`${amt} ${name}`);
        });

        const outputs = {};
        const outputParts = [];
        (r.Outputs || []).forEach((name, idx) => {
            const amt = (r.OutputAmounts && r.OutputAmounts[idx]) || 0;
            const key = name.toLowerCase();
            outputs[key] = (outputs[key] || 0) + (hasVariableTime ? 0 : amt / time);
            outputParts.push(`${amt} ${name}`);
        });

        converted.push({
            id: autoId++,
            name: r.Machine || "unknown machine",
            inputs: inputs,
            outputs: outputs,
            origTime: hasVariableTime ? -1 : time,
            power: parseMF(r.MF),
            cost: 0,
            rawIn: inputParts.join(', '),
            rawOut: outputParts.join(', '),
            isVariableTime: hasVariableTime
        });
    });

    return converted;
}



function addRecipe() {
    const editId = document.getElementById('editId').value;
    const id = editId || Date.now();
    const name = document.getElementById('mName').value.trim();
    const time = parseFloat(document.getElementById('mTime').value);

    if (!name || !time) {
        showBanner("Machine Name and Time are required.");
        return;
    }

    // Same rule as the import converter: a non-positive time (most
    // notably -1, used by some recipes for a variable/steam-
    // dependent process time) isn't a real divisor. Skip rate math
    // for those instead of dividing by a negative or zero number.
    const hasVariableTime = time <= 0;

    const existingIdx = recipes.findIndex(r => r.id == id);

    // Editing an existing machine must not silently re-enable it —
    // keep whatever enabled/disabled state it already had. Brand
    // new machines start enabled.
    const existingDisabled = existingIdx > -1 ? !!recipes[existingIdx].disabled : false;

    const recipeData = {
        id: id,
        name: name,
        inputs: hasVariableTime ? {} : parseItems(document.getElementById('mInputs').value, time),
        outputs: hasVariableTime ? {} : parseItems(document.getElementById('mOutputs').value, time),
        origTime: hasVariableTime ? -1 : time,
        power: parseFloat(document.getElementById('mPower').value) || 0,
        cost: parseFloat(document.getElementById('mCost').value) || 0,
        rawIn: document.getElementById('mInputs').value,
        rawOut: document.getElementById('mOutputs').value,
        isVariableTime: hasVariableTime,
        disabled: existingDisabled
    };

    if (existingIdx > -1) {
        recipes[existingIdx] = recipeData;
    } else {
        recipes.push(recipeData);
    }

    saveData();
    displayRecipes();
    resetRecipeForm();
}

function resetRecipeForm() {
    ['mName', 'mTime', 'mPower', 'mCost', 'mInputs', 'mOutputs', 'editId'].forEach(id => document.getElementById(id).value = '');

    const panel = document.getElementById('creatorPanel');
    panel.classList.remove('editing');

    document.getElementById('saveBtn').classList.remove('editing');
    document.getElementById('saveBtn').innerText = "Save Recipe";
    document.getElementById('cancelEditBtn').style.display = 'none';
}

function editRecipe(id) {
    const r = recipes.find(rec => rec.id == id);
    if (!r) return;

    document.getElementById('editId').value = r.id;
    document.getElementById('mName').value = r.name;
    document.getElementById('mTime').value = r.origTime;
    document.getElementById('mPower').value = r.power;
    document.getElementById('mCost').value = r.cost;
    document.getElementById('mInputs').value = r.rawIn;
    document.getElementById('mOutputs').value = r.rawOut;

    // UI Feedback
    const panel = document.getElementById('creatorPanel');
    panel.classList.add('editing');
    panel.classList.remove('collapsed');   // make sure the form is visible

    document.getElementById('saveBtn').classList.add('editing');
    document.getElementById('saveBtn').innerText = "Update Machine";
    document.getElementById('cancelEditBtn').style.display = 'block';

    const nameField = document.getElementById('mName');
    if (nameField.scrollIntoView) {
        nameField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function toggleCreator() {
    document.getElementById('creatorPanel').classList.toggle('collapsed');
}

function parseItems(str, time) {
    const obj = {};
    if (!str) return obj;
    str.split(',').forEach(p => {
        const parts = p.trim().split(' ');
        const qty = parseFloat(parts[0]);
        const item = parts.slice(1).join(' ').toLowerCase().trim();
        if (item && Number.isFinite(qty)) {
            obj[item] = (obj[item] || 0) + (qty / time);
        }
    });
    return obj;
}



// Which DAG view is currently visible: 'text' or 'graphic'.
// Persists across re-simulate / advanced-toggle so switching tabs
// doesn't reset when the user re-runs the sim.
let activeDagView = 'text';

// Cached { nodes, edges, target } from the most recent calculateAll(),
// so switching to the Graphic tab (or toggling Advanced View while on
// it) can re-render from cache instead of re-running the solver.
let lastGraphData = null;

function setDagView(view) {
    activeDagView = view;
    updateDagViewVisibility();
    writeStateToHash();

    // Lazily render the graphic view the first time it's switched to,
    // using whatever data is currently cached from the last run.
    // (renderGraphDAG is async: it shows a "Laying out…" state, loads
    // ELK on first use, and ignores itself if superseded.)
    if (view === 'graphic' && lastGraphData) {
        const graphContainer = document.getElementById('machineGraph');
        const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
        if (graphContainer && !graphContainer.hasChildNodes()) {
            renderGraphDAGSafe(graphContainer, lastGraphData, isAdvanced);
        }
    }
}

function updateDagViewVisibility() {
    const textEl = document.getElementById('machineList');
    const graphEl = document.getElementById('machineGraph');
    const tabText = document.getElementById('dagTab-text');
    const tabGraphic = document.getElementById('dagTab-graphic');
    const zoomControls = document.getElementById('dagZoomControls');

    if (!textEl || !graphEl) return;

    const showGraphic = activeDagView === 'graphic';

    textEl.style.display = showGraphic ? 'none' : 'block';
    graphEl.style.display = showGraphic ? 'block' : 'none';
    if (zoomControls) zoomControls.style.display = showGraphic ? 'flex' : 'none';

    if (tabText) {
        tabText.classList.toggle('active', !showGraphic);
        tabText.setAttribute('aria-selected', String(!showGraphic));
    }
    if (tabGraphic) {
        tabGraphic.classList.toggle('active', showGraphic);
        tabGraphic.setAttribute('aria-selected', String(showGraphic));
    }
}

function dagZoomIn() {
    const c = document.getElementById('machineGraph');
    if (c && c._dagZoomIn) c._dagZoomIn();
}
function dagZoomOut() {
    const c = document.getElementById('machineGraph');
    if (c && c._dagZoomOut) c._dagZoomOut();
}
function dagZoomReset() {
    const c = document.getElementById('machineGraph');
    if (c && c._dagZoomReset) c._dagZoomReset();
}

function calculateAll(rerollColors = false) {
    const container = document.getElementById('machineList');
    const graphContainer = document.getElementById('machineGraph');

    container.innerHTML = "";
    if (graphContainer) {
        // Layout is async: drop any in-flight render so a stale graph
        // can't be mounted after we clear the container.
        cancelDagRender(graphContainer);
        graphContainer.innerHTML = "";
    }

    // Re-roll only for a fresh calculation. Toggling Advanced View
    // redraws the same DAG and should not change its color mapping.
    if (rerollColors) {
        dagCollapsed = new Set();
        sharedColorAssignments.clear();
        usedSharedColors.clear();
    }

    document.getElementById('results').style.display = 'block';
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.style.display = 'none';

    const target = document.getElementById('targetItem').value
        .toLowerCase()
        .trim();

    const qty = parseFloat(
        document.getElementById('targetQty').value
    );

    const time = parseFloat(
        document.getElementById('targetTime').value
    );

    if (!target || isNaN(qty) || isNaN(time) || time <= 0) {
        showBanner("Enter a Target Item, Quantity, and Time.");
        return;
    }

    let data;
    try {
        data = runLogic(target, qty, time);
    } catch (err) {
        reportError("The simulation failed", err);
        return;
    }

    activeRecipeIds = new Set(
        Object.values(data.treeData)
            .flat()
            .map(node => node.recipeId)
    );
    displayRecipes();

    const section = document.createElement('div');

    section.style.marginBottom = "40px";

    section.innerHTML = `
        <div style="
            color:var(--secondary);
            font-weight:bold;
            border-bottom:1px solid var(--secondary);
            margin-bottom:15px;
        ">
            📦 ${escapeHtml(target.toUpperCase())} PRODUCTION
        </div>
    `;

    section.innerHTML += renderNode(
        data.treeData,
        target,
        data.flowTotals[target],
        data.flowTotals,
        0,
        true,
        "",
        new Set(),
        new Set(),
        data.sharedItems,
        data.byproductSupplied,
        data.byproductSource
    );

    container.appendChild(section);

    // ---- GRAPHIC DAG ----
    // Build once per simulation run (cheap relative to layout) and
    // store so switching tabs or toggling Advanced View doesn't need
    // to re-run the solver — just re-layout/re-render from cached data.
    try {
        lastGraphData = buildGraphDataRoot(data, target);
    } catch (err) {
        lastGraphData = null;
        reportError("The production graph could not be built", err);
    }

    if (graphContainer) {
        const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
        if (activeDagView === 'graphic') {
            renderGraphDAGSafe(graphContainer, lastGraphData, isAdvanced);
        }
    }

    updateDagViewVisibility();
    writeStateToHash();

    const bank =
        parseFloat(
            document.getElementById('currentBank').value
        ) || 0;

    const remaining = bank - data.totalCost;

    // Power can be net-negative when generators (Coal Generator,
    // Steam Turbine, etc. — recipes with negative MF in the source
    // data) produce more than the rest of the tree consumes. Label
    // and color that as a surplus rather than showing a bare
    // negative KW figure, which would look like a display bug.
    const isPowerSurplus = data.totalPwr < 0;
    const powerLabel = isPowerSurplus ? "Net Power Surplus" : "Total Factory Power Draw";
    const powerColor = isPowerSurplus ? 'var(--success)' : 'var(--accent)';
    const powerValue = Math.abs(data.totalPwr).toLocaleString();

    document.getElementById('summaryList').innerHTML = `
        <div style="color:${powerColor}">
            ${powerLabel}:
            <b>${powerValue} MF</b>
        </div>

        <div style="color:var(--danger)">
            Total Build Cost:
            <b>$${data.totalCost.toLocaleString()}</b>
        </div>

        <div style="
            font-size:1.2em;
            margin-top:10px;
            color:${remaining >= 0
            ? 'var(--success)'
            : 'var(--danger)'
        };
        ">
            Remaining Bank:
            <b>$${remaining.toLocaleString()}</b>
        </div>
    `;
}



function runLogic(target, qty, time) {
    let totalPwr = 0;
    let totalCost = 0;

    const EPSILON = 1e-9;

    // =========================================================
    // GLOBAL RESOURCE BALANCE
    // =========================================================

    // demand[item] = how much the factory needs
    // supply[item] = how much the factory has already produced
    let demand = {};
    let supply = {};

    let flowTotals = {};
    let treeData = {};

    // byproductSupplied[item] = how much of this item's total demand
    // was covered by internally-produced byproduct supply, even for
    // items that end up falling back to [RAW] for the remainder.
    // Example: C makes 0.5 x/s as a byproduct while B needs 1.5 x/s;
    // 0.5 gets used internally and only the remaining 1.0 is truly
    // external. Without this, the tree would just say "[RAW] x" and
    // hide that 0.5/s of it actually came from your own factory.
    let byproductSupplied = {};

    // byproductSource[item] = { machineName, sourceItem } — which
    // machine/recipe produced this item as a byproduct, so the
    // renderer can say "recycled from C" instead of a bare number.
    // sourceItem is the recipe's PRIMARY output (the item name that
    // triggered that machine's construction), used to build the
    // "jump to" anchor link back to that machine's full expansion.
    let byproductSource = {};

    // recipeNodeRegistry: recipe.id -> the ONE node object representing
    // all machines built for that recipe, no matter which item(s)
    // triggered the build.
    //
    // BUG THIS FIXES: a recipe with multiple co-products (e.g. a Steam
    // Cracking Plant that outputs both petro-gas AND polymer-resin) can
    // get invoked from solveItem() more than once — once per co-product
    // that's independently needed downstream. addMachineNode() used to
    // key nodes by the ITEM being solved, so each of those calls created
    // its own separate node (e.g. two "0.14x" nodes). Each one then got
    // rounded up to a whole machine INDEPENDENTLY at render time — 2
    // machines recommended, when really one 0.28x machine (still just 1
    // whole machine) covers both. Keying by the recipe's stable id
    // instead means every build of "the same machine" — regardless of
    // which output triggered it — accumulates into one shared node, so
    // it's counted and rounded exactly once.
    let recipeNodeRegistry = new Map();

    demand[target] = qty / time;
    flowTotals[target] = qty / time;


    // =========================================================
    // MACHINE NODE CREATION
    // =========================================================

    function addMachineNode(item, recipe, machinesNeeded) {
        if (!treeData[item]) {
            treeData[item] = [];
        }

        let node = recipeNodeRegistry.get(recipe.id);

        if (node) {
            // This exact recipe already has machines built elsewhere
            // in the tree (for a different output). Reuse that SAME
            // node — don't fork a second one under this item.
            if (!treeData[item].includes(node)) {
                treeData[item].push(node);
            }
        } else {
            node = {
                machine: recipe.name,
                recipeId: recipe.id,
                count: 0,
                allOutputs: recipe.outputs,
                inputs: []
            };

            treeData[item].push(node);
            recipeNodeRegistry.set(recipe.id, node);
        }

        node.count += machinesNeeded;


        for (let input in recipe.inputs) {
            const inputRate =
                recipe.inputs[input] * machinesNeeded;

            const existingInput =
                node.inputs.find(
                    i => i.itemName === input
                );

            if (existingInput) {
                existingInput.rate += inputRate;
            } else {
                node.inputs.push({
                    itemName: input,
                    rate: inputRate
                });
            }
        }
    }


    // =========================================================
    // FIND THE BEST PRODUCER
    // =========================================================
    //
    // The old version simply used producers[0].
    //
    // That's dangerous when a machine has a byproduct:
    //
    // B -> B + Z
    // Z -> Z
    //
    // If we need Z, blindly choosing B creates:
    //
    // B -> A -> Z -> B -> A -> Z...
    //
    // Instead, reject producers whose inputs would lead back
    // into the dependency chain we're currently solving.
    //

    function chooseProducer(item, ancestry) {

        const producers =
            findAllProducers(item);

        if (producers.length === 0) {
            return null;
        }


        const validProducers = producers.filter(producer => {

            const recipe =
                producer.fullRecipe;

            const rate =
                producer.rate;

            // Invalid recipe.
            if (
                !Number.isFinite(rate) ||
                rate <= EPSILON
            ) {
                return false;
            }


            // Prevent dependency cycles.
            //
            // Example:
            // ancestry = [B, A]
            //
            // Candidate Z producer = Z machine
            // inputs = []
            // -> valid
            //
            // Candidate Z producer = B machine
            // inputs = [A]
            // -> A is already in ancestry
            // -> reject
            for (let input in recipe.inputs) {
                if (ancestry.has(input)) {
                    return false;
                }
            }

            return true;
        });


        if (validProducers.length === 0) {
            return null;
        }


        // Prefer simpler producers.
        //
        // This naturally prefers:
        //
        // Z machine -> produces Z directly
        //
        // over:
        //
        // B machine -> produces B + Z and needs A
        //
        // TIE-BREAK: when two producers need the same number of
        // distinct input items (a very common tie — e.g. "Roller"
        // and "Industrial Roller" both take just steel plate),
        // input-count alone can't distinguish them. Without a
        // second key, Array.sort's stability falls back to
        // insertion order — effectively "whichever recipe you
        // added/imported first" — which silently picked the
        // slower Roller (8s) over the faster Industrial Roller
        // (6s) even though the industrial version is strictly
        // better. Break ties by preferring the HIGHER per-second
        // output rate for the target item, since a higher rate
        // means fewer machines needed to hit the same throughput
        // (accounts for both the recipe's time AND its output
        // quantity per cycle, which is more correct than just
        // comparing machine times directly).
        //
        validProducers.sort((a, b) => {

            const aInputs =
                Object.keys(a.fullRecipe.inputs).length;

            const bInputs =
                Object.keys(b.fullRecipe.inputs).length;

            if (aInputs !== bInputs) {
                return aInputs - bInputs;
            }

            // Tie on input count — prefer the faster/more
            // efficient producer (higher output rate first).
            return b.rate - a.rate;
        });


        return validProducers[0];
    }


    // =========================================================
    // SOLVE ONE ITEM
    // =========================================================

    function solveItem(
        item,
        requiredAmount,
        ancestry = new Set()
    ) {
        if (
            !Number.isFinite(requiredAmount) ||
            requiredAmount <= EPSILON
        ) {
            return;
        }

        // Track total requested flow
        flowTotals[item] =
            (flowTotals[item] || 0) + requiredAmount;

        // =====================================================
        // USE EXISTING SUPPLY FIRST
        // =====================================================

        const available =
            supply[item] || 0;

        const used =
            Math.min(available, requiredAmount);

        supply[item] =
            available - used;

        if (used > EPSILON) {
            byproductSupplied[item] =
                (byproductSupplied[item] || 0) + used;
        }

        const deficit =
            requiredAmount - used;

        // Completely satisfied by existing production
        if (deficit <= EPSILON) {
            return;
        }

        // =====================================================
        // CYCLE PROTECTION
        // =====================================================

        if (ancestry.has(item)) {
            console.warn(
                `Production cycle detected while solving "${item}".`,
                [...ancestry, item]
            );
            return;
        }

        const nextAncestry =
            new Set(ancestry);

        nextAncestry.add(item);

        // =====================================================
        // FIND PRODUCER
        // =====================================================

        const producer =
            chooseProducer(
                item,
                nextAncestry
            );

        // No producer = raw resource
        if (!producer) {
            console.warn(
                `No valid producer found for "${item}". ` +
                `Treating it as a raw resource.`
            );
            return;
        }

        const recipe =
            producer.fullRecipe;

        const rate =
            producer.rate;

        if (
            !Number.isFinite(rate) ||
            rate <= EPSILON
        ) {
            console.error(
                `Invalid production rate for ${recipe.name}:`,
                rate
            );
            return;
        }

        // =====================================================
        // MACHINE COUNT
        // =====================================================
        //
        // DO NOT ROUND HERE.
        //
        // A value like:
        //
        // 0.25 blast furnace
        //
        // means 25% of one machine's production capacity.
        //
        // Physical machine counts can be rounded at the end.
        //

        const machinesNeeded =
            deficit / rate;

        if (
            !Number.isFinite(machinesNeeded) ||
            machinesNeeded <= EPSILON
        ) {
            console.error(
                `Invalid machine count for ${recipe.name}:`,
                machinesNeeded
            );
            return;
        }

        // =====================================================
        // COST / POWER
        // =====================================================

        totalPwr +=
            (recipe.power || 0) *
            machinesNeeded;

        totalCost +=
            (recipe.cost || 0) *
            machinesNeeded;

        // =====================================================
        // DISPLAY TREE
        // =====================================================

        addMachineNode(
            item,
            recipe,
            machinesNeeded
        );

        // =====================================================
        // PRODUCE ALL OUTPUTS
        // =====================================================
        //
        // BUGFIX: machinesNeeded was derived as
        // `deficit / rate`, so by construction
        // `machinesNeeded * recipe.outputs[item] === deficit`
        // EXACTLY for the item we're currently solving. That
        // amount is already fully spoken for (it's what closes
        // THIS deficit) — it must NOT be re-added to `supply`,
        // or a later, unrelated branch that also needs `item`
        // will see phantom leftover supply, consume it for
        // free, and under-build machines for its own real
        // demand. This under-counts every item that has more
        // than one downstream consumer anywhere in the tree.
        //
        // Any OTHER outputs (byproducts) from this recipe are
        // real surplus and should still be banked normally.
        //

        for (let output in recipe.outputs) {

            const produced =
                recipe.outputs[output] *
                machinesNeeded;

            if (!Number.isFinite(produced)) {
                console.error(
                    `Invalid output for ${recipe.name}:`,
                    output,
                    produced
                );
                continue;
            }

            const isSameItemRecirculation =
                output === item &&
                Number.isFinite(recipe.inputs[output]) &&
                recipe.inputs[output] > 0;

            if (output === item) {
                // Exactly covers the deficit we just solved for.
                // Do not bank it into the general supply ledger, or a
                // later unrelated branch will erroneously "see" free
                // product and under-build real demand. However, if the
                // same item is also consumed by this recipe (e.g. a boiler
                // that recycles its own water while producing steam), we
                // should still record that portion as internal recycling so
                // the renderer can show "recycled from Boiler" instead of
                // falling through to [RAW].
                if (isSameItemRecirculation) {
                    byproductSupplied[output] =
                        (byproductSupplied[output] || 0) +
                        produced;

                    if (!byproductSource[output]) {
                        byproductSource[output] = {
                            machineName: recipe.name,
                            sourceItem: item,
                            recipeId: recipe.id
                        };
                    }
                }
                continue;
            }

            supply[output] =
                (supply[output] || 0) +
                produced;

            // Remember which machine/recipe produced this byproduct.
            // Keep the FIRST valid source for an item instead of
            // overwriting it later with another unrelated recipe,
            // otherwise stale mappings cause false recycled outlines
            // on machines that are not actually producing the item in
            // the current branch.
            if (!byproductSource[output]) {
                byproductSource[output] = {
                    machineName: recipe.name,
                    sourceItem: item,
                    recipeId: recipe.id
                };
            }
        }

        // =====================================================
        // PROCESS INPUTS
        // =====================================================

        for (let input in recipe.inputs) {

            const inputRate =
                recipe.inputs[input] *
                machinesNeeded;

            if (!Number.isFinite(inputRate)) {
                console.error(
                    `Invalid input rate for ${recipe.name}:`,
                    input,
                    inputRate
                );
                continue;
            }

            solveItem(
                input,
                inputRate,
                nextAncestry
            );
        }
    }


    // =========================================================
    // START CALCULATION
    // =========================================================

    // The target is already registered in demand above,
    // so solve it using the initial required amount.
    //
    // We call the actual solving logic with the target's
    // original requirement.
    //

    // Reset target demand because solveItem() adds it itself.
    demand = {};
    flowTotals = {};

    solveItem(
        target,
        qty / time
    );


    // =========================================================
    // SHARED-NODE DETECTION
    // =========================================================
    //
    // For every item, count how many DISTINCT parent items
    // require it as an input somewhere in treeData. An item
    // needed by 2+ different parents is a "shared" resource —
    // its subtree only gets expanded once in the render pass
    // (see renderNode's [SEE ABOVE] logic), so we flag it here
    // to visually highlight both the original expansion and
    // every collapsed reference back to it.
    //

    const consumerCount = {};

    for (const parentItem in treeData) {
        treeData[parentItem].forEach(node => {
            node.inputs.forEach(inp => {
                if (!consumerCount[inp.itemName]) {
                    consumerCount[inp.itemName] = new Set();
                }
                consumerCount[inp.itemName].add(parentItem);
            });
        });
    }

    const sharedItems = new Set(
        Object.keys(consumerCount).filter(
            item => consumerCount[item].size > 1
        )
    );


    // =========================================================
    // RETURN RESULTS
    // =========================================================

    return {
        treeData,
        flowTotals,
        totalPwr,
        totalCost,
        sharedItems,
        byproductSupplied,
        byproductSource
    };
}




// =========================================================
// COLOR FOR SHARED ITEMS — RESHUFFLED EACH GENERATE, STABLE
// WITHIN ONE RENDER
// =========================================================
//
// Each distinct shared item (e.g. "steel ingot" vs "iron mix")
// gets its own color, generated from a hash of its name mixed
// with a seed. The seed is re-rolled for each fresh calculation
// (every "Run Simulation" press), so colors look different from
// one generate to the next. Toggling Advanced View reuses the
// existing seed, so the seed itself is fixed for
// the DURATION of a single render, so within that one tree the
// badge on a machine's full expansion and every "⤴ shared
// above" pointer to it still land on the exact same color. If
// the seed changed mid-render, the whole point of the
// color-matching feature (visually pairing a node with its
// references) would break.
//
// A small curated palette is used instead of fully random hex
// values so every color stays readable on a dark UI background
// (decent contrast, not too dark/muddy, not neon).
//
const SHARED_ITEM_PALETTE = [
    "#e76f51", "#2a9d8f", "#e9c46a", "#264653",
    "#f4a261", "#457b9d", "#8ab17d", "#d62828",
    "#6a4c93", "#118ab2", "#ff006e", "#8338ec",
    "#3a86ff", "#06d6a0", "#fb5607", "#ffbe0b",
    "#7209b7", "#4361ee", "#4cc9f0", "#f72585",
    "#588157", "#bc6c25", "#006d77", "#ef476f",
];

// Item-to-color assignments stay stable while the current DAG is
// redrawn. Each new item gets the palette color farthest from the
// colors already assigned, avoiding duplicate or near-duplicate
// highlights even when item hashes collide.
const sharedColorAssignments = new Map();
const usedSharedColors = new Set();

// Seed for the colour hash. Fixed, so the same item gets the same colour
// on every run and in every session; collisions are resolved by the order
// items are first seen in a run (which is itself deterministic).
let currentColorSeed = 0;

function getSharedItemColor(itemName, seed = currentColorSeed) {
    if (sharedColorAssignments.has(itemName)) {
        return sharedColorAssignments.get(itemName);
    }

    let hash = seed >>> 0;
    for (let i = 0; i < itemName.length; i++) {
        hash = (Math.imul(hash, 31) + itemName.charCodeAt(i)) >>> 0;
    }

    const availableColors = SHARED_ITEM_PALETTE.filter(
        color => !usedSharedColors.has(color)
    );

    let selectedColor;

    if (availableColors.length > 0) {
        const colorDistance = (first, second) => {
            const firstRgb = [1, 3, 5].map(
                offset => parseInt(first.slice(offset, offset + 2), 16)
            );
            const secondRgb = [1, 3, 5].map(
                offset => parseInt(second.slice(offset, offset + 2), 16)
            );

            return Math.sqrt(firstRgb.reduce(
                (total, value, index) => total + (value - secondRgb[index]) ** 2,
                0
            ));
        };

        const assignedColors = [...usedSharedColors];
        selectedColor = availableColors
            .map((color, index) => ({
                color,
                index,
                distance: assignedColors.length === 0
                    ? 0
                    : Math.min(...assignedColors.map(
                        assigned => colorDistance(color, assigned)
                    ))
            }))
            .sort((first, second) =>
                second.distance - first.distance ||
                ((first.index + hash) % availableColors.length) -
                ((second.index + hash) % availableColors.length)
            )[0].color;
    } else {
        let hue = (hash + usedSharedColors.size * 137.5) % 360;
        selectedColor = `hsl(${hue}, 75%, 55%)`;

        while (usedSharedColors.has(selectedColor)) {
            hue = (hue + 137.5) % 360;
            selectedColor = `hsl(${hue}, 75%, 55%)`;
        }
    }

    sharedColorAssignments.set(itemName, selectedColor);
    usedSharedColors.add(selectedColor);
    return selectedColor;
}


function renderNode(
    treeData,
    itemName,
    requiredRate,
    flowTotals,
    depth,
    isLast = true,
    prefix = "",
    visited = new Set(),
    rendered = new Set(),   // global set of items already fully expanded,
                             // shared (by reference) across every branch of this render pass.
                             // This is intentionally separate from `visited`, which only
                             // tracks the current branch for cycle detection.
    sharedItems = new Set(), // items consumed by 2+ distinct parents.
                              // Used to visually flag both the original
                              // expansion and every collapsed reference,
                              // so it's obvious at a glance which machine
                              // is feeding multiple downstream consumers.
    byproductSupplied = {},  // NEW: item -> amount of its demand that
                              // was covered by internally-produced
                              // byproduct supply (see runLogic).
    byproductSource = {},    // NEW: item -> { machineName, sourceItem }
                              // for whichever machine produced it as
                              // a byproduct, so a "raw" item that's
                              // actually (partly) recycled internally
                              // can say so instead of just [RAW].
    renderedRecipes = new Set() // global set of recipe ids already fully
                              // drawn as a machine block anywhere in this
                              // render pass. A recipe with 2+ co-products
                              // (e.g. Steam Cracking Plant making both
                              // petro-gas and polymer-resin) can be reached
                              // via more than one item branch; this makes
                              // sure it's only drawn once — every later
                              // branch that needs it gets a short pointer
                              // back to the original block instead of a
                              // second full copy with its own (misleadingly
                              // separate) machine count.
) {
    const isShared = sharedItems.has(itemName);

    // Each shared item gets its own consistent color (see
    // getSharedItemColor) so multiple different shared items in
    // the same tree are visually distinguishable from each other,
    // not all lumped into one indistinguishable orange highlight.
    const sharedColor = isShared ? getSharedItemColor(itemName) : null;

    // Convert hex to an rgba() background tint at low opacity
    // (shared top-level helper, see hexToRgbaShared in the DAG section).
    const hexToRgba = hexToRgbaShared;

    // Consistent highlight color used everywhere this item appears —
    // at its full expansion AND at every collapsed reference spot —
    // so the eye can visually match them up.
    const sharedHighlightStyle = isShared
        ? `border-right: 3px solid ${sharedColor}; background: ${hexToRgba(sharedColor, 0.08)};`
        : "";

    const connector =
        depth === 0
            ? ""
            : (isLast ? "└─ " : "├─ ");

    const newPrefix =
        depth === 0
            ? ""
            : prefix +
            (isLast
                ? "&nbsp;&nbsp;&nbsp;&nbsp;"
                : "│&nbsp;&nbsp;&nbsp;");

    const inPrefix =
        depth === 0
            ? ""
            : prefix +
            (isLast
                ? "&nbsp;&nbsp;&nbsp;"
                : "│&nbsp;&nbsp;");

    const advancedToggle =
        document.getElementById('advancedToggle');

    const isAdvanced =
        advancedToggle
            ? advancedToggle.checked
            : false;


    // =========================================================
    // RAW RESOURCE (possibly partly or fully recycled)
    // =========================================================
    //
    // !treeData[itemName] means no machine was BUILT to cover this
    // item's remaining deficit — but that's not the same as "100%
    // external." A byproduct (e.g. C making x as a side output)
    // can fully or partially satisfy demand via the `supply`
    // ledger without ever triggering a new machine build. Check
    // byproductSupplied/byproductSource to tell the true story:
    //
    //   - recycledAmount <= ~0        -> genuinely external [RAW]
    //   - recycledAmount >= requiredRate -> fully recycled, no RAW at all
    //   - otherwise                   -> split: some recycled, some RAW
    //

    if (!treeData[itemName]) {

        const recycledAmount = byproductSupplied[itemName] || 0;
        const source = byproductSource[itemName];
        const trulyRawAmount = Math.max(0, requiredRate - recycledAmount);

        const EPS = 1e-6;

        // Fully covered by a byproduct — no external input needed at all.
        if (source && recycledAmount >= requiredRate - EPS) {

            const recycledColor = getSharedItemColor(itemName);
            const anchorId = `node-recipe-${escapeHtml(source.recipeId)}`;

            const rateStr = isAdvanced
                ? ` (${recycledAmount.toFixed(3)} ${escapeHtml(itemName)}/s)`
                : "";

            return `
                <div style="
                    font-family: monospace;
                    white-space: nowrap;
                    margin-bottom: 8px;
                    font-size: 16px;
                ">
                    <span style="color: #666;">
                        ${prefix}${connector}
                    </span>

                    <a href="#${anchorId}" style="color:${recycledColor}; font-weight:bold; text-decoration:none;" title="Jump to ${escapeHtml(source.machineName)}, which produces this as a byproduct">
                        ♻ recycled from ${escapeHtml(source.machineName.toUpperCase())}
                    </a>

                    <span style="color:${recycledColor};">
                        ${escapeHtml(itemName)}${rateStr}
                    </span>
                </div>
            `;
        }

        // Partly covered by a byproduct, partly genuinely external.
        if (source && recycledAmount > EPS) {

            const recycledColor = getSharedItemColor(itemName);
            const anchorId = `node-recipe-${escapeHtml(source.recipeId)}`;

            const rateStr = isAdvanced
                ? ` (${recycledAmount.toFixed(3)}/s recycled, ${trulyRawAmount.toFixed(3)}/s raw)`
                : "";

            return `
                <div style="
                    font-family: monospace;
                    white-space: nowrap;
                    margin-bottom: 8px;
                    font-size: 16px;
                ">
                    <span style="color: #666;">
                        ${prefix}${connector}
                    </span>

                    <span style="color:#3498db;">[RAW]</span>

                    <span style="color:#3498db;">
                        ${escapeHtml(itemName)}
                    </span>

                    <a href="#${anchorId}" style="color:${recycledColor}; font-size:0.85em; text-decoration:none;" title="Jump to ${escapeHtml(source.machineName)}, which produces some of this as a byproduct">
                        (♻ partly recycled from ${escapeHtml(source.machineName.toUpperCase())}${rateStr})
                    </a>
                </div>
            `;
        }

        // Genuinely external — no internal source at all.
        // Still apply the shared-item highlight/badge if this raw
        // item is consumed by 2+ different machines elsewhere in
        // the tree (e.g. "crude oil" needed by both a steam
        // cracking plant AND a plastic refinery) — otherwise a
        // shared RAW input looks like two unrelated inputs instead
        // of one resource you need to size for combined demand.
        const displayVal =
            isAdvanced
                ? `${requiredRate.toFixed(3)} ${escapeHtml(itemName)}/s`
                : escapeHtml(itemName);

        const rawSharedBadge = isShared
            ? `<span style="
                   color:${sharedColor};
                   font-size:0.75em;
                   font-weight:bold;
                   border:1px solid ${sharedColor};
                   border-radius:4px;
                   padding:1px 5px;
                   margin-left:6px;
               " title="This raw input is needed by multiple machines elsewhere in the tree — sum the rates to know your true total requirement">
                   ⑂ shared: ${escapeHtml(itemName)}
               </span>`
            : "";

        return `
            <div style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 8px;
                font-size: 16px;
                ${sharedHighlightStyle}
            ">
                <span style="color: #666;">
                    ${prefix}${connector}
                </span>

                <span style="color:#3498db;">
                    [RAW] ${displayVal}
                </span>

                ${rawSharedBadge}
            </div>
        `;
    }


    // =========================================================
    // CYCLE PROTECTION (SAME BRANCH)
    // =========================================================
    //
    // If we have already visited this item somewhere above
    // this branch, don't recursively render it again.
    //

    if (visited.has(itemName)) {

        const displayVal =
            isAdvanced
                ? `${requiredRate.toFixed(3)} ${escapeHtml(itemName)}/s`
                : escapeHtml(itemName);

        return `
            <div style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 8px;
                font-size: 16px;
            ">
                <span style="color: #666;">
                    ${prefix}${connector}
                </span>

                <span style="color:var(--danger);">
                    [CYCLE] ${displayVal}
                </span>
            </div>
        `;
    }


    // =========================================================
    // ALREADY FULLY RENDERED ELSEWHERE — SHOW COLLAPSED REFERENCE
    // =========================================================
    //
    // treeData[itemName]'s machine counts are GLOBAL TOTALS —
    // solveItem() shares supply/demand across the ENTIRE tree,
    // not per-branch. So if "steel ingot" is needed by both the
    // "steel rod" branch and the "steel plate" branch, the
    // 0.29x blast furnace figure already accounts for BOTH.
    //
    // If we expand its subtree again here, we're not adding any
    // extra machines to the totals (those are computed once in
    // runLogic), but we ARE printing the same subtree twice,
    // which reads as if double the machines are required.
    //
    // Fix: expand any given item's subtree only once per render
    // pass. Every later occurrence (in ANY branch) becomes a
    // short pointer back to the first expansion instead of a
    // full recursive re-render.
    //
    if (rendered.has(itemName)) {

        const totalRate =
            flowTotals[itemName] !== undefined
                ? flowTotals[itemName]
                : requiredRate;

        const rateStr = isAdvanced
            ? ` (${totalRate.toFixed(3)}/s total)`
            : "";

        const anchorId = `node-item-${itemName.replace(/[^a-zA-Z0-9]/g, '_')}`;

        return `
            <div style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 8px;
                font-size: 16px;
                ${sharedHighlightStyle}
            ">
                <span style="color: #666;">
                    ${prefix}${connector}
                </span>

                <a href="#${anchorId}" style="color:${sharedColor}; font-weight:bold; text-decoration:none;" title="Jump to full breakdown above">
                    ⤴ shared above: ${escapeHtml(itemName)}${rateStr}
                </a>
            </div>
        `;
    }

    // Mark this item as fully expanded BEFORE recursing, so that
    // if it appears again anywhere else in the tree (including
    // deeper inside its own subtree via a different path), it
    // collapses instead of re-expanding.
    rendered.add(itemName);


    // Create a new Set for this branch.
    //
    // This is important because an item can legitimately appear
    // in two DIFFERENT branches without being a cycle.
    const branchVisited = new Set(visited);

    branchVisited.add(itemName);


    let html = `<a id="node-item-${itemName.replace(/[^a-zA-Z0-9]/g, '_')}"></a>`;


    treeData[itemName].forEach((node) => {

        // =====================================================
        // CO-PRODUCT ALREADY DRAWN ELSEWHERE
        // =====================================================
        //
        // A recipe with multiple outputs (e.g. Steam Cracking Plant
        // making both petro-gas and polymer-resin) can be reached
        // from more than one item branch — one branch needing
        // petro-gas, another needing polymer-resin. Both branches
        // resolve to the SAME node object (see recipeNodeRegistry in
        // runLogic), so its `count` already reflects the true
        // combined total. Draw the full machine block only the FIRST
        // time this recipe is encountered; every later branch just
        // points back to it, so the tree doesn't imply two separate
        // (and separately-rounded) machines where there's only one.
        if (renderedRecipes.has(node.recipeId)) {

            const anchorId = `node-recipe-${escapeHtml(node.recipeId)}`;
            const pointerColor = getSharedItemColor(itemName);

            const rateStr = isAdvanced
                ? ` (${node.count.toFixed(3)}x total)`
                : "";

            html += `
                <div style="
                    font-family: monospace;
                    white-space: nowrap;
                    margin-bottom: 8px;
                    font-size: 16px;
                ">
                    <span style="color: #666;">
                        ${prefix}${connector}
                    </span>

                    <a href="#${anchorId}" style="color:${pointerColor}; font-weight:bold; text-decoration:none;" title="This machine also makes ${escapeHtml(itemName)} as a co-product — already counted in its full breakdown above">
                        ⤴ shared above: ${escapeHtml(node.machine.toUpperCase())} (also makes ${escapeHtml(itemName)}${rateStr})
                    </a>
                </div>
            `;

            return;
        }

        renderedRecipes.add(node.recipeId);

        let outputStrings = [];


        // =====================================================
        // OUTPUTS
        // =====================================================

        for (let out in node.allOutputs) {

            const totalRate =
                node.allOutputs[out] *
                node.count;

            outputStrings.push(
                isAdvanced
                    ? `${totalRate.toFixed(3)} ${escapeHtml(out)}/s`
                    : escapeHtml(out)
            );
        }


        // =====================================================
        // INPUTS
        // =====================================================

        let inputStrings =
            node.inputs.map(inp =>
                isAdvanced
                    ? `${inp.rate.toFixed(3)} ${escapeHtml(inp.itemName)}/s`
                    : escapeHtml(inp.itemName)
            );


        // =====================================================
        // MACHINE
        // =====================================================
        //
        // DISPLAY-ONLY ROUNDING.
        //
        // node.count stays exact (e.g. 0.3432) everywhere in the
        // data model — it's still used for input-rate math,
        // totals, and the collapsed [SEE ABOVE] figures. We only
        // round UP for what's shown to the person, since you
        // can't build 0.3432 of a machine; you need 1 whole one.
        //
        // Math.ceil rather than round(): a machine running at
        // partial capacity still fully covers the need (that's
        // the whole point of the fractional math), so rounding
        // DOWN would under-supply the chain. Always round up.
        //
        // The exact value is kept as a title tooltip and a small
        // inline note so the fractional/utilization info isn't
        // lost, just de-emphasized.

        const wholeMachines = Math.ceil(node.count - 1e-9);
        const exactStr = node.count.toFixed(4);

        const recycledSourceItem =
            Object.keys(byproductSource).find(
                sourceItem =>
                    byproductSource[sourceItem] &&
                    byproductSource[sourceItem].recipeId === node.recipeId
            ) ||
            (itemName && byproductSource[itemName] && byproductSource[itemName].recipeId === node.recipeId
                ? itemName
                : null);

        const recycledSourceColor =
            recycledSourceItem
                ? getSharedItemColor(recycledSourceItem)
                : null;

        // Badge shown only on the item's FIRST (full) expansion when
        // it's shared by 2+ different parents elsewhere in the tree —
        // same color as its matching "⤴ shared above" references,
        // so it's visually obvious this machine feeds more than one
        // downstream consumer, and which item it's the source of.
        const sharedBadge = isShared
            ? `<span style="
                   color:${sharedColor};
                   font-size:0.75em;
                   font-weight:bold;
                   border:1px solid ${sharedColor};
                   border-radius:4px;
                   padding:1px 5px;
                   margin-left:6px;
               " title="This machine's output (${escapeHtml(itemName)}) is shared by multiple downstream consumers">
                   ⑂ shared: ${escapeHtml(itemName)}
               </span>`
            : "";

        html += `
            <div id="node-recipe-${escapeHtml(node.recipeId)}" style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 0px;
                font-size: 16px;
                ${sharedHighlightStyle}
                ${recycledSourceColor ? `border: 2px solid ${recycledSourceColor}; box-shadow: 0 0 0 1px rgba(105, 129, 20, 0.45); background: rgba(105, 129, 20, 0.06); border-radius: 6px; padding: 4px 8px;` : ""}
            ">
                <span style="color: #666;">
                    ${prefix}${connector}
                </span>

                <b style="color:var(--accent)" title="Exact: ${exactStr}x">
                    ${wholeMachines}x
                </b>

                <b style="color:var(--text)">
                    ${escapeHtml(node.machine.toUpperCase())}
                </b>

                <span style="color:#888; font-size:0.8em;">
                    (${exactStr}x needed)
                </span>

                ${sharedBadge}
            </div>
        `;


        // =====================================================
        // OUTPUT DISPLAY
        // =====================================================

        html += `
            <div style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 0px;
                font-size: 16px;
                opacity: 0.9;
            ">
                <span style="color: #666;">
                    ${inPrefix}
                </span>

                <span style="
                    color: var(--success);
                    font-weight: 900;
                ">
                    │OUT:
                </span>

                ${outputStrings.join(', ')}
            </div>
        `;


        // =====================================================
        // INPUT DISPLAY
        // =====================================================

        html += `
            <div style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 8px;
                font-size: 16px;
                opacity: 0.9;
            ">
                <span style="color: #666;">
                    ${inPrefix}
                </span>

                <span style="
                    color: var(--danger);
                    font-weight: 900;
                ">
                    │IN :
                </span>

                ${inputStrings.length
                ? inputStrings.join(', ')
                : 'NONE'
            }
            </div>
        `;


        // =====================================================
        // RECURSE INTO INPUTS
        // =====================================================

        node.inputs.forEach((input, idx) => {

            html += renderNode(
                treeData,
                input.itemName,
                input.rate,
                flowTotals,
                depth + 1,
                idx === node.inputs.length - 1,
                newPrefix,
                branchVisited,
                rendered,             // propagate the same global set down
                sharedItems,          // propagate shared-item flags down
                byproductSupplied,    // propagate recycling info down
                byproductSource,
                renderedRecipes       // propagate recipe-level dedup down
            );

        });

    });


    return html;
}

// =========================================================
// GRAPHIC DAG — GRAPH DATA BUILDER
// =========================================================
//
// Mirrors renderNode()'s traversal EXACTLY (same recursion order,
// same `visited` / `rendered` / `renderedRecipes` dedup sets) but
// instead of emitting an HTML string, it emits a flat { nodes, edges }
// graph structure for the node-and-edge visualization. Keeping the
// two traversals in lockstep means the graphic view and text view
// always agree on what's collapsed, what's shared, and what's a
// cycle/raw/recycled leaf — no separate source of truth to drift.
//
// Node shape:
//   {
//     id,                 // unique within this render pass
//     kind,                // 'machine' | 'raw' | 'cycle'
//                          // (a recycled raw leaf is a 'raw' node with
//                          //  partialRecycle set, or no raw node at all)
//     label,                // machine or item name
//     itemName,             // item this node represents/produces
//     count, exactCount,    // machine count (machine nodes only)
//     rate,                 // it/s, for advanced-view labels
//     isShared, sharedColor,
//     recipeId
//   }
//
// Edge shape: { from, to, itemName, rate }

function buildGraphData(
    treeData,
    itemName,
    requiredRate,
    flowTotals,
    visited,
    rendered,
    sharedItems,
    byproductSupplied,
    byproductSource,
    renderedRecipes,
    nodes,
    edges,
    nodeIdForItem,     // item -> id of its full-expansion node (for cycle back-edges)
    nodeIdForRecipe,   // recipeId -> id of its machine node
    parentNodeId       // id of the node that consumes this item (edge target), or null for root
) {
    const EPS = 1e-6;
    let idCounter = buildGraphData._idCounter;

    function nextId(prefix) {
        buildGraphData._idCounter += 1;
        return `${prefix}_${buildGraphData._idCounter}`;
    }

    const isShared = sharedItems.has(itemName);
    const sharedColor = isShared ? getSharedItemColor(itemName) : null;

    // ---- RAW / RECYCLED LEAF ----
    //
    // Same three cases as renderNode's raw leaf, so the graph and the text
    // tree always agree on how much of this item is internal:
    //   - fully supplied by a byproduct   -> recycle edge at the full rate
    //   - partly supplied                 -> recycle edge at the supplied
    //                                        rate, plus a raw node and edge
    //                                        for the remainder
    //   - not supplied                    -> plain raw node
    if (!treeData[itemName]) {
        const recycledAmount = byproductSupplied[itemName] || 0;
        const source = byproductSource[itemName];
        const recycledColor = getSharedItemColor(itemName);
        const recycledPart = Math.min(recycledAmount, requiredRate);
        const rawPart = Math.max(0, requiredRate - recycledPart);

        const sourceNodeId = source ? nodeIdForRecipe.get(source.recipeId) : null;

        if (sourceNodeId && parentNodeId && recycledPart > EPS) {
            edges.push({
                from: sourceNodeId,
                to: parentNodeId,
                itemName,
                rate: recycledPart,
                // A TRUE recycle edge: a machine's own byproduct is
                // being fed back to satisfy demand elsewhere in the
                // tree. Distinct from isSharedEdge (below), which just
                // means "this item has more than one consumer" — a
                // recycle edge specifically means "the supply is a
                // byproduct, not the item's primary expansion."
                isRecycleEdge: true,
                sharedColor: recycledColor
            });

            if (rawPart > EPS) {
                const rawId = nextId('raw');
                nodes.push({
                    id: rawId, kind: 'raw', label: itemName, itemName,
                    rate: rawPart, isShared, sharedColor: recycledColor,
                    recycledSourceColor: recycledColor,
                    partialRecycle: { amount: recycledPart, machine: source.machineName }
                });
                edges.push({ from: rawId, to: parentNodeId, itemName, rate: rawPart });
            }
            return sourceNodeId;
        }

        const id = nextId('raw');
        nodes.push({
            id, kind: 'raw', label: itemName, itemName,
            rate: requiredRate, isShared, sharedColor: recycledColor,
            recycledSourceColor: recycledColor
        });

        if (parentNodeId) {
            edges.push({ from: id, to: parentNodeId, itemName, rate: requiredRate });
        }
        return id;
    }

    // ---- CYCLE ----
    if (visited.has(itemName)) {
        const id = nextId('cycle');
        nodes.push({ id, kind: 'cycle', label: itemName, itemName, rate: requiredRate });
        if (parentNodeId) {
            edges.push({ from: id, to: parentNodeId, itemName, rate: requiredRate });
        }
        return id;
    }

    // ---- ALREADY FULLY EXPANDED ELSEWHERE — draw a real edge back to it ----
    if (rendered.has(itemName)) {
        const targetId = nodeIdForItem.get(itemName);
        if (parentNodeId && targetId) {
            edges.push({
                from: targetId, to: parentNodeId, itemName,
                rate: requiredRate, isSharedEdge: true, sharedColor: getSharedItemColor(itemName)
            });
        }
        return targetId;
    }

    rendered.add(itemName);
    const branchVisited = new Set(visited);
    branchVisited.add(itemName);

    let firstNodeIdForThisItem = null;

    treeData[itemName].forEach((node) => {
        // Co-product recipe already drawn — just add an edge to it.
        if (renderedRecipes.has(node.recipeId)) {
            const targetId = nodeIdForRecipe.get(node.recipeId);
            if (parentNodeId && targetId) {
                edges.push({
                    from: targetId, to: parentNodeId, itemName,
                    rate: requiredRate, isSharedEdge: true,
                    sharedColor: isShared ? sharedColor : getSharedItemColor(itemName)
                });
            }
            if (!firstNodeIdForThisItem) firstNodeIdForThisItem = targetId;
            return;
        }

        renderedRecipes.add(node.recipeId);

        const machineId = nextId('m');
        nodeIdForRecipe.set(node.recipeId, machineId);
        if (!firstNodeIdForThisItem) firstNodeIdForThisItem = machineId;
        if (!nodeIdForItem.has(itemName)) nodeIdForItem.set(itemName, machineId);

        const outputs = Object.keys(node.allOutputs).map(out => ({
            itemName: out,
            rate: node.allOutputs[out] * node.count
        }));

        const recycledSourceItem =
            Object.keys(byproductSource).find(
                sourceItem =>
                    byproductSource[sourceItem] &&
                    byproductSource[sourceItem].recipeId === node.recipeId
            ) ||
            (itemName && byproductSource[itemName] && byproductSource[itemName].recipeId === node.recipeId
                ? itemName
                : null);

        const recycledSourceColor =
            recycledSourceItem
                ? getSharedItemColor(recycledSourceItem)
                : null;

        nodes.push({
            id: machineId,
            kind: 'machine',
            label: node.machine,
            itemName,
            recipeId: node.recipeId,
            count: Math.ceil(node.count - 1e-9),
            exactCount: node.count,
            outputs,
            inputSummary: node.inputs.map(inp => inp.itemName).join(', '),
            isShared, sharedColor, recycledSourceColor
        });

        if (parentNodeId) {
            edges.push({ from: machineId, to: parentNodeId, itemName, rate: requiredRate });
        }

        node.inputs.forEach(input => {
            buildGraphData(
                treeData, input.itemName, input.rate, flowTotals,
                branchVisited, rendered, sharedItems,
                byproductSupplied, byproductSource, renderedRecipes,
                nodes, edges, nodeIdForItem, nodeIdForRecipe, machineId
            );
        });
    });

    return firstNodeIdForThisItem;
}

function buildGraphDataRoot(data, target) {
    buildGraphData._idCounter = 0;

    const nodes = [];
    const edges = [];

    buildGraphData(
        data.treeData, target, data.flowTotals[target], data.flowTotals,
        new Set(), new Set(), data.sharedItems,
        data.byproductSupplied, data.byproductSource, new Set(),
        nodes, edges, new Map(), new Map(), null
    );

    return { nodes, edges, target };
}


// =========================================================
// GRAPHIC DAG — ELK LAYOUT + SVG RENDER
// =========================================================
//
// Geometry (node boxes + routed edge polylines) comes from
// dag-layout.js, which runs ELK's layered algorithm with orthogonal
// routing and fixed-side ports. This section turns that geometry into
// SVG. Visual styling lives in style.css (classes + --dag-* variables);
// the only inline styling is the per-item colour (--item-color).

function hexToRgbaShared(hex, alpha) {
    if (!hex || hex[0] !== '#') return `rgba(255,255,255,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Alias of escapeHtml (single implementation, defined below).
function svgEsc(str) {
    return escapeHtml(str);
}

// Truncate a label to fit the node width instead of overflowing/wrapping —
// full text is always available via <title> tooltip.
function fitLabel(str, maxChars) {
    const s = String(str);
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

// Fallback colour for a recycle edge with no per-item colour (rare:
// buildGraphData always sets one).
const DAG_RECYCLE_DEFAULT = '#7fd858';

// Nodes whose upstream steps are folded away. Cleared by each new Run.
let dagCollapsed = new Set();

// Layout direction: 'RIGHT' (left to right) or 'DOWN' (top to bottom).
function loadDagDirection() {
    try {
        return localStorage.getItem('dagDirection') === 'DOWN' ? 'DOWN' : 'RIGHT';
    } catch (err) {
        return 'RIGHT';
    }
}
let dagDirection = loadDagDirection();

// ---- ELK engine loading ------------------------------------------------
//
// ELK is ~1.6 MB, so it is loaded the first time the Graphic tab is
// rendered, not on page load. The promise is cached; a failed load
// clears the cache so a later attempt can retry.

let _elkPromise = null;

function ensureElk() {
    if (_elkPromise) return _elkPromise;

    _elkPromise = new Promise((resolve, reject) => {
        if (typeof DagLayout === 'undefined') {
            reject(new Error('dag-layout.js did not load'));
            return;
        }
        if (typeof ELK !== 'undefined') {
            resolve(new ELK());
            return;
        }
        const s = document.createElement('script');
        s.src = 'vendor/elk.bundled.js';
        s.onload = () => {
            if (typeof ELK === 'undefined') {
                reject(new Error('ELK loaded but did not define a global'));
            } else {
                resolve(new ELK());
            }
        };
        s.onerror = () => reject(new Error('Could not load vendor/elk.bundled.js'));
        document.head.appendChild(s);
    });

    _elkPromise.catch(() => { _elkPromise = null; });
    return _elkPromise;
}

// ---- render orchestration ----------------------------------------------
//
// Layout is asynchronous, so every render takes a token. If a newer
// render (or a cancel from calculateAll) happens while a layout is
// pending, the older one sees a stale token and mounts nothing.

let dagRenderToken = 0;

function cancelDagRender(container) {
    dagRenderToken++;
    if (container && container._dagCleanup) {
        container._dagCleanup();
        container._dagCleanup = null;
    }
}

function showDagMessage(container, html, isError) {
    container.innerHTML =
        `<div class="dag-status${isError ? ' dag-status--error' : ''}">${html}</div>`;
}

// Every caller goes through here, so an unexpected failure while drawing
// the graph is reported and the Text Tree keeps working.
function renderGraphDAGSafe(container, graphData, isAdvanced) {
    return renderGraphDAG(container, graphData, isAdvanced).catch(err => {
        console.error(err);
        showDagMessage(container, 'The graph could not be drawn. Use the Text Tree instead.', true);
        showBanner(`The production graph could not be drawn: ${err && err.message ? err.message : err}`);
    });
}

async function renderGraphDAG(container, graphData, isAdvanced) {
    cancelDagRender(container);
    const token = dagRenderToken;

    showDagMessage(container, 'Laying out graph…');

    // Fold collapsed subtrees first; everything below works on this view.
    const view = DagLayout.collapseGraph(graphData, dagCollapsed);

    let layout;
    try {
        const elk = await ensureElk();
        DagLayout.setElk(elk);
        layout = await DagLayout.layoutGraph(view, { direction: dagDirection });
    } catch (err) {
        if (token !== dagRenderToken) return;
        console.error(err);
        showDagMessage(
            container,
            `Graph layout failed to load (${escapeHtml(err.message || err)}).<br>` +
            `<button type="button" class="tiny-btn dag-fallback-btn" onclick="setDagView('text')">` +
            `Switch to Text Tree</button>`,
            true
        );
        return;
    }

    if (token !== dagRenderToken) return; // superseded while laying out

    try {
        container.innerHTML = buildDagSvg(view, layout, isAdvanced);
        initDagPanZoom(container, view, layout);
    } catch (err) {
        console.error(err);
        showDagMessage(
            container,
            `Could not draw the graph (${escapeHtml(err.message || err)}).<br>` +
            `<button type="button" class="tiny-btn dag-fallback-btn" onclick="setDagView('text')">` +
            `Switch to Text Tree</button>`,
            true
        );
    }
}

// ---- SVG building ------------------------------------------------------

function dagMarkerId(kind, color) {
    return `arrowhead-${kind}-${String(color).replace(/[^a-zA-Z0-9]/g, '_')}`;
}

// Colour that outlines / tints a node: a shared item's colour wins,
// then the colour of the byproduct it recycles; leaves fall back to
// their own shared colour.
function dagNodeItemColor(node) {
    return (node.isShared && node.sharedColor) ||
        node.recycledSourceColor ||
        (node.kind !== 'machine' ? node.sharedColor : null) ||
        null;
}

function buildDagMarkerDefs(graphData) {
    const plainColors = new Set();
    const recycleColors = new Set();
    graphData.edges.forEach(edge => {
        if (edge.isRecycleEdge) {
            recycleColors.add(edge.sharedColor || DAG_RECYCLE_DEFAULT);
        } else if (edge.isSharedEdge && edge.sharedColor) {
            plainColors.add(edge.sharedColor);
        }
    });

    // Default (uncoloured) arrowhead follows the theme variable.
    let defs = `
        <marker id="arrowhead-plain" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" style="fill:var(--dag-edge)"></path>
        </marker>`;

    plainColors.forEach(color => {
        defs += `
        <marker id="${dagMarkerId('shared', color)}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" fill="${svgEsc(color)}"></path>
        </marker>`;
    });

    // Recycle arrowheads are a hollow chevron so they read as a
    // different kind of edge before the colour or dash registers.
    recycleColors.forEach(color => {
        defs += `
        <marker id="${dagMarkerId('recycle', color)}" markerWidth="12" markerHeight="12" refX="9" refY="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 M0,5 L10,5" fill="none" stroke="${svgEsc(color)}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>
        </marker>`;
    });

    return `<defs>${defs}</defs>`;
}

// Edge colour: a byproduct's colour for recycle edges, the item's colour
// for shared edges, otherwise the theme default.
function dagEdgeColor(edge) {
    if (edge.isRecycleEdge) return edge.sharedColor || DAG_RECYCLE_DEFAULT;
    if (edge.isSharedEdge && edge.sharedColor) return edge.sharedColor;
    return null;
}

// Line width scales with flow (log scale, so one huge flow does not
// swamp the rest): 1.5px for the smallest flow up to 4.5px for the largest.
function dagEdgeWidth(rate, maxRate) {
    const r = Number(rate) || 0;
    if (!maxRate || maxRate <= 0) return 2;
    const t = Math.min(1, Math.max(0, Math.log(1 + r) / Math.log(1 + maxRate)));
    return +(1.5 + 3 * t).toFixed(2);
}

// Label text: the item's name; with Advanced View, the rate as well.
function dagEdgeLabelText(edge, isAdvanced) {
    const name = DagLayout.prettyName(edge.itemName);
    const prefix = edge.isRecycleEdge ? '♻ ' : '';
    if (!isAdvanced) return `${prefix}${name}`;
    return `${prefix}${(Number(edge.rate) || 0).toFixed(2)}/s ${name}`;
}

function dagEdgeTemplate(edge, index, points, maxRate) {
    const d = DagLayout.roundedPath(points, 8);
    if (!d) return '';

    const isRecycle = !!edge.isRecycleEdge;
    const isShared = !isRecycle && !!edge.isSharedEdge;
    const color = dagEdgeColor(edge);

    let marker = 'arrowhead-plain';
    if (isRecycle) marker = dagMarkerId('recycle', color);
    else if (isShared && color) marker = dagMarkerId('shared', color);

    const classes = ['dag-edge'];
    if (isRecycle) classes.push('dag-edge--recycle');
    if (isShared) classes.push('dag-edge--shared');

    const styleAttr = color ? ` style="--item-color:${svgEsc(color)}"` : '';
    const rate = Number(edge.rate) || 0;
    const tip = `${rate.toFixed(2)}/s ${DagLayout.prettyName(edge.itemName)}`;
    const tooltip = isRecycle ? `♻ recycled: ${tip}` : tip;

    return `
        <g class="${classes.join(' ')}" aria-hidden="true" data-edge-id="e${index}" data-from="${svgEsc(edge.from)}" data-to="${svgEsc(edge.to)}" data-item="${svgEsc(edge.itemName)}"${styleAttr}>
            <path d="${d}" stroke-width="${dagEdgeWidth(rate, maxRate)}" marker-end="url(#${marker})"></path>
            <title>${svgEsc(tooltip)}</title>
        </g>`;
}

// A placed edge label. `item` carries the position computed by buildDagSvg.
function dagEdgeLabelHtml(edge, index, item) {
    const color = dagEdgeColor(edge);
    const styleAttr = color ? ` style="--item-color:${svgEsc(color)}"` : '';
    const cls = edge.isRecycleEdge ? 'dag-edge-label dag-edge-label--recycle' : 'dag-edge-label';
    return `
        <g class="${cls}" data-edge-id="e${index}" transform="translate(${item.x.toFixed(1)},${item.y.toFixed(1)})" pointer-events="none"${styleAttr}>
            <rect width="${item.w.toFixed(1)}" height="${item.h}" rx="${item.h / 2}"></rect>
            <text x="${(item.w / 2).toFixed(1)}" y="13" text-anchor="middle">${svgEsc(item.text)}</text>
        </g>`;
}

function dagNodeTemplate(node, box, isAdvanced) {
    const { x, y, w, h } = box;
    const itemColor = dagNodeItemColor(node);
    const glowColor = node.recycledSourceColor || node.sharedColor || null;
    const hasGlow = !!(node.isShared || node.recycledSourceColor);

    const classes = ['dag-node', `dag-node--${node.kind}`];
    if (node.isShared) classes.push('dag-node--shared');
    if (node.recycledSourceColor) classes.push('dag-node--recycled');
    if (hasGlow) classes.push('dag-node--glow');

    const styleParts = [];
    if (itemColor) styleParts.push(`--item-color:${svgEsc(itemColor)}`);
    if (glowColor) styleParts.push(`--glow-color:${svgEsc(hexToRgbaShared(glowColor, 0.6))}`);
    const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

    const itemTitle = node.kind === 'machine'
        ? `${node.count}x ${node.label}, makes ${node.outputs.map(o => DagLayout.prettyName(o.itemName)).join(', ')}`
        : `${node.kind} ${DagLayout.prettyName(node.itemName)}`;

    const attrs =
        `class="${classes.join(' ')}" data-node-id="${svgEsc(node.id)}" data-kind="${svgEsc(node.kind)}"` +
        ` tabindex="0" role="button" aria-label="${svgEsc(itemTitle)}"` +
        ` transform="translate(${x.toFixed(1)},${y.toFixed(1)})"${styleAttr}`;

    if (node.kind === 'machine') {
        const outStr = isAdvanced
            ? node.outputs.map(o => `${(Number(o.rate) || 0).toFixed(2)} ${DagLayout.prettyName(o.itemName)}/s`).join(', ')
            : node.outputs.map(o => DagLayout.prettyName(o.itemName)).join(', ');
        const inputStr = node.inputSummary
            ? node.inputSummary.split(', ').map(n => DagLayout.prettyName(n)).join(', ')
            : 'NONE';
        const mono = DagLayout.monogramFor(node.label);
        // Fold control: "▾ fold" to hide the steps feeding this machine, or
        // "▸ +N" to show the N hidden steps. Mouse via tap; keyboard via C.
        let fold = '';
        if (node.collapsed) {
            fold = `<g class="dag-fold dag-fold--expand" aria-hidden="true" data-collapse-toggle="${svgEsc(node.id)}">
                <rect x="10" y="${h - 24}" width="64" height="16" rx="8"></rect>
                <text x="42" y="${h - 12}" text-anchor="middle">▸ +${node.hiddenCount}</text></g>`;
        } else if (node.collapsible) {
            fold = `<g class="dag-fold" aria-hidden="true" data-collapse-toggle="${svgEsc(node.id)}">
                <rect x="10" y="${h - 24}" width="50" height="16" rx="8"></rect>
                <text x="35" y="${h - 12}" text-anchor="middle">▾ fold</text></g>`;
        }

        return `
        <g ${attrs}>
            <rect width="${w}" height="${h}" rx="6"></rect>
            <text class="dag-t-count" x="10" y="20">${svgEsc(node.count)}x <tspan class="dag-t-label">${svgEsc(fitLabel(node.label.toUpperCase(), 22))}</tspan></text>
            <text class="dag-t-out" x="10" y="38">OUT: ${svgEsc(fitLabel(outStr, 26))}</text>
            <text class="dag-t-in" x="10" y="54">IN: ${svgEsc(fitLabel(inputStr, 30))}</text>
            ${node.isShared ? `<text class="dag-t-badge" x="${w - 10}" y="16" text-anchor="end">⑂ shared</text>` : ''}
            <g class="dag-monogram" pointer-events="none">
                <circle cx="${w - 18}" cy="${h - 18}" r="10" fill="${mono.color}"></circle>
                <text x="${w - 18}" y="${h - 14.5}" text-anchor="middle">${svgEsc(mono.text)}</text>
            </g>
            ${fold}
            <title>${svgEsc(node.label)} — exact ${Number(node.exactCount).toFixed(4)}x needed
Outputs: ${svgEsc(node.outputs.map(o => o.itemName + ' (' + (Number(o.rate) || 0).toFixed(3) + '/s)').join(', '))}
Inputs: ${svgEsc(inputStr)}</title>
        </g>`;
    }

    // Leaf nodes: raw materials and cycle markers.
    let prefix = '';
    let extra = '';
    if (node.kind === 'raw') {
        prefix = '[RAW] ';
        extra = node.partialRecycle ? `partly recycled from ${node.partialRecycle.machine}` : '';
    } else if (node.kind === 'cycle') {
        prefix = '[CYCLE] ';
    }
    const rateStr = isAdvanced ? ` (${(Number(node.rate) || 0).toFixed(2)}/s)` : '';

    return `
        <g ${attrs}>
            <rect width="${w}" height="${h}" rx="6"></rect>
            <text class="dag-t-leaf" x="10" y="18">${prefix}${svgEsc(fitLabel(DagLayout.prettyName(node.itemName), 24))}</text>
            ${extra ? `<text class="dag-t-extra" x="10" y="34">${svgEsc(fitLabel(extra, 30))}</text>` : ''}
            <title>${svgEsc(node.itemName)}${svgEsc(rateStr)}${extra ? ' — ' + svgEsc(extra) : ''}</title>
        </g>`;
}

function buildDagSvg(graphData, layout, isAdvanced) {
    const maxRate = graphData.edges.reduce((m, e) => Math.max(m, Number(e.rate) || 0), 0);

    // Edges that have a route, in graph order.
    const routed = [];
    graphData.edges.forEach((edge, i) => {
        const points = layout.edges.get(`e${i}`);
        if (points && points.length >= 2) routed.push({ edge, i, points });
    });

    // Labels: every edge gets one, but placed greedily so none sits on a
    // node or on another label. Recycle edges win ties, then shared, then
    // larger flows.
    const obstacles = [...layout.nodes.values()].map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
    const labelItems = routed.map(({ edge, i, points }, order) => {
        const text = fitLabel(dagEdgeLabelText(edge, isAdvanced), 28);
        const w = Math.min(200, 14 + text.length * 6.1);
        const a = DagLayout.labelAnchor(points);
        const rateN = maxRate > 0 ? (Number(edge.rate) || 0) / maxRate : 0;
        const kind = edge.isRecycleEdge ? 3 : (edge.isSharedEdge ? 2 : 1);
        return {
            id: i, order, priority: kind + rateN * 0.5,
            x: a.x - w / 2, y: a.y - 23, w, h: 18, text
        };
    });
    const accepted = DagLayout.placeLabels(labelItems, obstacles);

    let edgesHtml = '';
    let recycleHtml = '';
    routed.forEach(({ edge, i, points }) => {
        const html = dagEdgeTemplate(edge, i, points, maxRate);
        if (edge.isRecycleEdge) recycleHtml += html;
        else edgesHtml += html;
    });

    let labelsHtml = '';
    labelItems.forEach(item => {
        if (!accepted.has(item.id)) return;
        labelsHtml += dagEdgeLabelHtml(graphData.edges[item.id], item.id, item);
    });

    let nodesHtml = '';
    graphData.nodes.forEach(node => {
        const box = layout.nodes.get(node.id);
        if (!box) return;
        nodesHtml += dagNodeTemplate(node, box, isAdvanced);
    });

    return `
        <svg id="dagSvg" class="dag-svg" role="group" tabindex="0" aria-label="Production graph. Click a machine, or use the arrow keys to move between machines." width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="display:block; user-select:none; -webkit-user-select:none; -moz-user-select:none;">
            ${buildDagMarkerDefs(graphData)}
            <g id="dagViewport">
                ${recycleHtml}
                ${edgesHtml}
                ${labelsHtml}
                ${nodesHtml}
            </g>
        </svg>
    `;
}

// ---- INTERACTION: PAN / ZOOM / SELECTION / SEARCH / KEYBOARD ----
//
// Everything here works on the <g id="dagViewport"> transform. The <svg>
// has NO viewBox, so one SVG unit === one CSS pixel and pointer deltas
// map 1:1 onto the transform. ELK layout coordinates map to screen as
//   screen = pan + scale * layoutCoord
//
// Gestures share one pointer map, so mouse, touch and pen take the same
// path:
//   - one pointer: drag to pan; a tap (no real movement) selects or clears
//   - two pointers: pinch to zoom around their midpoint
//   - wheel: zoom around the cursor
//
// Selecting a node highlights its lineage (everything that feeds it and
// everything it feeds) and dims the rest of the graph.

const DAG_SCALE_MIN = 0.25;
const DAG_SCALE_MAX = 3.5;
const DAG_FIT_MAX = 1.4;       // a whole-graph fit never enlarges past this
const DAG_FIT_PAD = 60;
const DAG_TAP_SLOP = 4;        // px of movement that turns a tap into a drag

function dagClamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

function dagReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function dagAnnounce(text) {
    const live = document.getElementById('dagLive');
    if (live) live.textContent = text;
}

function initDagPanZoom(container, graphData, layout) {
    const svg = container.querySelector('#dagSvg');
    const viewport = container.querySelector('#dagViewport');
    if (!svg || !viewport) return;

    const adj = DagLayout.buildAdjacency(graphData);
    const nodeById = new Map(graphData.nodes.map(n => [n.id, n]));
    container._dagModel = { graphData, layout, adj, nodeById };

    let scale = 1;
    let panX = 0;
    let panY = 0;
    // Set once the user pans or zooms. Until then a resize refits the
    // whole graph; after that a resize keeps the current view centred.
    let userMoved = false;
    // A fold or direction change re-renders; keep the selection if its node
    // is still in the view.
    let selectedId = container._dagKeepSelect || null;
    container._dagKeepSelect = null;
    let animFrame = 0;
    let resizeFrame = 0;
    let lastSize = { w: 0, h: 0 };

    // Hidden containers measure 0; fall back to a sane size so the
    // initial fit is still meaningful. A real resize later corrects it.
    const viewSize = () => ({
        w: container.clientWidth || 900,
        h: container.clientHeight || 500
    });

    function applyTransform() {
        viewport.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
        // Level of detail: labels are only drawn when zoomed in enough to
        // read them (CSS keys off this attribute, so no re-render on zoom).
        const band = scale >= 1 ? 'high' : (scale >= 0.6 ? 'mid' : 'low');
        if (container.dataset.zoomBand !== band) container.dataset.zoomBand = band;
    }

    function stopAnimation() {
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = 0;
    }

    // Moves to a target view, animating unless the user prefers reduced motion.
    function setView(s, x, y, animate) {
        stopAnimation();
        if (!animate || dagReducedMotion()) {
            scale = s;
            panX = x;
            panY = y;
            applyTransform();
            return;
        }
        const from = { s: scale, x: panX, y: panY };
        const t0 = performance.now();
        const DURATION = 220;
        const step = now => {
            const t = Math.min(1, (now - t0) / DURATION);
            const k = 1 - Math.pow(1 - t, 3); // ease-out cubic
            scale = from.s + (s - from.s) * k;
            panX = from.x + (x - from.x) * k;
            panY = from.y + (y - from.y) * k;
            applyTransform();
            animFrame = t < 1 ? requestAnimationFrame(step) : 0;
        };
        animFrame = requestAnimationFrame(step);
    }

    function fitAll(animate) {
        const v = viewSize();
        const s = dagClamp(
            Math.min((v.w - DAG_FIT_PAD) / layout.width, (v.h - DAG_FIT_PAD) / layout.height, DAG_FIT_MAX),
            DAG_SCALE_MIN,
            DAG_FIT_MAX
        );
        setView(s, (v.w - layout.width * s) / 2, (v.h - layout.height * s) / 2, animate);
    }

    // Centres a box (layout coordinates) in the view at a scale that fits it.
    function fitBox(bx, by, bw, bh, maxScale, animate) {
        const v = viewSize();
        const s = dagClamp(
            Math.min((v.w - DAG_FIT_PAD) / bw, (v.h - DAG_FIT_PAD) / bh, maxScale),
            DAG_SCALE_MIN,
            DAG_SCALE_MAX
        );
        userMoved = true;
        setView(s, v.w / 2 - (bx + bw / 2) * s, v.h / 2 - (by + bh / 2) * s, animate);
    }

    // Centres one node, keeping the current zoom.
    function centreNode(id, animate) {
        const box = layout.nodes.get(id);
        if (!box) return;
        const v = viewSize();
        userMoved = true;
        setView(scale, v.w / 2 - (box.x + box.w / 2) * scale, v.h / 2 - (box.y + box.h / 2) * scale, animate);
    }

    // Zooms to newScale, keeping the point (cx, cy) in view-local pixels fixed.
    function zoomAround(newScale, cx, cy) {
        stopAnimation();
        const s = dagClamp(newScale, DAG_SCALE_MIN, DAG_SCALE_MAX);
        panX = cx - ((cx - panX) / scale) * s;
        panY = cy - ((cy - panY) / scale) * s;
        scale = s;
        userMoved = true;
        applyTransform();
    }

    function zoomBy(factor) {
        const v = viewSize();
        zoomAround(scale * factor, v.w / 2, v.h / 2);
    }

    function localPoint(clientX, clientY) {
        const r = svg.getBoundingClientRect();
        return { x: clientX - r.left, y: clientY - r.top };
    }

    // ---- selection & lineage ----

    function applyHighlight() {
        const nodeEls = svg.querySelectorAll('[data-node-id]');
        const edgeEls = svg.querySelectorAll('[data-edge-id]');
        nodeEls.forEach(el => el.classList.remove('is-lineage', 'is-selected'));
        edgeEls.forEach(el => el.classList.remove('is-lineage'));
        svg.classList.remove('dag-dim');

        if (!selectedId || !nodeById.has(selectedId)) {
            selectedId = null;
            renderDagDetail(container, null);
            return;
        }

        const L = DagLayout.computeLineage(graphData, adj, selectedId);
        svg.classList.add('dag-dim');
        nodeEls.forEach(el => {
            const id = el.dataset.nodeId;
            if (L.nodes.has(id)) el.classList.add('is-lineage');
            if (id === selectedId) el.classList.add('is-selected');
        });
        edgeEls.forEach(el => {
            if (L.edges.has(Number(el.dataset.edgeId.slice(1)))) el.classList.add('is-lineage');
        });
        renderDagDetail(container, selectedId, L);
    }

    function selectNode(id) {
        selectedId = id;
        applyHighlight();
        const node = nodeById.get(id);
        const L = DagLayout.computeLineage(graphData, adj, id);
        dagAnnounce(
            `${node.label || node.itemName}: ` +
            `${L.upNodes.size - 1} upstream, ${L.downNodes.size - 1} downstream`
        );
    }

    function clearSelection() {
        selectedId = null;
        applyHighlight();
        dagAnnounce('Selection cleared');
    }

    function tapTarget(target) {
        const fold = target && target.closest ? target.closest('[data-collapse-toggle]') : null;
        if (fold) {
            dagToggleCollapse(fold.dataset.collapseToggle);
            return;
        }
        const el = target && target.closest ? target.closest('[data-node-id]') : null;
        if (!el) {
            clearSelection();
            return;
        }
        const id = el.dataset.nodeId;
        if (id === selectedId) clearSelection();
        else selectNode(id);
    }

    function focusDomNode(id) {
        const el = svg.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
        if (el) el.focus({ preventScroll: true });
    }

    // Selects a node, zooms to it and moves keyboard focus onto it.
    function focusNodeById(id) {
        const box = layout.nodes.get(id);
        if (!box) return;
        selectNode(id);
        fitBox(box.x - 20, box.y - 20, box.w + 40, box.h + 40, 1.2, true);
        focusDomNode(id);
    }

    // Pans just enough to bring a node on screen, without changing zoom.
    function ensureVisible(id) {
        const box = layout.nodes.get(id);
        if (!box) return;
        const v = viewSize();
        const sx = panX + scale * box.x;
        const sy = panY + scale * box.y;
        const inside = sx >= 0 && sy >= 0 &&
            sx + scale * box.w <= v.w && sy + scale * box.h <= v.h;
        if (!inside) centreNode(id, true);
    }

    // Arrow-key navigation: the nearest node in that direction, scored
    // so that nodes straight ahead beat ones off to the side.
    function moveFocusDirection(fromId, key) {
        const from = layout.nodes.get(fromId);
        if (!from) return;
        const x0 = from.x + from.w / 2;
        const y0 = from.y + from.h / 2;
        let best = null;
        let bestScore = Infinity;
        layout.nodes.forEach((box, id) => {
            if (id === fromId || !nodeById.has(id)) return;
            const dx = box.x + box.w / 2 - x0;
            const dy = box.y + box.h / 2 - y0;
            let primary;
            let perp;
            if (key === 'ArrowRight') { primary = dx; perp = Math.abs(dy); }
            else if (key === 'ArrowLeft') { primary = -dx; perp = Math.abs(dy); }
            else if (key === 'ArrowDown') { primary = dy; perp = Math.abs(dx); }
            else { primary = -dy; perp = Math.abs(dx); }
            if (primary <= 1) return;
            const score = primary + 2 * perp;
            if (score < bestScore) {
                bestScore = score;
                best = id;
            }
        });
        if (!best) return;
        focusDomNode(best);
        ensureVisible(best);
    }

    // ---- pointers: pan, pinch, tap ----

    const pointers = new Map();
    let gesture = null;          // { kind: 'pan', ... } or { kind: 'pinch', ... }
    let tapCandidate = false;    // a lone pointer that has not moved yet
    let downTarget = null;

    function pinchStart() {
        const [a, b] = [...pointers.values()];
        const c = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        return {
            kind: 'pinch',
            d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
            s0: scale,
            // world point under the pinch midpoint, held fixed while zooming
            wx: (c.x - panX) / scale,
            wy: (c.y - panY) / scale
        };
    }

    svg.addEventListener('pointerdown', e => {
        if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
        stopAnimation();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* unsupported: window backstop still ends it */ }

        if (pointers.size === 1) {
            gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY };
            tapCandidate = true;
            downTarget = e.target;
            svg.style.cursor = 'grabbing';
        } else if (pointers.size === 2) {
            gesture = pinchStart();
            tapCandidate = false;
        }
    });

    svg.addEventListener('pointermove', e => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!gesture) return;

        if (gesture.kind === 'pinch' && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const c = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
            const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
            scale = dagClamp(gesture.s0 * d / gesture.d0, DAG_SCALE_MIN, DAG_SCALE_MAX);
            panX = c.x - gesture.wx * scale;
            panY = c.y - gesture.wy * scale;
            userMoved = true;
            tapCandidate = false;
            applyTransform();
            return;
        }

        if (gesture.kind === 'pan' && pointers.size === 1) {
            const dx = e.clientX - gesture.sx;
            const dy = e.clientY - gesture.sy;
            if (Math.abs(dx) > DAG_TAP_SLOP || Math.abs(dy) > DAG_TAP_SLOP) {
                tapCandidate = false;
                userMoved = true;
            }
            panX = gesture.px + dx;
            panY = gesture.py + dy;
            applyTransform();
        }
    });

    function endPointer(e) {
        // Returns false for pointers we are not tracking, so the svg
        // listener and the window backstop can both fire safely.
        if (!pointers.delete(e.pointerId)) return;

        if (pointers.size === 1 && gesture && gesture.kind === 'pinch') {
            // Lifting one finger off a pinch carries on as a pan with the other.
            const [rest] = [...pointers.values()];
            gesture = { kind: 'pan', sx: rest.x, sy: rest.y, px: panX, py: panY };
            tapCandidate = false;
            return;
        }

        if (pointers.size === 0) {
            if (e.type === 'pointerup' && tapCandidate) tapTarget(downTarget);
            gesture = null;
            tapCandidate = false;
            downTarget = null;
            svg.style.cursor = 'grab';
        }
    }
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    // Backstop: a pointer released outside the svg (capture can fail)
    // still ends its gesture. Removed in _dagCleanup.
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);

    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const p = localPoint(e.clientX, e.clientY);
        zoomAround(scale * Math.pow(1.0015, -e.deltaY), p.x, p.y);
    }, { passive: false });

    // ---- keyboard ----

    svg.addEventListener('keydown', e => {
        const el = e.target && e.target.closest ? e.target.closest('[data-node-id]') : null;
        const id = el ? el.dataset.nodeId : null;
        let handled = true;

        switch (e.key) {
            case 'Escape':
                clearSelection();
                break;
            case 'Enter':
            case ' ':
                if (!id) { handled = false; break; }
                if (id === selectedId) clearSelection();
                else selectNode(id);
                break;
            case 'ArrowRight':
            case 'ArrowLeft':
            case 'ArrowUp':
            case 'ArrowDown':
                if (!id) { handled = false; break; }
                moveFocusDirection(id, e.key);
                break;
            case '+':
            case '=':
                zoomBy(1.3);
                break;
            case '-':
            case '_':
                zoomBy(1 / 1.3);
                break;
            case '0':
            case 'f':
            case 'F':
                userMoved = false;
                fitAll(true);
                break;
            case 'c':
            case 'C': {
                const n = id && nodeById.get(id);
                if (!n || !(n.collapsible || n.collapsed)) { handled = false; break; }
                dagToggleCollapse(id);
                break;
            }
            default:
                handled = false;
        }
        if (handled) e.preventDefault();
    });

    // ---- resize: refit until the user takes over the view ----

    const ro = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (resizeFrame) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                const w = container.clientWidth;
                const h = container.clientHeight;
                if (!w || !h) return; // hidden (other tab): refit when shown
                if (!userMoved || !lastSize.w) {
                    fitAll(false);
                } else {
                    panX += (w - lastSize.w) / 2;
                    panY += (h - lastSize.h) / 2;
                    applyTransform();
                }
                lastSize = { w, h };
            });
        })
        : null;

    // ---- toolbar and search hooks ----

    container._dagZoomIn = () => zoomBy(1.3);
    container._dagZoomOut = () => zoomBy(1 / 1.3);
    container._dagZoomReset = () => {
        userMoved = false;
        fitAll(true);
    };
    container._dagClear = () => clearSelection();
    container._dagGetSelection = () => selectedId;
    container._dagSearch = (query, commit) => {
        const q = String(query || '').trim().toLowerCase();
        const countEl = document.getElementById('dagSearchCount');
        if (!q) {
            if (countEl) countEl.textContent = '';
            return;
        }
        const matches = graphData.nodes.filter(n =>
            [n.label, n.itemName].some(v => v && String(v).toLowerCase().includes(q))
        );
        if (countEl) {
            countEl.textContent = matches.length
                ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
                : 'no match';
        }
        if (commit && matches.length) focusNodeById(matches[0].id);
    };

    container._dagCleanup = () => {
        window.removeEventListener('pointerup', endPointer);
        window.removeEventListener('pointercancel', endPointer);
        if (ro) ro.disconnect();
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        stopAnimation();
        pointers.clear();
    };

    // ---- first view ----

    svg.style.cursor = 'grab';
    fitAll(false);
    lastSize = { w: container.clientWidth, h: container.clientHeight };
    applyHighlight();
    if (ro) ro.observe(container);
}

// Detail panel for the selected node. Shown only while something is
// selected; it is a sibling of the graph, so it is rebuilt on each change.
function renderDagDetail(container, id, lineage) {
    const panel = document.getElementById('dagDetail');
    if (!panel) return;
    const model = container && container._dagModel;
    const node = id && model ? model.nodeById.get(id) : null;
    if (!node) {
        panel.hidden = true;
        panel.innerHTML = '';
        return;
    }

    const L = lineage || DagLayout.computeLineage(model.graphData, model.adj, id);
    const upCount = L.upNodes.size - 1;
    const downCount = L.downNodes.size - 1;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    let title;
    let body;
    if (node.kind === 'machine') {
        title = `${node.count}× ${node.label}`;
        const outs = node.outputs
            .map(o => `${escapeHtml(o.itemName)} <span class="dag-detail-num">${o.rate.toFixed(2)}/s</span>`)
            .join('<br>');
        body = `
            <div class="dag-detail-row"><span>Outputs</span><div>${outs || 'none'}</div></div>
            <div class="dag-detail-row"><span>Inputs</span><div>${escapeHtml(node.inputSummary || 'none')}</div></div>
            <div class="dag-detail-row"><span>Exact need</span><div>${Number(node.exactCount).toFixed(4)}×</div></div>`;
    } else if (node.kind === 'raw') {
        title = `[RAW] ${node.itemName}`;
        body = `
            <div class="dag-detail-row"><span>Rate</span><div>${Number(node.rate).toFixed(2)}/s</div></div>
            <div class="dag-detail-row"><span>Note</span><div>${node.partialRecycle
                ? `Partly recycled from ${escapeHtml(node.partialRecycle.machine)}`
                : 'Raw input, not produced in this plan'}</div></div>`;
    } else {
        title = `[CYCLE] ${node.itemName}`;
        body = `
            <div class="dag-detail-row"><span>Note</span><div>Loops back to an item already being produced</div></div>`;
    }

    const flags = [];
    if (node.isShared) flags.push('⑂ shared between consumers');
    if (node.recycledSourceColor) flags.push('♻ recycled byproduct');

    panel.hidden = false;
    panel.innerHTML = `
        <div class="dag-detail-head">
            <strong>${escapeHtml(title)}</strong>
            <button type="button" class="tiny-btn" onclick="dagClearSelection()" aria-label="Clear selection">×</button>
        </div>
        ${body}
        ${flags.length ? `<div class="dag-detail-flags">${flags.join(' · ')}</div>` : ''}
        <div class="dag-detail-row"><span>Feeds</span><div>${plural(downCount, 'downstream step')}</div></div>
        <div class="dag-detail-row"><span>Fed by</span><div>${plural(upCount, 'upstream step')}</div></div>`;
}

// Toolbar and search entry points (the DOM controls live outside the graph).
function dagClearSelection() {
    const c = document.getElementById('machineGraph');
    if (c && c._dagClear) c._dagClear();
}

// Folds or unfolds a node's upstream steps and redraws, keeping the
// current selection when its node is still visible.
function dagToggleCollapse(id) {
    const c = document.getElementById('machineGraph');
    if (!c || !lastGraphData || !id) return;
    if (dagCollapsed.has(id)) dagCollapsed.delete(id);
    else dagCollapsed.add(id);
    c._dagKeepSelect = c._dagGetSelection ? c._dagGetSelection() : null;
    const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
    renderGraphDAGSafe(c, lastGraphData, isAdvanced);
}

function dagToggleDirection() {
    dagDirection = dagDirection === 'RIGHT' ? 'DOWN' : 'RIGHT';
    try { localStorage.setItem('dagDirection', dagDirection); } catch (err) { /* private mode: keep in memory */ }
    updateDagDirectionButton();
    writeStateToHash();
    const c = document.getElementById('machineGraph');
    if (!c || !lastGraphData) return;
    c._dagKeepSelect = c._dagGetSelection ? c._dagGetSelection() : null;
    const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
    renderGraphDAGSafe(c, lastGraphData, isAdvanced);
}

function updateDagDirectionButton() {
    const btn = document.getElementById('dagDirBtn');
    if (!btn) return;
    btn.textContent = dagDirection === 'DOWN' ? '⇅ Top-down' : '⇄ Left-to-right';
    btn.setAttribute('aria-label', dagDirection === 'DOWN'
        ? 'Layout: top to bottom. Switch to left to right.'
        : 'Layout: left to right. Switch to top to bottom.');
}
updateDagDirectionButton();

function dagSearchInput(value) {
    const c = document.getElementById('machineGraph');
    if (c && c._dagSearch) c._dagSearch(value, false);
}

function dagSearchSubmit(value) {
    const c = document.getElementById('machineGraph');
    if (c && c._dagSearch) c._dagSearch(value, true);
}

// ---- SHARE / EXPORT ------------------------------------------------------
//
// The hash carries the run inputs and view settings, so a link reopens the
// same plan. Recipes are not in the link: they live in this browser.

function writeStateToHash() {
    if (!lastGraphData) return;
    const params = new URLSearchParams();
    params.set('t', lastGraphData.target);
    const qty = document.getElementById('targetQty')?.value;
    const time = document.getElementById('targetTime')?.value;
    const bank = document.getElementById('currentBank')?.value;
    if (qty) params.set('q', qty);
    if (time) params.set('s', time);
    if (bank) params.set('b', bank);
    if (document.getElementById('advancedToggle')?.checked) params.set('adv', '1');
    params.set('dir', dagDirection);
    params.set('view', activeDagView);
    try {
        history.replaceState(null, '', '#' + params.toString());
    } catch (err) { /* some embedded contexts forbid it: the page still works */ }
}

function restoreStateFromHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const target = params.get('t');
    if (!target) return;

    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== null) el.value = value;
    };
    set('targetItem', target);
    set('targetQty', params.get('q'));
    set('targetTime', params.get('s'));
    set('currentBank', params.get('b'));
    const adv = document.getElementById('advancedToggle');
    if (adv) adv.checked = params.get('adv') === '1';
    if (params.get('dir') === 'DOWN' || params.get('dir') === 'RIGHT') {
        dagDirection = params.get('dir');
        try { localStorage.setItem('dagDirection', dagDirection); } catch (err) { /* keep in memory */ }
        updateDagDirectionButton();
    }

    // Only run when there is a recipe library to run against.
    if (recipes.length === 0) return;
    calculateAll(true);
    if (params.get('view') === 'graphic') setDagView('graphic');
}

// Colour and layout rules the graph needs, copied into an exported SVG so it
// looks the same outside the page.
const DAG_EXPORT_VARS = [
    '--dag-bg', '--dag-grid', '--dag-node-fill', '--dag-leaf-fill', '--dag-raw',
    '--dag-edge', '--dag-recycle', '--dag-label-bg', '--dag-out', '--dag-in',
    '--dag-dim-text', '--dag-dim-opacity', '--text', '--accent', '--grey',
    '--danger', '--success', '--card-dark'
];

// Replaces the page's colour variables with their values, so the text works
// outside the page. Element-level variables (--item-color) are left alone:
// each element sets them in its own style attribute.
function dagResolveVars(text, canvas) {
    const cs = getComputedStyle(canvas);
    let out = text;
    DAG_EXPORT_VARS.forEach(name => {
        const value = cs.getPropertyValue(name).trim();
        if (value) out = out.split(`var(${name})`).join(value);
    });
    return out;
}

function dagExportCss(canvas) {
    const resolve = text => dagResolveVars(text, canvas);
    let css = '';
    Array.from(document.styleSheets).forEach(sheet => {
        let rules;
        try { rules = sheet.cssRules; } catch (err) { return; }
        Array.from(rules).forEach(rule => {
            if (!rule.selectorText) return;
            if (!/dag-|is-lineage|is-selected|sr-only/.test(rule.selectorText)) return;
            css += resolve(rule.cssText) + '\n';
        });
    });
    return css;
}

// The whole graph as an SVG string, independent of the current pan and zoom
// and selection. Returns null if no graph is on screen.
function dagExportSvgString() {
    const canvas = document.getElementById('machineGraph');
    const svg = canvas && canvas.querySelector('#dagSvg');
    const model = canvas && canvas._dagModel;
    if (!svg || !model) return null;

    const W = Math.ceil(model.layout.width);
    const H = Math.ceil(model.layout.height);
    const clone = svg.cloneNode(true);
    ['style', 'tabindex', 'role', 'aria-label'].forEach(a => clone.removeAttribute(a));
    clone.classList.remove('dag-svg', 'dag-dim');
    clone.setAttribute('width', W);
    clone.setAttribute('height', H);
    clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const viewport = clone.querySelector('#dagViewport');
    if (viewport) viewport.removeAttribute('transform');
    clone.querySelectorAll('.is-lineage, .is-selected').forEach(el => el.classList.remove('is-lineage', 'is-selected'));
    clone.querySelectorAll('[tabindex]').forEach(el => el.removeAttribute('tabindex'));

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', W);
    bg.setAttribute('height', H);
    bg.setAttribute('fill', getComputedStyle(canvas).getPropertyValue('--dag-bg').trim() || '#0a0a0a');
    clone.insertBefore(bg, clone.firstChild);

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = dagExportCss(canvas);
    clone.insertBefore(style, clone.firstChild);

    return dagResolveVars(new XMLSerializer().serializeToString(clone), canvas);
}

function dagExportName(ext) {
    const target = (lastGraphData && lastGraphData.target) || 'graph';
    const date = new Date().toISOString().slice(0, 10);
    return `industrialist-${target}-${date}.${ext}`;
}

function dagDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dagExportSvg() {
    const svg = dagExportSvgString();
    if (!svg) return;
    dagDownload(new Blob([svg], { type: 'image/svg+xml' }), dagExportName('svg'));
}

function dagExportPng() {
    const svg = dagExportSvgString();
    const model = document.getElementById('machineGraph')?._dagModel;
    if (!svg || !model) return;
    const W = Math.ceil(model.layout.width);
    const H = Math.ceil(model.layout.height);
    const SCALE = 2;

    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = W * SCALE;
        canvas.height = H * SCALE;
        const ctx = canvas.getContext('2d');
        ctx.scale(SCALE, SCALE);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => {
            if (blob) dagDownload(blob, dagExportName('png'));
        }, 'image/png');
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        showBanner('Could not render the graph to PNG. Try the SVG export instead.');
    };
    img.src = url;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Recipe IDs represented in the currently displayed DAG.
let activeRecipeIds = new Set();

// Current status filter for the recipe library list: 'all',
// 'enabled', 'disabled', or 'used'. Persists only for the session (not
// saved to localStorage) — always reopens showing everything.
let recipeStatusFilter = 'all';

function setRecipeStatusFilter(filter) {
    recipeStatusFilter = filter;
    displayRecipes();
}

function displayRecipes() {
    const div = document.getElementById('recipeDisplay');
    const countBadge = document.getElementById('recipeCount');

    const searchInput = document.getElementById('recipeSearch');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    const disabledCount = recipes.filter(r => r.disabled).length;

    // Keep the filter pills in sync (active state + counts) even
    // when displayRecipes() is called from somewhere other than a
    // pill click (e.g. after add/edit/delete/import).
    ['all', 'enabled', 'disabled', 'used'].forEach(f => {
        const btn = document.getElementById(`filterPill-${f}`);
        if (!btn) return;
        btn.classList.toggle('active', recipeStatusFilter === f);
    });
    const disabledCountEl = document.getElementById('disabledPillCount');
    if (disabledCountEl) disabledCountEl.textContent = disabledCount;

    let filtered = recipes;

    if (recipeStatusFilter === 'enabled') {
        filtered = filtered.filter(r => !r.disabled);
    } else if (recipeStatusFilter === 'disabled') {
        filtered = filtered.filter(r => r.disabled);
    } else if (recipeStatusFilter === 'used') {
        filtered = filtered.filter(r => activeRecipeIds.has(r.id));
    }

    if (query) {
        filtered = filtered.filter(r => {
            if (r.name.toLowerCase().includes(query)) return true;
            if ((r.rawIn || '').toLowerCase().includes(query)) return true;
            if ((r.rawOut || '').toLowerCase().includes(query)) return true;
            return false;
        });
    }

    countBadge.textContent = (query || recipeStatusFilter !== 'all')
        ? `${filtered.length}/${recipes.length}`
        : recipes.length;

    if (recipes.length === 0) {
        div.innerHTML = `<div class="recipe-empty-msg">No recipes yet. Add one above, or import a recipe file.</div>`;
        return;
    }

    if (filtered.length === 0) {
        const reason = recipeStatusFilter !== 'all'
            ? `No ${recipeStatusFilter} recipes${query ? ` match "${escapeHtml(query)}"` : ''}.`
            : `No recipes match "${escapeHtml(query)}".`;
        div.innerHTML = `<div class="recipe-empty-msg">${reason}</div>`;
        return;
    }

    // Build compact one-line rows. Each row shows the machine name
    // plus a condensed in/out summary; full detail is available via
    // the title tooltip and by clicking edit.
    div.innerHTML = filtered.map(r => {
        const inStr = r.rawIn ? escapeHtml(r.rawIn) : 'none';
        const outStr = escapeHtml(r.rawOut || '');
        const isDisabled = !!r.disabled;

        // Recipes with an unknown/variable process time (Time === -1
        // in the source data — e.g. steam-temperature-dependent
        // machines like Steam Cracking Plant) get a distinct red
        // left border instead of the normal accent color, and a
        // warning badge, so they're easy to spot in a long list and
        // you know their rates are 0 (unusable in a calculation)
        // until a real time is set via edit.
        const isVariable = r.isVariableTime || r.origTime === -1;

        let rowClass = 'recipe-row';
        if (isVariable) rowClass += ' recipe-row-variable';
        if (isDisabled) rowClass += ' recipe-row-disabled';
        if (activeRecipeIds.has(r.id)) rowClass += ' recipe-row-active';

        const variableBadge = isVariable
            ? `<span class="variable-time-badge" title="Process time is variable (e.g. steam-temperature dependent) — rates are 0 until you set a real time">⚠ variable time</span>`
            : '';

        const disabledBadge = isDisabled
            ? `<span class="disabled-badge" title="This machine is disabled — the simulator skips it and routes around it, as if it didn't exist">🚫 disabled</span>`
            : '';

        const toggleTitle = isDisabled
            ? "Enable this machine (make it available again)"
            : "Disable this machine (e.g. not unlocked in-game yet)";
        const toggleIcon = isDisabled ? '🔌' : '⏻';

        return `
            <div class="${rowClass}" title="${escapeHtml(r.name)}\nIn: ${inStr}\nOut: ${outStr}${isVariable ? '\n⚠ Variable process time — edit to set a real value' : ''}${isDisabled ? '\n🚫 Disabled — excluded from simulations' : ''}">
                <div class="row-top">
                    <span class="row-name">${escapeHtml(r.name)}</span>
                    <span class="row-actions">
                        <span data-recipe-action="toggle" data-recipe-id="${escapeHtml(String(r.id))}" title="${toggleTitle}" class="${isDisabled ? 'toggle-disabled' : 'toggle-enabled'}">${toggleIcon}</span>
                        <span data-recipe-action="edit" data-recipe-id="${escapeHtml(String(r.id))}" title="Edit">✏️</span>
                        <span data-recipe-action="delete" data-recipe-id="${escapeHtml(String(r.id))}" title="Delete">✖</span>
                    </span>
                </div>
                <div class="row-io">
                    <b>In:</b> ${inStr} <b>Out:</b> ${outStr}
                </div>
                ${variableBadge}${disabledBadge}
            </div>
        `;
    }).join('');
}

// =========================================================
// ENABLE / DISABLE MACHINES
// =========================================================
//
// Lets you flag a machine recipe as unavailable (e.g. "I haven't
// unlocked the Alloyer in-game yet") without deleting it. A
// disabled recipe is completely skipped by findAllProducers(), so
// the simulator treats it as though it doesn't exist: it'll route
// around it to another producer if one exists, or fall back to
// [RAW] for that item.
//
function toggleRecipeDisabled(id) {
    const r = recipes.find(rec => String(rec.id) === String(id));
    if (!r) return;

    r.disabled = !r.disabled;

    saveData();
    displayRecipes();
}

function deleteAllRecipes() {
    if (confirm("Are you sure you want to delete ALL recipes? This cannot be undone.")) {
        recipes = [];
        saveData();
        displayRecipes();
    }
}

function deleteRecipe(id) {
    recipes = recipes.filter(r => String(r.id) !== String(id));
    saveData();
    displayRecipes();
}

function saveData() {
    localStorage.setItem(
        'factoryRecipes',
        JSON.stringify(recipes)
    );
}

function findAllProducers(itemName) {
    let producers = [];
    recipes.forEach(r => {
        // Disabled machines (e.g. "I don't have an Alloyer unlocked
        // yet") are skipped entirely, as if the recipe didn't exist.
        // The solver will fall back to another producer of this item
        // if one is enabled, or treat it as a raw/external input if
        // not — same as any other item with zero producers.
        if (r.disabled) return;

        if (r.outputs[itemName]) {
            producers.push({
                fullRecipe: r,
                rate: r.outputs[itemName]
            });
        }
    });
    return producers;
}