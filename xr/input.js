// Unified XR input: one state per side, the same for controllers and tracked hands.
//   sides.left / sides.right = { type: 'controller'|'hand'|'none', rayOrigin, rayDirection, grabPose: { position, quaternion },
//     selectPressed, grabPressed, pokeTip, justSelected, justDeselected, justGrabbed, justReleased, source,
//     stick: { x, y } (controller thumbstick, y < 0 = pushed forward; hands: 0) }
// All vectors are world space (they include the rig, so they line up with the scene). Distances inside a hand (pinch)
// are measured in real metres (rig scale divided out).
// Controllers: target-ray space = ray, grip space = grabPose, trigger = select, grip button = grab.
// Hands: the system's select (pinch along the ray) = select; near grab = thumb tip to index tip < 1.5 cm (released
// > 2.5 cm), grabPose = midpoint of the two tips (low-pass filtered), pokeTip = index tip. Without joint poses (desktop
// Chrome over Quest Link) the system pinch is the grab too, at the hand's grip (else target-ray) pose; sides.*.joints says which.
// Models are self-hosted in xr/assets/profiles (no CDN): Meta Quest controllers and the generic hand; other controllers
// get a small built-in model. Controller models are loaded here (profile lookup + GLTFLoader, cached) instead of three's
// XRControllerModelFactory: that one throws when a controller disconnects while its model loads, and does not animate
// anything we need.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchProfile } from 'three/addons/libs/motion-controllers.module.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const PROFILES = new URL('./assets/profiles', import.meta.url).href;
const PINCH_ON = 0.015, PINCH_OFF = 0.025, SMOOTH_HZ = 18;
const blankSide = () => ({ type: 'none', rayOrigin: new THREE.Vector3(), rayDirection: new THREE.Vector3(0, 0, -1),
  grabPose: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }, selectPressed: false, grabPressed: false,
  pokeTip: null, justSelected: false, justDeselected: false, justGrabbed: false, justReleased: false, source: null, index: -1,
  stick: { x: 0, y: 0 } });

let factories = null;   // the three.js controller objects live as long as the renderer: set the models up once
function models() {
  if (factories) return factories;
  const hmf = new XRHandModelFactory(); hmf.setPath(PROFILES + '/generic-hand/');
  return factories = { loader: new GLTFLoader(), cache: new Map(), hmf, done: new WeakSet() };
}
/** Controller model for an input source (null: no self-hosted profile - use the built-in box). */
async function controllerScene(src) {
  const f = models();
  let asset;
  try { asset = (await fetchProfile(src, PROFILES)).assetPath; } catch (e) { return null; }
  if (!asset) return null;
  if (!f.cache.has(asset)) f.cache.set(asset, f.loader.loadAsync(asset).then(g => g.scene, () => null));
  const scene = await f.cache.get(asset);
  return scene ? scene.clone() : null;
}
const handLook = new THREE.MeshStandardMaterial({ color: 0xd9c8b4, roughness: 0.7, transparent: true, opacity: 0.55, depthWrite: false });

