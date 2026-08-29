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
    a.download = `[]-recipe-${new Date().toISOString().slice(0, 10)}.json`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}

function importData() {
    const input = document.createElement('input');

    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files[0];
        const reader = new FileReader();

        reader.onload = event => {
            try {
                const imported = JSON.parse(event.target.result);
                const converted = convertImportedData(imported);

                if (converted === null) {
                    alert(
                        "Error importing file: unrecognized recipe format.\n\n" +
                        "Expected either this app's native { recipes: [...] } " +
                        "export, or a flat list of single-output recipe entries."
                    );
                    return;
                }

                recipes = converted;

                saveData();
                displayRecipes();

                alert(`Import Successful! Loaded ${recipes.length} recipe(s).`);

            } catch (err) {
                console.error(err);
                alert("Error importing file: Invalid JSON format.");
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

    if (!name || !time) return alert("Machine Name and Time are required!");

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
        if (item) {
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

    // Lazily render the graphic view the first time it's switched to,
    // using whatever data is currently cached from the last run.
    if (view === 'graphic' && lastGraphData) {
        const graphContainer = document.getElementById('machineGraph');
        const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
        if (graphContainer && !graphContainer.hasChildNodes()) {
            renderGraphDAG(graphContainer, lastGraphData, isAdvanced);
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
    if (graphContainer) graphContainer.innerHTML = "";

    // Re-roll only for a fresh calculation. Toggling Advanced View
    // redraws the same DAG and should not change its color mapping.
    if (rerollColors) {
        currentColorSeed = Math.floor(Math.random() * 2147483647);
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
        alert("Enter a Target Item, Quantity, and Time.");
        return;
    }

    const data = runLogic(target, qty, time);

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
            📦 ${target.toUpperCase()} PRODUCTION
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
    lastGraphData = buildGraphDataRoot(data, target);

    if (graphContainer) {
        const isAdvanced = document.getElementById('advancedToggle')?.checked || false;
        if (activeDagView === 'graphic') {
            renderGraphDAG(graphContainer, lastGraphData, isAdvanced);
        }
    }

    updateDagViewVisibility();

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

// Current render's color seed. Re-rolled once per fresh calculation
// (see calculateAll) — NOT per node, NOT per page load.
let currentColorSeed = Math.floor(Math.random() * 2147483647);

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

    // Convert hex to an rgba() background tint at low opacity.
    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

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
            const anchorId = `node-recipe-${source.recipeId}`;

            const rateStr = isAdvanced
                ? ` (${recycledAmount.toFixed(3)} ${itemName}/s)`
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

                    <a href="#${anchorId}" style="color:${recycledColor}; font-weight:bold; text-decoration:none;" title="Jump to ${source.machineName}, which produces this as a byproduct">
                        ♻ recycled from ${source.machineName.toUpperCase()}
                    </a>

                    <span style="color:${recycledColor};">
                        ${itemName}${rateStr}
                    </span>
                </div>
            `;
        }

        // Partly covered by a byproduct, partly genuinely external.
        if (source && recycledAmount > EPS) {

            const recycledColor = getSharedItemColor(itemName);
            const anchorId = `node-recipe-${source.recipeId}`;

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
                        ${itemName}
                    </span>

                    <a href="#${anchorId}" style="color:${recycledColor}; font-size:0.85em; text-decoration:none;" title="Jump to ${source.machineName}, which produces some of this as a byproduct">
                        (♻ partly recycled from ${source.machineName.toUpperCase()}${rateStr})
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
                ? `${requiredRate.toFixed(3)} ${itemName}/s`
                : itemName;

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
                   ⑂ shared: ${itemName}
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
                ? `${requiredRate.toFixed(3)} ${itemName}/s`
                : itemName;

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
                    ⤴ shared above: ${itemName}${rateStr}
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

            const anchorId = `node-recipe-${node.recipeId}`;
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

                    <a href="#${anchorId}" style="color:${pointerColor}; font-weight:bold; text-decoration:none;" title="This machine also makes ${itemName} as a co-product — already counted in its full breakdown above">
                        ⤴ shared above: ${node.machine.toUpperCase()} (also makes ${itemName}${rateStr})
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
                    ? `${totalRate.toFixed(3)} ${out}/s`
                    : out
            );
        }


        // =====================================================
        // INPUTS
        // =====================================================

        let inputStrings =
            node.inputs.map(inp =>
                isAdvanced
                    ? `${inp.rate.toFixed(3)} ${inp.itemName}/s`
                    : inp.itemName
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
               " title="This machine's output (${itemName}) is shared by multiple downstream consumers">
                   ⑂ shared: ${itemName}
               </span>`
            : "";

        html += `
            <div id="node-recipe-${node.recipeId}" style="
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
                    ${node.machine.toUpperCase()}
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
//     kind,                // 'machine' | 'raw' | 'recycled' | 'cycle' | 'ref'
//     label,                // machine or item name
//     itemName,             // item this node represents/produces
//     count, exactCount,    // machine count (machine nodes only)
//     rate,                 // it/s, for advanced-view labels
//     isShared, sharedColor,
//     recipeId,
//     refTargetId           // for 'ref' nodes: id of the node this points to
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
    nodeIdForItem,     // item -> id of its full-expansion node (for 'ref'/back-edges)
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
    if (!treeData[itemName]) {
        const recycledAmount = byproductSupplied[itemName] || 0;
        const source = byproductSource[itemName];
        const recycledColor = getSharedItemColor(itemName);

        // If this item is internally supplied as a byproduct, connect the
        // source machine directly to the consuming machine instead of creating
        // a separate "recycled" node card. This keeps the DAG as a clean flow
        // graph and emphasizes that the material is coming from a real machine.
        if (source) {
            const sourceNodeId = nodeIdForRecipe.get(source.recipeId);
            if (sourceNodeId && parentNodeId) {
                edges.push({
                    from: sourceNodeId,
                    to: parentNodeId,
                    itemName,
                    rate: requiredRate,
                    isSharedEdge: true,
                    sharedColor: recycledColor
                });
                return sourceNodeId;
            }
        }

        const id = nextId('raw');

        if (source && recycledAmount > EPS) {
            nodes.push({
                id, kind: 'raw', label: itemName, itemName,
                rate: requiredRate, isShared, sharedColor: recycledColor,
                recycledSourceColor: recycledColor,
                partialRecycle: { amount: recycledAmount, machine: source.machineName }
            });
        } else {
            nodes.push({
                id, kind: 'raw', label: itemName, itemName,
                rate: requiredRate, isShared, sharedColor: recycledColor,
                recycledSourceColor: recycledColor
            });
        }

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
// GRAPHIC DAG — DAGRE LAYOUT + SVG RENDER
// =========================================================

const NODE_W = 220;
const NODE_H_MACHINE = 88;
const NODE_H_LEAF = 46;

function hexToRgbaShared(hex, alpha) {
    if (!hex || hex[0] !== '#') return `rgba(255,255,255,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function svgEsc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Truncate a label to fit the node width instead of overflowing/wrapping —
// full text is always available via <title> tooltip.
function fitLabel(str, maxChars) {
    const s = String(str);
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

function renderGraphDAG(container, graphData, isAdvanced) {
    if (container._dagCleanup) {
        container._dagCleanup();
        container._dagCleanup = null;
    }
    container.innerHTML = "";

    if (typeof dagre === 'undefined') {
        container.innerHTML = `
            <div style="padding:30px; color:var(--danger); font-family:monospace;">
                Graph layout library failed to load (no network access?).
                Try the Text Tree view instead.
            </div>
        `;
        return;
    }

    // multigraph: true — two distinct items can each create an edge
    // between the SAME pair of nodes (e.g. a co-product recipe feeding
    // two different inputs of the same downstream machine), which
    // requires named parallel edges. Without this, setEdge() throws.
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    graphData.nodes.forEach(node => {
        const h = node.kind === 'machine' ? NODE_H_MACHINE : NODE_H_LEAF;
        g.setNode(node.id, { width: NODE_W, height: h, node });
    });

    graphData.edges.forEach((edge, i) => {
        g.setEdge(edge.from, edge.to, { edge }, `e${i}`);
    });

    dagre.layout(g);

    const graphInfo = g.graph();
    const totalW = graphInfo.width || 800;
    const totalH = graphInfo.height || 400;

    const edgeColors = new Set(
        g.edges().map(e => {
            const edgeData = g.edge(e).edge;
            return edgeData.isSharedEdge && edgeData.sharedColor
                ? edgeData.sharedColor
                : '#e6d9b0';
        })
    );

    const markerDefs = [...edgeColors].map(color => {
        const markerId = `arrowhead-${color.replace(/[^a-zA-Z0-9]/g, '_')}`;
        return `
            <marker id="${markerId}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 Z" fill="${color}"></path>
            </marker>
        `;
    }).join('');

    let defs = `<defs>${markerDefs}</defs>`;

    // ---- EDGES ----
    let edgesHtml = '';
    g.edges().forEach(e => {
        const edgeData = g.edge(e).edge;
        const points = g.edge(e).points;

        const path = points.map((p, i) =>
            (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)
        ).join(' ');

        const stroke = edgeData.isSharedEdge
            ? edgeData.sharedColor || '#e6d9b0'
            : '#e6d9b0';
        const width = edgeData.isSharedEdge ? 2.8 : 2;
        const dash = edgeData.isSharedEdge ? '' : '';
        const arrowId = `arrowhead-${stroke.replace(/[^a-zA-Z0-9]/g, '_')}`;

        const rateLabel = isAdvanced
            ? `${edgeData.rate.toFixed(2)}/s ${edgeData.itemName}`
            : edgeData.itemName;

        const mid = points[Math.floor(points.length / 2)];

        edgesHtml += `
            <g class="dag-edge">
                <path d="${path}" fill="none" stroke="${stroke}" stroke-width="${width}" marker-end="url(#${arrowId})" opacity="0.85"></path>
                <title>${svgEsc(rateLabel)}</title>
            </g>
        `;
    });

    // ---- NODES ----
    let nodesHtml = '';
    g.nodes().forEach(nId => {
        const gNode = g.node(nId);
        const node = gNode.node;
        const x = gNode.x - gNode.width / 2;
        const y = gNode.y - gNode.height / 2;
        const w = gNode.width;
        const h = gNode.height;

        // Neutral dark gray/black fills — deliberately not the app's
        // warm --card tone, so the graph reads as black/gray like the
        // text tree's surface rather than picking up an amber tint.
        const fill = node.kind === 'machine' ? '#1c1c1c' : '#101010';
        let borderColor = 'var(--grey)';
        if (node.kind === 'raw') borderColor = node.recycledSourceColor || '#3498db';
        if (node.kind === 'recycled') borderColor = node.sharedColor || 'var(--success)';
        if (node.kind === 'cycle') borderColor = 'var(--danger)';
        if (node.recycledSourceColor) borderColor = node.recycledSourceColor;
        if (node.isShared && node.sharedColor) borderColor = node.sharedColor;

        const glow = node.isShared || node.recycledSourceColor
            ? `filter: drop-shadow(0 0 3px ${hexToRgbaShared(node.recycledSourceColor || node.sharedColor || '#ffffff', 0.6)});`
            : '';

        if (node.kind === 'machine') {
            const rateStr = isAdvanced
                ? node.outputs.map(o => `${o.rate.toFixed(2)} ${o.itemName}/s`).join(', ')
                : node.outputs.map(o => o.itemName).join(', ');
            const inputStr = node.inputSummary || 'NONE';

            nodesHtml += `
                <g class="dag-node" data-node-id="${svgEsc(node.id)}" transform="translate(${x},${y})">
                    <rect width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${borderColor}" stroke-width="${node.isShared || node.recycledSourceColor ? 2.4 : 1.5}" style="${glow}"></rect>
                    <text x="10" y="20" fill="var(--accent)" font-family="monospace" font-weight="bold" font-size="13">
                        ${svgEsc(node.count)}x <tspan fill="var(--text)">${svgEsc(fitLabel(node.label.toUpperCase(), 22))}</tspan>
                    </text>
                    <text x="10" y="38" fill="var(--success)" font-family="monospace" font-size="10.5">
                        OUT: ${svgEsc(fitLabel(rateStr, 26))}
                    </text>
                    <text x="10" y="54" fill="#f4a261" font-family="monospace" font-size="9.5">
                        IN: ${svgEsc(fitLabel(inputStr, 30))}
                    </text>
                    ${node.isShared ? `<text x="${w - 10}" y="16" fill="${node.sharedColor}" font-family="monospace" font-size="9" text-anchor="end">⑂ shared</text>` : ''}
                    <title>${svgEsc(node.label)} — exact ${node.exactCount.toFixed(4)}x needed
Outputs: ${svgEsc(node.outputs.map(o => o.itemName + ' (' + o.rate.toFixed(3) + '/s)').join(', '))}
Inputs: ${svgEsc(inputStr)}</title>
                </g>
            `;
        } else {
            let icon = '';
            let textColor = '#3498db';
            let extra = '';
            if (node.kind === 'recycled') { icon = '♻ '; textColor = node.sharedColor || 'var(--success)'; extra = `from ${node.sourceMachine}`; }
            if (node.kind === 'raw') {
                icon = '[RAW] ';
                textColor = node.recycledSourceColor || node.sharedColor || '#3498db';
                extra = node.partialRecycle ? `partly recycled from ${node.partialRecycle.machine}` : '';
            }
            if (node.kind === 'cycle') { icon = '[CYCLE] '; textColor = 'var(--danger)'; }

            const rateStr = isAdvanced ? ` (${node.rate.toFixed(2)}/s)` : '';

            nodesHtml += `
                <g class="dag-node" transform="translate(${x},${y})">
                    <rect width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${borderColor}" stroke-width="${node.isShared ? 2 : 1.5}" stroke-dasharray="${node.kind === 'raw' || node.kind === 'cycle' ? '4,2' : ''}" style="${glow}"></rect>
                    <text x="10" y="18" fill="${textColor}" font-family="monospace" font-weight="bold" font-size="12">
                        ${icon}${svgEsc(fitLabel(node.itemName, 24))}
                    </text>
                    ${extra ? `<text x="10" y="34" fill="#888" font-family="monospace" font-size="9.5">${svgEsc(fitLabel(extra, 30))}</text>` : ''}
                    <title>${svgEsc(node.itemName)}${svgEsc(rateStr)}${extra ? ' — ' + svgEsc(extra) : ''}</title>
                </g>
            `;
        }
    });

    const svg = `
        <svg id="dagSvg" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="display:block; user-select:none; -webkit-user-select:none; -moz-user-select:none;">
            ${defs}
            <g id="dagViewport">
                ${edgesHtml}
                ${nodesHtml}
            </g>
        </svg>
    `;

    container.innerHTML = svg;
    initDagPanZoom(container, totalW, totalH);
}


// ---- PAN & ZOOM ----
// Simple pointer-drag pan + wheel/pinch zoom on the <g id="dagViewport">
// transform. No dependency — plain pointer events, works for mouse,
// touch, and trackpad alike.
//
// COORDINATE SPACE: the <svg> deliberately has NO viewBox (see
// renderGraphDAG) — it's sized to 100%/100% of its container, so one
// SVG unit === one CSS pixel. That's what lets panX/panY (derived
// straight from clientX/clientY deltas) map 1:1 onto the transform
// with no scale-factor mismatch. A viewBox here would put the
// transform in a different coordinate system than the pointer
// events, which is what made panning feel unreliable before.

function initDagPanZoom(container, contentW, contentH) {
    const svg = container.querySelector('#dagSvg');
    const viewport = container.querySelector('#dagViewport');
    if (!svg || !viewport) return;

    let scale = 1;
    let panX = 0;
    let panY = 0;

    // Fit the whole graph in view on first render, with generous
    // headroom — bias toward "readable" over "everything crammed
    // in", and never shrink below a legible floor.
    const wrapRect = container.getBoundingClientRect();
    const availW = wrapRect.width || 900;
    const availH = wrapRect.height || 500;
    const PADDING = 60;
    const fitScale = Math.min(
        (availW - PADDING) / contentW,
        (availH - PADDING) / contentH,
        1.4
    );
    const initialScale = Math.min(Math.max(fitScale, 0.4), 1.4);

    function resetView() {
        scale = initialScale;
        panX = (availW - contentW * scale) / 2;
        panY = (availH - contentH * scale) / 2;
    }
    resetView();

    function applyTransform() {
        viewport.setAttribute('transform', `translate(${panX},${panY}) scale(${scale})`);
    }
    applyTransform();

    let isPanning = false;
    let didDrag = false;
    let startX = 0, startY = 0, startPanX = 0, startPanY = 0;

    svg.addEventListener('pointerdown', e => {
        // Only left-click / primary touch starts a pan.
        if (e.button !== undefined && e.button !== 0) return;
        isPanning = true;
        didDrag = false;
        startX = e.clientX;
        startY = e.clientY;
        startPanX = panX;
        startPanY = panY;
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* not supported; fall back to plain listeners */ }
        svg.style.cursor = 'grabbing';
    });

    svg.addEventListener('pointermove', e => {
        if (!isPanning) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true;
        panX = startPanX + dx;
        panY = startPanY + dy;
        applyTransform();
    });

    function endPan(e) {
        if (!isPanning) return;
        isPanning = false;
        svg.style.cursor = 'grab';
        try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    // Backstop: if pointer capture silently failed and the button is
    // released outside the SVG, this still catches it. Removed when
    // this graph is torn down (see below) to avoid piling up stale
    // listeners across repeated "Run Simulation" calls.
    window.addEventListener('pointerup', endPan);
    container._dagCleanup = () => window.removeEventListener('pointerup', endPan);

    svg.style.cursor = 'grab';

    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = Math.pow(1.0015, -e.deltaY);
        const newScale = Math.min(Math.max(scale * zoomFactor, 0.25), 3.5);

        // Zoom centered on cursor position — keep the point under the
        // cursor fixed in place while scale changes.
        panX = mouseX - ((mouseX - panX) / scale) * newScale;
        panY = mouseY - ((mouseY - panY) / scale) * newScale;
        scale = newScale;

        applyTransform();
    }, { passive: false });

    // Expose zoom controls for the +/-/reset buttons.
    container._dagZoomIn = () => {
        const cx = availW / 2, cy = availH / 2;
        const newScale = Math.min(scale * 1.3, 3.5);
        panX = cx - ((cx - panX) / scale) * newScale;
        panY = cy - ((cy - panY) / scale) * newScale;
        scale = newScale;
        applyTransform();
    };
    container._dagZoomOut = () => {
        const cx = availW / 2, cy = availH / 2;
        const newScale = Math.max(scale * 0.77, 0.25);
        panX = cx - ((cx - panX) / scale) * newScale;
        panY = cy - ((cy - panY) / scale) * newScale;
        scale = newScale;
        applyTransform();
    };
    container._dagZoomReset = () => {
        resetView();
        applyTransform();
    };
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