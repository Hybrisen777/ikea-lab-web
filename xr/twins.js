// Identical parts in any orientation. The models bake each part's assembled orientation into its mesh (a dowel lying
// along x and one along z have different vertex data), so "the same part" is decided by shape: same label, same vertex
// count, same principal moments, and a proper rotation (no mirror: a left / right pair differs; a part with a symmetry plane, like the STEFAN bracket, is its own mirror image turned 180 deg and does match) that maps
// one vertex cloud onto the other within 1.5 mm. twin(a, b) returns that transform as a Matrix4 from b's node-local
// space to a's (a's mesh = T * b's mesh), or null. Computed once per pair (first grab), cached.
import * as THREE from 'three';

const TOL = 0.0015, SAMPLE = 64, STEP = 10;                                   // metres, points, degrees (symmetric axis search)

export function createTwins() {
  const shapes = new Map(), pairs = new Map();

  function shapeOf(part) {
    if (shapes.has(part.name)) return shapes.get(part.name);
    part.node.updateMatrixWorld(true);
    const inv = part.node.matrixWorld.clone().invert(), v = new THREE.Vector3(), pts = [];
    for (const mesh of part.meshes) {
      const rel = inv.clone().multiply(mesh.matrixWorld), pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(rel).clone());
    }
    const c = new THREE.Vector3(); for (const p of pts) c.add(p); c.divideScalar(Math.max(1, pts.length));
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of pts) { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j] / pts.length; }
    const { vals, vecs } = eig3(C);                                              // descending; vecs = columns
    const s = { pts, c, vals, F: new THREE.Matrix4().makeBasis(...vecs).setPosition(0, 0, 0) };
    shapes.set(part.name, s);
    return s;
  }

  /** Largest distance from a sample of `from` (moved by R about the centroids) to its nearest point in `to`. */
  function misfit(from, to, R) {
    const step = Math.max(1, Math.floor(from.pts.length / SAMPLE)), q = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < from.pts.length; i += step) {
      q.copy(from.pts[i]).sub(from.c).applyMatrix4(R).add(to.c);
      let best = Infinity;
      for (const p of to.pts) { const d = p.distanceToSquared(q); if (d < best) best = d; }
      worst = Math.max(worst, best);
      if (worst > TOL * TOL) return Infinity;
    }
    return Math.sqrt(worst);
  }

  /** First fitting transform, or with all: every fit (a part's symmetries when a = b). */
  function find(a, b, all = false) {
    if (a.label !== b.label) return null;
    const found = [];
    const A = shapeOf(a), B = shapeOf(b);
    if (A.pts.length !== B.pts.length) return null;
    const scale = Math.max(A.vals[0], 1e-12);
    if (A.vals.some((x, i) => Math.abs(x - B.vals[i]) > 0.03 * scale)) return null;
    // candidate rotations B -> A: map B's principal frame onto A's, axis signs free (proper rotations only); around an
    // axis whose two other moments are equal (dowels, bolts) any angle is possible: search it in STEP degree steps
    const near = (x, y) => Math.abs(x - y) <= 0.03 * scale;
    const spinAxis = near(A.vals[1], A.vals[2]) ? 0 : near(A.vals[0], A.vals[1]) ? 2 : -1;
    const BtInv = B.F.clone().transpose();
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const S = new THREE.Matrix4().makeScale(sx, sy, sx * sy);                  // det = +1
      const base = A.F.clone().multiply(S);
      const turns = spinAxis < 0 ? 1 : 360 / STEP;
      for (let k = 0; k < turns; k++) {
        const spin = spinAxis < 0 ? new THREE.Matrix4()
          : new THREE.Matrix4().makeRotationAxis(new THREE.Vector3().setComponent(spinAxis, 1), k * STEP * Math.PI / 180);
        const R = base.clone().multiply(spin).multiply(BtInv);
        if (misfit(B, A, R) <= TOL && misfit(A, B, R.clone().transpose()) <= TOL) {
          // T: b-local -> a-local = translate(A.c) * R * translate(-B.c)
          const T = new THREE.Matrix4().makeTranslation(A.c.x, A.c.y, A.c.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-B.c.x, -B.c.y, -B.c.z));
          if (!all) return T;
          found.push(T);
        }
      }
    }
    return all ? found : null;
  }
  const syms = new Map();

  return {
    /** Matrix4 b-local -> a-local (a's mesh = T * b's mesh) when a and b are the same part, else null. */
    twin(a, b) {
      const key = a.name + '|' + b.name;
      if (!pairs.has(key)) {   // one search per pair, the other direction is its exact inverse (a symmetric part has
        const t = a === b ? new THREE.Matrix4() : find(a, b);   // several fits; two searches could pick different ones)
        pairs.set(key, t); pairs.set(b.name + '|' + a.name, t && t.clone().invert());
      }
      return pairs.get(key);
    },
    /** Rotations (quaternions, node-local) under which the part looks the same: a square LACK leg turned by 90 deg. */
    symmetries(part) {
      if (!syms.has(part.name)) {
        const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
        syms.set(part.name, (find(part, part, true) || []).map(T => { T.decompose(p, q, sc); return q.clone(); }));
        if (!syms.get(part.name).length) syms.get(part.name).push(new THREE.Quaternion());
      }
      return syms.get(part.name);
    },
  };
}

/** Eigen decomposition of a symmetric 3x3 matrix (Jacobi): values descending, vectors as Vector3 columns. */
function eig3(m) {
  const a = m.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const vecs = idx.map(i => new THREE.Vector3(V[0][i], V[1][i], V[2][i]));
  if (vecs[0].clone().cross(vecs[1]).dot(vecs[2]) < 0) vecs[2].negate();     // right-handed frame
  return { vals: idx.map(i => a[i][i]), vecs };
}
