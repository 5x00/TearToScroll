import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import {
  initCloth,
  stepCloth,
  addVertexToCloth,
  buildSpringsFromIndices,
  type ClothData,
} from "../hooks/useCloth";
import { pageSetups } from "./pageContent";

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
  mode: "cursor" | "drag" | "cut";
  pageIndex?: number;
}

const RED = new THREE.Color(1, 0, 0);
const BLUE = new THREE.Color(0, 0.4, 1);
const _color = new THREE.Color();
const _dummy = new THREE.Object3D();

// Tracks which cloth page currently owns a cursor-mode drag gesture across all instances.
let activeCursorPageIndex: number | null = null;
// Set by whichever page receives onPointerDown in drag/cut mode (stopPropagation blocks others).
let globalPointerDown = false;
const registeredClothMeshes = new Set<THREE.Mesh>();
let activeCutMesh: THREE.Mesh | null = null;

// Squared distance from point P to line segment AB in 3D.
function distSqPointToSeg(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  const t =
    lenSq > 0
      ? Math.max(
          0,
          Math.min(
            1,
            ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq,
          ),
        )
      : 0;
  const rx = ax + t * abx - px,
    ry = ay + t * aby - py,
    rz = az + t * abz - pz;
  return rx * rx + ry * ry + rz * rz;
}

function nearestVertex(
  face: THREE.Face,
  point: THREE.Vector3,
  positions: Float32Array,
): number {
  let best = face.a,
    bestD = Infinity;
  for (const vi of [face.a, face.b, face.c]) {
    const i = vi * 3;
    const dx = positions[i] - point.x,
      dy = positions[i + 1] - point.y,
      dz = positions[i + 2] - point.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = vi;
    }
  }
  return best;
}

