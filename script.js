let recipes = JSON.parse(localStorage.getItem('factoryRecipes')) || [];

window.onload = () => {
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
    a.download = `factory_recipe_${new Date().toISOString().slice(0, 10)}.json`;

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

                if (imported.recipes) {
                    recipes = imported.recipes;
                }

                saveData();
                displayRecipes();

                alert("Import Successful!");

            } catch (err) {
                alert("Error importing file: Invalid JSON format.");
            }
        };

        reader.readAsText(file);
    };

    input.click();
}



function addRecipe() {
    const editId = document.getElementById('editId').value;
    const id = editId || Date.now();
    const name = document.getElementById('mName').value.trim();
    const time = parseFloat(document.getElementById('mTime').value);

    if (!name || !time) return alert("Machine Name and Time are required!");

    const recipeData = {
        id: id,
        name: name,
        inputs: parseItems(document.getElementById('mInputs').value, time),
        outputs: parseItems(document.getElementById('mOutputs').value, time),
        origTime: time,
        power: parseFloat(document.getElementById('mPower').value) || 0,
        cost: parseFloat(document.getElementById('mCost').value) || 0,
        rawIn: document.getElementById('mInputs').value,
        rawOut: document.getElementById('mOutputs').value
    };

    const existingIdx = recipes.findIndex(r => r.id == id);
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
    document.querySelector('.card').classList.remove('editing');
    document.getElementById('saveBtn').classList.remove('editing');
    document.getElementById('saveBtn').innerText = "💾 Save to Database";
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
    document.querySelector('.card').classList.add('editing');
    document.getElementById('saveBtn').classList.add('editing');
    document.getElementById('saveBtn').innerText = "Update Machine";
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function parseItems(str, time) {
    const obj = {};
    if (!str) return obj;
    str.split(',').forEach(p => {
        const parts = p.trim().split(' ');
        const qty = parseFloat(parts[0]);
        const item = parts.slice(1).join(' ').toLowerCase().trim();
        if (item) obj[item] = qty / time;
    });
    return obj;
}



function calculateAll() {
    const container = document.getElementById('machineList');

    container.innerHTML = "";

    // Re-roll the shared-item color seed for this render. Colors
    // stay fixed for every node within THIS calculation (so a
    // machine's badge and its "⤴ shared above" pointers still
    // match each other), but will look different the next time
    // this function runs (e.g. pressing Calculate again).
    currentColorSeed = Math.floor(Math.random() * 2147483647);

    document.getElementById('results').style.display = 'block';

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

    const bank =
        parseFloat(
            document.getElementById('currentBank').value
        ) || 0;

    const remaining = bank - data.totalCost;

    document.getElementById('summaryList').innerHTML = `
        <div style="color:var(--accent)">
            ⚡ Total Factory Power:
            <b>${data.totalPwr.toLocaleString()} KW</b>
        </div>

        <div style="color:var(--danger)">
            💰 Total Build Cost:
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
            🏦 Remaining Bank:
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

    demand[target] = qty / time;
    flowTotals[target] = qty / time;


    // =========================================================
    // MACHINE NODE CREATION
    // =========================================================

    function addMachineNode(item, recipe, machinesNeeded) {
        if (!treeData[item]) {
            treeData[item] = [];
        }

        let node = treeData[item].find(
            n => n.machine === recipe.name &&
                JSON.stringify(n.allOutputs) ===
                JSON.stringify(recipe.outputs)
        );

        if (!node) {
            node = {
                machine: recipe.name,
                count: 0,
                allOutputs: recipe.outputs,
                inputs: []
            };

            treeData[item].push(node);
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
        validProducers.sort((a, b) => {

            const aInputs =
                Object.keys(a.fullRecipe.inputs).length;

            const bInputs =
                Object.keys(b.fullRecipe.inputs).length;

            return aInputs - bInputs;
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

            if (output === item) {
                // Exactly covers the deficit we just solved for.
                // Do not bank it — see note above.
                continue;
            }

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

            supply[output] =
                (supply[output] || 0) +
                produced;

            // Remember which machine/recipe produced this byproduct
            // and what its primary output was, so the renderer can
            // later show "recycled from C" with a working jump link,
            // instead of a bare [RAW] label when this item gets
            // consumed elsewhere in the tree.
            byproductSource[output] = {
                machineName: recipe.name,
                sourceItem: item
            };
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
// with a seed. The seed is re-rolled every time calculateAll()
// runs (every "Calculate" press), so colors look different from
// one generate to the next — but the seed itself is fixed for
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
    "#e67e22", // orange
    "#3498db", // blue
    "#2ecc71", // green
    "#e74c3c", // red
    "#9b59b6", // purple
    "#1abc9c", // teal
    "#f1c40f", // yellow
    "#e84393", // pink
    "#00cec9", // cyan
    "#fd79a8", // rose
    "#a29bfe", // lavender
    "#fab1a0", // peach
    // Copy-paste format to append to your array:
    "#ff7675", // warm coral
    "#74b9ff", // sky blue
    "#55efc4", // mint
    "#fdcb6e", // soft gold
    "#6c5ce7", // deep iris
    "#00b894", // persian green
    "#e17055", // terracotta
    "#81ecec", // light aqua
    "#d63031", // crimson
    "#fd9644", // amber orange
    "#26de81", // bright emerald
    "#a55eea", // orchid
];

// Current render's color seed. Re-rolled once per calculateAll()
// call (see there) — NOT per node, NOT per page load.
let currentColorSeed = Math.floor(Math.random() * 2147483647);

function getSharedItemColor(itemName, seed = currentColorSeed) {
    let hash = seed >>> 0;
    for (let i = 0; i < itemName.length; i++) {
        hash = (Math.imul(hash, 31) + itemName.charCodeAt(i)) >>> 0;
    }
    return SHARED_ITEM_PALETTE[hash % SHARED_ITEM_PALETTE.length];
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
    byproductSource = {}     // NEW: item -> { machineName, sourceItem }
                              // for whichever machine produced it as
                              // a byproduct, so a "raw" item that's
                              // actually (partly) recycled internally
                              // can say so instead of just [RAW].
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
            const anchorId = `node-${source.sourceItem.replace(/[^a-zA-Z0-9]/g, '_')}`;

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
            const anchorId = `node-${source.sourceItem.replace(/[^a-zA-Z0-9]/g, '_')}`;

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

        const anchorId = `node-${itemName.replace(/[^a-zA-Z0-9]/g, '_')}`;

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


    let html = "";


    treeData[itemName].forEach((node) => {

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
            <div id="node-${itemName.replace(/[^a-zA-Z0-9]/g, '_')}" style="
                font-family: monospace;
                white-space: nowrap;
                margin-bottom: 0px;
                font-size: 16px;
                ${sharedHighlightStyle}
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
                byproductSource
            );

        });

    });


    return html;
}

function displayRecipes() {
    const div = document.getElementById('recipeDisplay');
    div.innerHTML = recipes.map(r => `
        <div class="recipe-card">
            <div class="control-btn" style="position:absolute; top:5px; right:5px; display:flex; gap:10px;">
                <span onclick="editRecipe(${r.id})" style="cursor:pointer;">✏️</span>
                <span onclick="deleteRecipe(${r.id})" style="cursor:pointer;">✖</span>
            </div>
            <strong>${r.name.toUpperCase()}</strong><br>
            <small style="opacity:0.7">📥 In: ${r.rawIn || 'None'} | 📤 Out: ${r.rawOut}</small>
        </div>
    `).join('');
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
        if (r.outputs[itemName]) {
            producers.push({
                fullRecipe: r,
                rate: r.outputs[itemName]
            });
        }
    });
    return producers;
}