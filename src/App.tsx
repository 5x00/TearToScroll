import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Environment, Html } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import { Leva, useControls } from "leva";
import { ClothMesh } from "./components/ClothMesh";
import emailjs from "@emailjs/browser";

// Perspective camera setup: plane fills the screen exactly at INITIAL_RADIUS.
// half-height at distance d = d * tan(FOV/2).  Set that equal to PLANE_HEIGHT/2.
const FOV = 50;
const PLANE_HEIGHT = 2;
const PLANE_WIDTH = PLANE_HEIGHT * (window.innerWidth / window.innerHeight);
const INITIAL_RADIUS = PLANE_HEIGHT / 2 / Math.tan((FOV / 2) * (Math.PI / 180));
// z-gap between layers. Each layer is scaled up by (R+d)/R so it still fills
// the frustum edge-to-edge despite being further from the camera.
const LAYER_DEPTH = 0.1;

const env = {
  intensity: 0.5,
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

function Scene({ mode }: { mode: "cursor" | "drag" | "cut" }) {
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
      <directionalLight position={[3, 4, 3]} intensity={1.2} color="#fff8f4" />
      <directionalLight
        position={[-2, 1, -1]}
        intensity={0.25}
        color="#e8eeff"
      />
      <Environment
        files="/env.hdr"
        environmentIntensity={env.intensity}
        backgroundRotation={[0, env.rotation * (Math.PI / 180), 0]}
        environmentRotation={[0, env.rotation * (Math.PI / 180), 0]}
        backgroundBlurriness={env.blurriness}
      />
      {[0, 1, 2].map((i) => (
        <group
          key={`${segments}-${i}`}
          position={[0, 0, -i * LAYER_DEPTH]}
          scale={(INITIAL_RADIUS + i * LAYER_DEPTH) / INITIAL_RADIUS}
        >
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
          />
        </group>
      ))}
    </>
  );
}

