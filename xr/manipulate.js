// Two-hand scene manipulation (the Meta OS / most VR apps gesture): pinch (hands) or squeeze (controller grips) with
// BOTH hands in empty space - not holding a part, not dragging the panel - then pull the hands apart = bigger, together
// = smaller, move them = move the assembly, turn them around each other = turn it. Moves the rig only (like teleport),
// so attach radii and reach stay in real centimetres at any size. Scale is kept between 2x real size and 1/25.
import * as THREE from 'three';

const K_MIN = 0.5, K_MAX = 25;                    // rig scale k (world units per real metre): 0.5 = twice real size

export function createManipulation(xs) {
  const { rig } = xs, input = xs.input;
  let g = null;                                   // the gesture: { mid0, dist0, ang0, rig0 }

  const refPos = s => rig.worldToLocal(s.grabPose.position.clone());   // real-space hand position
  const free = side => {
    const s = input.sides[side];
    return s.type !== 'none' && s.grabPressed && !xs.holding?.[side] && !xs.interaction?.hover[side]?.dragging;
  };
  function frameOf() {
    const a = refPos(input.sides.left), b = refPos(input.sides.right);
    return { mid: a.clone().add(b).multiplyScalar(0.5).setY((a.y + b.y) / 2), dist: Math.max(a.distanceTo(b), 0.02), ang: Math.atan2(b.x - a.x, b.z - a.z) };
  }

  function update() {
    if (!(free('left') && free('right'))) { if (g) xs.host.events.emit('manipulate', { source: 'xr', end: true, scale: xs.scale }); g = null; return; }
    const f = frameOf();
    if (!g) {
      rig.updateMatrix();
      g = { mid0: f.mid, dist0: f.dist, ang0: f.ang, rig0: rig.matrix.clone(), k0: rig.scale.x };
      for (const side of ['left', 'right']) input.pulse(side, 0.3, 20);
      return;
    }
    // content in real space: C' = M * C, M = T(mid) R(dAng) S(s) T(-mid0); the rig is its inverse: rig' = rig0 * M^-1
    let s = f.dist / g.dist0;
    s = THREE.MathUtils.clamp(s, g.k0 / K_MAX, g.k0 / K_MIN);
    const M = new THREE.Matrix4().makeTranslation(f.mid.x, f.mid.y, f.mid.z)
      .multiply(new THREE.Matrix4().makeRotationY(f.ang - g.ang0))
      .multiply(new THREE.Matrix4().makeScale(s, s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-g.mid0.x, -g.mid0.y, -g.mid0.z));
    const R = g.rig0.clone().multiply(M.invert());
    R.decompose(rig.position, rig.quaternion, rig.scale);
    const k = rig.scale.x; rig.scale.setScalar(k);           // uniform (rounding)
    rig.updateMatrixWorld(true);
    xs.scale = 1 / k;
    // incremental: next frame continues from here (real hand positions do not depend on the rig)
    g = { rig0: rig.matrix.clone(), mid0: f.mid, dist0: f.dist, ang0: f.ang, k0: k };
  }
  return { update, dispose() { g = null; }, get active() { return !!g; } };
}
