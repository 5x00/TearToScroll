# ClothSim Scroll

**[Try the live demo →](https://your-project.vercel.app)** *(placeholder)*

An interactive 3D cloth simulation built with React, Three.js, and Verlet physics. Cloth planes are layered like pages, each rendered with live HTML content captured as WebGL textures. You can drag, tear, and cut the fabric in real time.

---

## Capabilities

- **Verlet physics** — constraint-based spring solver with configurable gravity, damping, and rest-length relaxation over multiple iterations
- **Drag mode** — click and pull cloth vertices toward the cursor with tunable drag strength
- **Cut mode** — sweep the cursor to sever edges; uses raycasting and line-segment distance queries, then splits vertices (seam splitting) to cleanly separate cloth faces
- **Automatic tearing** — springs that exceed a configurable stretch threshold snap and remove themselves from the mesh
- **Tension visualization** — vertex color gradient (blue → red) shows live spring stretch across the surface
- **HTML-to-WebGL textures** — page content is rendered via canvas and mapped onto cloth geometry
- **Live parameter tuning** — Leva UI controls for segments, damping, gravity, tear distance, drag strength, and cut radius
- **WASD + Q/E camera** — 3D navigation through the scene

## Tech Stack

- React + TypeScript + Vite
- Three.js (rendering, raycasting, geometry)
- Verlet integration (custom physics)
- Leva (real-time parameter controls)

## Getting Started

```bash
npm install
npm run dev
```
