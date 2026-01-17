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
 * * 1. GRIDFINITY HEIGHT (STRICT STACKING COMPLIANCE):
 * - CONSTRAINT: "Units" defines the STACKING HEIGHT (Shoulder).
 * - 6U = 42mm Shoulder.
 * - Total Physical Height = 42mm + 4.4mm Lip = 46.4mm.
 * - This ensures 6U + 6U = 12U in a stack.
 * * 2. VISUALIZATION (CAD STYLE):
 * - Lines: `depthTest: false` ensures they render ON TOP of the model.
 * - Green: Body/Outer dimensions.
 * - Blue: Lid/Lip dimensions.
 * - Red: Internal Capacity.
 * * 3. LAYOUT ENGINE:
 * - Calculates geometry "Cursor" from Y=0 UPWARDS.
 * - Feet -> Floor -> Wall -> [Shoulder] -> Lip/Lid.
 * * ==========================================================================================
 */

const GRID_SIZE_MM = 42.0;
const GRID_Z_STEP_MM = 7.0; 
const IN_TO_MM = 25.4;
const MM_TO_IN = 1 / 25.4;
const GEO_OVERLAP = 0.002; 

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

// --- Constraint Engine ---
function calculateConstraints(config) {
    const { 
        measureMode, appMode, gridfinityType,
        width, depth, height, 
        gridWidth, gridDepth, gridHeight,
        wall, floor, 
        lidEnabled, lidType, lidThickness, lipDepth 
    } = config;

    const isGridfinity = appMode === 'gridfinity';
    
    const layout = {
        outerW: 0, outerD: 0, totalH: 0,
        innerW: 0, innerD: 0, innerH: 0,
        stack: { feet: null, floor: null, wall: null, rail: null, lip: null, lid: null },
        valid: true,
        errors: []
    };

    // 1. Horizontal Dimensions
    if (isGridfinity) {
        layout.outerW = (gridWidth * GRID_SIZE_MM) * MM_TO_IN;
        layout.outerD = (gridDepth * GRID_SIZE_MM) * MM_TO_IN;
        layout.innerW = layout.outerW - (wall * 2);
        layout.innerD = layout.outerD - (wall * 2);
    } else if (measureMode === 'internal') {
        layout.innerW = width;
        layout.innerD = depth;
        layout.outerW = width + (wall * 2);
        layout.outerD = depth + (wall * 2);
    } else {
        layout.outerW = width;
        layout.outerD = depth;
        layout.innerW = Math.max(0, width - (wall * 2));
        layout.innerD = Math.max(0, depth - (wall * 2));
    }

    // Validation (Soft)
    if (layout.innerW <= 0.01) { 
        layout.valid = false; layout.errors.push("Width too narrow"); layout.innerW = 0.01;
    }
    if (layout.innerD <= 0.01) { 
        layout.valid = false; layout.errors.push("Depth too narrow"); layout.innerD = 0.01; 
    }

    // 2. Vertical Stack
    let currentY = 0; 

    // A. Feet (Gridfinity Only)
    const FOOT_HEIGHT_IN = 5.0 * MM_TO_IN;
    if (isGridfinity && gridfinityType === 'bin') {
        layout.stack.feet = { yMin: 0, yMax: FOOT_HEIGHT_IN };
        currentY = FOOT_HEIGHT_IN - GEO_OVERLAP; 
    }

    // B. Floor
    layout.stack.floor = { yMin: currentY, yMax: currentY + floor };
    currentY += floor - GEO_OVERLAP;

    // C. Wall Height Logic
    let targetWallH = 0;
    const railCapH = 0.08; 
    const railSpacerH = lidThickness + 0.02; 
    const totalRailStack = railCapH + railSpacerH;
    const LIP_HEIGHT_IN = 4.4 * MM_TO_IN;

    if (isGridfinity) {
        // Gridfinity Stacking Logic:
        // "Height" input is the Stacking Height (Shoulder).
        const stackingHeight = (gridHeight * GRID_Z_STEP_MM) * MM_TO_IN;
        
        // Wall fills gap from Floor Top to Stacking Height
        targetWallH = stackingHeight - currentY; // currentY is Floor Top (approx)
        
        // Store stacking height for dimensions
        layout.bodyH = stackingHeight;
    } 
    else if (measureMode === 'internal') {
        let capacity = height;
        if (lidEnabled && lidType === 'step') {
            capacity += lipDepth; 
        }
        targetWallH = capacity;
    } 
    else {
        // External
        if (lidEnabled && lidType === 'slide') {
            targetWallH = height - (currentY) - totalRailStack;
        } else if (lidEnabled && lidType === 'step') {
            targetWallH = height - (currentY) - lidThickness;
        } else {
            targetWallH = height - currentY;
        }
    }

    if (targetWallH < 0.04) {
         layout.valid = false; 
         layout.errors.push("Height too short");
         targetWallH = 0.04;
    }

    layout.stack.wall = { yMin: currentY, yMax: currentY + targetWallH };
    currentY += targetWallH;

    // D. Top Features
    if (isGridfinity) {
        // Lip sits on top of Body (Stacking Height)
        layout.stack.lip = { yMin: currentY - GEO_OVERLAP, yMax: currentY + LIP_HEIGHT_IN };
        currentY += LIP_HEIGHT_IN;
    } 
    else if (lidEnabled && !isGridfinity) {
        if (lidType === 'slide') {
            const spacerY = currentY - GEO_OVERLAP;
            const capY = spacerY + railSpacerH - GEO_OVERLAP;
            layout.stack.rail = { 
                spacer: { yMin: spacerY, yMax: spacerY + railSpacerH },
                cap: { yMin: capY, yMax: capY + railCapH }
            };
            
            layout.stack.lid = {
                yPos: currentY, 
                type: 'slide',
                thickness: lidThickness,
                width: layout.outerW - wall - 0.02,
                depth: layout.outerD - 0.02
            };

            currentY = capY + railCapH;
        } 
        else if (lidType === 'step') {
            layout.stack.lid = {
                yPos: currentY, 
                type: 'step',
                thickness: lidThickness,
                insertDepth: lipDepth,
                width: layout.outerW,
                depth: layout.outerD
            };
            currentY += lidThickness;
        }
    }

    layout.totalH = currentY;
    layout.innerH = layout.stack.wall.yMax - layout.stack.floor.yMax;

    return layout;
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
        if (!unitLabel) return Math.round(v).toString(); 
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

    // Calculate percentage for the blue track fill
    const percentage = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;

    return (
        <div className={`mb-5 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="flex justify-between items-baseline mb-1">
                <span className="text-gray-300 font-bold text-xs">{label}</span>
                {error ? <span className="text-red-400 font-bold text-xs">{error}</span> : 
                 warning ? <span className="text-amber-500 font-bold text-xs">{warning}</span> : null}
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

// --- Main App ---
export default function App() {
  const mountRef = useRef(null);
  const modelGroupRef = useRef(new THREE.Group());
  const labelGroupRef = useRef(new THREE.Group());
  const cameraRef = useRef(null);
  
  const [appMode, setAppMode] = useState('in'); 
  const [showMeasure, setShowMeasure] = useState(true);
  
  // DEFAULT CONFIG (3.5 x 5.5 x 2.5)
  const [config, setConfig] = useState({
      measureMode: 'internal',
      gridfinityType: 'bin', 
      lidEnabled: false,
      lidType: 'step', 
      width: 3.5,  
      depth: 5.5, 
      height: 2.5,
      wall: 0.08, 
      floor: 0.08,
      lidThickness: 0.08,
      lipDepth: 0.15,
      tolerance: 0.01,
      gridWidth: 2,
      gridDepth: 3,
      gridHeight: 6, 
      holes: false,
      holeSize: 0.25 
  });

  const updateConfig = (key, value) => {
      if (typeof value === 'number' && (isNaN(value) || value < 0)) return;
      setConfig(prev => ({ ...prev, [key]: value }));
  };

  const getDisplayProps = (key, minIn, maxIn, stepIn) => {
      const val = config[key];
      if (appMode === 'mm') {
          return {
              value: val * IN_TO_MM,
              min: minIn * IN_TO_MM,
              max: maxIn * IN_TO_MM,
              step: stepIn * IN_TO_MM,
              unitLabel: 'mm',
              onChange: (v) => updateConfig(key, v * MM_TO_IN) 
          };
      }
      return {
          value: val,
          min: minIn,
          max: maxIn,
          step: stepIn,
          unitLabel: 'in',
          onChange: (v) => updateConfig(key, v)
      };
  };

  const isGridfinity = appMode === 'gridfinity';
  // Define isMM locally for use in labels
  const isMM = appMode === 'mm' || isGridfinity; 

  const getStructProps = (key, minIn, maxIn, stepIn) => {
      const val = config[key];
      if (isMM) {
          return {
              value: val * IN_TO_MM,
              min: minIn * IN_TO_MM,
              max: maxIn * IN_TO_MM,
              step: 0.1, 
              unitLabel: 'mm',
              onChange: (v) => updateConfig(key, v * MM_TO_IN) 
          };
      }
      return {
          value: val,
          min: minIn,
          max: maxIn,
          step: stepIn,
          unitLabel: 'in',
          onChange: (v) => updateConfig(key, v)
      };
  };

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
        const w = appMode === 'mm' ? (config.width * IN_TO_MM).toFixed(0) : config.width.toFixed(2);
        const d = appMode === 'mm' ? (config.depth * IN_TO_MM).toFixed(0) : config.depth.toFixed(2);
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
    const { wall, holes, holeSize, gridfinityType, lidEnabled, lidType } = config;

    const material = new THREE.MeshStandardMaterial({ 
        color: "#3b82f6", roughness: 0.5, metalness: 0.1
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
        const GRID_IN = GRID_SIZE_MM * MM_TO_IN;
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

    // 1. FEET
    if (stack.feet) {
        const unitsX = config.gridWidth;
        const unitsZ = config.gridDepth;
        const GRID_IN = GRID_SIZE_MM * MM_TO_IN;
        const topH = (2.15 * MM_TO_IN) + GEO_OVERLAP;
        const botH = (2.85 * MM_TO_IN) + GEO_OVERLAP;
        
        // Magnet Holes
        const addMagnetHoles = (shape) => {
            const magR = (6.5 / 2) * MM_TO_IN; 
            const magOff = 13.0 * MM_TO_IN;
            // Clockwise winding = Hole
            const h1 = new THREE.Path(); h1.absarc(-magOff, -magOff, magR, 0, Math.PI*2, true); shape.holes.push(h1);
            const h2 = new THREE.Path(); h2.absarc(magOff, -magOff, magR, 0, Math.PI*2, true); shape.holes.push(h2);
            const h3 = new THREE.Path(); h3.absarc(-magOff, magOff, magR, 0, Math.PI*2, true); shape.holes.push(h3);
            const h4 = new THREE.Path(); h4.absarc(magOff, magOff, magR, 0, Math.PI*2, true); shape.holes.push(h4);
        };

        const footTopShape = createRoundedRectPath(41.5 * MM_TO_IN, 41.5 * MM_TO_IN, 4.0 * MM_TO_IN);
        addMagnetHoles(footTopShape);
        const footTop = new THREE.ExtrudeGeometry(footTopShape, { depth: topH, bevelEnabled: false });
        footTop.rotateX(-Math.PI/2);
        
        const footBotShape = createRoundedRectPath(37.5 * MM_TO_IN, 37.5 * MM_TO_IN, 2.0 * MM_TO_IN);
        addMagnetHoles(footBotShape);
        const footBot = new THREE.ExtrudeGeometry(footBotShape, { depth: botH, bevelEnabled: false });
        footBot.rotateX(-Math.PI/2);

        const startX = -(outerW/2) + (GRID_IN/2);
        const startZ = -(outerD/2) + (GRID_IN/2);

        for(let i=0; i<unitsX; i++){
            for(let j=0; j<unitsZ; j++){
                const cx = startX + (i * GRID_IN);
                const cz = startZ + (j * GRID_IN);
                addMesh(footBot, cx + boxOffsetX, stack.feet.yMin, cz);
                addMesh(footTop, cx + boxOffsetX, stack.feet.yMin + (2.85 * MM_TO_IN) - GEO_OVERLAP, cz); 
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

        if (holes) {
            // --- PATTERNED WALLS (4 separate meshes with boolean-style holes in 2D) ---
            const createPerforatedWall = (w, height, thick) => {
                const shape = new THREE.Shape();
                shape.moveTo(-w/2, 0);
                shape.lineTo(w/2, 0);
                shape.lineTo(w/2, height);
                shape.lineTo(-w/2, height);
                shape.lineTo(-w/2, 0);

                const hexR = holeSize / 2;
                const hexW = hexR * Math.sqrt(3);
                const hexH = hexR * 2;
                const spacingX = hexW * 1.05; // Tight packing
                const spacingY = hexH * 0.8; // 30-60-90 triangle stacking

                // Grid logic
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
                            // Don't add if odd row pushes it out
                            if (isOddRow && c === cols - 1) continue; 

                            const cx = startX + (c * spacingX) + offsetX;
                            const cy = startY + (r * spacingY);
                            
                            // Bounds Check
                            if (cx > w/2 - margin || cy > height - margin) continue;

                            const hex = createHexagonPath(cx, cy, hexR);
                            shape.holes.push(hex);
                        }
                    }
                }

                const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
                return geo;
            };

            // Front & Back (Full Width)
            const fbGeo = createPerforatedWall(outerW, h, wall);
            // Position: Center of wall thickness should align with outerD edge?
            // Extrude creates depth +Z.
            // Front Wall: At +outerD/2. We want outer face at +D/2. So mesh at D/2 - wall.
            addMesh(fbGeo, boxOffsetX, y, outerD/2 - wall, 0, 0); // Front (Inner face at D/2-w, Outer at D/2) -> No, extrude is +Z.
                                                                  // If we place at Z, extrude goes to Z+Thick. 
                                                                  // We want outer face at outerD/2. So Z = outerD/2 - wall.
            
            // Back Wall: At -outerD/2. We want outer face at -D/2. So mesh at -D/2, extrude to -D/2+wall.
            // Wait, let's rotate back wall 180 to face out? Or just place it.
            // Let's place it at -outerD/2.
            addMesh(fbGeo, boxOffsetX, y, -outerD/2, 0, 0); 

            // Left & Right (Inset by wall thickness to avoid overlap)
            // Width = outerD - 2*wall
            const sideW = outerD - (wall * 2.05); // slight gap for tolerance visually
            const lrGeo = createPerforatedWall(sideW, h, wall);
            
            // Right Wall (+X): Rotated -90 deg around Y? 
            // Shape is in XY. Rotate Y -90 -> Shape in YZ (facing -X). Extrude in -X.
            // Let's keep it simple. Rotate Y 90. Shape in YZ (facing +X). Extrude +X.
            // We want outer face at outerW/2. So place at outerW/2 - wall.
            addMesh(lrGeo, boxOffsetX + outerW/2 - wall, y, 0, 0, Math.PI/2);

            // Left Wall (-X):
            // Place at -outerW/2. Extrude +X to -outerW/2 + wall.
            addMesh(lrGeo, boxOffsetX - outerW/2, y, 0, 0, Math.PI/2);


        } else {
            // --- SOLID WALLS (Optimized Extrusion) ---
            const shape = new THREE.Shape();
            shape.moveTo(-outerW/2, -outerD/2);
            shape.lineTo(outerW/2, -outerD/2);
            shape.lineTo(outerW/2, outerD/2);
            shape.lineTo(-outerW/2, outerD/2);
            shape.lineTo(-outerW/2, -outerD/2);
            
            const iw = outerW - (wall*2);
            const id = outerD - (wall*2);
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

    // 4. RAILS
    if (stack.rail) {
        const { spacer, cap } = stack.rail;
        const spH = spacer.yMax - spacer.yMin;
        const spY = spacer.yMin;
        
        // CORRECTION: Spacer = Wall / 2.
        const spThick = wall / 2;
        
        const sideSpacer = new THREE.BoxGeometry(spThick, spH, outerD);
        addMesh(sideSpacer, boxOffsetX-(outerW/2)+(spThick/2), spY + spH/2, 0);
        addMesh(sideSpacer, boxOffsetX+(outerW/2)-(spThick/2), spY + spH/2, 0);
        
        const spBack = new THREE.BoxGeometry(outerW - (spThick*2), spH, spThick);
        addMesh(spBack, boxOffsetX, spY + spH/2, -(outerD/2)+(spThick/2));

        const cH = cap.yMax - cap.yMin;
        const cY = cap.yMin;
        const capWidth = wall; // Cap covers spacer + ledge
        
        const cSide = new THREE.BoxGeometry(capWidth, cH, outerD);
        addMesh(cSide, boxOffsetX-(outerW/2)+(capWidth/2), cY + cH/2, 0);
        addMesh(cSide, boxOffsetX+(outerW/2)-(capWidth/2), cY + cH/2, 0);
        
        const cBack = new THREE.BoxGeometry(outerW - (capWidth*2), cH, capWidth);
        addMesh(cBack, boxOffsetX, cY + cH/2, -(outerD/2)+(capWidth/2));
    }

    // 5. LIP
    if (stack.lip) {
        const lH = stack.lip.yMax - stack.lip.yMin;
        const lY = stack.lip.yMin + lH/2;
        const th = 0.1; 
        const side = new THREE.BoxGeometry(th, lH, outerD);
        addMesh(side, boxOffsetX-(outerW/2)+(th/2), lY, 0);
        addMesh(side, boxOffsetX+(outerW/2)-(th/2), lY, 0);
        const fb = new THREE.BoxGeometry(outerW - (th*2), lH, th);
        addMesh(fb, boxOffsetX, lY, -(outerD/2)+(th/2));
        addMesh(fb, boxOffsetX, lY, (outerD/2)-(th/2));
    }

    // 6. LID GEOMETRY
    if (stack.lid) {
        const { type, thickness, insertDepth, width, depth } = stack.lid;
        const lidX = (outerW / 2) + gap; 
        
        if (type === 'step') {
            const plate = new THREE.BoxGeometry(outerW, thickness, outerD);
            addMesh(plate, lidX, thickness/2, 0, 0, 0, lidMaterial);
            if (insertDepth > 0) {
                const innerW = outerW - (wall*2) - (config.tolerance || 0.01);
                const innerD = outerD - (wall*2) - (config.tolerance || 0.01);
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

  }, [layout, config]);

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
          
          // Internal Height (Red Vertical)
          const ihX = boxOffsetX - layout.innerW/2 + 0.2; 
          const ihZ = layout.innerD/2 - 0.2;
          const floorTop = stack.floor ? stack.floor.yMax : 0;
          const iH = stack.wall.yMax - floorTop;
          const ihStart = new THREE.Vector3(ihX, floorTop, ihZ);
          const ihEnd = new THREE.Vector3(ihX, floorTop + iH, ihZ);
          addArrow(ihStart, ihEnd, red);
          addLabel(ihStart.clone().lerp(ihEnd, 0.5).add(new THREE.Vector3(0.1, 0, -0.1)), iH, red, "Int H");
      }

      // 5. Lid Dimensions
      if (stack.lid) {
          const lidX = (outerW / 2) + gap;
          const { width: lW, depth: lD, thickness: lT } = stack.lid;
          
          const lStart = new THREE.Vector3(lidX - lW/2, 0, lD/2 + 0.5);
          const lEnd = new THREE.Vector3(lidX + lW/2, 0, lD/2 + 0.5);
          addArrow(lStart, lEnd, blue);
          addLabel(lStart.clone().lerp(lEnd, 0.5).add(new THREE.Vector3(0, 0, 0.1)), lW, blue, "Lid W");
          
          const tStart = new THREE.Vector3(lidX + lW/2 + 0.2, 0, 0);
          const tEnd = new THREE.Vector3(lidX + lW/2 + 0.2, lT, 0);
          addArrow(tStart, tEnd, blue);
          addLabel(tStart.clone().lerp(tEnd, 0.5).add(new THREE.Vector3(0.1, 0, 0)), lT, blue, "Thick");
      }

  }, [layout, showMeasure, appMode, config, isMM]); 

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-900 font-sans select-none text-gray-200 overflow-hidden">
        <div ref={mountRef} className="flex-1 relative bg-gray-900 min-w-0 min-h-0"></div>
        <div className="w-full md:w-80 h-2/5 md:h-full bg-gray-800 border-t md:border-t-0 md:border-l border-gray-700 p-6 overflow-y-auto flex-shrink-0 z-10 shadow-xl md:shadow-none">
            <h1 className="text-xl font-bold text-white mb-6">BOX3D -- Parametric Box & Gridfinity Generator</h1>
            <SegmentedControl options={[ { label: 'Inch', value: 'in' }, { label: 'mm', value: 'mm' }, { label: 'Gridfinity', value: 'gridfinity' } ]} value={appMode} onChange={setAppMode} />
            
            <div className="mb-6 space-y-4">
                {appMode !== 'gridfinity' && (
                    <SegmentedControl options={[ { label: 'Internal Capacity', value: 'internal' }, { label: 'External Bounds', value: 'external' } ]} value={config.measureMode} onChange={v => updateConfig('measureMode', v)} />
                )}
                {appMode === 'gridfinity' && (
                    <SegmentedControl options={[ { label: 'Bin', value: 'bin' }, { label: 'Frame', value: 'frame' } ]} value={config.gridfinityType} onChange={v => updateConfig('gridfinityType', v)} />
                )}
                {appMode === 'gridfinity' ? (
                    <>
                        <ControlInput label="Width (Units)" description="42mm blocks" unitLabel={null} value={config.gridWidth} min={1} max={10} step={1} onChange={v => updateConfig('gridWidth', v)} />
                        <ControlInput label="Depth (Units)" description="42mm blocks" unitLabel={null} value={config.gridDepth} min={1} max={10} step={1} onChange={v => updateConfig('gridDepth', v)} />
                        {config.gridfinityType === 'bin' && <ControlInput label="Height (Units)" description="7mm vertical blocks" unitLabel={null} value={config.gridHeight} min={2} max={20} step={1} onChange={v => updateConfig('gridHeight', v)} />}
                    </>
                ) : (
                    <>
                        <ControlInput label="Width" unitLabel={appMode} value={config.width} min={0.5} max={24} onChange={v => updateConfig('width', v)} />
                        <ControlInput label="Depth" unitLabel={appMode} value={config.depth} min={0.5} max={24} onChange={v => updateConfig('depth', v)} />
                        <ControlInput label="Height" unitLabel={appMode} value={config.height} min={0.5} max={24} onChange={v => updateConfig('height', v)} />
                    </>
                )}
            </div>

            {(!isGridfinity || config.gridfinityType === 'bin') && (
                <div className="mb-6 space-y-4 pt-4 border-t border-gray-700">
                    <ControlInput label="Wall Thickness" description="Structural walls" {...getStructProps('wall', 0.03, 0.5, 0.001)} />
                    <ControlInput label="Floor Thickness" description="Bottom plate" {...getStructProps('floor', 0.03, 0.5, 0.001)} />
                    
                    <div className="pt-2 pb-2">
                        <label className="flex items-center justify-between cursor-pointer mb-3">
                            <span className="text-xs font-bold text-gray-300">Wall Pattern</span>
                            <input type="checkbox" checked={config.holes} onChange={e => updateConfig('holes', e.target.checked)} className="accent-blue-600" />
                        </label>
                        {config.holes && (
                            <ControlInput label="Hex Hole Size" description="Diameter" {...getDisplayProps('holeSize', 0.1, 2.0, 0.01)} />
                        )}
                    </div>

                    {!isGridfinity && (
                        <div className="pt-2 border-t border-gray-700">
                            <label className="flex items-center cursor-pointer mb-3 mt-4"><input type="checkbox" checked={config.lidEnabled} onChange={e => updateConfig('lidEnabled', e.target.checked)} className="mr-2 accent-blue-600" /><span className="text-sm font-bold text-white">Enable Lid</span></label>
                            {config.lidEnabled && (
                                <>
                                    <SegmentedControl options={[ { label: 'Step (Friction)', value: 'step' }, { label: 'Slide (Rail)', value: 'slide' } ]} value={config.lidType} onChange={v => updateConfig('lidType', v)} />
                                    <ControlInput label="Lid Thickness" {...getDisplayProps('lidThickness', 0.04, 0.5, 0.001)} />
                                    {config.lidType === 'step' && <ControlInput label="Insert Depth" description="Depth of plug" {...getDisplayProps('lipDepth', 0.04, 1.0, 0.01)} />}
                                    <ControlInput label="Tolerance" description="Fit clearance" {...getDisplayProps('tolerance', 0.0, 0.05, 0.001)} />
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
            
            <div className="mt-4 pt-4 border-t border-gray-700">
                <label className="flex items-center cursor-pointer mb-4"><input type="checkbox" checked={showMeasure} onChange={e => setShowMeasure(e.target.checked)} className="mr-2 accent-green-500" /><span className="text-sm font-bold text-green-400">Show Dimensions</span></label>
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
