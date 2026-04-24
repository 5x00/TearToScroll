export interface Spring {
  a: number; // particle index A
  b: number; // particle index B
  rest: number; // rest length
}

export interface ClothData {
  positions: Float32Array;
  prevPositions: Float32Array;
  restPositions: Float32Array; // initial geometry positions — never mutated
  isPinned: Uint8Array;
  originalIndices: Uint32Array; // maps vertex index to its topological original index
  springs: Spring[];
  cols: number;
  rows: number;
}

export function buildSpringsFromIndices(indices: ArrayLike<number>, restPositions: Float32Array): Spring[] {
  const springs: Spring[] = [];
  const edgeSet = new Set<string>();

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i+1], c = indices[i+2];
    const edges = [
      [Math.min(a, b), Math.max(a, b)],
      [Math.min(b, c), Math.max(b, c)],
      [Math.min(c, a), Math.max(c, a)]
    ];

    for (const [u, v] of edges) {
      if (u === v) continue;
      const key = `${u}_${v}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        const dx = restPositions[v*3] - restPositions[u*3];
        const dy = restPositions[v*3+1] - restPositions[u*3+1];
        const dz = restPositions[v*3+2] - restPositions[u*3+2];
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 0.0001;
        springs.push({ a: u, b: v, rest: dist });
      }
    }
  }
  return springs;
}

// Build particle and spring data from a PlaneGeometry's position and index buffers.
export function initCloth(
  positionArray: Float32Array,
  indices: ArrayLike<number>,
  segsX: number,
  segsY: number,
): ClothData {
  const cols = segsX + 1;
  const rows = segsY + 1;
  const count = cols * rows;

  const positions     = new Float32Array(positionArray);
  const prevPositions = new Float32Array(positionArray);
  const restPositions = new Float32Array(positionArray); // snapshot, never mutated
  const isPinned      = new Uint8Array(count);
  const originalIndices = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    originalIndices[i] = i;
  }

  // Pin all 4 edges
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        isPinned[r * cols + c] = 1;
      }
    }
  }

  const springs = buildSpringsFromIndices(indices, restPositions);

  return { positions, prevPositions, restPositions, isPinned, originalIndices, springs, cols, rows };
}

export interface StepParams {
  cloth: ClothData;
  iterations: number;
  damping: number;
  gravity: number;
}

export function stepCloth({ cloth, iterations, damping, gravity }: StepParams): void {
  const { positions, prevPositions, isPinned, springs } = cloth;
  const count = positions.length / 3;

  // Verlet integrate free particles
  for (let i = 0; i < count; i++) {
    if (isPinned[i]) continue;
    const i3 = i * 3;
    const vx = (positions[i3]     - prevPositions[i3])     * damping;
    const vy = (positions[i3 + 1] - prevPositions[i3 + 1]) * damping;
    const vz = (positions[i3 + 2] - prevPositions[i3 + 2]) * damping;

    prevPositions[i3]     = positions[i3];
    prevPositions[i3 + 1] = positions[i3 + 1];
    prevPositions[i3 + 2] = positions[i3 + 2];

    positions[i3]     += vx;
    positions[i3 + 1] += vy - gravity;
    positions[i3 + 2] += vz;
  }

  // Constraint relaxation
  for (let iter = 0; iter < iterations; iter++) {
    for (const { a, b, rest } of springs) {
      const a3 = a * 3, b3 = b * 3;
      const dx = positions[b3]     - positions[a3];
      const dy = positions[b3 + 1] - positions[a3 + 1];
      const dz = positions[b3 + 2] - positions[a3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
      const factor = (1 - rest / dist) * 0.5;
      const cx = dx * factor, cy = dy * factor, cz = dz * factor;

      if (!isPinned[a]) {
        positions[a3]     += cx;
        positions[a3 + 1] += cy;
        positions[a3 + 2] += cz;
      }
      if (!isPinned[b]) {
        positions[b3]     -= cx;
        positions[b3 + 1] -= cy;
        positions[b3 + 2] -= cz;
      }
    }
  }
}

export function addVertexToCloth(cloth: ClothData, sourceVertexIndex: number): number {
  const count = cloth.positions.length / 3;
  const newIndex = count;

  // Reallocate arrays
  const newPositions = new Float32Array((count + 1) * 3);
  const newPrevPositions = new Float32Array((count + 1) * 3);
  const newRestPositions = new Float32Array((count + 1) * 3);
  const newIsPinned = new Uint8Array(count + 1);
  const newOriginalIndices = new Uint32Array(count + 1);

  newPositions.set(cloth.positions);
  newPrevPositions.set(cloth.prevPositions);
  newRestPositions.set(cloth.restPositions);
  newIsPinned.set(cloth.isPinned);
  newOriginalIndices.set(cloth.originalIndices);

  // Copy data from source vertex
  const s3 = sourceVertexIndex * 3;
  const n3 = newIndex * 3;

  newPositions[n3] = cloth.positions[s3];
  newPositions[n3 + 1] = cloth.positions[s3 + 1];
  newPositions[n3 + 2] = cloth.positions[s3 + 2];

  newPrevPositions[n3] = cloth.prevPositions[s3];
  newPrevPositions[n3 + 1] = cloth.prevPositions[s3 + 1];
  newPrevPositions[n3 + 2] = cloth.prevPositions[s3 + 2];

  newRestPositions[n3] = cloth.restPositions[s3];
  newRestPositions[n3 + 1] = cloth.restPositions[s3 + 1];
  newRestPositions[n3 + 2] = cloth.restPositions[s3 + 2];

  newIsPinned[newIndex] = cloth.isPinned[sourceVertexIndex];
  newOriginalIndices[newIndex] = cloth.originalIndices[sourceVertexIndex];

  cloth.positions = newPositions;
  cloth.prevPositions = newPrevPositions;
  cloth.restPositions = newRestPositions;
  cloth.isPinned = newIsPinned;
  cloth.originalIndices = newOriginalIndices;

  return newIndex;
}
