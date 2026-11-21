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

    return {
        NODE_W, NODE_H_MACHINE, NODE_H_LEAF, DEFAULTS,
        nodeSize, buildElkGraph, extractLayout, layoutGraph, setElk,
        signature, clearCache, roundedPath, labelAnchor, buildAdjacency
    };
});
