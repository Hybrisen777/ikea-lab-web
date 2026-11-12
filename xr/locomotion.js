// Moving around in VR (not in AR: there the real room is the floor). Moves the rig, never the scene.
//   Floor spots (the beginner way, hands and controllers): four glowing circles on the floor around the product - point
//     at one and pinch / pull the trigger: you stand there, turned towards the product.
//   Controller: thumbstick forward = free aim (arc + ring on the real floor), release = teleport; left / right = snap turn 30°.
//   Hands: only the floor spots, and only when a pinch is RELEASED still on the same spot within 1.2 s without having
//     grabbed a part - a pinch meant for a part or the panel never moves you (no free aiming with hands).
//   Floor button (panel): the next pinch / trigger with the hand or controller held on the real floor sets the floor
//     height (xs.setFloor) - Chrome over Quest Link guesses local-floor and puts it too low.
// Everything is in the reference space (rig local, real metres, floor y = xs.floorY), so it works the same in Room and
// Table scale: in Table mode the spots are around the miniature's table, in Room mode around the real-size product.
import * as THREE from 'three';

const SPEED = 6, G = 9.8, MAX_DIST = 8, STEPS = 48, DT = 0.03, TURN = Math.PI / 6;
const AIM_ON = -0.6, AIM_OFF = 0.3, TURN_ON = 0.7, TURN_OFF = 0.3, HAND_TAP = 1.2;
const FLOOR_ABOVE = { controller: 0.04, hand: 0.03, joints: 0.01 };   // grab point above the floor when touching it
const FLOOR_HINT = 'Touch the real floor with your hand or controller and pinch / pull the trigger.';
const SPOT_GAP = 0.7, SPOT_R = 0.28, SPOT_HIDE = 0.6;   // spots 0.7 m outside the product box; the one you stand on hides
const OK = 0x2fb7ff, BAD = 0x888888;
export const WALK_HINT = 'Walk around: point at a blue circle on the floor and pinch (trigger).';