export function ClothMesh({
  width,
  height,
  segments,
  iterations,
  damping,
  gravity,
  wireframe,
  showVertices,
  tearDistance,
  dragStrength,
  cutRadius,
  cutForce,
  mode,
  pageIndex = 0,
}: ClothMeshProps) {
  const { camera, gl: threeRenderer } = useThree();

  const clothRef = useRef<ClothData | null>(null);
  const tensionArr = useRef<Float32Array>(new Float32Array(0));
  const hoveredVertex = useRef<number>(-1);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const dragVertexRef = useRef(-1);
  const dragTarget = useRef(new THREE.Vector3());
  const dragPlane = useRef(new THREE.Plane());

  const isPointerDown = useRef(false);
  const lastMouseNDC = useRef(new THREE.Vector2());
  const raycaster = useRef(new THREE.Raycaster());
  // Seam map persists across frames within a single cut stroke so adjacent splits share vertices.
  const seamMapRef = useRef(new Map<number, number>());
  const lastHitPoint = useRef<THREE.Vector3 | null>(null);
  const uvFilledCountRef = useRef(0);
  const mouseDownTargetRef = useRef<Element | null>(null);

  const tearDistanceRef = useRef(tearDistance);
  const dragStrengthRef = useRef(dragStrength);
  const cutRadiusRef = useRef(cutRadius);
  const cutForceRef = useRef(cutForce);
  useEffect(() => {
    tearDistanceRef.current = tearDistance;
    dragStrengthRef.current = dragStrength;
    cutRadiusRef.current = cutRadius;
    cutForceRef.current = cutForce;
  }, [tearDistance, dragStrength, cutRadius, cutForce]);

  const hoverSphereRef = useRef<THREE.Mesh>(null!);
  const forceDotsRef = useRef<THREE.InstancedMesh>(null!);
  const meshRef = useRef<THREE.Mesh>(null!);

  // HTML-in-Canvas texture (WICG experimental API).
  // Requires Chrome Canary with chrome://flags/#canvas-draw-element enabled.
  const htmlTex = useMemo(() => {
    const t = new THREE.DataTexture(
      new Uint8Array([242, 241, 237, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    t.repeat.set(1, -1);
    t.offset.set(0, 1);
    t.needsUpdate = true;
    return t;
  }, []);

  const htmlGlTexRef = useRef<WebGLTexture | null>(null);
  const htmlDivRef = useRef<HTMLElement | null>(null);
  const uploadFnRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // The spec requires the element to be a direct child of the canvas
    // whose WebGL context we call texElementImage2D on — R3F's domElement.
    const glCanvas = threeRenderer.domElement;
    glCanvas.setAttribute("layoutsubtree", "");

    const contentDiv = document.createElement("div");
    Object.assign(contentDiv.style, {
      width: "100%",
      height: "100%",
      background: "#F2F1ED",
      position: "absolute",
      top: "0",
      left: "0",
      overflow: "hidden",
      fontFamily: "system-ui, sans-serif",
      pointerEvents: "none",
      visibility: "hidden",
    });
    const repaint = () => uploadFnRef.current?.();

    // Fast path for image-sequence pages: upload decoded HTMLImageElement directly
    // via gl.texImage2D — no DOM rasterisation, no frame-rate hit.
    const uploadImage = (img: HTMLImageElement) => {
      if (!img.complete || img.naturalWidth === 0) return;
      const glCtx = threeRenderer.getContext() as WebGLRenderingContext;
      let tex = htmlGlTexRef.current;
      if (!tex) {
        tex = glCtx.createTexture()!;
        glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.LINEAR);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.LINEAR);
        glCtx.bindTexture(glCtx.TEXTURE_2D, null);
        htmlGlTexRef.current = tex;
        const props = (threeRenderer as any).properties.get(htmlTex) as Record<string, unknown>;
        props.__webglTexture = tex;
        props.__webglInit = true;
        props.__version = htmlTex.version;
      }
      glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
      glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA, glCtx.RGBA, glCtx.UNSIGNED_BYTE, img);
      glCtx.bindTexture(glCtx.TEXTURE_2D, null);
    };

    pageSetups[pageIndex]?.(contentDiv, repaint, uploadImage);
    contentDiv.querySelectorAll("input, textarea").forEach((el) => {
      el.addEventListener("input", () => uploadFnRef.current?.());
    });

    glCanvas.appendChild(contentDiv);
    contentDiv.addEventListener("dragstart", (e) => e.preventDefault());
    htmlDivRef.current = contentDiv;

    const gl = threeRenderer.getContext() as WebGLRenderingContext & {
      texElementImage2D?: (
        target: number,
        level: number,
        internalformat: number,
        format: number,
        type: number,
        element: Element | object,
      ) => void;
    };

    if (!gl.texElementImage2D) {
      console.warn(
        "[html-in-canvas] texElementImage2D unavailable — enable chrome://flags/#canvas-draw-element",
      );
      return;
    }

    // Create the GL texture manually (matching the official WICG WebGL demo),
    // then inject it into Three.js's property map so it uses this texture
    // when rendering the mesh — no initTexture / upload pipeline involved.
    const glTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    // Initialise with a 1×1 off-white pixel so Three.js has valid data before paint fires.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([245, 245, 235, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    htmlGlTexRef.current = glTex;

    // Inject into Three.js so the material's `map` slot sees this GL texture.
    const props = (threeRenderer as any).properties.get(htmlTex) as Record<
      string,
      unknown
    >;
    props.__webglTexture = glTex;
    props.__webglInit = true;
    props.__version = htmlTex.version;

    const upload = () => {
      if (!gl.texElementImage2D) return;
      // texElementImage2D captures nothing from visibility:hidden elements.
      // Un-hide synchronously before the capture, then re-hide; no visual flash
      // because both style mutations happen in the same JS task before any paint.
      const wasHidden = contentDiv.style.visibility === "hidden";
      if (wasHidden) contentDiv.style.visibility = "visible";
      gl.bindTexture(gl.TEXTURE_2D, glTex);
      gl.texElementImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        contentDiv,
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (wasHidden) contentDiv.style.visibility = "hidden";
    };

    uploadFnRef.current = upload;

    // Use addEventListener so multiple ClothMesh instances can each register
    // their own upload handler without overwriting each other.
    glCanvas.addEventListener("paint", upload as EventListener);
    (glCanvas as any).requestPaint?.();

    return () => {
      uploadFnRef.current = null;
      glCanvas.removeEventListener("paint", upload as EventListener);
      if (glCanvas.contains(contentDiv)) glCanvas.removeChild(contentDiv);
      // Do NOT removeAttribute('layoutsubtree') — other meshes still need it.
      htmlDivRef.current = null;
      htmlGlTexRef.current = null;
      gl.deleteTexture(glTex);
    };
  }, [threeRenderer, htmlTex, pageIndex]);

  const edgesRef = useRef<Uint32Array>(new Uint32Array(0));
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
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
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
    uvFilledCountRef.current = geometry.attributes.position.count;

    const n = cloth.springs.length;
    const edgeArr = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      edgeArr[i * 2] = cloth.springs[i].a;
      edgeArr[i * 2 + 1] = cloth.springs[i].b;
    }
    edgesRef.current = edgeArr;
    prevSpringCount.current = n;


    edgeGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3),
    );
    edgeGeo.drawRange = { start: 0, count: n * 2 };
  }, [geometry, segments, vertexCount, edgeGeo]);

  useEffect(
    () => () => {
      geometry.dispose();
      edgeGeo.dispose();
    },
    [geometry, edgeGeo],
  );

  function splitEdge(
    cloth: ClothData,
    a: number,
    b: number,
    seamMap: Map<number, number>,
  ): boolean {
    const indexAttr = geometry.index;
    if (!indexAttr) return false;
    const indices = indexAttr.array as Uint32Array;

    const origA = cloth.originalIndices[a];
    const origB = cloth.originalIndices[b];

    // Find all triangles sharing edge topologically
    const sharedTris: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const ta = indices[i],
        tb = indices[i + 1],
        tc = indices[i + 2];
      const ota = cloth.originalIndices[ta];
      const otb = cloth.originalIndices[tb];
      const otc = cloth.originalIndices[tc];

      const hasA = ota === origA || otb === origA || otc === origA;
      const hasB = ota === origB || otb === origB || otc === origB;

      if (hasA && hasB) sharedTris.push(i);
    }

    if (sharedTris.length === 0 || sharedTris.length > 2) return false; // boundary or already split cleanly

    // Geometrically consistent remapping: always remap the triangle on the
    // "left" of the directed edge origA -> origB.
    let tToRemap = sharedTris[0];
    if (sharedTris.length === 2) {
      const u = origA < origB ? origA : origB;
      const v = origA < origB ? origB : origA;

      const t0_a = indices[sharedTris[0]],
        t0_b = indices[sharedTris[0] + 1],
        t0_c = indices[sharedTris[0] + 2];
      let c = t0_a;
      if (
        cloth.originalIndices[t0_a] !== origA &&
        cloth.originalIndices[t0_a] !== origB
      )
        c = t0_a;
      else if (
        cloth.originalIndices[t0_b] !== origA &&
        cloth.originalIndices[t0_b] !== origB
      )
        c = t0_b;
      else c = t0_c;

      const pos = cloth.restPositions;
      const ux = pos[u * 3],
        uy = pos[u * 3 + 1];
      const vx = pos[v * 3],
        vy = pos[v * 3 + 1];
      const cx = pos[c * 3],
        cy = pos[c * 3 + 1];

      const crossZ = (vx - ux) * (cy - uy) - (vy - uy) * (cx - ux);
      tToRemap = crossZ > 0 ? sharedTris[0] : sharedTris[1];
    } else {
      return false;
    }

    // Find the specific vertex indices in the chosen triangle for origA / origB.
    const ta = indices[tToRemap],
      tb = indices[tToRemap + 1],
      tc = indices[tToRemap + 2];
    const specificA =
      cloth.originalIndices[ta] === origA
        ? ta
        : cloth.originalIndices[tb] === origA
          ? tb
          : tc;
    const specificB =
      cloth.originalIndices[ta] === origB
        ? ta
        : cloth.originalIndices[tb] === origB
          ? tb
          : tc;

    // Reuse existing seam copies for shared vertices (ensures continuous seams).
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

    // Remap the selected triangle.
    const newIndices = new Uint32Array(indices);
    for (let k = tToRemap; k < tToRemap + 3; k++) {
      if (cloth.originalIndices[newIndices[k]] === origA)
        newIndices[k] = a_new!;
      else if (cloth.originalIndices[newIndices[k]] === origB)
        newIndices[k] = b_new!;
    }
    geometry.setIndex(new THREE.BufferAttribute(newIndices, 1));
    return true;
  }


  function deleteEdgeTriangles(
    cloth: ClothData,
    a: number,
    b: number,
  ): boolean {
    const indexAttr = geometry.index;
    if (!indexAttr) return false;
    const indices = indexAttr.array as Uint32Array;
    let modified = false;

    const origA = cloth.originalIndices[a];
    const origB = cloth.originalIndices[b];

    for (let i = 0; i < indices.length; i += 3) {
      const ta = indices[i],
        tb = indices[i + 1],
        tc = indices[i + 2];
      const ota = cloth.originalIndices[ta];
      const otb = cloth.originalIndices[tb];
      const otc = cloth.originalIndices[tc];

      const hasA = ota === origA || otb === origA || otc === origA;
      const hasB = ota === origB || otb === origB || otc === origB;

      if (hasA && hasB) {
        indices[i] = 0;
        indices[i + 1] = 0;
        indices[i + 2] = 0;
        modified = true;
      }
    }
    if (modified) {
      indexAttr.needsUpdate = true;
    }
    return modified;
  }



  function findInteractiveAt(div: HTMLElement, clientX: number, clientY: number): Element | null {
    for (const el of div.querySelectorAll("a, input, textarea, button, select, label")) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom)
        return el;
    }
    return null;
  }

  function updateSliderFromClient(slider: HTMLInputElement, clientX: number) {
    const rect = slider.getBoundingClientRect();
    if (!rect.width) return;
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || 100;
    const step = Number(slider.step) || 1;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    let v = Math.round((min + t * (max - min)) / step) * step;
    v = Math.max(min, Math.min(max, v));
    if (String(slider.value) !== String(v)) {
      slider.value = String(v);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }



  function onPointerDown(e: ThreeEvent<PointerEvent>) {
    const cloth = clothRef.current;
    if (!cloth || !e.face) return;

    if (mode === "cursor") {
      if (!e.uv) return;
      // Only the frontmost non-degenerate cloth surface should handle this.
      const frontmost = e.intersections.find((ix) => {
        const f = ix.face;
        return f && !(f.a === 0 && f.b === 0 && f.c === 0);
      });
      if (!frontmost || frontmost.object !== meshRef.current) return;

      const div = htmlDivRef.current;
      if (!div) return;

      activeCursorPageIndex = pageIndex;
      isPointerDown.current = true;

      const rect = div.getBoundingClientRect();
      const clientX = rect.left + e.uv.x * rect.width;
      const clientY = rect.top + (1 - e.uv.y) * rect.height;

      const target = findInteractiveAt(div, clientX, clientY);

      if (target instanceof HTMLInputElement && target.type === "range") {
        mouseDownTargetRef.current = target;
        updateSliderFromClient(target, clientX);
        uploadFnRef.current?.();
        return;
      }
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        mouseDownTargetRef.current = target;
        target.focus();
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY }));
        return;
      }
      if (target instanceof HTMLButtonElement) {
        target.click();
        uploadFnRef.current?.();
        return;
      }
      if (target instanceof HTMLLabelElement) {
        target.click();
        uploadFnRef.current?.();
        return;
      }
      if (target instanceof HTMLAnchorElement) {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      return;
    }

    lastMouseNDC.current.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      (e.clientY / window.innerHeight) * -2 + 1,
    );
    isPointerDown.current = true;
    globalPointerDown = true;

    if (mode === "drag") {
      const vi = nearestVertex(e.face, e.point, cloth.positions);
      dragVertexRef.current = vi;
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      dragPlane.current.setFromNormalAndCoplanarPoint(camDir, e.point);
      dragTarget.current.set(
        cloth.positions[vi * 3],
        cloth.positions[vi * 3 + 1],
        cloth.positions[vi * 3 + 2],
      );
    } else {
      seamMapRef.current.clear();
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
    const mesh = meshRef.current;
    registeredClothMeshes.add(mesh);
    return () => { registeredClothMeshes.delete(mesh); };
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const ndc = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        (e.clientY / window.innerHeight) * -2 + 1,
      );
      lastMouseNDC.current.copy(ndc);

      // Cursor mode: slider drag only — no raycast needed.
      if (
        modeRef.current === "cursor" &&
        activeCursorPageIndex === pageIndex &&
        isPointerDown.current
      ) {
        const sliderTarget = mouseDownTargetRef.current;
        if (sliderTarget instanceof HTMLInputElement && sliderTarget.type === "range") {
          updateSliderFromClient(sliderTarget, e.clientX);
          uploadFnRef.current?.();
        }
        return;
      }

      if (!isPointerDown.current || dragVertexRef.current < 0) return;
      raycaster.current.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      if (raycaster.current.ray.intersectPlane(dragPlane.current, hit)) {
        dragTarget.current.copy(hit);
      }
    }

    function onUp() {
      if (modeRef.current === "cursor" && activeCursorPageIndex === pageIndex) {
        mouseDownTargetRef.current = null;
        activeCursorPageIndex = null;
      }
      isPointerDown.current = false;
      globalPointerDown = false;
      activeCutMesh = null;
      dragVertexRef.current = -1;
      hoveredVertex.current = -1;
      lastHitPoint.current = null;
      seamMapRef.current.clear();
    }

    const onRepaintAll = () => uploadFnRef.current?.();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("clothrepaintall", onRepaintAll);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("clothrepaintall", onRepaintAll);
    };
  }, [camera]);



  useFrame(() => {
    const cloth = clothRef.current;
    if (!cloth) return;

    const dvi = dragVertexRef.current;
    if (modeRef.current === "drag" && dvi >= 0) {
      const i = dvi * 3;
      const s = dragStrengthRef.current;
      const tx = dragTarget.current.x,
        ty = dragTarget.current.y,
        tz = dragTarget.current.z;
      cloth.positions[i] += (tx - cloth.positions[i]) * s;
      cloth.positions[i + 1] += (ty - cloth.positions[i + 1]) * s;
      cloth.positions[i + 2] += (tz - cloth.positions[i + 2]) * s;
      cloth.prevPositions[i] = cloth.positions[i];
      cloth.prevPositions[i + 1] = cloth.positions[i + 1];
      cloth.prevPositions[i + 2] = cloth.positions[i + 2];
    }

    stepCloth({ cloth, iterations, damping, gravity });

    if (modeRef.current === "cut" && globalPointerDown) {
      raycaster.current.setFromCamera(lastMouseNDC.current, camera);
      const allHits = raycaster.current.intersectObjects([...registeredClothMeshes]);

      if (activeCutMesh === null) {
        const front = allHits.find(h => { const f = h.face; return f && !(f.a === 0 && f.b === 0 && f.c === 0); });
        if (front) activeCutMesh = front.object as THREE.Mesh;
      }

      if (activeCutMesh === meshRef.current) {
        const lockedHit = allHits.find(h => h.object === meshRef.current && h.face && !(h.face.a === 0 && h.face.b === 0 && h.face.c === 0));
        if (lockedHit) {
        // Convert world-space hit to mesh local space so distances match cloth.positions
        const hp = meshRef.current.worldToLocal(lockedHit.point.clone());
        const r = cutRadiusRef.current;
        const r2 = r * r;

        // Snapshot positions before splits (addVertexToCloth replaces the array).
        const posSnap = cloth.positions;

        // Collect all springs within cut radius along the swept path
        const toSplit: [number, number][] = [];

        // Interpolate between frames to avoid missing springs when moving fast.
        const startP = lastHitPoint.current || hp;
        const dist = startP.distanceTo(hp);
        const steps = Math.max(1, Math.ceil(dist / (r || 0.1)));

        const tempP = new THREE.Vector3();

        for (const { a, b } of cloth.springs) {
          const a3 = a * 3,
            b3 = b * 3;
          let hit = false;

          for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            tempP.lerpVectors(startP, hp, t);

            if (
              distSqPointToSeg(
                tempP.x,
                tempP.y,
                tempP.z,
                posSnap[a3],
                posSnap[a3 + 1],
                posSnap[a3 + 2],
                posSnap[b3],
                posSnap[b3 + 1],
                posSnap[b3 + 2],
              ) < r2
            ) {
              hit = true;
              break;
            }
          }

          if (hit) {
            toSplit.push([a, b]);
          }
        }

        if (!lastHitPoint.current) lastHitPoint.current = new THREE.Vector3();
        lastHitPoint.current.copy(hp);

        let topologyChanged = false;
        for (const [a, b] of toSplit) {
          if (!splitEdge(cloth, a, b, seamMapRef.current)) {
            if (deleteEdgeTriangles(cloth, a, b)) topologyChanged = true;
          } else {
            topologyChanged = true;
          }
        }

        if (topologyChanged) {
          cloth.springs = buildSpringsFromIndices(
            geometry.index!.array as Uint32Array,
            cloth.restPositions,
          );

          const vCount = cloth.positions.length / 3;
          if (vCount > tensionArr.current.length) {
            const t = new Float32Array(vCount);
            t.set(tensionArr.current);
            tensionArr.current = t;
          }
        }

        // Apply cut force: push vertices near hit point outward.
        const cutF = cutForceRef.current;
        if (cutF > 0) {
          const pos = cloth.positions;
          const count = pos.length / 3;
          for (let v = 0; v < count; v++) {
            if (cloth.isPinned[v]) continue;
            const v3 = v * 3;
            const dx = pos[v3] - hp.x;
            const dy = pos[v3 + 1] - hp.y;
            const dz = pos[v3 + 2] - hp.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 0 && dist < r) {
              const factor = (1 - dist / r) * cutF;
              // Inject outward velocity via Verlet prevPos trick.
              cloth.prevPositions[v3] = cloth.positions[v3] - dx * factor;
              cloth.prevPositions[v3 + 1] =
                cloth.positions[v3 + 1] - dy * factor;
              cloth.prevPositions[v3 + 2] =
                cloth.positions[v3 + 2] - dz * factor;
            }
          }
        }
        }
      }
    }

    // Auto-tear: delete triangles of stretched springs.
    const td = tearDistanceRef.current;
    if (td > 0) {
      const pos = cloth.positions;
      const toDelete: [number, number][] = [];

      cloth.springs = cloth.springs.filter(({ a, b, rest }) => {
        const a3 = a * 3,
          b3 = b * 3;
        const dx = pos[b3] - pos[a3],
          dy = pos[b3 + 1] - pos[a3 + 1],
          dz = pos[b3 + 2] - pos[a3 + 2];
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > rest * td) {
          toDelete.push([a, b]);
          return false;
        }
        return true;
      });

      if (toDelete.length > 0) {
        let topologyChanged = false;
        for (const [a, b] of toDelete) {
          if (deleteEdgeTriangles(cloth, a, b)) topologyChanged = true;
        }

        if (topologyChanged) {
          // Rebuild springs to ensure wireframe matches the deleted faces precisely.
          cloth.springs = buildSpringsFromIndices(
            geometry.index!.array as Uint32Array,
            cloth.restPositions,
          );
        }
      }
    }

    // Rebuild edge list when spring count changes.
    const sc = cloth.springs.length;
    if (sc !== prevSpringCount.current) {
      prevSpringCount.current = sc;
      const edgeArr = new Uint32Array(sc * 2);
      for (let i = 0; i < sc; i++) {
        edgeArr[i * 2] = cloth.springs[i].a;
        edgeArr[i * 2 + 1] = cloth.springs[i].b;
      }
      edgesRef.current = edgeArr;
      const needed = sc * 2 * 3;
      if (needed > (edgeGeo.attributes.position.array as Float32Array).length) {
        edgeGeo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(needed * 2), 3),
        );
      }
      edgeGeo.drawRange = { start: 0, count: sc * 2 };
    }

    // Expand geometry position buffer if cloth gained vertices from splits.
    {
      const posArr = geometry.attributes.position.array as Float32Array;
      const clothVertCount = cloth.positions.length / 3;
      const prevFilled = uvFilledCountRef.current;

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

        const oldUv = geometry.attributes.uv.array as Float32Array;
        const newUv = new Float32Array((newSize / 3) * 2);
        newUv.set(oldUv);

        for (let i = prevFilled; i < clothVertCount; i++) {
          const origIdx = cloth.originalIndices[i];
          newUv[i * 2]     = newUv[origIdx * 2];
          newUv[i * 2 + 1] = newUv[origIdx * 2 + 1];
        }

        geometry.setAttribute("uv", new THREE.BufferAttribute(newUv, 2));
      } else if (clothVertCount > prevFilled) {
        // Buffer already has capacity — fill the new UV slots in-place.
        const uvAttr = geometry.attributes.uv;
        const uvArr = uvAttr.array as Float32Array;

        for (let i = prevFilled; i < clothVertCount; i++) {
          const origIdx = cloth.originalIndices[i];
          uvArr[i * 2]     = uvArr[origIdx * 2];
          uvArr[i * 2 + 1] = uvArr[origIdx * 2 + 1];
        }
        uvAttr.needsUpdate = true;
      }

      uvFilledCountRef.current = clothVertCount;
    }

    // Write cloth positions to geometry.
    const posAttr = geometry.attributes.position;
    (posAttr.array as Float32Array).set(cloth.positions);
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    // Update edge lines.
    const ep = edgeGeo.attributes.position.array as Float32Array;
    const src = cloth.positions;
    const edges = edgesRef.current;
    for (let e = 0; e < edges.length; e += 2) {
      const ai = edges[e] * 3,
        bi = edges[e + 1] * 3,
        out = e * 3;
      ep[out] = src[ai];
      ep[out + 1] = src[ai + 1];
      ep[out + 2] = src[ai + 2];
      ep[out + 3] = src[bi];
      ep[out + 4] = src[bi + 1];
      ep[out + 5] = src[bi + 2];
    }
    edgeGeo.attributes.position.needsUpdate = true;

    // Hover sphere.
    const hs = hoverSphereRef.current;
    if (hs) {
      const vi = hoveredVertex.current;
      const show = vi >= 0 && !isPointerDown.current && showVertices;
      hs.visible = show;
      if (show) {
        hs.position.set(
          cloth.positions[vi * 3],
          cloth.positions[vi * 3 + 1],
          cloth.positions[vi * 3 + 2],
        );
        (hs.material as THREE.MeshBasicMaterial).color.set(
          mode === "cut" ? 0xffffff : 0xff0000,
        );
      }
    }

    // Vertex / tension dots.
    const dots = forceDotsRef.current;
    if (dots) {
      dots.visible = showVertices;
      if (dots.visible) {
        const tension = tensionArr.current;
        tension.fill(0);
        for (const { a, b, rest } of cloth.springs) {
          const a3 = a * 3,
            b3 = b * 3;
          const dx = cloth.positions[b3] - cloth.positions[a3];
          const dy = cloth.positions[b3 + 1] - cloth.positions[a3 + 1];
          const dz = cloth.positions[b3 + 2] - cloth.positions[a3 + 2];
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
          const stretch = Math.max(0, (dist - rest) / rest);
          if (tension[a] < stretch) tension[a] = stretch;
          if (tension[b] < stretch) tension[b] = stretch;
        }

        const count = Math.min(
          cloth.positions.length / 3,
          dots.instanceMatrix.count,
        );
        dots.count = count;
        for (let i = 0; i < count; i++) {
          const show = showVertices;
          if (!show) {
            _dummy.scale.setScalar(0);
            _dummy.updateMatrix();
            dots.setMatrixAt(i, _dummy.matrix);
            continue;
          }
          _dummy.position.set(
            cloth.positions[i * 3],
            cloth.positions[i * 3 + 1],
            cloth.positions[i * 3 + 2],
          );
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
          side={THREE.DoubleSide}
        />
      </mesh>

      <lineSegments geometry={edgeGeo} visible={wireframe}>
        <lineBasicMaterial
          color={0xffffff}
          transparent
          opacity={0.25}
          depthTest={false}
        />
      </lineSegments>

      <mesh ref={hoverSphereRef} visible={false} renderOrder={1}>
        <sphereGeometry args={[sphereRadius, 8, 8]} />
        <meshBasicMaterial color="red" depthTest={false} />
      </mesh>

      {/* Allocate 4× initial vertex count to leave room for seam copies. */}
      <instancedMesh
        ref={forceDotsRef}
        args={[undefined, undefined, vertexCount * 4]}
        renderOrder={1}
      >
        <sphereGeometry args={[sphereRadius, 8, 8]} />
        <meshBasicMaterial depthTest={false} />
      </instancedMesh>
    </group>
  );
}
