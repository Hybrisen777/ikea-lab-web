// Immersive session for the assembly player (loaded by xr/detect.js on "Enter VR" / "Enter AR").
// The scene is not moved: a rig group carries the camera and the hands / controllers, and its transform puts the
// product where the user should see it. Room = real scale on the floor in front of the user; Table = a miniature
// (~0.8 m across) at table height 0.5 m in front. Exit restores everything the session changed.
import { xrPrefs, applyQuality } from './quality.js?v=3fac0b060a';

const TABLE_HEIGHT = 0.8, TABLE_SIZE = 0.8, TABLE_GAP = 0.5, ROOM_GAP = 0.6;
let current = null;
// The last session's state (same page): re-entering continues there - Quest Link ends the session whenever the headset
// is taken off. Rig pose (teleports, turns, scale), Watch / Hands-on, the shown step and move (the player keeps them).
let resume = null;

/** While the headset session starts: what to do and how long it can take (PC + Quest Link: up to 2-3 min). */
export function startNotice(mode, ua = navigator.userAgent) {   // exported for QA (ua)
  const pc = !/OculusBrowser|Mobile|Android/.test(ua), el = document.createElement('div');
  el.id = 'xrStarting';
  el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;max-width:440px;padding:20px 24px;'
    + 'background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:15px/1.45 system-ui,sans-serif;text-align:center';
  el.innerHTML = `<div style="font-weight:700;font-size:18px;margin-bottom:6px">Starting ${mode === 'immersive-ar' ? 'AR' : 'VR'}…</div>`
    + (pc ? 'Put the headset on and wait - with Quest Link the start can take <b>2-3 minutes</b>. Keep the headset on your head, '
      + 'otherwise it pauses. This page shows the headset view once it runs.'
      + '<div style="margin-top:10px;font-size:12.5px;color:#555">Faster: open this page in the <b>Quest Browser</b> on the '
      + 'headset itself - no Link, so no long wait. The slow start over Link comes from the browser security '
      + 'sandbox (a Chrome / Meta issue); starting Chrome with the option <b>--disable-features=XRSandbox</b> may '
      + 'shorten it (this lowers a security setting - use that Chrome for VR only).</div>'
      : 'Allow the request in the headset if it asks.');
  document.body.appendChild(el);
  return el;
}

