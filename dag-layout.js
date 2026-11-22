// =========================================================
// DAG LAYOUT (ELK) — pure, DOM-free
// =========================================================
//
// Turns the { nodes, edges } graph model built by buildGraphData()
// into positions + routed edge polylines using ELK's layered
// algorithm with orthogonal edge routing and fixed-side ports.
//
// Kept DOM-free on purpose so it can be loaded as a plain <script>
// in the browser (exposes window.DagLayout) AND required from Node
// for tests (module.exports).
//
// Coordinates returned are in graph space, origin top-left, y down:
//   node  -> { x, y, w, h }          (x,y = top-left corner)
//   edge  -> [{x,y}, {x,y}, ...]     (polyline: start, bends..., end)
//
// Edge direction in the model is producer -> consumer. With
// direction RIGHT, producers sit on the left and the final product
// on the right; every edge leaves a node's EAST side and enters the
// consumer's WEST side, so the last segment of an edge is always a
// real horizontal run into the target (arrowheads never point
// sideways), with no hand-tuned elbow offsets.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DagLayout = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const NODE_W = 220;
    const NODE_H_MACHINE = 88;
    const NODE_H_LEAF = 46;

    const DEFAULTS = {
        direction: 'RIGHT',        // 'RIGHT' (left-to-right) | 'DOWN'
        nodeSpacing: 26,           // between nodes in the same layer
        layerSpacing: 70,          // between layers
        edgeSpacing: 12,           // between parallel edge segments
        padding: 20
    };

    function nodeSize(node) {
        return {
            w: NODE_W,
            h: node.kind === 'machine' ? NODE_H_MACHINE : NODE_H_LEAF
        };
    }

    // ---- ELK input -------------------------------------------------

    function buildElkGraph(graphData, opts) {
        const o = Object.assign({}, DEFAULTS, opts);
        const horizontal = o.direction !== 'DOWN';
        const inSide = horizontal ? 'WEST' : 'NORTH';
        const outSide = horizontal ? 'EAST' : 'SOUTH';

        const nodeIds = new Set(graphData.nodes.map(n => n.id));

        // One port per (node, side, item): every edge carrying the same
        // item into / out of a node shares that port, so a node with
        // several consumers of one output fans out from a single exit
        // and a multi-input machine gets one distinct entry per input.
        const portsByNode = new Map();
        function portFor(nodeId, dir, item) {
            let entry = portsByNode.get(nodeId);
            if (!entry) {
                entry = { list: [], index: new Map() };
                portsByNode.set(nodeId, entry);
            }
            const key = dir + '\u0000' + item;
            let id = entry.index.get(key);
            if (!id) {
                id = `${nodeId}:${dir}:${item}`;
                entry.index.set(key, id);
                entry.list.push({
                    id,
                    width: 0,
                    height: 0,
                    layoutOptions: { 'elk.port.side': dir === 'in' ? inSide : outSide }
                });
            }
            return id;
        }

        const elkEdges = [];
        graphData.edges.forEach((edge, i) => {
            if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
            elkEdges.push({
                id: `e${i}`,
                sources: [portFor(edge.from, 'out', edge.itemName)],
                targets: [portFor(edge.to, 'in', edge.itemName)]
            });
        });

        const children = graphData.nodes.map(node => {
            const size = nodeSize(node);
            const entry = portsByNode.get(node.id);
            return {
                id: node.id,
                width: size.w,
                height: size.h,
                ports: entry ? entry.list : [],
                layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' }
            };
        });

        const pad = o.padding;
        return {
            id: 'root',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': horizontal ? 'RIGHT' : 'DOWN',
                'elk.edgeRouting': 'ORTHOGONAL',
                'elk.padding': `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
                'elk.spacing.nodeNode': String(o.nodeSpacing),
                'elk.spacing.edgeEdge': String(o.edgeSpacing),
                'elk.spacing.edgeNode': '20',
                'elk.layered.spacing.nodeNodeBetweenLayers': String(o.layerSpacing),
                'elk.layered.spacing.edgeNodeBetweenLayers': '20',
                'elk.layered.spacing.edgeEdgeBetweenLayers': String(o.edgeSpacing),
                // Determinism: same graph in -> same picture out.
                'elk.randomSeed': '1',
                'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
                'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
                'elk.layered.nodePlacement.favorStraightEdges': 'true',
                // Edges sharing a port are drawn as one trunk.
                'elk.layered.mergeEdges': 'true',
                // Route back-edges (recycled byproducts) around nodes.
                'elk.layered.feedbackEdges': 'true'
            },
            children,
            edges: elkEdges
        };
    }

    // ---- ELK output ------------------------------------------------

    function extractLayout(graphData, laidOut) {
        const nodes = new Map();
        (laidOut.children || []).forEach(c => {
            nodes.set(c.id, { x: c.x, y: c.y, w: c.width, h: c.height });
        });

        const edges = new Map();
        (laidOut.edges || []).forEach(e => {
            const sections = e.sections || [];
            let pts = [];
            sections.forEach(sec => {
                pts.push(sec.startPoint);
                (sec.bendPoints || []).forEach(b => pts.push(b));
                pts.push(sec.endPoint);
            });
            pts = pts.filter(Boolean).map(p => ({ x: p.x, y: p.y }));
            edges.set(e.id, pts);
        });

        // Safety net: an edge ELK returned no route for still gets a
        // straight line between the two node centres.
        graphData.edges.forEach((edge, i) => {
            const id = `e${i}`;
            if (edges.has(id) && edges.get(id).length >= 2) return;
            const a = nodes.get(edge.from);
            const b = nodes.get(edge.to);
            if (!a || !b) return;
            edges.set(id, [
                { x: a.x + a.w, y: a.y + a.h / 2 },
                { x: b.x, y: b.y + b.h / 2 }
            ]);
        });

        return {
            nodes,
            edges,
            width: laidOut.width || 800,
            height: laidOut.height || 400
        };
    }

    // ---- cache -----------------------------------------------------
    //
    // Keyed on STRUCTURE only (ids, kinds, sizes, edge endpoints, items
    // and layout options) — never rates, colours or labels — so
    // toggling Advanced View or re-running the same target does not
    // pay for a second layout.

    const CACHE_MAX = 5;
    const cache = new Map();

    function hashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36) + ':' + str.length;
    }

    function signature(graphData, opts) {
        const o = Object.assign({}, DEFAULTS, opts);
        const parts = [
            o.direction, o.nodeSpacing, o.layerSpacing, o.edgeSpacing, o.padding
        ];
        graphData.nodes.forEach(n => {
            const s = nodeSize(n);
            parts.push(`${n.id}|${n.kind}|${s.w}x${s.h}`);
        });
        graphData.edges.forEach(e => parts.push(`${e.from}>${e.to}|${e.itemName}`));
        return hashString(parts.join('\n'));
    }

    let elkInstance = null;
    function setElk(instance) { elkInstance = instance; }

    // Resolves to { nodes, edges, width, height, fromCache }.
    function layoutGraph(graphData, opts) {
        const elk = (opts && opts.elk) || elkInstance;
        if (!elk) return Promise.reject(new Error('ELK is not loaded'));

        const key = signature(graphData, opts);
        if (cache.has(key)) {
            const hit = cache.get(key);
            // refresh recency
            cache.delete(key);
            cache.set(key, hit);
            return Promise.resolve(Object.assign({ fromCache: true }, hit));
        }

        const layoutOpts = Object.assign({}, opts);
        delete layoutOpts.elk;
        const elkGraph = buildElkGraph(graphData, layoutOpts);

        return elk.layout(elkGraph).then(laidOut => {
            const layout = extractLayout(graphData, laidOut);
            cache.set(key, layout);
            while (cache.size > CACHE_MAX) {
                cache.delete(cache.keys().next().value);
            }
            return Object.assign({ fromCache: false }, layout);
        });
    }

    function clearCache() { cache.clear(); }

    // ---- geometry helpers -------------------------------------------

    function fmt(n) { return (Math.round(n * 10) / 10).toString(); }

    function dedupePoints(points) {
        const out = [];
        points.forEach(p => {
            const last = out[out.length - 1];
            if (!last || Math.abs(p.x - last.x) > 0.01 || Math.abs(p.y - last.y) > 0.01) {
                out.push(p);
            }
        });
        return out;
    }

    // SVG path through the polyline with rounded corners. Corner radius
    // is clamped to half of each adjoining segment so the last segment
    // (the one the arrowhead sits on) always keeps a straight run.
    function roundedPath(points, radius) {
        const r = radius === undefined ? 8 : radius;
        const p = dedupePoints(points);
        if (p.length < 2) return '';
        let d = `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
        for (let i = 1; i < p.length - 1; i++) {
            const a = p[i - 1], b = p[i], c = p[i + 1];
            const len1 = Math.hypot(b.x - a.x, b.y - a.y);
            const len2 = Math.hypot(c.x - b.x, c.y - b.y);
            const u1 = { x: (b.x - a.x) / len1, y: (b.y - a.y) / len1 };
            const u2 = { x: (c.x - b.x) / len2, y: (c.y - b.y) / len2 };
            const cross = u1.x * u2.y - u1.y * u2.x;
            if (Math.abs(cross) < 1e-6) {          // collinear: no corner
                d += ` L ${fmt(b.x)} ${fmt(b.y)}`;
                continue;
            }
            const rr = Math.min(r, len1 / 2, len2 / 2);
            d += ` L ${fmt(b.x - u1.x * rr)} ${fmt(b.y - u1.y * rr)}`;
            d += ` Q ${fmt(b.x)} ${fmt(b.y)} ${fmt(b.x + u2.x * rr)} ${fmt(b.y + u2.y * rr)}`;
        }
        const last = p[p.length - 1];
        d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
        return d;
    }

    // Midpoint of the longest segment: a good, corner-free place for a
    // label to sit on the line.
    function labelAnchor(points) {
        const p = dedupePoints(points);
        if (p.length === 0) return { x: 0, y: 0 };
        if (p.length === 1) return { x: p[0].x, y: p[0].y };
        let best = 0, bestLen = -1;
        for (let i = 0; i < p.length - 1; i++) {
            const len = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
            if (len > bestLen) { bestLen = len; best = i; }
        }
        return {
            x: (p[best].x + p[best + 1].x) / 2,
            y: (p[best].y + p[best + 1].y) / 2
        };
    }

    // Adjacency over edge indices, built once per render and reused by
    // interaction code (highlighting upstream / downstream paths).
    function buildAdjacency(graphData) {
        const incoming = new Map();
        const outgoing = new Map();
        graphData.nodes.forEach(n => {
            incoming.set(n.id, []);
            outgoing.set(n.id, []);
        });
        graphData.edges.forEach((e, i) => {
            if (outgoing.has(e.from)) outgoing.get(e.from).push(i);
            if (incoming.has(e.to)) incoming.get(e.to).push(i);
        });
        return { incoming, outgoing };
    }

    // Lineage of one node: everything that feeds it (upstream, walking
    // incoming edges back to raw materials) and everything it feeds
    // (downstream, walking outgoing edges to the final product). The
    // selected node itself is included. Returns edge indices too, so the
    // edges on those paths can be highlighted with the nodes.
    function computeLineage(graphData, adjacency, nodeId) {
        const adj = adjacency || buildAdjacency(graphData);
        const edgeSet = new Set();
        const upNodes = new Set([nodeId]);
        const downNodes = new Set([nodeId]);

        function walk(start, neighbours, seen, direction) {
            const stack = [start];
            while (stack.length) {
                const cur = stack.pop();
                const edgeIdxs = neighbours.get(cur) || [];
                edgeIdxs.forEach(i => {
                    const e = graphData.edges[i];
                    const next = direction === 'up' ? e.from : e.to;
                    edgeSet.add(i);
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                });
            }
        }

        if (!adj.incoming.has(nodeId)) {
            return { nodes: new Set(), edges: new Set(), upNodes, downNodes };
        }
        walk(nodeId, adj.incoming, upNodes, 'up');
        walk(nodeId, adj.outgoing, downNodes, 'down');

        const nodes = new Set([...upNodes, ...downNodes]);
        return { nodes, edges: edgeSet, upNodes, downNodes };
    }

    // ---- readable names -------------------------------------------------
    //
    // Item ids are hyphenated (`water-free-gas`). Display names title-case
    // them; the raw id stays in data-* attributes and tooltips.
    const NAME_OVERRIDES = {};

    function prettyName(id) {
        const raw = String(id || '');
        if (Object.prototype.hasOwnProperty.call(NAME_OVERRIDES, raw)) return NAME_OVERRIDES[raw];
        return raw
            .split(/[-_]+/)
            .filter(Boolean)
            .map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
            .join(' ');
    }

    // Machine badge: two-letter initials on a colour picked by hashing the
    // machine name, so the same machine always gets the same badge.
    const MONOGRAM_PALETTE = [
        '#e07a5f', '#81b29a', '#f2cc8f', '#3d85c6',
        '#c27ba0', '#6aa84f', '#e69138', '#76a5af'
    ];

    function monogramFor(name) {
        const words = prettyName(name).split(' ').filter(Boolean);
        const letters = words.length > 1
            ? words[0].charAt(0) + words[1].charAt(0)
            : (words[0] || '?').slice(0, 2);
        let h = 0;
        const key = String(name || '');
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return {
            text: letters.toUpperCase(),
            color: MONOGRAM_PALETTE[h % MONOGRAM_PALETTE.length]
        };
    }

    // ---- label placement -------------------------------------------------
    //
    // Greedy: highest priority first; a label is dropped if its box would
    // overlap a node or a label already placed. Dropped labels stay
    // available in the edge's tooltip.
    function placeLabels(items, obstacles) {
        const placed = (obstacles || []).map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
        const accepted = new Set();
        const order = items.slice().sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
        order.forEach(it => {
            const overlaps = placed.some(p =>
                it.x < p.x + p.w && p.x < it.x + it.w && it.y < p.y + p.h && p.y < it.y + it.h
            );
            if (overlaps) return;
            placed.push({ x: it.x, y: it.y, w: it.w, h: it.h });
            accepted.add(it.id);
        });
        return accepted;
    }

    // ---- collapse ----------------------------------------------------------
    //
    // Collapsing a node hides the upstream steps that exist only to feed it.
    // A step is hidden only when every consumer of it is also hidden (or is
    // the collapsed node), so anything shared with another part of the plan
    // stays visible. Returns a smaller { nodes, edges } graph; collapsed
    // nodes carry `collapsed` and `hiddenCount`, and any node that has
    // inputs carries `collapsible`.
    // Steps that exist only to feed `c`, given steps already hidden.
    function exclusiveUpstream(graphData, adj, c, removed) {
        const cand = new Set();
        const stack = [c];
        while (stack.length) {
            const cur = stack.pop();
            adj.incoming.get(cur).forEach(i => {
                const from = graphData.edges[i].from;
                if (from !== c && !cand.has(from) && !removed.has(from)) {
                    cand.add(from);
                    stack.push(from);
                }
            });
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const x of cand) {
                const feedsVisible = adj.outgoing.get(x).some(i => {
                    const t = graphData.edges[i].to;
                    return !(t === c || cand.has(t) || removed.has(t));
                });
                if (feedsVisible) {
                    cand.delete(x);
                    changed = true;
                    break;
                }
            }
        }
        return cand;
    }

    function collapseGraph(graphData, collapsed) {
        const adj = buildAdjacency(graphData);
        const ids = new Set(graphData.nodes.map(n => n.id));
        const removed = new Set();
        const hidden = new Map();

        const targets = [...(collapsed || [])].filter(id =>
            ids.has(id) && adj.incoming.get(id).length > 0
        );
        targets.forEach(c => {
            const cand = exclusiveUpstream(graphData, adj, c, removed);
            cand.forEach(x => removed.add(x));
            hidden.set(c, cand.size);
        });

        // A node offers a fold only if folding would hide something.
        const offers = new Map();
        graphData.nodes.forEach(n => {
            if (adj.incoming.get(n.id).length === 0) return;
            offers.set(n.id, exclusiveUpstream(graphData, adj, n.id, new Set()).size);
        });

        const nodes = graphData.nodes
            .filter(n => !removed.has(n.id))
            .map(n => {
                const out = Object.assign({}, n);
                if ((offers.get(n.id) || 0) > 0) out.collapsible = true;
                if (hidden.has(n.id)) {
                    out.collapsed = true;
                    out.hiddenCount = hidden.get(n.id);
                }
                return out;
            });

        const keep = new Set(nodes.map(n => n.id));
        const edges = graphData.edges.filter(e => keep.has(e.from) && keep.has(e.to));
        return { nodes, edges, target: graphData.target };
    }

    return {
        NODE_W, NODE_H_MACHINE, NODE_H_LEAF, DEFAULTS,
        nodeSize, buildElkGraph, extractLayout, layoutGraph, setElk,
        signature, clearCache, roundedPath, labelAnchor, buildAdjacency,
        computeLineage, prettyName, monogramFor, placeLabels, collapseGraph
    };
});
