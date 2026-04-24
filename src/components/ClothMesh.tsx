import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { initCloth, stepCloth, addVertexToCloth, buildSpringsFromIndices, type ClothData } from "../hooks/useCloth";

interface ClothMeshProps {
  width: number;
  height: number;
  segments: number;
  iterations: number;
  damping: number;
  gravity: number;
  wireframe: boolean;
  showVertices: boolean;
  tearDistance: number;
  dragStrength: number;
  cutRadius: number;
  cutForce: number;
  mode: 'cursor' | 'drag' | 'cut';
  pageIndex?: number;
  pageLabel?: string;
}

const RED    = new THREE.Color(1, 0, 0);
const BLUE   = new THREE.Color(0, 0.4, 1);
const _color = new THREE.Color();
const _dummy = new THREE.Object3D();



// Squared distance from point P to line segment AB in 3D
function distSqPointToSeg(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const lenSq = abx*abx + aby*aby + abz*abz;
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, ((px-ax)*abx + (py-ay)*aby + (pz-az)*abz) / lenSq))
    : 0;
  const rx = ax + t*abx - px, ry = ay + t*aby - py, rz = az + t*abz - pz;
  return rx*rx + ry*ry + rz*rz;
}

function nearestVertex(face: THREE.Face, point: THREE.Vector3, positions: Float32Array): number {
  let best = face.a, bestD = Infinity;
  for (const vi of [face.a, face.b, face.c]) {
    const i = vi * 3;
    const dx = positions[i] - point.x, dy = positions[i+1] - point.y, dz = positions[i+2] - point.z;
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bestD) { bestD = d; best = vi; }
  }
  return best;
}