export async function enterXR(mode, host) {
  if (current) return current;
  const { THREE, renderer, scene, camera } = host;
  const trace = window.__xrTrace = window.__xrTrace || [], t0 = performance.now();   // QA: start-up timing (Quest Link)
  const mark = what => trace.push({ what, s: +((performance.now() - t0) / 1000).toFixed(2), at: new Date().toISOString().slice(11, 19) });
  mark('click ' + mode);
  const restoreQuality = applyQuality(renderer, scene);
  const inputModule = import('./input.js?v=3fac0b060a'), interactModule = import('./interact.js?v=3fac0b060a'), handsOnModule = import('./handson.js?v=3fac0b060a');
  const arModule = mode === 'immersive-ar' ? import('./ar.js?v=3fac0b060a') : null;
  const locoModule = mode === 'immersive-vr' ? import('./locomotion.js?v=3fac0b060a') : null;   // AR: the real room is the floor
  const mq = new URLSearchParams(location.search).get('mirror');   // desktop (Quest Link): the VR view on the PC screen
  const mirrorModule = mq === '1' || (mq !== '0' && !/OculusBrowser|Mobile|Android/.test(navigator.userAgent)) ? import('./mirror.js?v=3fac0b060a') : null;
  const notice = startNotice(mode);
  const session = await navigator.xr.requestSession(mode, {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking', 'hit-test', 'plane-detection', 'bounded-floor'],
  }).catch(e => { notice.remove(); restoreQuality(); mark('request failed: ' + e.message); throw e; });
  notice.remove();
  mark('session granted');

  // everything the session changes, to put back on exit
  const saved = {
    fov: camera.fov, near: camera.near, far: camera.far, parent: camera.parent,
    background: scene.background, floor: host.stageMeshes.floor?.visible, clearAlpha: renderer.getClearAlpha(),
    ui: ['panel', 'help', 'hud', 'callout', 'selCallout', 'page', 'xrButtons'].map(id => document.getElementById(id)).filter(Boolean).map(el => [el, el.style.visibility]),
  };
  const xs = current = {
    mode, session, host, rig: new THREE.Group(), granted: new Set(session.enabledFeatures || []), placed: false,
    scaleMode: mode === 'immersive-ar' ? 'table' : xrPrefs.scale, modules: [], mode2: 'watch',
    recenter() { xs.placed = false; xs.panelPending = false; },
    setScale(m) { xs.scaleMode = m; xrPrefs.set('scale', m); xs.placed = false; },
    // real floor height in the reference space: Chrome over Quest Link guesses local-floor (often too low); the Floor
    // button measures it (xr/locomotion.js) and it is remembered per browser. AR keeps 0 (hit-test finds real surfaces).
    floorY: mode === 'immersive-vr' ? xrPrefs.floor : 0,
    setFloor(y) { xs.floorY = y; xrPrefs.set('floor', y); xs.placed = false; },
    exit: () => session.end(),
    mirrorWanted: !!mirrorModule,                                   // the panel offers Photo (needs the mirror)
  };
  xs.rig.name = 'XRRig'; scene.add(xs.rig); xs.rig.add(camera);
  try {   // a setup error must end the session: else the headset waits for a first frame forever ("loading")
    xs.input = (await inputModule).createInput(xs); xs.modules.push(xs.input);   // before setSession: sees every 'connected'
    xs.interaction = (await interactModule).createInteraction(xs); xs.modules.push(xs.interaction);
    xs.handsOn = (await handsOnModule).createHandsOn(xs); xs.modules.push(xs.handsOn);
    if (arModule) { xs.ar = (await arModule).createAR(xs); xs.modules.push(xs.ar); }
    if (locoModule) { xs.locomotion = (await locoModule).createLocomotion(xs); xs.modules.push(xs.locomotion); }
    if (mirrorModule) { xs.mirror = (await mirrorModule).createMirror(xs); xs.modules.push(xs.mirror); }
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    if (!/OculusBrowser/.test(navigator.userAgent)) hideLayers(session);
    await renderer.xr.setSession(session);
  } catch (e) {
    for (const m of xs.modules.reverse()) try { m.dispose?.(); } catch {}
    xs.rig.remove(camera); if (saved.parent) saved.parent.add(camera); scene.remove(xs.rig);
    renderer.xr.enabled = false; restoreQuality(); current = null;
    session.end().catch(() => {});
    throw e;
  }
  if (!session.enabledFeatures) for (const f of ['hand-tracking', 'hit-test']) xs.granted.add(f + '?');   // unknown: probe on use
  if (mode === 'immersive-ar') {   // passthrough: no background, no floor
    scene.background = null; renderer.setClearAlpha(0);
    if (host.stageMeshes.floor) host.stageMeshes.floor.visible = false;
  }
  for (const [el] of saved.ui) el.style.visibility = 'hidden';

  const r = resume && resume.mode === mode && resume.page === location.search ? resume : null;
  resume = null;
  if (r) {   // continue where the last session ended
    xs.rig.position.fromArray(r.rig[0]); xs.rig.quaternion.fromArray(r.rig[1]); xs.rig.scale.setScalar(r.rig[2]);
    xs.rig.updateMatrixWorld(true);
    Object.assign(xs, { scaleMode: r.scaleMode, scale: r.scale, placed: true, panelPending: true });
    if (r.mode2 === 'handson') xs.setMode?.('handson', { resume: true });
    mark('resumed');
  }

  host.xr.active = true;
  const failed = new Set();   // a module that throws is logged once and skipped; the frame still renders
  xs.errors = [];
  let firstFrame = true, handSeen = false;
  host.xr.update = (dt, frame) => {
    if (firstFrame) { firstFrame = false; mark('first frame'); }
    if (!handSeen) for (const s of Object.values(xs.input.sides)) if (s.type === 'hand' && s.joints !== undefined) { handSeen = true; mark('hand, joint poses: ' + s.joints); }
    if (!xs.placed && frame) guard('place', () => place(xs, frame));
    if (xs.panelPending && frame) guard('panel', () => placePanel(xs, frame));
    for (const m of xs.modules) if (!failed.has(m)) guard(m, () => m.update?.(dt, frame));
  };
  function guard(key, fn) {
    try { fn(); } catch (e) {
      failed.add(key); xs.errors.push(String(e?.stack || e)); console.error('WebXR update:', e);
      xs.panel?.flash?.('XR error - see console', '#d33');
    }
  }

  session.addEventListener('end', () => {
    if (xs.placed) resume = { mode, page: location.search, mode2: xs.mode2, scaleMode: xs.scaleMode, scale: xs.scale,
      rig: [xs.rig.position.toArray(), xs.rig.quaternion.toArray(), xs.rig.scale.x] };
    for (const m of xs.modules.reverse()) m.dispose?.();
    host.xr.active = false; host.xr.update = null;
    xs.rig.remove(camera); if (saved.parent) saved.parent.add(camera);
    scene.remove(xs.rig);
    Object.assign(camera, { fov: saved.fov, near: saved.near, far: saved.far, zoom: 1 });
    scene.background = saved.background; renderer.setClearAlpha(saved.clearAlpha);
    if (host.stageMeshes.floor) host.stageMeshes.floor.visible = saved.floor;
    for (const [el, v] of saved.ui) el.style.visibility = v;
    restoreQuality();
    renderer.xr.enabled = false;
    host.resize(); host.dirty();
    current = null; window.xrSession = null;
  }, { once: true });

  window.xrSession = xs;   // QA (WebTests/xr.spec.js)
  return xs;
}