export function createLocomotion(xs) {
  const { host } = xs, input = xs.input, rig = xs.rig;
  const pts = new Float32Array((STEPS + 1) * 3), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const arc = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: OK, transparent: true, opacity: 0.9, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.85, depthTest: false }));
  arc.frustumCulled = false; arc.renderOrder = ring.renderOrder = 33; arc.visible = ring.visible = false;
  rig.add(arc, ring);                                              // rig local = reference space (real metres)

  // floor spots: a disc (ray target) + a rim, front / right / back / left of the product
  const spotGeo = new THREE.CircleGeometry(SPOT_R, 40).rotateX(-Math.PI / 2), rimGeo = new THREE.RingGeometry(SPOT_R, SPOT_R + 0.035, 40).rotateX(-Math.PI / 2);
  const spots = [0, 1, 2, 3].map(i => {
    const disc = new THREE.Mesh(spotGeo, new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.25, depthWrite: false }));
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.9, depthWrite: false }));
    disc.add(rim); disc.renderOrder = rim.renderOrder = 32; disc.userData.spot = i; rig.add(disc);
    return disc;
  });
  const ray = new THREE.Raycaster();
  xs.walkHint = WALK_HINT;
  if (xs.mode2 === 'watch') xs.panel?.setHint(WALK_HINT);

  const state = { left: { aim: false, armed: true, tap: null }, right: { aim: false, armed: true, tap: null } };
  let target = null, frame = null, frameNo = 0, calib = null, hintBefore = '';
  const floor = () => xs.floorY || 0;

  // head pose in the reference space, read once per XR frame (an XRFrame is only valid inside its callback; teleportTo /
  // turn may be called from outside it, e.g. QA): position + facing direction (atan2(x, z) of the forward vector)
  let headPos = null, headDir = null;
  function readHead() {
    const pose = frame?.getViewerPose(host.renderer.xr.getReferenceSpace());
    if (!pose) return;
    const o = pose.transform.orientation, f = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    headPos = new THREE.Vector3().copy(pose.transform.position); headDir = Math.atan2(f.x, f.z);
  }
  const head = () => headPos?.clone() || null;
  const headYaw = () => headDir;
  const toRef = v => rig.worldToLocal(v.clone());
  const dirToRef = v => v.clone().applyQuaternion(rig.quaternion.clone().invert()).normalize();
  /** Product (kit area + finished) in the reference space: floor centre and the half sizes along world X / Z. */
  function content() {
    const b = host.kitBox.clone().union(host.finalBox), k = rig.scale.x;
    return { c: toRef(b.getCenter(new THREE.Vector3())).setY(0), hx: (b.max.x - b.min.x) / 2 / k, hz: (b.max.z - b.min.z) / 2 / k };
  }

  /** Arc from a side's ray (world) in reference space; returns the landing point on the floor or null. */
  function trace(s) {
    const o = toRef(s.rayOrigin), d = dirToRef(s.rayDirection), h = head();
    let p = o.clone(), n = 0, hit = null;
    const v = d.multiplyScalar(SPEED), put = q => { pts[n * 3] = q.x; pts[n * 3 + 1] = q.y; pts[n * 3 + 2] = q.z; n++; };
    put(p);
    while (n < STEPS) {
      const q = p.clone().addScaledVector(v, DT); v.y -= G * DT;
      const F = floor();
      if (q.y <= F) { hit = p.clone().lerp(q, (p.y - F) / (p.y - q.y)); hit.y = F; put(hit); break; }
      put(q); p = q;
    }
    geo.setDrawRange(0, n); geo.attributes.position.needsUpdate = true;
    if (hit && h && Math.hypot(hit.x - h.x, hit.z - h.z) > MAX_DIST) hit = null;
    return hit;
  }

  /** Move the rig so the user's feet land at the reference-space floor point T (keeps the rig height and turn). */
  function teleportTo(T, extra = {}) {
    const h = head(); if (!h) return false;
    const k = rig.scale.x, delta = new THREE.Vector3(T.x - h.x, 0, T.z - h.z).multiplyScalar(k).applyQuaternion(rig.quaternion);
    rig.position.add(delta); rig.updateMatrixWorld(true);
    host.events.emit('teleport', { source: 'xr', to: [T.x, T.z], ...extra });
    return true;
  }
  /** Turn the world around the user's head by angle a (radians, + = left). */
  function turn(a, emit = true) {
    const h = head(); if (!h) return false;
    const k = rig.scale.x, w = h.clone().multiplyScalar(k).applyQuaternion(rig.quaternion).add(rig.position);   // head in world
    rig.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a));
    rig.position.copy(w).sub(h.clone().multiplyScalar(k).applyQuaternion(rig.quaternion));
    rig.updateMatrixWorld(true);
    if (emit) host.events.emit('turn', { source: 'xr', angle: a });
    return true;
  }
  /** Stand on spot i, turned towards the product. */
  function goToSpot(i) {
    if (!teleportTo(spots[i].position, { spot: i })) return false;
    const h = head(), yaw = headYaw(), { c } = content();
    if (h && yaw != null) { let a = Math.atan2(c.x - h.x, c.z - h.z) - yaw; a = Math.atan2(Math.sin(a), Math.cos(a)); turn(a, false); }
    return true;
  }

  function layoutSpots() {
    const { c, hx, hz } = content(), h = head(), q = rig.quaternion.clone().invert();
    const dirs = [[0, 0, 1, hz], [1, 0, 0, hx], [0, 0, -1, hz], [-1, 0, 0, hx]];   // world +Z (front), +X, -Z, -X
    dirs.forEach(([x, y, z, half], i) => {
      const d = new THREE.Vector3(x, y, z).applyQuaternion(q).setY(0).normalize();
      spots[i].position.copy(c).addScaledVector(d, half + SPOT_GAP).setY(floor() + 0.005);
      spots[i].visible = !h || Math.hypot(spots[i].position.x - h.x, spots[i].position.z - h.z) > SPOT_HIDE;
    });
  }
  /** Floor spot on a side's ray, if it is nearer than what the ray already hits (panel / part). */
  function spotOn(side, s) {
    if (s.type === 'none' || xs.holding?.[side]) return null;
    ray.set(s.rayOrigin, s.rayDirection); ray.far = 20 * rig.scale.x;
    const hit = ray.intersectObjects(spots.filter(m => m.visible), false)[0];
    const other = xs.interaction.hover[side];
    return hit && (!other || hit.distance < other.distance) ? hit.object.userData.spot : null;
  }

  /** Floor button: the next select (not on the panel) with the hand / controller on the real floor sets its height. */
  function calibrate() {
    if (calib) { calib = null; xs.panel?.setHint(hintBefore); return; }   // pressed again = cancel
    calib = { from: frameNo }; hintBefore = xs.panel?.hint || ''; xs.panel?.setHint(FLOOR_HINT);
  }
  function calibrationStep() {
    for (const side of ['left', 'right']) {
      const s = input.sides[side], h = xs.interaction.hover[side];
      if (!s.justSelected || frameNo <= calib.from || h?.kind === 'button' || h?.kind === 'panel') continue;
      const y = rig.worldToLocal(s.grabPose.position.clone()).y - FLOOR_ABOVE[s.type === 'hand' ? (s.joints ? 'joints' : 'hand') : 'controller'];
      calib = null; xs.panel?.setHint(hintBefore);
      xs.setFloor(y); input.pulse(side, 0.6, 40);
      xs.panel?.flash(`Floor set (${y >= 0 ? '+' : ''}${(y * 100).toFixed(0)} cm)`, '#2e7d32');
      host.events.emit('floor', { source: 'xr', y });
      return;
    }
  }

  function update(dt, f) {
    frame = f; frameNo++; readHead();
    if (calib) { arc.visible = ring.visible = false; target = null; calibrationStep(); return; }
    if (!xs.placed) return;
    layoutSpots();
    const hovered = new Set();
    let aiming = null;
    for (const side of ['left', 'right']) {
      const s = input.sides[side], st = state[side];
      const spot = st.aim ? null : spotOn(side, s);
      if (spot != null) hovered.add(spot);
      if (s.type === 'hand') {                                        // hands: spot on release of a short, empty pinch
        if (s.justSelected) st.tap = spot != null ? { spot, t: performance.now() } : null;
        if (st.tap && xs.holding?.[side]) st.tap = null;                // the pinch grabbed a part
        if (st.tap && s.justDeselected) {
          const ok = spot === st.tap.spot && performance.now() - st.tap.t < HAND_TAP * 1000;
          st.tap = null;
          if (ok) goToSpot(spot);
        }
        st.aim = false; continue;
      }
      if (spot != null && s.justSelected) { if (goToSpot(spot)) input.pulse(side, 0.5, 30); continue; }
      if (s.type === 'controller') {
        if (!st.aim && s.stick.y < AIM_ON) st.aim = true;
        if (st.aim && Math.hypot(s.stick.x, s.stick.y) < AIM_OFF) { st.aim = false; if (target && teleportTo(target)) input.pulse(side, 0.5, 30); target = null; }
        if (!st.aim) {
          if (st.armed && Math.abs(s.stick.x) > TURN_ON) { st.armed = false; turn(-Math.sign(s.stick.x) * TURN); input.pulse(side, 0.3, 20); }
          else if (Math.abs(s.stick.x) < TURN_OFF) st.armed = true;
        }
      } else st.aim = false;
      if (st.aim && !aiming) aiming = side;
    }
    spots.forEach((m, i) => { const on = hovered.has(i); m.material.opacity = on ? 0.6 : 0.25; m.scale.setScalar(on ? 1.12 : 1); });
    if (aiming) {
      target = trace(input.sides[aiming]);
      arc.material.color.setHex(target ? OK : BAD);
      arc.visible = true; ring.visible = !!target; if (target) ring.position.copy(target);
    } else { arc.visible = ring.visible = false; target = null; }
  }

  function dispose() {
    rig.remove(arc, ring, ...spots); geo.dispose(); arc.material.dispose(); ring.geometry.dispose(); ring.material.dispose();
    spotGeo.dispose(); rimGeo.dispose(); for (const m of spots) { m.material.dispose(); m.children[0].material.dispose(); }
    xs.walkHint = '';
  }
  return { update, dispose, teleportTo, turn, goToSpot, spots, calibrate, get calibrating() { return !!calib; },
    get aiming() { return arc.visible; }, get target() { return target; } };
}
