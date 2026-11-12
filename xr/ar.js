// AR placement: a reticle follows the real surface the user looks at (hit-test from the viewer), select (trigger /
// pinch, not on the panel) puts the product there, facing the user. Without hit-test (not granted / not supported)
// or before the first hit the default placement stays (table height in front of the user). Recenter = place again.
import * as THREE from 'three';
import { applyRig } from './session.js?v=3fac0b060a';

export function createAR(xs) {
  const { host, session } = xs, input = xs.input;
  let source = null, placing = true, lastHit = null, failed = false;
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffdb00, transparent: true, opacity: 0.9, depthTest: false }));
  reticle.renderOrder = 32; reticle.visible = false; reticle.matrixAutoUpdate = false;
  xs.rig.add(reticle);                                     // rig local = reference space, like the hit poses

  session.requestReferenceSpace('viewer')
    .then(viewer => session.requestHitTestSource?.({ space: viewer }))
    .then(s => { source = s || null; if (!s) failed = true; })
    .catch(() => { failed = true; });                      // hit-test not granted: keep the default placement
  xs.hitTest = () => (source ? 'active' : failed ? 'unavailable' : 'pending');

  const recenter = xs.recenter;
  xs.recenter = () => { recenter(); placing = true; };     // AR: recenter = place again on a surface

  /** Put the product's floor centre on a reference-space point, facing the user. */
  function placeAt(p, frame) {
    const pose = frame && frame.getViewerPose(host.renderer.xr.getReferenceSpace());
    const head = pose ? pose.transform.position : { x: 0, z: 0 };
    const userYaw = Math.atan2(head.x - p.x, head.z - p.z);   // direction the user looks at the point
    const box = host.kitBox.clone().union(host.finalBox), c = box.getCenter(new THREE.Vector3()).setY(0);
    const cam = host.sc.camera, viewYaw = Math.atan2(-(cam.target[0] - cam.position[0]), -(cam.target[2] - cam.position[2]));
    applyRig(xs, { c, D: new THREE.Vector3(p.x, p.y, p.z), yaw: viewYaw - userYaw, s: xs.scale || 1 });   // the user sees it from the desktop camera's side
    placing = false; reticle.visible = false;
    host.events.emit('arPlace', { source: 'xr', at: [p.x, p.y, p.z] });
  }
  xs.arPlaceAt = (p, frame) => placeAt(p, frame);         // QA

  function update(dt, frame) {
    if (!placing) return;
    if (source && frame) {
      const hits = frame.getHitTestResults(source);
      const pose = hits[0]?.getPose(host.renderer.xr.getReferenceSpace());
      if (pose) { reticle.matrix.fromArray(pose.transform.matrix); reticle.visible = true; lastHit = pose.transform.position; }
      else reticle.visible = false;
    }
    if (!lastHit) return;
    for (const side of ['left', 'right']) {
      const s = input.sides[side];
      if (s.justSelected && xs.interaction.hover[side]?.kind !== 'button' && xs.interaction.hover[side]?.kind !== 'panel') { placeAt(lastHit, frame); break; }
    }
  }
  function dispose() { source?.cancel?.(); xs.rig.remove(reticle); reticle.geometry.dispose(); reticle.material.dispose(); }
  return { update, dispose, get placing() { return placing; } };
}