/** three.js renders through a WebXR projection layer whenever renderState.layers exists. Desktop Chrome on Quest Link
 *  (Chrome 156, 2026-11-02) accepts that layer but never delivers an XR frame (headset stuck on "loading"); the classic
 *  XRWebGLLayer works. Hiding renderState.layers from three on this session selects the XRWebGLLayer path. */
function hideLayers(session) {
  const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'renderState')?.get;
  if (!get) return;
  Object.defineProperty(session, 'renderState', { configurable: true, get() {
    const rs = get.call(session);
    return new Proxy(rs, { get: (t, k) => (k === 'layers' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  } });
}

/** Content box (kit area + finished product), its centre on the floor and the desktop view direction. */
function contentFrame(THREE, host) {
  const box = host.kitBox.clone().union(host.finalBox), c = box.getCenter(new THREE.Vector3()).setY(0);
  const cam = host.sc.camera, F = new THREE.Vector3(cam.target[0] - cam.position[0], 0, cam.target[2] - cam.position[2]).normalize();
  const proj = [];
  for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) proj.push(x * F.x + z * F.z);
  const half = (Math.max(...proj) - Math.min(...proj)) / 2;
  const across = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  return { c, yaw: Math.atan2(-F.x, -F.z), half, across };
}

/** Rig transform so that the content centre lands in front of the user (head pose of this frame, reference space). */
function place(xs, frame) {
  const { THREE, renderer } = xs.host;
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return;
  const p = pose.transform.position, o = pose.transform.orientation;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
  const userYaw = Math.atan2(-f.x, -f.z);
  const { c, yaw, half, across } = contentFrame(THREE, xs.host);
  const table = xs.scaleMode === 'table';
  const s = table ? Math.min(1, Math.max(0.05, TABLE_SIZE / across)) : 1;
  const dist = (table ? TABLE_GAP : ROOM_GAP) + half * s;
  const D = new THREE.Vector3(p.x - Math.sin(userYaw) * dist, (table ? TABLE_HEIGHT : 0) + (xs.floorY || 0), p.z - Math.cos(userYaw) * dist);
  applyRig(xs, { c, D, yaw: yaw - userYaw, s });
  xs.panel?.place(new THREE.Vector3(p.x, p.y, p.z), userYaw);
}
/** Panel in front of the user (a resumed session keeps the rig, but the panel goes where the user looks now). */
function placePanel(xs, frame) {
  const { THREE, renderer } = xs.host;
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return;
  const p = pose.transform.position, o = pose.transform.orientation;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
  xs.panel?.place(new THREE.Vector3(p.x, p.y, p.z), Math.atan2(-f.x, -f.z));
  xs.panelPending = false;
}

// world = rig.position + R * (k * ref): the reference point D shows the world point c, turned by yaw, at scale s
export function applyRig(xs, { c, D, yaw, s }) {
  const { THREE } = xs.host, k = 1 / s;
  xs.rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  xs.rig.scale.setScalar(k);
  xs.rig.position.copy(c).sub(D.clone().multiplyScalar(k).applyQuaternion(xs.rig.quaternion));
  xs.rig.updateMatrixWorld(true);
  xs.scale = s; xs.placed = true;
}