export default function App() {
  const [mode, setMode] = useState<"cursor" | "drag" | "cut">("cut");
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [sendStatus, setSendStatus] = useState<
    "" | "sending" | "sent" | "error"
  >("");
  const contactRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.style.userSelect = mode === "cursor" ? "" : "none";
    if (mode !== "cursor") window.getSelection()?.removeAllRanges();
    return () => {
      document.body.style.userSelect = "";
    };
  }, [mode]);

  // Link hover effect in cursor mode
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const links =
        contactRef.current?.querySelectorAll<HTMLElement>(".sp-link");
      links?.forEach((link) => {
        const r = link.getBoundingClientRect();
        const over =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        link.style.color =
          mode === "cursor" && over ? "rgba(255,120,40,1)" : "var(--cm)";
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [mode]);

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setSendStatus("sending");
    try {
      await emailjs.send("service_3h0v68i", "template_0ac2h4m", form, {
        publicKey: import.meta.env.VITE_EMAILJS_PUBLIC_KEY,
      });
      setSendStatus("sent");
      setForm({ name: "", email: "", message: "" });
    } catch {
      setSendStatus("error");
    }
  }

  function handlePointerMissed(e: MouseEvent) {
    if (mode !== "cursor") return;
    const hit = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find(
        (el) =>
          contactRef.current?.contains(el) &&
          (el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLButtonElement ||
            el instanceof HTMLAnchorElement),
      );
    if (!hit) return;
    if (hit instanceof HTMLInputElement || hit instanceof HTMLTextAreaElement) {
      hit.focus();
    } else {
      (hit as HTMLElement).click();
    }
  }

  return (
    <>
      {/* Contact form — sits behind the canvas via z-index */}
      <div
        ref={contactRef}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          background: "var(--cbg)",
          fontFamily: "'Urbanist', system-ui, sans-serif",
        }}
      >
        <style>{`
          .sp-input, .sp-ta {
            width:100%; box-sizing:border-box; background:transparent; border:none;
            border-bottom:1.5px solid var(--ct); font-family:inherit;
            font-size:32px; font-weight:300; letter-spacing:-0.5px;
            color:var(--ct); padding:8px 0; outline:none; resize:none;
          }
          .sp-input::placeholder, .sp-ta::placeholder { color:var(--cm); }
          .sp-ta { font-size:18px; font-weight:400; letter-spacing:0; min-height:80px; }
          .sp-btn {
            background:transparent; border:none; cursor:pointer; padding:0;
            font-family:inherit; font-size:10px; font-weight:600;
            letter-spacing:0.18em; color:var(--ct);
          }
          .sp-link {
            font-family:'Manrope',sans-serif; font-size:11px; font-weight:400;
            letter-spacing:0.1em; color:var(--cm); text-decoration:none;
          }
        `}</style>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            padding: "40px 48px",
            boxSizing: "border-box",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.14em",
              color: "var(--cm)",
              marginBottom: 28,
            }}
          >
            GET IN TOUCH
          </span>
          <form
            onSubmit={handleSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 20 }}
          >
            <input
              className="sp-input"
              placeholder="Name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <input
              className="sp-input"
              type="email"
              placeholder="Email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
            />
            <textarea
              className="sp-ta"
              placeholder="Message"
              value={form.message}
              onChange={(e) =>
                setForm((f) => ({ ...f, message: e.target.value }))
              }
            />
            <div
              style={{ display: "flex", alignItems: "center", marginTop: 8 }}
            >
              <button
                type="submit"
                className="sp-btn"
                disabled={sendStatus === "sending"}
              >
                SEND →
              </button>
              {sendStatus && (
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    color: "var(--cm)",
                    marginLeft: 20,
                  }}
                >
                  {sendStatus === "sending"
                    ? "Sending…"
                    : sendStatus === "sent"
                      ? "Sent ✓"
                      : "Error — try again"}
                </span>
              )}
            </div>
          </form>
          <div style={{ marginTop: 40, display: "flex", gap: 28 }}>
            <a
              className="sp-link"
              href="https://www.instagram.com/5x00.art/"
              target="_blank"
              rel="noreferrer"
            >
              INSTAGRAM
            </a>
            <a
              className="sp-link"
              href="https://www.linkedin.com/in/5x00/"
              target="_blank"
              rel="noreferrer"
            >
              LINKEDIN
            </a>
            <a
              className="sp-link"
              href="https://x.com/5x00_art"
              target="_blank"
              rel="noreferrer"
            >
              X
            </a>
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: 0,
              right: 0,
              textAlign: "center",
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 300,
                letterSpacing: "0.18em",
                color: "var(--cm)",
              }}
            >
              day-dream
            </span>
          </div>
        </div>
      </div>

      <Leva collapsed />
      <Canvas
        camera={{
          fov: FOV,
          position: [0, 0, INITIAL_RADIUS],
          near: 0.01,
          far: 100,
        }}
        gl={{
          alpha: true,
          outputColorSpace: "srgb",
          toneMapping: THREE.NoToneMapping,
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1,
          filter: "contrast(1.8) brightness(1.05)",
        }}
        onPointerMissed={handlePointerMissed}
      >
        <Scene mode={mode} />
      </Canvas>

      {/* Rendered outside Canvas so the filter on the canvas wrapper doesn't apply */}
      <div
        className="fixed bottom-6 right-6 bg-white/10 backdrop-blur-md p-1 rounded-full flex gap-1 shadow-lg select-none"
        style={{ zIndex: 2 }}
      >
        <button
          onClick={() => setMode("cursor")}
          className={`px-3 py-1.5 rounded-full text-sm transition-all ${
            mode === "cursor"
              ? "bg-white shadow-sm"
              : "opacity-60 hover:opacity-100 grayscale"
          }`}
          title="Cursor Mode — interact with page content"
        >
          👆
        </button>
        <button
          onClick={() => setMode("drag")}
          className={`px-3 py-1.5 rounded-full text-sm transition-all ${
            mode === "drag"
              ? "bg-white shadow-sm"
              : "opacity-60 hover:opacity-100 grayscale"
          }`}
          title="Drag Mode"
        >
          🖐️
        </button>
        <button
          onClick={() => setMode("cut")}
          className={`px-3 py-1.5 rounded-full text-sm transition-all ${
            mode === "cut"
              ? "bg-white shadow-sm"
              : "opacity-60 hover:opacity-100 grayscale"
          }`}
          title="Cut Mode"
        >
          🔪
        </button>
      </div>
    </>
  );
}
