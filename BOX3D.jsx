import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * ==========================================================================================
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! CRITICAL ARCHITECTURE !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * ==========================================================================================
 * DO NOT DELETE, SIMPLIFY, OR IGNORE THESE COMMENTS.
 * ==========================================================================================
 * * --- ENGINEERING LOG ---
 * * 1. FIXED-POINT ARITHMETIC (MICRON NATIVE):
 * - SOURCE OF TRUTH: All 'config' state for dimensions is stored in INTERNAL UNITS (IU).
 * - SCALE: 100,000 IU = 1.0 mm (10nm precision).
 * - 1.0 Inch = 25.4 mm = 2,540,000 IU.
 * - This prevents floating point drift and allows unit switching without physical resizing.
 * * 2. LAYOUT ENGINE:
 * - Calculates geometry "Cursor" from Y=0 UPWARDS.
 * - Feet -> Floor -> Wall -> [Shoulder] -> Lip/Lid.
 * * ==========================================================================================
 */

const IN_TO_MM = 25.4;
const MM_TO_IN = 1 / 25.4;
const GEO_OVERLAP = 0.002; 

// --- Precision Constants ---
const IU_PER_MM = 100000;
const IU_PER_IN = 2540000; // 25.4 * 100000

// Convert Internal Units back to Scene Units (Inches) for Three.js
const toScene = (iu) => {
    const mm = iu / IU_PER_MM;
    return mm * MM_TO_IN;
};

// Helper: Convert initial inch values to IU for state initialization
const initIn = (val) => Math.round(val * IU_PER_IN);
const initMm = (val) => Math.round(val * IU_PER_MM);

// --- Helpers ---
function createHexagonPath(x, y, radius) {
  const path = new THREE.Path();
  const angleOff = Math.PI / 6; 
  for (let i = 0; i < 6; i++) {
    const angle = angleOff + (i * 60 * Math.PI) / 180;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
  return path;
}

function createRoundedRectPath(width, height, radius) {
    const ctx = new THREE.Shape();
    const x = -width / 2;
    const y = -height / 2;
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    return ctx;
}

// --- Gridfinity Geometry Helpers ---

// Generate points around a rounded rectangle perimeter (in XZ plane)
function generateRoundedRectRing(width, depth, radius, cornerSegs = 8) {
    const points = [];
    const hw = width / 2;
    const hd = depth / 2;
    const r = Math.min(radius, hw, hd);

    // Corner centers (counterclockwise from bottom-right)
    const corners = [
        { cx: hw - r, cz: -(hd - r), a0: -Math.PI / 2, a1: 0 },           // bottom-right
        { cx: hw - r, cz: hd - r, a0: 0, a1: Math.PI / 2 },               // top-right
        { cx: -(hw - r), cz: hd - r, a0: Math.PI / 2, a1: Math.PI },      // top-left
        { cx: -(hw - r), cz: -(hd - r), a0: Math.PI, a1: 3 * Math.PI / 2 }, // bottom-left
    ];

    for (const c of corners) {
        for (let i = 0; i < cornerSegs; i++) {
            const t = i / cornerSegs;
            const angle = c.a0 + (c.a1 - c.a0) * t;
            points.push({ x: c.cx + r * Math.cos(angle), z: c.cz + r * Math.sin(angle) });
        }
    }
    return points;
}

// Build a BufferGeometry from stacked rounded-rect rings
function buildProfileGeometry(levels, cornerSegs = 8, bottomHoles = null) {
    // levels: [{ y (scene units), width, depth, radius }]
    // bottomHoles: [{ x, z, radius, depth?, screwRadius? }]
    //   depth: magnet pocket depth (tube walls + annular floor)
    //   screwRadius: concentric through-hole radius
    const rings = levels.map(l =>
        generateRoundedRectRing(l.width, l.depth, l.radius, cornerSegs).map(p => ({ ...p, y: l.y }))
    );

    const ptsPerRing = rings[0].length;
    const vertices = [];
    const indices = [];
    const HOLE_SEGS = 20;

    // Side faces between adjacent rings
    for (let r = 0; r < rings.length - 1; r++) {
        const baseIdx = vertices.length / 3;
        const ring0 = rings[r];
        const ring1 = rings[r + 1];
        for (let i = 0; i < ptsPerRing; i++) {
            vertices.push(ring0[i].x, ring0[i].y, ring0[i].z);
        }
        for (let i = 0; i < ptsPerRing; i++) {
            vertices.push(ring1[i].x, ring1[i].y, ring1[i].z);
        }
        for (let i = 0; i < ptsPerRing; i++) {
            const next = (i + 1) % ptsPerRing;
            const a = baseIdx + i;
            const b = baseIdx + next;
            const c = baseIdx + ptsPerRing + next;
            const d = baseIdx + ptsPerRing + i;
            indices.push(a, b, c);
            indices.push(a, c, d);
        }
    }

    const botY = rings[0][0].y;
    const topY = rings[rings.length - 1][0].y;

    // Top cap with screw hole cutouts
    const topRing = rings[rings.length - 1];
    if (bottomHoles && bottomHoles.some(h => h.screwRadius)) {
        const topShape = createRoundedRectPath(
            levels[levels.length - 1].width,
            levels[levels.length - 1].depth,
            levels[levels.length - 1].radius
        );
        for (const hole of bottomHoles) {
            if (hole.screwRadius) {
                const hp = new THREE.Path();
                hp.absarc(hole.x, -hole.z, hole.screwRadius, 0, Math.PI * 2, true);
                topShape.holes.push(hp);
            }
        }
        const topGeo = new THREE.ShapeGeometry(topShape, cornerSegs * 4);
        const pos = topGeo.attributes.position;
        const idx = topGeo.index ? topGeo.index.array : null;
        const capBase = vertices.length / 3;
        for (let i = 0; i < pos.count; i++) {
            vertices.push(pos.getX(i), topY, -pos.getY(i));
        }
        if (idx) {
            for (let i = 0; i < idx.length; i += 3) {
                indices.push(capBase + idx[i], capBase + idx[i + 1], capBase + idx[i + 2]);
            }
        }
        topGeo.dispose();
    } else {
        // Simple top cap (fan from center)
        const topCenterIdx = vertices.length / 3;
        vertices.push(0, topY, 0);
        const topBaseIdx = vertices.length / 3;
        for (let i = 0; i < ptsPerRing; i++) {
            vertices.push(topRing[i].x, topRing[i].y, topRing[i].z);
        }
        for (let i = 0; i < ptsPerRing; i++) {
            const next = (i + 1) % ptsPerRing;
            indices.push(topCenterIdx, topBaseIdx + i, topBaseIdx + next);
        }
    }

    // Bottom cap
    if (!bottomHoles || bottomHoles.length === 0) {
        const botRing = rings[0];
        const botCenterIdx = vertices.length / 3;
        vertices.push(0, botY, 0);
        const botBaseIdx = vertices.length / 3;
        for (let i = 0; i < ptsPerRing; i++) {
            vertices.push(botRing[i].x, botRing[i].y, botRing[i].z);
        }
        for (let i = 0; i < ptsPerRing; i++) {
            const next = (i + 1) % ptsPerRing;
            indices.push(botCenterIdx, botBaseIdx + next, botBaseIdx + i);
        }
    } else {
        // Bottom face with magnet hole cutouts
        const botLevel = levels[0];
        const shape = createRoundedRectPath(botLevel.width, botLevel.depth, botLevel.radius);
        for (const hole of bottomHoles) {
            const holePath = new THREE.Path();
            holePath.absarc(hole.x, -hole.z, hole.radius, 0, Math.PI * 2, true);
            shape.holes.push(holePath);
        }
        const shapeGeo = new THREE.ShapeGeometry(shape, cornerSegs * 4);
        const pos = shapeGeo.attributes.position;
        const idx = shapeGeo.index ? shapeGeo.index.array : null;
        const capBaseIdx = vertices.length / 3;
        for (let i = 0; i < pos.count; i++) {
            vertices.push(pos.getX(i), botY, -pos.getY(i));
        }
        if (idx) {
            for (let i = 0; i < idx.length; i += 3) {
                indices.push(capBaseIdx + idx[i], capBaseIdx + idx[i + 2], capBaseIdx + idx[i + 1]);
            }
        }
        shapeGeo.dispose();

        // For each hole: build tube walls + annular floor + screw through-tube
        for (const hole of bottomHoles) {
            const { x, z, radius, depth, screwRadius } = hole;

            if (depth) {
                // Magnet pocket tube walls (normals face inward)
                const tubeBot = vertices.length / 3;
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const a = (i / HOLE_SEGS) * Math.PI * 2;
                    vertices.push(x + Math.cos(a) * radius, botY, z + Math.sin(a) * radius);
                }
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const a = (i / HOLE_SEGS) * Math.PI * 2;
                    vertices.push(x + Math.cos(a) * radius, botY + depth, z + Math.sin(a) * radius);
                }
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const next = (i + 1) % HOLE_SEGS;
                    const a = tubeBot + i, b = tubeBot + next;
                    const c = tubeBot + HOLE_SEGS + next, d = tubeBot + HOLE_SEGS + i;
                    // Reversed winding for inward-facing normals
                    indices.push(a, c, b);
                    indices.push(a, d, c);
                }

                // Annular floor at pocket depth (magnet radius → screw radius or center)
                const innerR = screwRadius || 0;
                const ringBase = vertices.length / 3;
                const floorY = botY + depth;
                // Outer ring
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const a = (i / HOLE_SEGS) * Math.PI * 2;
                    vertices.push(x + Math.cos(a) * radius, floorY, z + Math.sin(a) * radius);
                }
                if (innerR > 0) {
                    // Inner ring (screw hole edge)
                    for (let i = 0; i < HOLE_SEGS; i++) {
                        const a = (i / HOLE_SEGS) * Math.PI * 2;
                        vertices.push(x + Math.cos(a) * innerR, floorY, z + Math.sin(a) * innerR);
                    }
                    // Triangulate annulus (faces up, visible from below through the hole)
                    for (let i = 0; i < HOLE_SEGS; i++) {
                        const next = (i + 1) % HOLE_SEGS;
                        const o0 = ringBase + i, o1 = ringBase + next;
                        const i0 = ringBase + HOLE_SEGS + i, i1 = ringBase + HOLE_SEGS + next;
                        indices.push(o0, o1, i1);
                        indices.push(o0, i1, i0);
                    }
                } else {
                    // Solid circle cap (fan)
                    const centerIdx = vertices.length / 3;
                    vertices.push(x, floorY, z);
                    for (let i = 0; i < HOLE_SEGS; i++) {
                        const next = (i + 1) % HOLE_SEGS;
                        indices.push(centerIdx, ringBase + next, ringBase + i);
                    }
                }
            }

            // Screw through-hole: same as magnet hole but from pocket floor to top
            if (screwRadius && depth) {
                const screwBotY = botY + depth; // starts at magnet pocket floor
                const screwBot = vertices.length / 3;
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const a = (i / HOLE_SEGS) * Math.PI * 2;
                    vertices.push(x + Math.cos(a) * screwRadius, screwBotY, z + Math.sin(a) * screwRadius);
                }
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const a = (i / HOLE_SEGS) * Math.PI * 2;
                    vertices.push(x + Math.cos(a) * screwRadius, topY, z + Math.sin(a) * screwRadius);
                }
                for (let i = 0; i < HOLE_SEGS; i++) {
                    const next = (i + 1) % HOLE_SEGS;
                    const a = screwBot + i, b = screwBot + next;
                    const c = screwBot + HOLE_SEGS + next, d = screwBot + HOLE_SEGS + i;
                    indices.push(a, c, b);
                    indices.push(a, d, c);
                }
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}

