import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Html } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import { Leva, useControls } from "leva";
import { ClothMesh } from "./components/ClothMesh";

// Perspective camera setup: plane fills the screen exactly at INITIAL_RADIUS.
// half-height at distance d = d * tan(FOV/2).  Set that equal to PLANE_HEIGHT/2.
const FOV = 50;
const PLANE_HEIGHT = 2;
const PLANE_WIDTH = PLANE_HEIGHT * (window.innerWidth / window.innerHeight);
const INITIAL_RADIUS = PLANE_HEIGHT / 2 / Math.tan((FOV / 2) * (Math.PI / 180));

const env = {
  intensity: 1,
  backgroundIntensity: 0,
  rotation: 0,
  blurriness: 0,
};

function CameraController({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  const keys = useRef({
    w: false,
    a: false,
    s: false,
    d: false,
    q: false,
    e: false,
  });
  const theta = useRef(0);
  const phi = useRef(Math.PI / 2);
  const radius = useRef(INITIAL_RADIUS);
  const SPEED = 0.02;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key in keys.current)
        (keys.current as Record<string, boolean>)[e.key] = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key in keys.current)
        (keys.current as Record<string, boolean>)[e.key] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useFrame(() => {
    if (!enabled) return;
    const k = keys.current;
    if (k.w) phi.current = Math.max(0.05, phi.current - SPEED);
    if (k.s) phi.current = Math.min(Math.PI - 0.05, phi.current + SPEED);
    if (k.a) theta.current -= SPEED;
    if (k.d) theta.current += SPEED;
    if (k.q) radius.current = Math.max(0.1, radius.current - 0.05);
    if (k.e) radius.current = radius.current + 0.05;

    const r = radius.current;
    camera.position.set(
      r * Math.sin(phi.current) * Math.sin(theta.current),
      r * Math.cos(phi.current),
      r * Math.sin(phi.current) * Math.cos(theta.current),
    );
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function Scene() {
  const [mode, setMode] = useState<"cursor" | "drag" | "cut">("cut");
  const {
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
    cameraControls,
  } = useControls({
    cameraControls: false,
    segments: { value: 50, min: 5, max: 50, step: 1 },
    iterations: { value: 10, min: 1, max: 20, step: 1 },
    damping: { value: 0.99, min: 0.01, max: 0.999, step: 0.001 },
    gravity: { value: 0.001, min: 0, max: 0.001, step: 0.00001 },
    wireframe: false,
    showVertices: false,
    tearDistance: { value: 2.0, min: 0, max: 10.0, step: 0.1 },
    dragStrength: { value: 0.8, min: 0.05, max: 1.0, step: 0.05 },
    cutRadius: { value: 0.05, min: 0.005, max: 0.3, step: 0.005 },
    cutForce: { value: 0.5, min: 0, max: 5.0, step: 0.1 },
  });

  return (
    <>
      <CameraController enabled={cameraControls} />
      {cameraControls && (
        <Html fullscreen style={{ pointerEvents: "none" }}>
          <div className="absolute bottom-6 left-6 bg-white/10 backdrop-blur-sm rounded-sm p-4 text-white/80 font-mono text-xs max-w-xs shadow-lg">
            Use WASD to rotate the camera around and Q/E to zoom in/out
          </div>
        </Html>
      )}
      <Html fullscreen style={{ pointerEvents: "none" }}>
        <div className="absolute bottom-6 right-6 bg-white/10 backdrop-blur-md p-1 rounded-full flex gap-1 pointer-events-auto shadow-lg">
          <button
            onClick={() => setMode("cursor")}
            className={`px-3 py-1.5 rounded-full text-sm transition-all ${
              mode === "cursor" ? "bg-white shadow-sm" : "opacity-60 hover:opacity-100 grayscale"
            }`}
            title="Cursor Mode — interact with page content"
          >
            👆
          </button>
          <button
            onClick={() => setMode("drag")}
            className={`px-3 py-1.5 rounded-full text-sm transition-all ${
              mode === "drag" ? "bg-white shadow-sm" : "opacity-60 hover:opacity-100 grayscale"
            }`}
            title="Drag Mode"
          >
            🖐️
          </button>
          <button
            onClick={() => setMode("cut")}
            className={`px-3 py-1.5 rounded-full text-sm transition-all ${
              mode === "cut" ? "bg-white shadow-sm" : "opacity-60 hover:opacity-100 grayscale"
            }`}
            title="Cut Mode"
          >
            🔪
          </button>
        </div>
      </Html>
      <Environment
        files="/env.hdr"
        background
        environmentIntensity={env.intensity}
        backgroundIntensity={env.backgroundIntensity}
        backgroundRotation={[0, env.rotation * (Math.PI / 180), 0]}
        environmentRotation={[0, env.rotation * (Math.PI / 180), 0]}
        backgroundBlurriness={env.blurriness}
      />
      {(['Page 1', 'Page 2', 'Page 3', 'Page 4'] as const).map((label, i) => (
        <group key={`${segments}-${i}`} position={[0, 0, -i * 0.015]}>
          <ClothMesh
            width={PLANE_WIDTH}
            height={PLANE_HEIGHT}
            mode={mode}
            segments={segments}
            iterations={iterations}
            damping={damping}
            gravity={gravity}
            wireframe={wireframe}
            showVertices={showVertices}
            tearDistance={tearDistance}
            dragStrength={dragStrength}
            cutRadius={cutRadius}
            cutForce={cutForce}
            pageIndex={i}
            pageLabel={label}
          />
        </group>
      ))}
    </>
  );
}

export default function App() {
  return (
    <>
      <Leva collapsed />
      <Canvas
        camera={{
          fov: FOV,
          position: [0, 0, INITIAL_RADIUS],
          near: 0.01,
          far: 100,
        }}
        style={{ width: "100vw", height: "100vh" }}
      >
        <Scene />
      </Canvas>
    </>
  );
}