export function ClothMesh({
  width, height, segments, iterations, damping, gravity,
  wireframe, showVertices, tearDistance, dragStrength, cutRadius, cutForce, mode,
  pageIndex = 0, pageLabel = 'Page 1',
}: ClothMeshProps) {
  const { camera, gl: threeRenderer } = useThree();

  const clothRef      = useRef<ClothData | null>(null);
  const tensionArr    = useRef<Float32Array>(new Float32Array(0));
  const hoveredVertex = useRef<number>(-1);
  const modeRef       = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // In cursor mode the canvas is transparent to pointer events so the DOM
  // content divs inside it can be clicked. Re-enable in drag/cut mode.
  useEffect(() => {
    const canvas = threeRenderer.domElement;
    if (mode === 'cursor') {
      canvas.style.pointerEvents = 'none';
    } else {
      canvas.style.pointerEvents = 'auto';
    }
  }, [mode, threeRenderer]);

  // Show/hide the HTML content div for interactivity based on mode.
  // Only the frontmost cloth (pageIndex 0) is shown in cursor mode.
  useEffect(() => {
    const div = htmlDivRef.current;
    if (!div) return;
    const isFront = pageIndex === 0;
    if (mode === 'cursor' && isFront) {
      div.style.visibility    = 'visible';
      div.style.pointerEvents = 'auto';
      div.style.userSelect    = 'text';
    } else {
      div.style.visibility    = 'hidden';
      div.style.pointerEvents = 'none';
      div.style.userSelect    = 'none';
    }
  }, [mode, pageIndex]);

  // Drag state
  const dragVertexRef = useRef(-1);
  const dragTarget    = useRef(new THREE.Vector3());
  const dragPlane     = useRef(new THREE.Plane());

  // Cut state
  const isPointerDown = useRef(false);
  const lastMouseNDC  = useRef(new THREE.Vector2());
  const raycaster     = useRef(new THREE.Raycaster());
  // Seam map persists across frames within a single cut stroke so adjacent splits share vertices
  const seamMapRef    = useRef(new Map<number, number>());
  const lastHitPoint  = useRef<THREE.Vector3 | null>(null);

  // Param refs
  const tearDistanceRef = useRef(tearDistance);
  const dragStrengthRef = useRef(dragStrength);
  const cutRadiusRef    = useRef(cutRadius);
  const cutForceRef     = useRef(cutForce);
  useEffect(() => {
    tearDistanceRef.current = tearDistance;
    dragStrengthRef.current = dragStrength;
    cutRadiusRef.current    = cutRadius;
    cutForceRef.current     = cutForce;
  }, [tearDistance, dragStrength, cutRadius, cutForce]);

  // Three.js objects
  const hoverSphereRef = useRef<THREE.Mesh>(null!);
  const forceDotsRef   = useRef<THREE.InstancedMesh>(null!);
  const meshRef        = useRef<THREE.Mesh>(null!);

  // ── HTML-in-Canvas texture (WICG experimental API) ────────────────────────
  // Requires Chrome Canary with chrome://flags/#canvas-draw-element enabled.
  const htmlTex = useMemo(() => {
    const t = new THREE.DataTexture(
      new Uint8Array([245, 245, 235, 255]), // 1×1 warm-white placeholder
      1, 1, THREE.RGBAFormat,
    );
    t.needsUpdate = true;
    return t;
  }, []);

  // Ref holding the raw GL texture so useFrame can also refresh it
  const htmlGlTexRef = useRef<WebGLTexture | null>(null);
  const htmlDivRef   = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Each page uses a distinct palette and accent colour
    const PALETTES = [
      ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c77dff','#ff9a3c'],
      ['#00b4d8','#f72585','#ff3d71','#00e5ff','#fca311','#e63946'],
      ['#06d6a0','#118ab2','#ffd166','#ef476f','#073b4c','#8338ec'],
      ['#fb5607','#ff006e','#8338ec','#3a86ff','#ffbe0b','#06d6a0'],
    ];
    const COLORS = PALETTES[pageIndex % PALETTES.length];

    const shapesHtml = Array.from({ length: 28 }, () => {
      const color   = COLORS[Math.floor(Math.random() * COLORS.length)];
      const size    = 60 + Math.random() * 160;
      const x       = Math.random() * 100;
      const y       = Math.random() * 100;
      const radius  = Math.random() > 0.45 ? '50%' : Math.random() > 0.5 ? '12px' : '0px';
      const rot     = (Math.random() * 60 - 30).toFixed(1);
      const opacity = (0.55 + Math.random() * 0.45).toFixed(2);
      return `<div style="position:absolute;left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;width:${size.toFixed(0)}px;height:${size.toFixed(0)}px;background:${color};border-radius:${radius};opacity:${opacity};transform:translate(-50%,-50%) rotate(${rot}deg);"></div>`;
    }).join('');

    // The spec requires the element to be a direct child of the SAME canvas
    // whose WebGL context we call texElementImage2D on — R3F's domElement.
    const glCanvas = threeRenderer.domElement;
    glCanvas.setAttribute('layoutsubtree', '');

    const contentDiv = document.createElement('div');
    Object.assign(contentDiv.style, {
      width: '100%', height: '100%',
      background: '#f5f5eb', position: 'absolute',
      top: '0', left: '0', overflow: 'hidden',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
    });
    contentDiv.innerHTML = `
      ${shapesHtml}
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;mix-blend-mode:multiply;">
        <div style="font-size:120px;font-weight:900;letter-spacing:-5px;color:rgba(0,0,0,0.12);line-height:1;">${pageIndex + 1}</div>
        <div style="font-size:52px;font-weight:800;letter-spacing:-1px;color:rgba(0,0,0,0.8);line-height:1;margin-top:-12px;">${pageLabel}</div>
        <div style="font-size:14px;font-weight:400;color:rgba(0,0,0,0.4);letter-spacing:8px;margin-top:10px;">TEAR TO REVEAL</div>
      </div>
    `;
    glCanvas.appendChild(contentDiv);
    htmlDivRef.current = contentDiv;

    const gl = threeRenderer.getContext() as WebGLRenderingContext & {
      texElementImage2D?: (target: number, level: number, internalformat: number,
        format: number, type: number, element: Element | object) => void;
    };

    if (!gl.texElementImage2D) {
      console.warn('[html-in-canvas] texElementImage2D unavailable — enable chrome://flags/#canvas-draw-element');
      return;
    }

    // Create the GL texture MANUALLY (matching the official WICG WebGL demo).
    // We then inject it into Three.js's property map so it uses this texture
    // when rendering the mesh — no initTexture / upload pipeline involved.
    const glTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    // Initialise with a 1×1 off-white pixel so Three.js has valid data before paint fires
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([245, 245, 235, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    htmlGlTexRef.current = glTex;

    // Inject into Three.js so the material's `map` slot sees this GL texture
    const props = (threeRenderer as any).properties.get(htmlTex) as Record<string, unknown>;
    props.__webglTexture  = glTex;
    props.__webglInit     = true;
    props.__version       = htmlTex.version;   // prevent Three.js from re-uploading

    const upload = () => {
      if (!gl.texElementImage2D) return;
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, contentDiv);
      gl.bindTexture(gl.TEXTURE_2D, null);
    };

    // Use addEventListener so multiple ClothMesh instances can each register
    // their own upload handler without overwriting each other.
    glCanvas.addEventListener('paint', upload as EventListener);
    (glCanvas as any).requestPaint?.();

    return () => {
      glCanvas.removeEventListener('paint', upload as EventListener);
      if (glCanvas.contains(contentDiv)) glCanvas.removeChild(contentDiv);
      // Do NOT removeAttribute('layoutsubtree') — other meshes still need it.
      htmlDivRef.current   = null;
      htmlGlTexRef.current = null;
      gl.deleteTexture(glTex);
    };
  }, [threeRenderer, htmlTex, pageIndex, pageLabel]);
  // ──────────────────────────────────────────────────────────────────────────

  const clothTexture = useMemo(() => {
    const tex = new THREE.TextureLoader().load('/cloth_bump.png');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    return tex;
  }, []);

  // Edge wireframe state
  const edgesRef        = useRef<Uint32Array>(new Uint32Array(0));
  const prevSpringCount = useRef(0);

  const cols = segments + 1;
  const rows = segments + 1;
  const vertexCount = cols * rows;
  const sphereRadius = (Math.min(width, height) / segments) * 0.2;

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(width, height, segments, segments),
    [width, height, segments],
  );

  const edgeGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return geo;
  }, [cols, rows]);

  useEffect(() => {
    const cloth = initCloth(
      geometry.attributes.position.array as Float32Array,
      geometry.index!.array,
      segments,
      segments,
    );
    clothRef.current = cloth;
    tensionArr.current = new Float32Array(vertexCount);
    hoveredVertex.current = -1;
    dragVertexRef.current = -1;
    isPointerDown.current = false;
    seamMapRef.current.clear();
    lastHitPoint.current = null;

    const n = cloth.springs.length;
    const edgeArr = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      edgeArr[i * 2]     = cloth.springs[i].a;
      edgeArr[i * 2 + 1] = cloth.springs[i].b;
    }
    edgesRef.current = edgeArr;
    prevSpringCount.current = n;

    // Pre-allocate edge buffer at initial spring count
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    edgeGeo.drawRange = { start: 0, count: n * 2 };
  }, [geometry, segments, vertexCount, edgeGeo]);

  useEffect(() => () => { geometry.dispose(); edgeGeo.dispose(); }, [geometry, edgeGeo]);

  // --- cut: vertex-duplication seam split (no triangle deletion) ---
  //
  // For each cut edge (a, b), the two triangles sharing it are found:
  //   T1 keeps the original vertices (a, b)
  //   T2 gets seam copies (a_new, b_new) that start at the same position
  // No triangles are removed. The two sides are now physically independent
  // and will drift apart as physics runs.
  function splitEdge(cloth: ClothData, a: number, b: number, seamMap: Map<number, number>): boolean {
    const indexAttr = geometry.index;
    if (!indexAttr) return false;
    const indices = indexAttr.array as Uint32Array;

    const origA = cloth.originalIndices[a];
    const origB = cloth.originalIndices[b];

    // Find all triangles sharing edge topologically
    const sharedTris: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const ta = indices[i], tb = indices[i+1], tc = indices[i+2];
      const ota = cloth.originalIndices[ta];
      const otb = cloth.originalIndices[tb];
      const otc = cloth.originalIndices[tc];
      
      const hasA = (ota === origA || otb === origA || otc === origA);
      const hasB = (ota === origB || otb === origB || otc === origB);
      
      if (hasA && hasB) sharedTris.push(i);
    }
    
    if (sharedTris.length === 0 || sharedTris.length > 2) return false; // boundary or already split cleanly

    // Geometrically consistent remapping: always remap the triangle on the "left" of the directed edge origA -> origB
    let tToRemap = sharedTris[0];
    if (sharedTris.length === 2) {
      const u = origA < origB ? origA : origB;
      const v = origA < origB ? origB : origA;
      
      const t0_a = indices[sharedTris[0]], t0_b = indices[sharedTris[0]+1], t0_c = indices[sharedTris[0]+2];
      let c = t0_a;
      if (cloth.originalIndices[t0_a] !== origA && cloth.originalIndices[t0_a] !== origB) c = t0_a;
      else if (cloth.originalIndices[t0_b] !== origA && cloth.originalIndices[t0_b] !== origB) c = t0_b;
      else c = t0_c;
      
      const pos = cloth.restPositions;
      const ux = pos[u*3], uy = pos[u*3+1];
      const vx = pos[v*3], vy = pos[v*3+1];
      const cx = pos[c*3], cy = pos[c*3+1];
      
      const crossZ = (vx - ux) * (cy - uy) - (vy - uy) * (cx - ux);
      tToRemap = crossZ > 0 ? sharedTris[0] : sharedTris[1];
    } else {
      // Boundary edge: length === 1
      return false; // Don't split boundary edges, let them be deleted
    }

    // Find the specific vertex index in the chosen triangle that corresponds to origA and origB
    const ta = indices[tToRemap], tb = indices[tToRemap+1], tc = indices[tToRemap+2];
    const specificA = (cloth.originalIndices[ta] === origA) ? ta : (cloth.originalIndices[tb] === origA) ? tb : tc;
    const specificB = (cloth.originalIndices[ta] === origB) ? ta : (cloth.originalIndices[tb] === origB) ? tb : tc;

    // Reuse existing seam copies for shared vertices (ensures continuous seams)
    let a_new = seamMap.get(origA);
    if (a_new === undefined) {
      a_new = addVertexToCloth(cloth, specificA);
      cloth.isPinned[a_new] = 0;
      seamMap.set(origA, a_new);
    }
    
    let b_new = seamMap.get(origB);
    if (b_new === undefined) {
      b_new = addVertexToCloth(cloth, specificB);
      cloth.isPinned[b_new] = 0;
      seamMap.set(origB, b_new);
    }

    // Remap the selected triangle
    const newIndices = new Uint32Array(indices);
    for (let k = tToRemap; k < tToRemap + 3; k++) {
      if (cloth.originalIndices[newIndices[k]] === origA) newIndices[k] = a_new!;
      else if (cloth.originalIndices[newIndices[k]] === origB) newIndices[k] = b_new!;
    }
    geometry.setIndex(new THREE.BufferAttribute(newIndices, 1));
    return true;
  }

  // Deletes triangles sharing an edge by degenerating them
  function deleteEdgeTriangles(cloth: ClothData, a: number, b: number): boolean {
    const indexAttr = geometry.index;
    if (!indexAttr) return false;
    const indices = indexAttr.array as Uint32Array;
    let modified = false;

    const origA = cloth.originalIndices[a];
    const origB = cloth.originalIndices[b];

    for (let i = 0; i < indices.length; i += 3) {
      const ta = indices[i], tb = indices[i+1], tc = indices[i+2];
      const ota = cloth.originalIndices[ta];
      const otb = cloth.originalIndices[tb];
      const otc = cloth.originalIndices[tc];
      
      const hasA = (ota === origA || otb === origA || otc === origA);
      const hasB = (ota === origB || otb === origB || otc === origB);
      
      if (hasA && hasB) {
        indices[i] = 0;
        indices[i+1] = 0;
        indices[i+2] = 0;
        modified = true;
      }
    }
    if (modified) {
      indexAttr.needsUpdate = true;
    }
    return modified;
  }

  // --- pointer handlers ---

  function onPointerDown(e: ThreeEvent<PointerEvent>) {
    const cloth = clothRef.current;
    if (!cloth || !e.face) return;

    lastMouseNDC.current.set(
      (e.clientX / window.innerWidth)  *  2 - 1,
      (e.clientY / window.innerHeight) * -2 + 1,
    );
    isPointerDown.current = true;

    if (mode === 'drag') {
      const vi = nearestVertex(e.face, e.point, cloth.positions);
      dragVertexRef.current = vi;
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      dragPlane.current.setFromNormalAndCoplanarPoint(camDir, e.point);
      dragTarget.current.set(cloth.positions[vi*3], cloth.positions[vi*3+1], cloth.positions[vi*3+2]);
    } else {
      seamMapRef.current.clear(); // fresh seam map per cut stroke
      lastHitPoint.current = null;
    }

    e.stopPropagation();
  }

  function onPointerMoveHover(e: ThreeEvent<PointerEvent>) {
    const cloth = clothRef.current;
    if (!cloth || !e.face || isPointerDown.current) return;
    hoveredVertex.current = nearestVertex(e.face, e.point, cloth.positions);
  }

  function onPointerLeave() {
    if (!isPointerDown.current) hoveredVertex.current = -1;
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const ndc = new THREE.Vector2(
        (e.clientX / window.innerWidth)  *  2 - 1,
        (e.clientY / window.innerHeight) * -2 + 1,
      );
      lastMouseNDC.current.copy(ndc);

      if (!isPointerDown.current || dragVertexRef.current < 0) return;
      raycaster.current.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      if (raycaster.current.ray.intersectPlane(dragPlane.current, hit)) {
        dragTarget.current.copy(hit);
      }
    }

    function onUp() {
      isPointerDown.current = false;
      dragVertexRef.current = -1;
      hoveredVertex.current = -1;
      lastHitPoint.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, [camera]);

  // --- simulation + rendering ---

  useFrame(() => {
    const cloth = clothRef.current;
    if (!cloth) return;

    // Drag: move grabbed vertex toward mouse target
    const dvi = dragVertexRef.current;
    if (modeRef.current === 'drag' && dvi >= 0) {
      const i  = dvi * 3;
      const s  = dragStrengthRef.current;
      const tx = dragTarget.current.x, ty = dragTarget.current.y, tz = dragTarget.current.z;
      cloth.positions[i]     += (tx - cloth.positions[i])     * s;
      cloth.positions[i + 1] += (ty - cloth.positions[i + 1]) * s;
      cloth.positions[i + 2] += (tz - cloth.positions[i + 2]) * s;
      cloth.prevPositions[i]     = cloth.positions[i];
      cloth.prevPositions[i + 1] = cloth.positions[i + 1];
      cloth.prevPositions[i + 2] = cloth.positions[i + 2];
    }

    stepCloth({ cloth, iterations, damping, gravity });

    // Cut mode: split edges within cutRadius + apply cut force
    if (modeRef.current === 'cut' && isPointerDown.current) {
      raycaster.current.setFromCamera(lastMouseNDC.current, camera);
      const hits = raycaster.current.intersectObject(meshRef.current);
      if (hits.length) {
        const hp  = hits[0].point;
        const r   = cutRadiusRef.current;
        const r2  = r * r;
        
        // Snapshot positions before splits (addVertexToCloth replaces the array)
        const posSnap = cloth.positions;

        // Collect all springs within cut radius along the swept path
        const toSplit: [number, number][] = [];
        
        // If we have a previous hit point, interpolate to not miss points
        const startP = lastHitPoint.current || hp;
        const dist = startP.distanceTo(hp);
        const steps = Math.max(1, Math.ceil(dist / (r || 0.1)));
        
        const tempP = new THREE.Vector3();

        for (const { a, b } of cloth.springs) {
          const a3 = a * 3, b3 = b * 3;
          let hit = false;
          
          for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            tempP.lerpVectors(startP, hp, t);
            
            if (distSqPointToSeg(
              tempP.x, tempP.y, tempP.z,
              posSnap[a3], posSnap[a3+1], posSnap[a3+2],
              posSnap[b3], posSnap[b3+1], posSnap[b3+2],
            ) < r2) {
              hit = true;
              break;
            }
          }
          
          if (hit) {
            toSplit.push([a, b]);
          }
        }
        
        // Update last hit point for next frame
        if (!lastHitPoint.current) lastHitPoint.current = new THREE.Vector3();
        lastHitPoint.current.copy(hp);

        // Split each edge (seam map shared across the stroke so adjacent splits connect)
        let topologyChanged = false;
        for (const [a, b] of toSplit) {
          if (!splitEdge(cloth, a, b, seamMapRef.current)) {
            // If splitEdge fails (e.g., boundary edge), delete the triangles
            if (deleteEdgeTriangles(cloth, a, b)) topologyChanged = true;
          } else {
            topologyChanged = true;
          }
        }

        if (topologyChanged) {
          // Rebuild springs from the new index topology
          cloth.springs = buildSpringsFromIndices(geometry.index!.array as Uint32Array, cloth.restPositions);

          // Grow tensionArr if new vertices were added
          const vCount = cloth.positions.length / 3;
          if (vCount > tensionArr.current.length) {
            const t = new Float32Array(vCount);
            t.set(tensionArr.current);
            tensionArr.current = t;
          }
        }

        // Apply cut force: push vertices near hit point outward (like a knife parting cloth)
        const cutF = cutForceRef.current;
        if (cutF > 0) {
          const pos   = cloth.positions; // fresh ref after possible array reallocation
          const count = pos.length / 3;
          for (let v = 0; v < count; v++) {
            if (cloth.isPinned[v]) continue;
            const v3 = v * 3;
            const dx = pos[v3]   - hp.x;
            const dy = pos[v3+1] - hp.y;
            const dz = pos[v3+2] - hp.z;
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist > 0 && dist < r) {
              const factor = (1 - dist / r) * cutF;
              // Inject outward velocity via Verlet prevPos trick
              cloth.prevPositions[v3]   = cloth.positions[v3]   - dx * factor;
              cloth.prevPositions[v3+1] = cloth.positions[v3+1] - dy * factor;
              cloth.prevPositions[v3+2] = cloth.positions[v3+2] - dz * factor;
            }
          }
        }
      }
    }

    // Auto-tear: delete triangles of stretched springs
    const td = tearDistanceRef.current;
    if (td > 0) {
      const pos = cloth.positions;
      const toDelete: [number, number][] = [];
      
      cloth.springs = cloth.springs.filter(({ a, b, rest }) => {
        const a3 = a * 3, b3 = b * 3;
        const dx = pos[b3] - pos[a3], dy = pos[b3+1] - pos[a3+1], dz = pos[b3+2] - pos[a3+2];
        if (Math.sqrt(dx*dx + dy*dy + dz*dz) > rest * td) {
          toDelete.push([a, b]);
          return false; // Remove spring from physics
        }
        return true;
      });
      
      if (toDelete.length > 0) {
        let topologyChanged = false;
        for (const [a, b] of toDelete) {
          if (deleteEdgeTriangles(cloth, a, b)) topologyChanged = true;
        }
        
        if (topologyChanged) {
          // Rebuild springs to ensure wireframe matches the deleted faces precisely
          cloth.springs = buildSpringsFromIndices(geometry.index!.array as Uint32Array, cloth.restPositions);
        }
      }
    }

    // Rebuild edge list when spring count changes
    const sc = cloth.springs.length;
    if (sc !== prevSpringCount.current) {
      prevSpringCount.current = sc;
      const edgeArr = new Uint32Array(sc * 2);
      for (let i = 0; i < sc; i++) {
        edgeArr[i * 2]     = cloth.springs[i].a;
        edgeArr[i * 2 + 1] = cloth.springs[i].b;
      }
      edgesRef.current = edgeArr;
      // Resize edge buffer if it grew (vertex splits add new springs)
      const needed = sc * 2 * 3;
      if (needed > (edgeGeo.attributes.position.array as Float32Array).length) {
        edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(needed * 2), 3));
      }
      edgeGeo.drawRange = { start: 0, count: sc * 2 };
    }

    // Expand geometry position buffer if cloth gained vertices from splits
    {
      const posArr = geometry.attributes.position.array as Float32Array;
      if (cloth.positions.length > posArr.length) {
        const newSize = cloth.positions.length * 2;
        
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(newSize), 3),
        );
        
        geometry.setAttribute(
          "normal",
          new THREE.BufferAttribute(new Float32Array(newSize), 3),
        );

        // Also expand UVs and copy existing
        const oldUv = geometry.attributes.uv.array as Float32Array;
        const newUv = new Float32Array((newSize / 3) * 2);
        newUv.set(oldUv);
        
        // We need to copy the UVs for the duplicated vertices
        for (let i = oldUv.length / 2; i < cloth.positions.length / 3; i++) {
          const origIdx = cloth.originalIndices[i];
          newUv[i * 2] = oldUv[origIdx * 2];
          newUv[i * 2 + 1] = oldUv[origIdx * 2 + 1];
        }
        
        geometry.setAttribute("uv", new THREE.BufferAttribute(newUv, 2));
      } else if (cloth.positions.length / 3 > geometry.attributes.uv.array.length / 2) {
        // If we previously expanded but didn't fill all UVs, update the newly added ones
        const uvArr = geometry.attributes.uv.array as Float32Array;
        for (let i = 0; i < cloth.positions.length / 3; i++) {
          if (uvArr[i * 2] === 0 && uvArr[i * 2 + 1] === 0) {
            const origIdx = cloth.originalIndices[i];
            uvArr[i * 2] = uvArr[origIdx * 2];
            uvArr[i * 2 + 1] = uvArr[origIdx * 2 + 1];
          }
        }
        geometry.attributes.uv.needsUpdate = true;
      }
    }

    // Write cloth positions → geometry
    const posAttr = geometry.attributes.position;
    (posAttr.array as Float32Array).set(cloth.positions);
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    // Update edge lines
    const ep    = edgeGeo.attributes.position.array as Float32Array;
    const src   = cloth.positions;
    const edges = edgesRef.current;
    for (let e = 0; e < edges.length; e += 2) {
      const ai = edges[e] * 3, bi = edges[e+1] * 3, out = e * 3;
      ep[out]     = src[ai];   ep[out+1] = src[ai+1]; ep[out+2] = src[ai+2];
      ep[out+3]   = src[bi];   ep[out+4] = src[bi+1]; ep[out+5] = src[bi+2];
    }
    edgeGeo.attributes.position.needsUpdate = true;

    // Hover sphere
    const hs = hoverSphereRef.current;
    if (hs) {
      const vi   = hoveredVertex.current;
      const show = vi >= 0 && !isPointerDown.current && showVertices;
      hs.visible = show;
      if (show) {
        hs.position.set(cloth.positions[vi*3], cloth.positions[vi*3+1], cloth.positions[vi*3+2]);
        (hs.material as THREE.MeshBasicMaterial).color.set(mode === 'cut' ? 0xffffff : 0xff0000);
      }
    }

    // Vertex / tension dots
    const dots = forceDotsRef.current;
    if (dots) {
      dots.visible = showVertices;
      if (dots.visible) {
        const tension = tensionArr.current;
        tension.fill(0);
        for (const { a, b, rest } of cloth.springs) {
          const a3 = a*3, b3 = b*3;
          const dx = cloth.positions[b3]   - cloth.positions[a3];
          const dy = cloth.positions[b3+1] - cloth.positions[a3+1];
          const dz = cloth.positions[b3+2] - cloth.positions[a3+2];
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.0001;
          const stretch = Math.max(0, (dist - rest) / rest);
          if (tension[a] < stretch) tension[a] = stretch;
          if (tension[b] < stretch) tension[b] = stretch;
        }

        const count = Math.min(cloth.positions.length / 3, dots.instanceMatrix.count);
        dots.count = count;
        for (let i = 0; i < count; i++) {
          const show = showVertices;
          if (!show) {
            _dummy.scale.setScalar(0);
            _dummy.updateMatrix();
            dots.setMatrixAt(i, _dummy.matrix);
            continue;
          }
          _dummy.position.set(cloth.positions[i*3], cloth.positions[i*3+1], cloth.positions[i*3+2]);
          _dummy.scale.setScalar(1);
          _dummy.updateMatrix();
          dots.setMatrixAt(i, _dummy.matrix);
          _color.copy(BLUE).lerp(RED, Math.min(tension[i] / 0.3, 1));
          dots.setColorAt(i, _color);
        }
        dots.instanceMatrix.needsUpdate = true;
        if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={geometry}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMoveHover}
        onPointerLeave={onPointerLeave}
      >
        <meshStandardMaterial
          map={htmlTex}
          roughness={0.9}
          metalness={0.05}
          bumpMap={clothTexture}
          bumpScale={0.004}
          roughnessMap={clothTexture}
          side={THREE.DoubleSide}
        />
      </mesh>

      <lineSegments geometry={edgeGeo} visible={wireframe}>
        <lineBasicMaterial color={0xffffff} transparent opacity={0.25} depthTest={false} />
      </lineSegments>

      <mesh ref={hoverSphereRef} visible={false} renderOrder={1}>
        <sphereGeometry args={[sphereRadius, 8, 8]} />
        <meshBasicMaterial color="red" depthTest={false} />
      </mesh>

      {/* Allocate 4× initial vertex count to leave room for seam copies */}
      <instancedMesh ref={forceDotsRef} args={[undefined, undefined, vertexCount * 4]} renderOrder={1}>
        <sphereGeometry args={[sphereRadius, 8, 8]} />
        <meshBasicMaterial depthTest={false} />
      </instancedMesh>
    </group>
  );
}