// Create a single Gridfinity foot (one grid cell)
function createGridfinityFootGeo(withMagnets = true) {
    // Ground-truth profile (cq-gridfinity verified):
    // 35.6mm base → 0.7mm 45° → 37.0mm → 1.8mm vert → 2.25mm 45° → 41.5mm top
    // Total height: 4.75mm. Outer fillet: 4.0mm at top.
    const levels = [
        { y: 0,                          width: 35.6 * MM_TO_IN, depth: 35.6 * MM_TO_IN, radius: 1.05 * MM_TO_IN },
        { y: 0.7 * MM_TO_IN,            width: 37.0 * MM_TO_IN, depth: 37.0 * MM_TO_IN, radius: 1.75 * MM_TO_IN },
        { y: (0.7 + 1.8) * MM_TO_IN,    width: 37.0 * MM_TO_IN, depth: 37.0 * MM_TO_IN, radius: 1.75 * MM_TO_IN },
        { y: (0.7 + 1.8 + 2.25) * MM_TO_IN, width: 41.5 * MM_TO_IN, depth: 41.5 * MM_TO_IN, radius: 4.0 * MM_TO_IN },
    ];

    let holes = null;
    if (withMagnets) {
        const magR = (6.5 / 2) * MM_TO_IN;   // 6mm magnet + 0.5mm clearance
        const magD = 2.4 * MM_TO_IN;          // magnet pocket depth
        const screwR = (2.9 / 2) * MM_TO_IN;  // 2.4mm screw + 0.5mm clearance
        const magOff = 13.0 * MM_TO_IN;
        holes = [
            { x: -magOff, z: -magOff, radius: magR, depth: magD, screwRadius: screwR },
            { x: magOff, z: -magOff, radius: magR, depth: magD, screwRadius: screwR },
            { x: -magOff, z: magOff, radius: magR, depth: magD, screwRadius: screwR },
            { x: magOff, z: magOff, radius: magR, depth: magD, screwRadius: screwR },
        ];
    }

    return buildProfileGeometry(levels, 8, holes);
}