export function createInput(xs) {
  const { renderer } = xs.host, rig = xs.rig, f = models();
  const sides = { left: blankSide(), right: blankSide() };
  const slots = [0, 1].map(i => {
    const controller = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
    rig.add(controller, grip, hand);
    if (!f.done.has(grip)) {
      f.done.add(grip);
      const fallback = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.11), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }));
      fallback.name = 'fallbackModel'; fallback.visible = false; grip.add(fallback);
      const hm = f.hmf.createHandModel(hand, 'mesh'); hand.add(hm);
      hand.userData.handModel = hm;
    }
    const slot = { i, controller, grip, hand, side: null, source: null, pinch: false, smooth: null, listeners: [], gen: 0 };
    const on = (obj, type, fn) => { obj.addEventListener(type, fn); slot.listeners.push([obj, type, fn]); };
    on(controller, 'connected', e => connect(slot, e.data));
    on(controller, 'disconnected', () => disconnect(slot));
    on(controller, 'selectstart', () => { if (slot.side) sides[slot.side].selectPressed = true; });
    on(controller, 'selectend', () => { if (slot.side) sides[slot.side].selectPressed = false; });
    on(controller, 'squeezestart', () => { if (slot.side && sides[slot.side].type === 'controller') sides[slot.side].grabPressed = true; });
    on(controller, 'squeezeend', () => { if (slot.side && sides[slot.side].type === 'controller') sides[slot.side].grabPressed = false; });
    return slot;
  });
  // created before renderer.xr.setSession (xr/session.js), so no 'connected' event is missed

  function connect(slot, src) {
    slot.source = src; slot.side = src.handedness === 'left' ? 'left' : 'right';
    const s = sides[slot.side]; Object.assign(s, blankSide());
    s.type = src.hand ? 'hand' : 'controller'; s.source = src; s.index = slot.i;
    slot.pinch = false; slot.smooth = null;
    const gen = ++slot.gen, fb = slot.grip.getObjectByName('fallbackModel');
    const old = slot.grip.getObjectByName('controllerModel'); if (old) slot.grip.remove(old);
    if (fb) fb.visible = false;
    if (!src.hand) controllerScene(src).then(m => {
      if (gen !== slot.gen || slot.source !== src) return;            // disconnected / replaced while loading
      if (m) { m.name = 'controllerModel'; slot.grip.add(m); } else if (fb) fb.visible = true;
    });
    if (src.hand) slot.hand.traverse(o => { if (o.isMesh && o.material !== handLook) o.material = handLook; });
  }
  function disconnect(slot) {
    slot.gen++;
    const old = slot.grip.getObjectByName('controllerModel'); if (old) slot.grip.remove(old);
    const fb = slot.grip.getObjectByName('fallbackModel'); if (fb) fb.visible = false;
    if (slot.side && sides[slot.side].index === slot.i) Object.assign(sides[slot.side], blankSide());
    slot.source = null; slot.side = null;
  }

  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), mid = new THREE.Vector3();
  const prev = { left: {}, right: {} };
  function update(dt) {
    const k = rig.scale.x || 1;
    for (const slot of slots) {
      if (!slot.side) continue;
      const s = sides[slot.side];
      slot.controller.updateMatrixWorld(true);
      s.rayOrigin.setFromMatrixPosition(slot.controller.matrixWorld);
      s.rayDirection.set(0, 0, -1).applyQuaternion(slot.controller.getWorldQuaternion(tmpQ)).normalize();
      if (s.type === 'controller') {
        slot.grip.updateMatrixWorld(true);
        slot.grip.matrixWorld.decompose(s.grabPose.position, s.grabPose.quaternion, tmpV);
        s.pokeTip = null;
        const ax = slot.source?.gamepad?.axes || [];                     // xr-standard: 2, 3 = thumbstick (y < 0 = forward)
        s.stick.x = ax[2] || 0; s.stick.y = ax[3] || 0;
      } else if (s.type === 'hand') {
        const j = slot.hand.joints, th = j['thumb-tip'], ix = j['index-finger-tip'], wr = j['wrist'];
        if (!th || !ix || !th.visible || !ix.visible) {                   // no joint poses (desktop Chrome over Quest Link):
          s.grabPressed = s.selectPressed; s.pokeTip = null;               // the system pinch grabs, at the hand's grip / ray pose
          const g = slot.grip.visible ? slot.grip : slot.controller;
          g.updateMatrixWorld(true); g.matrixWorld.decompose(s.grabPose.position, s.grabPose.quaternion, tmpV);
          s.joints = false; continue;
        }
        s.joints = true;
        const a = th.getWorldPosition(new THREE.Vector3()), b = ix.getWorldPosition(new THREE.Vector3());
        const d = a.distanceTo(b) / k;                                       // real metres
        if (!slot.pinch && d < PINCH_ON) slot.pinch = true; else if (slot.pinch && d > PINCH_OFF) slot.pinch = false;
        s.grabPressed = slot.pinch;
        mid.addVectors(a, b).multiplyScalar(0.5);
        const q = (wr || ix).getWorldQuaternion(tmpQ);
        if (!slot.smooth) slot.smooth = { p: mid.clone(), q: q.clone() };
        const u = 1 - Math.exp(-SMOOTH_HZ * Math.max(dt, 1e-3));                // low-pass
        slot.smooth.p.lerp(mid, u); slot.smooth.q.slerp(q, u);
        s.grabPose.position.copy(slot.smooth.p); s.grabPose.quaternion.copy(slot.smooth.q);
        s.pokeTip = b;
      }
    }
    for (const side of ['left', 'right']) {
      const s = sides[side], p = prev[side];
      s.justSelected = s.selectPressed && !p.sel; s.justDeselected = !s.selectPressed && !!p.sel;
      s.justGrabbed = s.grabPressed && !p.grab; s.justReleased = !s.grabPressed && !!p.grab;
      p.sel = s.selectPressed; p.grab = s.grabPressed;
    }
  }

  /** Haptic pulse on a controller (hands: nothing). */
  function pulse(side, intensity = 0.6, ms = 40) {
    const a = sides[side]?.source?.gamepad?.hapticActuators?.[0];
    try { a?.pulse?.(intensity, ms); } catch (e) { /* not supported */ }
  }

  function dispose() {
    for (const slot of slots) {
      for (const [o, t, fn] of slot.listeners) o.removeEventListener(t, fn);
      rig.remove(slot.controller, slot.grip, slot.hand);
    }
  }
  return { sides, slots, update, pulse, dispose };
}