// Create the stacking lip geometry (inverted foot profile around bin perimeter)
// The lip is a rim at the top of the bin. Its inner cavity receives the foot of a stacking bin.
// Inner profile mirrors the foot: widest at top (entrance, 41.5mm per unit), narrowest at bottom (seat, 35.6mm per unit).
function createGridfinityLipGeo(outerW, outerD) {
    const lipH = 4.4 * MM_TO_IN; // 4.4mm lip (0.35mm clearance vs 4.75mm foot)

    // Insets from outer wall to inner lip surface (per axis total, both sides)
    // Lip cavity mirrors foot profile: same 45° chamfers (0.7mm, 2.25mm)
    const insetTop = 0.5 * MM_TO_IN;       // 0.25mm per side — thin edge at entrance
    const insetMid = 5.0 * MM_TO_IN;       // after 2.25mm 45° chamfer (0.25 + 2.25 per side)
    const insetBot = 6.4 * MM_TO_IN;       // after 0.7mm 45° chamfer (0.25 + 2.25 + 0.7 per side)

    // Vertical section: 4.4 - 2.25 - 0.7 = 1.45mm (shorter than foot's 1.8mm — the clearance)
    const innerLevels = [
        { y: 0,                              width: outerW - insetBot, depth: outerD - insetBot, radius: 1.05 * MM_TO_IN },
        { y: 0.7 * MM_TO_IN,                width: outerW - insetMid, depth: outerD - insetMid, radius: 1.75 * MM_TO_IN },
        { y: (0.7 + 1.45) * MM_TO_IN,       width: outerW - insetMid, depth: outerD - insetMid, radius: 1.75 * MM_TO_IN },
        { y: lipH,                           width: outerW - insetTop, depth: outerD - insetTop, radius: 4.0 * MM_TO_IN },
    ];

    const cornerSegs = 8;
    const ptsPerRing = cornerSegs * 4;
    const vertices = [];
    const indices = [];

    // Outer wall: straight vertical extrusion of the bin outer rect
    const outerRing = generateRoundedRectRing(outerW, outerD, 4.0 * MM_TO_IN, cornerSegs);

    // Outer sides
    const outerBotIdx = 0;
    for (let i = 0; i < ptsPerRing; i++) vertices.push(outerRing[i].x, 0, outerRing[i].z);
    for (let i = 0; i < ptsPerRing; i++) vertices.push(outerRing[i].x, lipH, outerRing[i].z);
    for (let i = 0; i < ptsPerRing; i++) {
        const next = (i + 1) % ptsPerRing;
        const a = outerBotIdx + i, b = outerBotIdx + next;
        const c = outerBotIdx + ptsPerRing + next, d = outerBotIdx + ptsPerRing + i;
        indices.push(a, c, b);
        indices.push(a, d, c);
    }

    // Inner sides (stepped profile, faces inward)
    const innerRings = innerLevels.map(l =>
        generateRoundedRectRing(l.width, l.depth, l.radius, cornerSegs).map(p => ({ ...p, y: l.y }))
    );
    for (let r = 0; r < innerRings.length - 1; r++) {
        const baseIdx = vertices.length / 3;
        const ring0 = innerRings[r], ring1 = innerRings[r + 1];
        for (let i = 0; i < ptsPerRing; i++) vertices.push(ring0[i].x, ring0[i].y, ring0[i].z);
        for (let i = 0; i < ptsPerRing; i++) vertices.push(ring1[i].x, ring1[i].y, ring1[i].z);
        for (let i = 0; i < ptsPerRing; i++) {
            const next = (i + 1) % ptsPerRing;
            const a = baseIdx + i, b = baseIdx + next;
            const c = baseIdx + ptsPerRing + next, d = baseIdx + ptsPerRing + i;
            indices.push(a, b, c);
            indices.push(a, c, d);
        }
    }

    // Bottom annular cap (between outer ring at y=0 and inner ring at y=0)
    const botOBase = vertices.length / 3;
    for (let i = 0; i < ptsPerRing; i++) vertices.push(outerRing[i].x, 0, outerRing[i].z);
    const botIBase = vertices.length / 3;
    for (let i = 0; i < ptsPerRing; i++) vertices.push(innerRings[0][i].x, 0, innerRings[0][i].z);
    for (let i = 0; i < ptsPerRing; i++) {
        const next = (i + 1) % ptsPerRing;
        indices.push(botOBase + i, botIBase + i, botIBase + next);
        indices.push(botOBase + i, botIBase + next, botOBase + next);
    }

    // Top annular cap (between outer ring at y=lipH and inner ring at y=lipH)
    const topOBase = vertices.length / 3;
    for (let i = 0; i < ptsPerRing; i++) vertices.push(outerRing[i].x, lipH, outerRing[i].z);
    const topIBase = vertices.length / 3;
    const topInner = innerRings[innerRings.length - 1];
    for (let i = 0; i < ptsPerRing; i++) vertices.push(topInner[i].x, lipH, topInner[i].z);
    for (let i = 0; i < ptsPerRing; i++) {
        const next = (i + 1) % ptsPerRing;
        indices.push(topOBase + i, topOBase + next, topIBase + next);
        indices.push(topOBase + i, topIBase + next, topIBase + i);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
}

// --- Constraint Engine ---
function calculateConstraints(config) {
    const { 
        measureMode, appMode, gridfinityType,
        width: width_IU, 
        depth: depth_IU, 
        height: height_IU, 
        gridWidth, gridDepth, gridHeight, 
        wall: wall_IU, 
        floor: floor_IU, 
        lidEnabled, lidType, 
        lidThickness: lidThick_IU, 
        lipDepth: lipDepth_IU,
        tolerance: tolerance_IU,
        holes, holeSize, infill
    } = config;

    const isGridfinity = appMode === 'gridfinity';
    const errors = [];
    const warnings = {}; // Object map for per-control warnings
    
    // Constants in IU
    const grid42_IU = 42 * IU_PER_MM;
    const grid7_IU = 7 * IU_PER_MM;
    const lipHeight_IU = 440000; // 4.4mm — stacking lip (0.35mm clearance vs 4.75mm foot)
    const railCapH_IU = 200000;  // 2.0mm * 100k
    
    // --- VALIDATION CHECKS (Mapped to Controls) ---
    // 1. Structural Thinness
    if (wall_IU < 80000) warnings.wall = "Fragile (< 0.8mm)";
    if (floor_IU < 80000) warnings.floor = "Risk of warping (< 0.8mm)";

    // 2. Lid Logic
    if (lidEnabled) {
        if (tolerance_IU === 0) warnings.tolerance = "0 tolerance: Force fit?";
        if (lidThick_IU < 40000) warnings.lidThickness = "Too thin (< 0.4mm)";
    }

    // 3. Hex Pattern
    if (holes) {
        if (holeSize < 200000) warnings.holeSize = "Too small (< 2mm)";
        if (infill < 0.25) warnings.infill = "Weak structure (< 25%)";
    }

    // 4. Horizontal Plane & Bed Size
    let outerW_IU = 0, outerD_IU = 0;
    let innerW_IU = 0, innerD_IU = 0;

    const gridTolerance_IU = 0.5 * IU_PER_MM; // 0.5mm total shrink for bin-to-bin clearance
    if (isGridfinity) {
        outerW_IU = gridWidth * grid42_IU - gridTolerance_IU;
        outerD_IU = gridDepth * grid42_IU - gridTolerance_IU;
        innerW_IU = outerW_IU - (wall_IU * 2);
        innerD_IU = outerD_IU - (wall_IU * 2);
    } else if (measureMode === 'internal') {
        innerW_IU = width_IU;
        innerD_IU = depth_IU;
        outerW_IU = innerW_IU + (wall_IU * 2);
        outerD_IU = innerD_IU + (wall_IU * 2);
    } else {
        outerW_IU = width_IU;
        outerD_IU = depth_IU;
        innerW_IU = Math.max(0, outerW_IU - (wall_IU * 2));
        innerD_IU = Math.max(0, outerD_IU - (wall_IU * 2));
    }

    // Check Bed Size (250mm limit)
    const MAX_DIM_IU = 250 * IU_PER_MM;
    const sizeWarn = "Exceeds 250mm";
    if (outerW_IU > MAX_DIM_IU) {
        if (isGridfinity) warnings.gridWidth = sizeWarn;
        else warnings.width = sizeWarn;
    }
    if (outerD_IU > MAX_DIM_IU) {
        if (isGridfinity) warnings.gridDepth = sizeWarn;
        else warnings.depth = sizeWarn;
    }

    if (innerW_IU <= 0 || innerD_IU <= 0) errors.push("Walls are too thick for the defined width/depth.");

    // 5. Vertical Stack (Cursor)
    let cursorY_IU = 0;
    const stack = { feet: null, floor: null, wall: null, rail: null, lip: null, lid: null };
    
    // A. Feet
    if (isGridfinity && gridfinityType === 'bin') {
        const footH_IU = 475000; // 4.75mm (0.7 + 1.8 + 2.25)
        stack.feet = { yMin: 0, yMax: toScene(footH_IU) };
        cursorY_IU = footH_IU;
    }

    // B. Floor
    const floorStart_IU = cursorY_IU;
    cursorY_IU += floor_IU;
    stack.floor = { yMin: toScene(floorStart_IU), yMax: toScene(cursorY_IU) };

    // C. Wall Height
    let targetWallH_IU = 0;
    
    if (isGridfinity) {
        const stackingHeight_IU = gridHeight * grid7_IU; 
        targetWallH_IU = stackingHeight_IU - cursorY_IU;
        
        if (targetWallH_IU < 10000) errors.push("Gridfinity Unit count too low for feet+floor height.");
        else targetWallH_IU = Math.max(10000, targetWallH_IU);

        // Check vertical bed limits for Gridfinity
        if (stackingHeight_IU > MAX_DIM_IU) warnings.gridHeight = sizeWarn;

        stack.bodyH = toScene(stackingHeight_IU);
    } 
    else if (measureMode === 'internal') {
        // INTERNAL MODE: height_IU is usable capacity.
        targetWallH_IU = height_IU;
        if (lidEnabled && lidType === 'step') {
            targetWallH_IU += lipDepth_IU;
        }
        
        // Calculate total external height approx to check bed limits
        const totalEstH = targetWallH_IU + cursorY_IU + (lidEnabled && lidType === 'slide' ? 500000 : 0);
        if (totalEstH > MAX_DIM_IU) warnings.height = sizeWarn;
    } 
    else {
        // EXTERNAL MODE
        let nonWallStack_IU = cursorY_IU; 
        
        if (lidEnabled && lidType === 'slide') {
             const railSpacer_IU = lidThick_IU + tolerance_IU; 
             const totalRail_IU = railCapH_IU + railSpacer_IU;
             nonWallStack_IU += totalRail_IU;
        } else if (lidEnabled && lidType === 'step') {
             nonWallStack_IU += lidThick_IU;
        }

        targetWallH_IU = height_IU - nonWallStack_IU;
        if (targetWallH_IU <= 0) errors.push("External height is too short for the floor and lid components.");
        targetWallH_IU = Math.max(10000, targetWallH_IU);

        if (height_IU > MAX_DIM_IU) warnings.height = sizeWarn;
    }

    const wallStart_IU = cursorY_IU;
    cursorY_IU += targetWallH_IU;
    stack.wall = { yMin: toScene(wallStart_IU), yMax: toScene(cursorY_IU) };

    // D. Top Features
    if (isGridfinity) {
        const lipStart_IU = cursorY_IU; 
        cursorY_IU += lipHeight_IU;
        stack.lip = { yMin: toScene(lipStart_IU), yMax: toScene(cursorY_IU) };
    }
    else if (lidEnabled && !isGridfinity) {
        if (lidType === 'slide') {
            const spacerH_IU = lidThick_IU + tolerance_IU; 
            const spacerStart_IU = cursorY_IU;
            cursorY_IU += spacerH_IU;
            
            const capStart_IU = cursorY_IU;
            cursorY_IU += railCapH_IU;

            stack.rail = { 
                spacer: { yMin: toScene(spacerStart_IU), yMax: toScene(spacerStart_IU + spacerH_IU) },
                cap: { yMin: toScene(capStart_IU), yMax: toScene(capStart_IU + railCapH_IU) }
            };

            stack.lid = {
                yPos: toScene(spacerStart_IU + (lidThick_IU/2)),
                type: 'slide',
                thickness: toScene(lidThick_IU),
                width: toScene(outerW_IU - wall_IU - tolerance_IU), 
                depth: toScene(outerD_IU - tolerance_IU)
            };
        }
        else if (lidType === 'step') {
            const lidStart_IU = cursorY_IU;
            stack.lid = {
                yPos: toScene(lidStart_IU),
                type: 'step',
                thickness: toScene(lidThick_IU),
                insertDepth: toScene(lipDepth_IU),
                width: toScene(outerW_IU),
                depth: toScene(outerD_IU)
            };
            cursorY_IU += lidThick_IU;
        }
    }

    return {
        outerW: toScene(outerW_IU),
        outerD: toScene(outerD_IU),
        innerW: toScene(innerW_IU),
        innerD: toScene(innerD_IU),
        totalH: toScene(cursorY_IU),
        innerH: toScene(stack.wall.yMax - stack.floor.yMax),
        bodyH: stack.bodyH, 
        stack: stack,
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings
    };
}

function generateSTL(scene) {
  let output = 'solid exported\n';
  const normal = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();

  scene.traverse((object) => {
    if (object.isMesh && object.geometry && object.visible) {
        if (object.material && object.material.type !== 'MeshStandardMaterial') return;

      const geometry = object.geometry.clone();
      object.updateMatrixWorld();
      geometry.applyMatrix4(object.matrixWorld);

      const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
      const positions = nonIndexed.attributes.position.array;

      for (let i = 0; i < positions.length; i += 9) {
        v1.set(positions[i], positions[i + 1], positions[i + 2]);
        v2.set(positions[i + 3], positions[i + 4], positions[i + 5]);
        v3.set(positions[i + 6], positions[i + 7], positions[i + 8]);

        const edge1 = new THREE.Vector3().subVectors(v2, v1);
        const edge2 = new THREE.Vector3().subVectors(v3, v1);
        normal.crossVectors(edge1, edge2).normalize();
        if (isNaN(normal.x)) normal.set(0, 1, 0); 

        v1.multiplyScalar(IN_TO_MM);
        v2.multiplyScalar(IN_TO_MM);
        v3.multiplyScalar(IN_TO_MM);

        output += `facet normal ${normal.x} ${normal.y} ${normal.z}\n`;
        output += `  outer loop\n`;
        output += `    vertex ${v1.x} ${v1.y} ${v1.z}\n`;
        output += `    vertex ${v2.x} ${v2.y} ${v2.z}\n`;
        output += `    vertex ${v3.x} ${v3.y} ${v3.z}\n`;
        output += `  endloop\n`;
        output += `endfacet\n`;
      }
    }
  });
  output += 'endsolid exported\n';
  return output;
}

// --- UI Components ---
function AlertBlock({ type, messages }) {
    if (!messages || messages.length === 0) return null;
    // Only used for global errors now
    if (type !== 'error') return null;
    
    return (
        <div className="mb-4 p-3 border rounded text-xs bg-red-900/40 border-red-700/50 text-red-200">
            <strong className="block mb-1 font-bold text-red-400">Configuration Error</strong>
            <ul className="list-disc pl-4 space-y-0.5 opacity-90">
                {messages.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
        </div>
    );
}

function SegmentedControl({ options, value, onChange, disabled }) {
    return (
        <div className={`flex w-full mb-5 bg-gray-900/50 p-1 rounded-lg border border-gray-700 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            {options.map((opt) => (
                <button
                    key={opt.value}
                    onClick={() => onChange(opt.value)}
                    className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all duration-200 ${
                        value === opt.value
                        ? 'bg-blue-600 text-white shadow-sm ring-1 ring-white/10'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                    }`}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

function ControlInput({ label, value, min, max, step, onChange, unitLabel, error, warning, description, disabled }) {
    const isInch = unitLabel === 'in'; 
    const format = (v) => {
        if (unitLabel === '%') return Math.round(v).toString();
        return unitLabel === 'in' ? v.toFixed(3) : v.toFixed(1);
    };

    const [localVal, setLocalVal] = useState(format(value));
    
    useEffect(() => {
        const num = parseFloat(localVal);
        if (Math.abs(num - value) > 0.0001) {
             setLocalVal(format(value));
        }
    }, [value, unitLabel]); 

    const commit = (valStr) => {
        const num = parseFloat(valStr);
        if (!isNaN(num)) {
            onChange(num);
        }
    };

    const onBlur = () => commit(localVal);
    const onKeyDown = (e) => { if(e.key === 'Enter') commit(localVal); };

    const percentage = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;

    return (
        <div className={`mb-5 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="flex justify-between items-baseline mb-1">
                <span className="text-gray-300 font-bold text-xs">{label}</span>
                {warning && <span className="text-amber-500 font-bold text-[10px] animate-pulse">{warning}</span>}
                {error && <span className="text-red-400 font-bold text-xs">{error}</span>}
            </div>
            {description && (
                <p className="text-[10px] text-gray-500 mb-2 leading-tight">{description}</p>
            )}
            <div className="flex items-center space-x-3">
                <input 
                    type="range" 
                    min={min} 
                    max={max} 
                    step={step}
                    value={value} 
                    onChange={(e) => onChange(parseFloat(e.target.value))}
                    className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer 
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110
                    [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:bg-blue-400 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:transition-all [&::-moz-range-thumb]:hover:scale-110"
                    style={{ background: `linear-gradient(to right, #2563eb ${percentage}%, #374151 ${percentage}%)` }}
                />
                <div className="flex items-center bg-gray-800 rounded px-2 py-1 border border-gray-700">
                    <input 
                        type="text" 
                        value={localVal}
                        onChange={(e) => setLocalVal(e.target.value)}
                        onBlur={onBlur}
                        onKeyDown={onKeyDown}
                        className="w-14 bg-transparent text-right text-xs text-white focus:outline-none font-mono"
                    />
                    {unitLabel && <span className="text-gray-500 text-[10px] ml-1">{unitLabel}</span>}
                </div>
            </div>
        </div>
    );
}

// --- Compartment Editor (Birds-Eye Wall Placement) ---
// Wall data model: { axis: 'x'|'z', pos: <mm>, seg: <index> }
// axis='x': vertical wall at x=pos, segment seg (0..gridDepth-1) spans one cell in z
// axis='z': horizontal wall at z=pos, segment seg (0..gridWidth-1) spans one cell in x
function CompartmentEditor({ gridWidth, gridDepth, walls, onWallsChange }) {
    const svgRef = useRef(null);
    const [hover, setHover] = useState(null); // { axis, pos, seg }

    const CELL_MM = 42;
    const totalW = gridWidth * CELL_MM;
    const totalD = gridDepth * CELL_MM;

    const maxPx = 220;
    const scale = maxPx / Math.max(totalW, totalD);
    const svgW = totalW * scale;
    const svgH = totalD * scale;

    const wallExists = (axis, pos, seg) =>
        walls.some(w => w.axis === axis && w.pos === pos && w.seg === seg);

    const toggleWall = (axis, pos, seg) => {
        if (wallExists(axis, pos, seg)) {
            onWallsChange(walls.filter(w => !(w.axis === axis && w.pos === pos && w.seg === seg)));
        } else {
            onWallsChange([...walls, { axis, pos, seg }]);
        }
    };

    const handleMouseMove = (e) => {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mx = ((e.clientX - rect.left) / rect.width) * totalW;
        const mz = ((e.clientY - rect.top) / rect.height) * totalD;

        let best = null;
        let bestDist = Infinity;

        // Check vertical lines (x-axis walls)
        for (let xi = 1; xi < gridWidth; xi++) {
            const x = xi * CELL_MM;
            const d = Math.abs(mx - x);
            if (d < bestDist && d < CELL_MM * 0.4) {
                const seg = Math.max(0, Math.min(gridDepth - 1, Math.floor(mz / CELL_MM)));
                bestDist = d;
                best = { axis: 'x', pos: x, seg };
            }
        }
        // Check horizontal lines (z-axis walls)
        for (let zi = 1; zi < gridDepth; zi++) {
            const z = zi * CELL_MM;
            const d = Math.abs(mz - z);
            if (d < bestDist && d < CELL_MM * 0.4) {
                const seg = Math.max(0, Math.min(gridWidth - 1, Math.floor(mx / CELL_MM)));
                bestDist = d;
                best = { axis: 'z', pos: z, seg };
            }
        }
        setHover(best);
    };

    const handleClick = () => {
        if (hover) toggleWall(hover.axis, hover.pos, hover.seg);
    };

    // Helper: get line coords for a wall segment
    const segCoords = (w) => {
        if (w.axis === 'x') {
            return { x1: w.pos, y1: w.seg * CELL_MM, x2: w.pos, y2: (w.seg + 1) * CELL_MM };
        } else {
            return { x1: w.seg * CELL_MM, y1: w.pos, x2: (w.seg + 1) * CELL_MM, y2: w.pos };
        }
    };

    return (
        <div className="mb-4">
            <span className="text-xs font-bold text-gray-300 block mb-2">Compartments</span>
            <div className="flex justify-center">
                <svg
                    ref={svgRef}
                    width={svgW}
                    height={svgH}
                    className="bg-gray-900 border border-gray-600 rounded cursor-crosshair"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={() => setHover(null)}
                    onClick={handleClick}
                    viewBox={`0 0 ${totalW} ${totalD}`}
                >
                    {/* Grid unit lines (dashed) */}
                    {Array.from({ length: gridWidth - 1 }, (_, i) => (i + 1) * CELL_MM).map(x => (
                        <line key={`gx${x}`} x1={x} y1={0} x2={x} y2={totalD}
                            stroke="#374151" strokeWidth={0.5} strokeDasharray="2,2" />
                    ))}
                    {Array.from({ length: gridDepth - 1 }, (_, i) => (i + 1) * CELL_MM).map(z => (
                        <line key={`gz${z}`} x1={0} y1={z} x2={totalW} y2={z}
                            stroke="#374151" strokeWidth={0.5} strokeDasharray="2,2" />
                    ))}

                    {/* Placed wall segments */}
                    {walls.map((w, i) => {
                        const c = segCoords(w);
                        return <line key={`w${i}`} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2}
                            stroke="#60a5fa" strokeWidth={1.5} />;
                    })}

                    {/* Hover preview */}
                    {hover && (() => {
                        const c = segCoords(hover);
                        const exists = wallExists(hover.axis, hover.pos, hover.seg);
                        return <line x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2}
                            stroke={exists ? "#ef4444" : "#3b82f6"}
                            strokeWidth={exists ? 2 : 1}
                            opacity={exists ? 0.6 : 0.5}
                            strokeDasharray={exists ? undefined : "3,2"} />;
                    })()}

                    {/* Outer border */}
                    <rect x={0} y={0} width={totalW} height={totalD}
                        fill="none" stroke="#9ca3af" strokeWidth={1} />
                </svg>
            </div>
            <p className="text-[10px] text-gray-500 mt-1 text-center">Click grid lines to add/remove dividers</p>
            {walls.length > 0 && (
                <button onClick={() => onWallsChange([])}
                    className="mt-2 w-full py-1 text-[10px] text-gray-400 hover:text-red-400 border border-gray-700 rounded transition-colors">
                    Clear All Walls
                </button>
            )}
        </div>
    );
}

// --- Main App ---
export default function App() {
  const mountRef = useRef(null);
  const modelGroupRef = useRef(new THREE.Group());
  const labelGroupRef = useRef(new THREE.Group());
  const cameraRef = useRef(null);
  
  const [appMode, setAppMode] = useState('in');
  const [showMeasure, setShowMeasure] = useState(true);
  const [compartmentWalls, setCompartmentWalls] = useState([]);
  
  // DEFAULT CONFIG (Micron Native)
  const [config, setConfig] = useState({
      measureMode: 'internal',
      gridfinityType: 'bin', 
      lidEnabled: false,
      lidType: 'step', 
      
      width: initIn(3.5),  
      depth: initIn(5.5), 
      height: initIn(2.5),
      
      wall: initIn(0.08), 
      floor: initIn(0.08),
      lidThickness: initIn(0.08),
      lipDepth: initIn(0.15),
      tolerance: initIn(0.01),
      
      holeSize: initIn(0.25),
      
      gridWidth: 2,
      gridDepth: 3,
      gridHeight: 6, 
      holes: false,
      infill: 0.50
  });

  // Prune walls that are out of bounds when grid shrinks
  useEffect(() => {
      if (compartmentWalls.length === 0) return;
      const maxX = config.gridWidth * 42;
      const maxZ = config.gridDepth * 42;
      const valid = compartmentWalls.filter(w => {
          if (w.axis === 'x') return w.pos < maxX && w.seg < config.gridDepth;
          else return w.pos < maxZ && w.seg < config.gridWidth;
      });
      if (valid.length !== compartmentWalls.length) setCompartmentWalls(valid);
  }, [config.gridWidth, config.gridDepth]);

  const updateConfig = (key, value) => {
      if (typeof value === 'number') {
          if (isNaN(value) || value < 0) return;
          setConfig(prev => ({ ...prev, [key]: value }));
      } else {
          setConfig(prev => ({ ...prev, [key]: value }));
      }
  };

  const getDisplayProps = (key, minIn, maxIn) => {
      const valIU = config[key];
      if (appMode === 'mm') {
          return {
              value: valIU / IU_PER_MM,
              min: minIn * 25.4,
              max: maxIn * 25.4,
              step: 1.0, 
              unitLabel: 'mm',
              onChange: (v) => updateConfig(key, Math.round(v * IU_PER_MM))
          };
      } else {
          return {
              value: valIU / IU_PER_IN,
              min: minIn,
              max: maxIn,
              step: 0.125, 
              unitLabel: 'in',
              onChange: (v) => updateConfig(key, Math.round(v * IU_PER_IN))
          };
      }
  };

  const getStructProps = (key, minIn, maxIn) => {
      const valIU = config[key];
      if (appMode === 'mm' || appMode === 'gridfinity') { 
          return {
              value: valIU / IU_PER_MM,
              min: minIn * 25.4,
              max: maxIn * 25.4,
              step: 0.1, 
              unitLabel: 'mm',
              onChange: (v) => updateConfig(key, Math.round(v * IU_PER_MM))
          };
      } else {
          return {
              value: valIU / IU_PER_IN,
              min: minIn,
              max: maxIn,
              step: 0.005, 
              unitLabel: 'in',
              onChange: (v) => updateConfig(key, Math.round(v * IU_PER_IN))
          };
      }
  };

  const isGridfinity = appMode === 'gridfinity';
  const isMM = appMode === 'mm' || isGridfinity; 
  
  const layout = useMemo(() => calculateConstraints({ ...config, appMode }), [config, appMode]);

  const handleExport = () => {
    if (!modelGroupRef.current) return;
    const stlString = generateSTL(modelGroupRef.current);
    const blob = new Blob([stlString], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    let name = "box";
    if (isGridfinity) {
        name = `gridfinity_${config.gridWidth}x${config.gridDepth}x${config.gridHeight}U`;
    } else {
        const w = appMode === 'mm' ? (config.width / IU_PER_MM).toFixed(0) : (config.width / IU_PER_IN).toFixed(2);
        const d = appMode === 'mm' ? (config.depth / IU_PER_MM).toFixed(0) : (config.depth / IU_PER_IN).toFixed(2);
        name = `box_${w}x${d}${appMode}`;
    }
    link.download = `${name}.stl`;
    link.click();
  };

  // --- Scene Setup ---
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    while(mount.firstChild) mount.removeChild(mount.firstChild);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#111827'); 
    
    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 2000);
    camera.position.set(8, 10, 10); 
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera; 
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none'; 
    mount.appendChild(labelRenderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const bottomLight = new THREE.DirectionalLight(0xffffff, 0.9);
    bottomLight.position.set(12, -5, 15);
    scene.add(bottomLight);

    const bottomLight2 = new THREE.DirectionalLight(0xffffff, 0.6);
    bottomLight2.position.set(-10, -4, -12);
    scene.add(bottomLight2);
    
    const gridHelper = new THREE.GridHelper(100, 100, 0x374151, 0x1f2937);
    scene.add(gridHelper);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    scene.add(modelGroupRef.current);
    scene.add(labelGroupRef.current);

    const animate = () => {
      requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
        if (mount && renderer && camera) {
            camera.aspect = mount.clientWidth / mount.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(mount.clientWidth, mount.clientHeight);
            labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
        }
    });
    resizeObserver.observe(mount);

    return () => resizeObserver.disconnect();
  }, []);

  // --- GEOMETRY GENERATION ---
  useEffect(() => {
    const group = modelGroupRef.current;
    while(group.children.length > 0) {
        const c = group.children[0];
        if(c.geometry) c.geometry.dispose();
        if(c.material) c.material.dispose();
        group.remove(c);
    }

    const { outerW, outerD, stack } = layout;
    const { wall, holes, holeSize, gridfinityType, lidEnabled, lidType, infill } = config;

    const material = new THREE.MeshStandardMaterial({
        color: "#3b82f6", roughness: 0.5, metalness: 0.1,
        side: THREE.DoubleSide
    });
    const lidMaterial = new THREE.MeshStandardMaterial({ 
        color: "#3b82f6", roughness: 0.5, metalness: 0.1
    });

    const addMesh = (geo, x, y, z, rotX=0, rotY=0, mat=material) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        if(rotX) mesh.rotation.x = rotX;
        if(rotY) mesh.rotation.y = rotY;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    };

    // --- GRIDFINITY FRAME (FEMALE) ---
    if (isGridfinity && gridfinityType === 'frame') {
        const unitsX = config.gridWidth;
        const unitsZ = config.gridDepth;
        const GRID_IN = 42 * MM_TO_IN; 
        const frameH = 5.0 * MM_TO_IN;
        
        const frameShape = new THREE.Shape();
        frameShape.moveTo(-outerW/2, -outerD/2);
        frameShape.lineTo(outerW/2, -outerD/2);
        frameShape.lineTo(outerW/2, outerD/2);
        frameShape.lineTo(-outerW/2, outerD/2);
        frameShape.lineTo(-outerW/2, -outerD/2);

        const startX = -(outerW / 2) + (GRID_IN / 2);
        const startZ = -(outerD / 2) + (GRID_IN / 2);

        for (let i = 0; i < unitsX; i++) {
            for (let j = 0; j < unitsZ; j++) {
                const cx = startX + (i * GRID_IN);
                const cz = startZ + (j * GRID_IN);
                const x = cx - (41.5 * MM_TO_IN)/2;
                const y = cz - (41.5 * MM_TO_IN)/2;
                const w = 41.5 * MM_TO_IN; const h = 41.5 * MM_TO_IN; const r = 4.0 * MM_TO_IN;
                
                const holeAt = new THREE.Path();
                holeAt.moveTo(x + r, y);
                holeAt.lineTo(x + w - r, y);
                holeAt.quadraticCurveTo(x + w, y, x + w, y + r);
                holeAt.lineTo(x + w, y + h - r);
                holeAt.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                holeAt.lineTo(x + r, y + h);
                holeAt.quadraticCurveTo(x, y + h, x, y + h - r);
                holeAt.lineTo(x, y + r);
                holeAt.quadraticCurveTo(x, y, x + r, y);
                frameShape.holes.push(holeAt);
            }
        }
        
        const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: frameH, bevelEnabled: false });
        frameGeo.rotateX(-Math.PI/2);
        const gap = 30 * MM_TO_IN;
        const boxOffsetX = -(outerW / 2) - gap;
        addMesh(frameGeo, boxOffsetX, 0, 0); 
        return; 
    }

    // --- PARTS BUILDER ---
    const gap = 30 * MM_TO_IN;
    const boxOffsetX = -(outerW / 2) - gap;

    // 1. FEET (proper chamfered profile per Gridfinity spec)
    if (stack.feet) {
        const unitsX = config.gridWidth;
        const unitsZ = config.gridDepth;
        const GRID_IN = 42.0 * MM_TO_IN;
        const footGeo = createGridfinityFootGeo(true);

        // Feet on nominal 42mm grid centers (independent of 0.5mm outer shrink)
        const nominalW = unitsX * GRID_IN;
        const nominalD = unitsZ * GRID_IN;
        const startX = -(nominalW / 2) + (GRID_IN / 2);
        const startZ = -(nominalD / 2) + (GRID_IN / 2);

        for (let i = 0; i < unitsX; i++) {
            for (let j = 0; j < unitsZ; j++) {
                const cx = startX + (i * GRID_IN);
                const cz = startZ + (j * GRID_IN);
                addMesh(footGeo, cx + boxOffsetX, stack.feet.yMin, cz);
            }
        }
    }

    // 2. FLOOR
    if (stack.floor) {
        const h = stack.floor.yMax - stack.floor.yMin + GEO_OVERLAP;
        const geo = new THREE.BoxGeometry(outerW, h, outerD);
        addMesh(geo, boxOffsetX, stack.floor.yMin + (h/2) - GEO_OVERLAP, 0);
    }

    // 3. WALLS
    if (stack.wall) {
        const h = stack.wall.yMax - stack.wall.yMin + GEO_OVERLAP;
        const y = stack.wall.yMin - GEO_OVERLAP;
        
        const wallThick = toScene(config.wall);

        if (holes) {
            const createPerforatedWall = (w, height, thick) => {
                const shape = new THREE.Shape();
                shape.moveTo(-w/2, 0);
                shape.lineTo(w/2, 0);
                shape.lineTo(w/2, height);
                shape.lineTo(-w/2, height);
                shape.lineTo(-w/2, 0);

                const hexR = toScene(config.holeSize) / 2 + (0.5 / 2) * MM_TO_IN; // +0.5mm clearance
                const voidFraction = 1 - Math.min(0.99, Math.max(0.01, infill));
                const centerSpacing = hexR * Math.sqrt(3 / voidFraction);
                const spacingX = centerSpacing;
                const spacingY = centerSpacing * Math.sqrt(3) / 2;

                const margin = thick * 1.5;
                const availW = w - (margin * 2);
                const availH = height - (margin * 2);
                
                const startX = -w/2 + margin + hexR;
                const startY = margin + hexR;

                const cols = Math.floor(availW / spacingX);
                const rows = Math.floor(availH / spacingY);

                if (cols > 0 && rows > 0) {
                    for(let r=0; r<rows; r++) {
                        for(let c=0; c<cols; c++) {
                            const isOddRow = r % 2 === 1;
                            const offsetX = isOddRow ? spacingX / 2 : 0;
                            if (isOddRow && c === cols - 1) continue; 

                            const cx = startX + (c * spacingX) + offsetX;
                            const cy = startY + (r * spacingY);
                            if (cx > w/2 - margin || cy > height - margin) continue;

                            const hex = createHexagonPath(cx, cy, hexR);
                            shape.holes.push(hex);
                        }
                    }
                }
                return new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
            };

            const fbGeo = createPerforatedWall(outerW, h, wallThick);
            addMesh(fbGeo, boxOffsetX, y, outerD/2 - wallThick, 0, 0); 
            addMesh(fbGeo, boxOffsetX, y, -outerD/2, 0, 0); 

            const sideW = outerD - (wallThick * 2.05); 
            const lrGeo = createPerforatedWall(sideW, h, wallThick);
            addMesh(lrGeo, boxOffsetX + outerW/2 - wallThick, y, 0, 0, Math.PI/2);
            addMesh(lrGeo, boxOffsetX - outerW/2, y, 0, 0, Math.PI/2);

        } else {
            const shape = new THREE.Shape();
            shape.moveTo(-outerW/2, -outerD/2);
            shape.lineTo(outerW/2, -outerD/2);
            shape.lineTo(outerW/2, outerD/2);
            shape.lineTo(-outerW/2, outerD/2);
            shape.lineTo(-outerW/2, -outerD/2);
            
            const iw = outerW - (wallThick*2);
            const id = outerD - (wallThick*2);
            const inner = new THREE.Path();
            inner.moveTo(-iw/2, -id/2);
            inner.lineTo(iw/2, -id/2);
            inner.lineTo(iw/2, id/2);
            inner.lineTo(-iw/2, id/2);
            inner.lineTo(-iw/2, -id/2);
            shape.holes.push(inner);

            const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
            geo.rotateX(-Math.PI/2);
            addMesh(geo, boxOffsetX, y, 0);
        }
    }

    // 3.5. COMPARTMENT DIVIDERS (per-segment)
    if (stack.wall && compartmentWalls.length > 0) {
        const h = stack.wall.yMax - stack.wall.yMin + GEO_OVERLAP;
        const y = stack.wall.yMin - GEO_OVERLAP;
        const wallThick = toScene(config.wall);
        const GRID_IN = 42.0 * MM_TO_IN;

        for (const w of compartmentWalls) {
            if (w.axis === 'x') {
                // Vertical segment: spans one cell in Z
                const segLen = GRID_IN; // one cell
                const geo = new THREE.BoxGeometry(wallThick, h, segLen);
                const wx = -(outerW / 2) + (w.pos * MM_TO_IN);
                const wz = -(outerD / 2) + (w.seg + 0.5) * GRID_IN;
                addMesh(geo, boxOffsetX + wx, y + h / 2, wz);
            } else {
                // Horizontal segment: spans one cell in X
                const segLen = GRID_IN;
                const geo = new THREE.BoxGeometry(segLen, h, wallThick);
                const wz = -(outerD / 2) + (w.pos * MM_TO_IN);
                const wx = -(outerW / 2) + (w.seg + 0.5) * GRID_IN;
                addMesh(geo, boxOffsetX + wx, y + h / 2, wz);
            }
        }
    }

    // 4. RAILS
    if (stack.rail) {
        const { spacer, cap } = stack.rail;
        const spH = spacer.yMax - spacer.yMin;
        const spY = spacer.yMin;
        const spThick = toScene(config.wall) / 2;
        
        const sideSpacer = new THREE.BoxGeometry(spThick, spH, outerD);
        addMesh(sideSpacer, boxOffsetX-(outerW/2)+(spThick/2), spY + spH/2, 0);
        addMesh(sideSpacer, boxOffsetX+(outerW/2)-(spThick/2), spY + spH/2, 0);
        
        const spBack = new THREE.BoxGeometry(outerW - (spThick*2), spH, spThick);
        addMesh(spBack, boxOffsetX, spY + spH/2, -(outerD/2)+(spThick/2));

        const cH = cap.yMax - cap.yMin;
        const cY = cap.yMin;
        const capWidth = toScene(config.wall); 
        
        const cSide = new THREE.BoxGeometry(capWidth, cH, outerD);
        addMesh(cSide, boxOffsetX-(outerW/2)+(capWidth/2), cY + cH/2, 0);
        addMesh(cSide, boxOffsetX+(outerW/2)-(capWidth/2), cY + cH/2, 0);
        
        const cBack = new THREE.BoxGeometry(outerW - (capWidth*2), cH, capWidth);
        addMesh(cBack, boxOffsetX, cY + cH/2, -(outerD/2)+(capWidth/2));
    }

    // 5. LIP (proper stepped profile matching foot inverse)
    if (stack.lip) {
        const lipGeo = createGridfinityLipGeo(outerW, outerD);
        addMesh(lipGeo, boxOffsetX, stack.lip.yMin, 0);
    }

    // 6. LID GEOMETRY
    if (stack.lid) {
        const { type, thickness, insertDepth, width, depth } = stack.lid;
        const lidX = (outerW / 2) + gap; 
        
        if (type === 'step') {
            const plate = new THREE.BoxGeometry(outerW, thickness, outerD);
            addMesh(plate, lidX, thickness/2, 0, 0, 0, lidMaterial);
            if (insertDepth > 0) {
                // Apply Tolerance Logic Here
                const tol = toScene(config.tolerance);
                const innerW = outerW - (toScene(config.wall)*2) - (tol !== undefined ? tol : 0.01);
                const innerD = outerD - (toScene(config.wall)*2) - (tol !== undefined ? tol : 0.01);
                const insert = new THREE.BoxGeometry(innerW, insertDepth, innerD);
                addMesh(insert, lidX, thickness + insertDepth/2, 0, 0, 0, lidMaterial);
            }
        } 
        else if (type === 'slide') {
            const plate = new THREE.BoxGeometry(width, thickness, depth);
            addMesh(plate, lidX, thickness/2, 0, 0, 0, lidMaterial);
            const hGeo = new THREE.BoxGeometry(outerW * 0.2, thickness * 2, thickness);
            addMesh(hGeo, lidX, thickness * 1.5, depth/2 - thickness, 0, 0, lidMaterial);
        }
    }

  }, [layout, config, compartmentWalls]);

  // --- DIMENSION LABELS ---
  useEffect(() => {
      const group = labelGroupRef.current;
      while(group.children.length > 0) group.remove(group.children[0]);
      
      if (!showMeasure || !layout || !cameraRef.current) return;

      const { outerW, outerD, totalH, innerW, innerH, stack } = layout;
      const { gridfinityType } = config; 
      const green = 0x4ade80;
      const red = 0xf87171;
      const blue = 0x60a5fa; 
      const gap = 30 * MM_TO_IN;
      const boxOffsetX = -(outerW / 2) - gap;

      const addLabel = (pos, val, color, labelText) => {
          const div = document.createElement('div');
          div.className = 'label';
          
          const showMM = isMM;
          const txtVal = showMM ? (val * IN_TO_MM).toFixed(1) : val.toFixed(2);
          const unit = showMM ? 'mm' : '"';
          const fullText = labelText ? `${labelText}: ${txtVal}${unit}` : `${txtVal}${unit}`;
          
          div.textContent = fullText;
          div.style.color = color === green ? '#4ade80' : (color === blue ? '#60a5fa' : '#f87171');
          div.style.fontSize = '12px';
          div.style.fontWeight = 'bold';
          div.style.textShadow = '1px 1px 2px black';
          div.style.zIndex = '100'; 
          div.style.whiteSpace = 'nowrap';
          
          const label = new CSS2DObject(div);
          label.position.copy(pos);
          group.add(label);
      };

      const addArrow = (start, end, color) => {
          const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), mat);
          group.add(line);
          
          const dir = end.clone().sub(start).normalize();
          const len = 0.15;
          const cone = new THREE.Mesh(new THREE.ConeGeometry(0.04, len, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
          cone.renderOrder = 999;
          cone.position.copy(end);
          cone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.clone().negate());
          cone.position.add(dir.clone().multiplyScalar(-len/2));
          group.add(cone);
          
          const cone2 = new THREE.Mesh(new THREE.ConeGeometry(0.04, len, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
          cone2.renderOrder = 999;
          cone2.position.copy(start);
          cone2.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
          cone2.position.add(dir.clone().multiplyScalar(len/2));
          group.add(cone2);
      };

      const extOff = 0.5;

      // 1. External Width (Back)
      const wStart = new THREE.Vector3(boxOffsetX - outerW/2, 0, -outerD/2 - extOff);
      const wEnd = new THREE.Vector3(boxOffsetX + outerW/2, 0, -outerD/2 - extOff);
      addArrow(wStart, wEnd, green);
      addLabel(wStart.clone().lerp(wEnd, 0.5).add(new THREE.Vector3(0, 0, -0.1)), outerW, green, "Ext W");

      // 2. External Depth (Right)
      const dStart = new THREE.Vector3(boxOffsetX + outerW/2 + extOff, 0, -outerD/2);
      const dEnd = new THREE.Vector3(boxOffsetX + outerW/2 + extOff, 0, outerD/2);
      addArrow(dStart, dEnd, green);
      addLabel(dStart.clone().lerp(dEnd, 0.5).add(new THREE.Vector3(0.1, 0, 0)), outerD, green, "Ext D");

      // 3. Height (Left)
      // Standard: Total Height. Gridfinity: Measure BODY (Rim) Height + Lip.
      if (isGridfinity && layout.bodyH) {
          // Body Height
          const bodyH = layout.bodyH;
          const hStart = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, 0, outerD/2);
          const hEnd = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, bodyH, outerD/2);
          addArrow(hStart, hEnd, green);
          addLabel(hStart.clone().lerp(hEnd, 0.5).add(new THREE.Vector3(-0.1, 0, 0)), bodyH, green, "Body H");
          
          // Lip Height (Blue)
          const lipH = 4.4 * MM_TO_IN;
          const lStart = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, bodyH, outerD/2);
          const lEnd = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, totalH, outerD/2);
          addArrow(lStart, lEnd, blue);
          addLabel(lStart.clone().lerp(lEnd, 0.5).add(new THREE.Vector3(-0.1, 0, 0)), lipH, blue, "Lip");
      } else {
          const hStart = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, 0, outerD/2);
          const hEnd = new THREE.Vector3(boxOffsetX - outerW/2 - extOff, totalH, outerD/2);
          addArrow(hStart, hEnd, green);
          addLabel(hStart.clone().lerp(hEnd, 0.5).add(new THREE.Vector3(-0.1, 0, 0)), totalH, green, "Ext H");
      }

      // 4. Internal Dimensions
      if (gridfinityType === 'bin' || !isGridfinity) {
          const measureY = stack.wall.yMax - 0.5; 
          
          const iwStart = new THREE.Vector3(boxOffsetX - layout.innerW/2, measureY, -layout.innerD/4);
          const iwEnd = new THREE.Vector3(boxOffsetX + layout.innerW/2, measureY, -layout.innerD/4);
          addArrow(iwStart, iwEnd, red);
          addLabel(iwStart.clone().lerp(iwEnd, 0.5).add(new THREE.Vector3(0, 0.1, 0)), layout.innerW, red, "Int W");
          
          const idStart = new THREE.Vector3(boxOffsetX + layout.innerW/4, measureY, -layout.innerD/2);
          const idEnd = new THREE.Vector3(boxOffsetX + layout.innerW/4, measureY, layout.innerD/2);
          addArrow(idStart, idEnd, red);
          addLabel(idStart.clone().lerp(idEnd, 0.5).add(new THREE.Vector3(0, 0.1, 0)), layout.innerD, red, "Int D");
          
          // Internal Height (Red Vertical) with compensation for Lid Insert
          const ihX = boxOffsetX - layout.innerW/2 + 0.2; 
          const ihZ = layout.innerD/2 - 0.2;
          const floorTop = stack.floor ? stack.floor.yMax : 0;
          let iH = stack.wall.yMax - floorTop;
          
          // If Step Lid in Internal Mode, the wall is taller than requested capacity.
          // Subtract the insert depth to show the *usable* height.
          if (config.measureMode === 'internal' && config.lidType === 'step' && config.lidEnabled) {
              iH -= toScene(config.lipDepth);
          }

          const ihStart = new THREE.Vector3(ihX, floorTop, ihZ);
          const ihEnd = new THREE.Vector3(ihX, floorTop + iH, ihZ);
          addArrow(ihStart, ihEnd, red);
          addLabel(ihStart.clone().lerp(ihEnd, 0.5).add(new THREE.Vector3(0.1, 0, -0.1)), iH, red, "Usable H");
      }

      // 5. Lid Dimensions
      if (stack.lid) {
          const lidX = (outerW / 2) + gap;
          const { width: lW, depth: lD, thickness: lT, insertDepth, type } = stack.lid;
          
          // Lid Width (Top)
          const lStart = new THREE.Vector3(lidX - lW/2, 0, lD/2 + 0.5);
          const lEnd = new THREE.Vector3(lidX + lW/2, 0, lD/2 + 0.5);
          addArrow(lStart, lEnd, blue);
          addLabel(lStart.clone().lerp(lEnd, 0.5).add(new THREE.Vector3(0, 0, 0.1)), lW, blue, "Lid W");
          
          // Lid Depth (Z-axis) - Shifted right
          const dStart = new THREE.Vector3(lidX + lW/2 + 1.0, 0, -lD/2);
          const dEnd = new THREE.Vector3(lidX + lW/2 + 1.0, 0, lD/2);
          addArrow(dStart, dEnd, blue);
          addLabel(dStart.clone().lerp(dEnd, 0.5).add(new THREE.Vector3(0.1, 0, 0)), lD, blue, "Lid D");

          // Lid Thickness
          const tStart = new THREE.Vector3(lidX + lW/2 + 0.2, 0, 0);
          const tEnd = new THREE.Vector3(lidX + lW/2 + 0.2, lT, 0);
          addArrow(tStart, tEnd, blue);
          addLabel(tStart.clone().lerp(tEnd, 0.5).add(new THREE.Vector3(0.1, 0, 0)), lT, blue, "Thick");

          // Insert Dimensions (Tolerance Check)
          if (type === 'step' && insertDepth > 0) {
              const tol = toScene(config.tolerance);
              const insertW = outerW - (toScene(config.wall)*2) - (tol !== undefined ? tol : 0.01);
              
              // Insert Width
              const iStart = new THREE.Vector3(lidX - insertW/2, lT + insertDepth + 0.2, 0);
              const iEnd = new THREE.Vector3(lidX + insertW/2, lT + insertDepth + 0.2, 0);
              addArrow(iStart, iEnd, blue);
              addLabel(iStart.clone().lerp(iEnd, 0.5).add(new THREE.Vector3(0, 0.1, 0)), insertW, blue, "Insert W");
              
              // Insert Depth Label (Vertical)
              const idStart = new THREE.Vector3(lidX - lW/2 - 0.2, lT, 0);
              const idEnd = new THREE.Vector3(lidX - lW/2 - 0.2, lT + insertDepth, 0);
              addArrow(idStart, idEnd, blue);
              addLabel(idStart.clone().lerp(idEnd, 0.5).add(new THREE.Vector3(-0.1, 0, 0)), insertDepth, blue, "Ins D");
          }

          // Lid Total Height
          let totalLidH = lT;
          if (type === 'step') totalLidH += insertDepth;
          if (type === 'slide') totalLidH = lT * 2.5; 

          // Shifted further left
          const hStart = new THREE.Vector3(lidX - lW/2 - 1.0, 0, 0);
          const hEnd = new THREE.Vector3(lidX - lW/2 - 1.0, totalLidH, 0);
          addArrow(hStart, hEnd, blue);
          addLabel(hStart.clone().lerp(hEnd, 0.5).add(new THREE.Vector3(-0.1, 0, 0)), totalLidH, blue, "Total H");
      }

  }, [layout, showMeasure, appMode, config, isMM]); 

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-900 font-sans select-none text-gray-200 overflow-hidden">
        <div ref={mountRef} className="flex-1 relative bg-gray-900 min-w-0 min-h-0"></div>
        <div className="w-full md:w-80 h-2/5 md:h-full bg-gray-800 border-t md:border-t-0 md:border-l border-gray-700 p-6 overflow-y-auto flex-shrink-0 z-10 shadow-xl md:shadow-none">
            <h1 className="text-xl font-bold text-white mb-6">BOX3D -- <span className="text-blue-400">3D Printable Box & Gridfinity Generator</span></h1>
            

            <SegmentedControl options={[ { label: 'Inch', value: 'in' }, { label: 'mm', value: 'mm' }, { label: 'Gridfinity', value: 'gridfinity' } ]} value={appMode} onChange={v => { setAppMode(v); if (v !== 'gridfinity') setCompartmentWalls([]); }} />
            
            <div className="mb-6 space-y-4">
                {appMode !== 'gridfinity' && (
                    <SegmentedControl options={[ { label: 'Internal Capacity', value: 'internal' }, { label: 'External Bounds', value: 'external' } ]} value={config.measureMode} onChange={v => updateConfig('measureMode', v)} />
                )}
                {appMode === 'gridfinity' && (
                    <SegmentedControl options={[ { label: 'Bin', value: 'bin' }, { label: 'Frame', value: 'frame' } ]} value={config.gridfinityType} onChange={v => { updateConfig('gridfinityType', v); if (v !== 'bin') setCompartmentWalls([]); }} />
                )}
                {appMode === 'gridfinity' ? (
                    <>
                        <ControlInput label="Width (Units)" description="42mm blocks" unitLabel={null} value={config.gridWidth} min={1} max={10} step={1} onChange={v => updateConfig('gridWidth', v)} warning={layout.warnings.gridWidth} />
                        <ControlInput label="Depth (Units)" description="42mm blocks" unitLabel={null} value={config.gridDepth} min={1} max={10} step={1} onChange={v => updateConfig('gridDepth', v)} warning={layout.warnings.gridDepth} />
                        {config.gridfinityType === 'bin' && <ControlInput label="Height (Units)" description="7mm vertical blocks" unitLabel={null} value={config.gridHeight} min={2} max={20} step={1} onChange={v => updateConfig('gridHeight', v)} warning={layout.warnings.gridHeight} />}
                    </>
                ) : (
                    <>
                        <ControlInput label="Width" unitLabel={appMode} {...getDisplayProps('width', 0.5, 24)} warning={layout.warnings.width} />
                        <ControlInput label="Depth" unitLabel={appMode} {...getDisplayProps('depth', 0.5, 24)} warning={layout.warnings.depth} />
                        <ControlInput label="Height" unitLabel={appMode} {...getDisplayProps('height', 0.5, 24)} warning={layout.warnings.height} />
                    </>
                )}
            </div>

            {isGridfinity && config.gridfinityType === 'bin' && (
                <div className="mb-4 pt-4 border-t border-gray-700">
                    <CompartmentEditor
                        gridWidth={config.gridWidth}
                        gridDepth={config.gridDepth}
                        walls={compartmentWalls}
                        onWallsChange={setCompartmentWalls}
                    />
                </div>
            )}

            {(!isGridfinity || config.gridfinityType === 'bin') && (
                <div className="mb-6 space-y-4 pt-4 border-t border-gray-700">
                    <ControlInput label="Wall Thickness" description="Structural walls" {...getStructProps('wall', 0.03, 0.5)} warning={layout.warnings.wall} />
                    <ControlInput label="Floor Thickness" description="Bottom plate" {...getStructProps('floor', 0.03, 0.5)} warning={layout.warnings.floor} />
                    
                    <div className="pt-2 pb-2">
                        <label className="flex items-center justify-between cursor-pointer mb-3">
                            <span className="text-xs font-bold text-gray-300">Hexagonal Perforations</span>
                            <input type="checkbox" checked={config.holes} onChange={e => updateConfig('holes', e.target.checked)} className="accent-blue-600" />
                        </label>
                        {config.holes && (
                            <>
                                <ControlInput label="Hex Size" description="Hole Diameter" {...getDisplayProps('holeSize', 0.1, 2.0)} warning={layout.warnings.holeSize} />
                                <ControlInput label="Wall Solidity" description="Structure remaining %" value={config.infill * 100} min={10} max={99} step={1} onChange={v => updateConfig('infill', v/100)} unitLabel="%" warning={layout.warnings.infill} />
                            </>
                        )}
                    </div>

                    {!isGridfinity && (
                        <div className="pt-2 border-t border-gray-700">
                            <label className="flex items-center cursor-pointer mb-3 mt-4"><input type="checkbox" checked={config.lidEnabled} onChange={e => updateConfig('lidEnabled', e.target.checked)} className="mr-2 accent-blue-600" /><span className="text-sm font-bold text-white">Enable Lid</span></label>
                            {config.lidEnabled && (
                                <>
                                    <SegmentedControl options={[ { label: 'Step (Friction)', value: 'step' }, { label: 'Slide (Rail)', value: 'slide' } ]} value={config.lidType} onChange={v => updateConfig('lidType', v)} />
                                    <ControlInput label="Lid Thickness" {...getStructProps('lidThickness', 0.04, 0.5)} warning={layout.warnings.lidThickness} />
                                    {config.lidType === 'step' && <ControlInput label="Insert Depth" description="Depth of plug" {...getStructProps('lipDepth', 0.04, 1.0)} /> }
                                    <ControlInput label="Tolerance" description="Fit clearance" {...getStructProps('tolerance', 0.0, 0.05)} warning={layout.warnings.tolerance} />
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
            

            <div className="mt-4 pt-4 border-t border-gray-700">
                <label className="flex items-center cursor-pointer mb-4"><input type="checkbox" checked={showMeasure} onChange={e => setShowMeasure(e.target.checked)} className="mr-2 accent-green-500" /><span className="text-sm font-bold text-green-400">Show Dimensions</span></label>
                
                <AlertBlock type="error" messages={layout.errors} />

                <button onClick={handleExport} className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded shadow-lg transition-all">Download .STL</button>
            </div>
            
            <div className="mt-4 pt-4 border-t border-gray-700">
                <div className="flex items-center justify-between mb-2">
                     <span className="text-xs font-bold text-gray-500">LEGEND</span>
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                    <span className="flex items-center"><span className="w-2 h-2 bg-green-400 rounded-full mr-1"></span>Outer</span>
                    <span className="flex items-center"><span className="w-2 h-2 bg-red-400 rounded-full mr-1"></span>Inner</span>
                    <span className="flex items-center"><span className="w-2 h-2 bg-blue-400 rounded-full mr-1"></span>Lid/Lip</span>
                </div>
            </div>
        </div>
    </div>
  );
}
