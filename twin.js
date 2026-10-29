// Digital-twin player: loads <folder>/twin.json + model.glb (exported by Unity's TwinWebExport), builds the device and
// its controls from the exported components, and ports TwinInteractor (click / hold / wheel / hover tooltip / orbit)
// and TwinUI (status, guided tasks, manual pages). Device logic lives in devices/*.js (one port per Unity controller).
// QA: window.twin.runTrace(script) replays a parity script frame by frame exactly like Unity's TwinTraceRunner.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createStage, srgb } from './stage.js?v=52995530e4';
import { hideLoading, attachScenario, modal } from './menu.js?v=52995530e4';
import { asset, settings } from './settings.js?v=52995530e4';
import { controlTypes, deviceTypes, richText, clamp, DEG, fmt0, TextLabel } from './twin-core.js?v=52995530e4';

/** Unity controller class -> module with its port. */
const DEVICE_MODULES = { StarkvindController: './devices/starkvind.js?v=52995530e4', HobController: './devices/hob.js?v=52995530e4', DishwasherController: './devices/dishwasher.js?v=52995530e4', FinsmakareController: './devices/finsmakare.js?v=52995530e4', OvenController: './devices/oven.js?v=52995530e4', HoodController: './devices/hood.js?v=52995530e4',
  MicrowaveController: './devices/microwave.js?v=52995530e4', DeskController: './devices/desk.js?v=52995530e4' };

const $ = id => document.getElementById(id);
const TRACE_DT = 1 / 60;
const HOVER_TINT = new THREE.Color().setRGB(1, 0.78, 0.1, THREE.SRGBColorSpace), HOVER_STRENGTH = 0.45;
const ORBIT_SPEED = 0.2, PAN_SPEED = 0.0015, CAM_MIN = 0.2, CAM_MAX = 4;      // TwinInteractor
const ZOOM_STEP = 0.15, ZOOM_SHARPNESS = 14;                                    // ZoomInput

export async function runTwin(dir, entry) {
  const tw = await (await fetch(asset(dir + '/twin.json'))).json();
  if (tw.format !== 'ikea-lab-twin') throw new Error('not a twin export: ' + tw.format);
  const deviceComp = tw.components.find(c => DEVICE_MODULES[c.type]) || tw.components.find(c => /Controller$/.test(c.type));
  if (!deviceComp || !DEVICE_MODULES[deviceComp.type]) throw new Error(`${tw.product.name}: no web port of ${deviceComp?.type || 'its controller'} yet`);
  await import(DEVICE_MODULES[deviceComp.type]);
  const gltf = await new GLTFLoader().loadAsync(asset(dir + '/' + (tw.model || 'model.glb')));
  document.title = `${tw.product.name} - IKEA Product Lab`;

  // ---------------- stage ----------------
  const { renderer, scene, fitShadow, stageMat } = createStage($('view'), tw.stage.background);
  scene.add(gltf.scene);
  if (tw.stage.floor) {
    const f = tw.stage.floor;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(f.size[0], f.size[2]), stageMat(f.color));
    m.rotation.x = -Math.PI / 2; m.position.set(...f.center); m.receiveShadow = true; scene.add(m);
  }

  // ---------------- nodes ----------------
  const byUid = {}, uidPath = {};
  gltf.scene.traverse(o => { if ('uid' in o.userData) byUid[o.userData.uid] = o; if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  for (const n of tw.nodes) uidPath[n.uid] = n.path;
  if (tw.placement && byUid[0]) {   // "both": the twin replaces the finished assembly at its final pose (SwitchToTwin)
    byUid[0].position.set(...tw.placement.position); byUid[0].quaternion.set(...tw.placement.rotation);
  }
  const pathNode = {}; for (const n of tw.nodes) pathNode[n.path] = byUid[n.uid];
  for (const o of Object.values(byUid)) {
    if (o.userData.active === false) o.visible = false;
    if (o.userData.rendererEnabled === false) for (const m of ownMeshes(o)) { m.material = m.material.clone(); m.material.visible = false; }
  }
  { const b = new THREE.Box3().setFromObject(gltf.scene).expandByScalar(0.8); fitShadow(b.getCenter(new THREE.Vector3()), b.getSize(new THREE.Vector3()).length() / 2); }

  // ---------------- text, device + controls ----------------
  const labels = new Map();   // node -> TextLabel
  for (const t of tw.texts || []) { const node = byUid[t.node]; if (node) labels.set(node, new TextLabel(node, t)); }
  // prefab lights (oven / dishwasher interior): Unity range -> distance; intensity is a look match, not physical
  const lights = new Map();   // node -> THREE light
  for (const l of tw.lights || []) {
    const node = byUid[l.node]; if (!node) continue;
    const col = srgb(l.color), I = l.intensity * 0.6;
    const L = l.type === 'Spot' ? new THREE.SpotLight(col, I, l.range, l.spotAngle * DEG / 2, 0.4, 1)
      : l.type === 'Directional' ? new THREE.DirectionalLight(col, I) : new THREE.PointLight(col, I, l.range, 1);
    if (L.isSpotLight) { L.target.position.set(0, 0, 1); L.add(L.target); }   // Unity spot shines along local +Z
    L.visible = l.enabled !== false; node.add(L); lights.set(node, L);
  }
  const controlByNode = (ref, type) => { const n = ref && ref.node != null ? byUid[ref.node] : null; return n ? controls.find(c => c.node === n && (!type || c.type === type)) || null : null; };
  const ctx = { node: ref => ref && ref.node != null ? byUid[ref.node] : null, byUid, time: 0, help: tw.help, muted: false,
    text: ref => { const n = ref && ref.node != null ? byUid[ref.node] : null; return n ? labels.get(n) || null : null; },
    control: (ref, type) => controlByNode(ref, type),
    light: ref => { const n = ref && ref.node != null ? byUid[ref.node] : null; return n ? lights.get(n) || null : null; } };
  const device = new deviceTypes[deviceComp.type](ctx, deviceComp.fields);
  const controls = [], controlOf = new Map();   // node -> first clickable control on it (GetComponentInParent order)
  for (const c of tw.components) {
    const Cls = controlTypes[c.type]; if (!Cls || c === deviceComp) continue;
    const node = byUid[c.node]; if (!node) continue;
    const ctl = new Cls(node, c.fields, device); ctl.type = c.type; controls.push(ctl);
    if (!controlOf.has(node) && (ctl.onClicked || ctl.onClickedAt)) controlOf.set(node, ctl);
  }
  device.init?.();                      // after all controls exist (Unity: every Awake has run) - resolve control references here
  for (const c of controls) c.start?.();
  const clickableOf = o => { for (let n = o; n; n = n.parent) if (controlOf.has(n)) return controlOf.get(n); return null; };

  // click areas = the exported colliders (Unity raycasts colliders only: plain geometry never blocks a click)
  const pickables = [], hidden = new THREE.MeshBasicMaterial({ visible: false });
  for (const c of tw.colliders) {
    const node = byUid[c.node]; if (!node || c.enabled === false) continue;
    let geo = null;
    if (c.type === 'box') geo = new THREE.BoxGeometry(...c.size);
    else if (c.type === 'sphere') geo = new THREE.SphereGeometry(c.radius, 12, 8);
    else if (c.type === 'capsule') geo = new THREE.CapsuleGeometry(c.radius, Math.max(0, c.height - 2 * c.radius), 4, 8);
    if (geo) {
      const m = new THREE.Mesh(geo, hidden); m.position.set(-c.center[0], c.center[1], c.center[2]);
      if (c.type === 'capsule' && c.direction !== 1) m.rotation[c.direction === 0 ? 'z' : 'x'] = Math.PI / 2;
      m.userData.collider = node; m.castShadow = m.receiveShadow = false; node.add(m); pickables.push(m);
    } else for (const mm of ownMeshes(node)) { mm.userData.collider = node; pickables.push(mm); }
  }

  // ---------------- camera (TwinInteractor.Configure) ----------------
  const camera = new THREE.PerspectiveCamera(tw.camera?.fovDeg || 60, 1, 0.02, 100);
  const orbit = { target: new THREE.Vector3(), distance: 1, yaw: 0, pitch: 0, zoomTarget: -1 };
  function resetCamera() {
    orbit.target.set(...(tw.camera?.target || [0, 1.1, 0])); orbit.zoomTarget = -1;
    const o = new THREE.Vector3(...(tw.camera?.position || [0, 1.2, 0.9])).sub(orbit.target);
    orbit.distance = o.length(); orbit.pitch = Math.asin(o.y / orbit.distance) / DEG; orbit.yaw = Math.atan2(o.x, o.z) / DEG;
  }
  resetCamera();
  // narrow (portrait) screens: step back so the device keeps the width it has on a desktop screen (up to 2.8x)
  const PORTRAIT_REF = 1.25;
  const fitScale = () => clamp(PORTRAIT_REF / Math.max(camera.aspect, 0.1), 1, 2.3);
  function placeCamera() {
    const p = orbit.pitch * DEG, y = orbit.yaw * DEG;
    camera.position.set(Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)).multiplyScalar(orbit.distance * fitScale()).add(orbit.target);
    camera.lookAt(orbit.target);
  }
  const zoomBy = notches => {
    if (orbit.zoomTarget < 0) orbit.zoomTarget = orbit.distance;
    orbit.zoomTarget = clamp(orbit.zoomTarget * Math.pow(1 - ZOOM_STEP, clamp(notches, -6, 6)), CAM_MIN, CAM_MAX);
  };
  function pan(dx, dy) {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const d = orbit.distance * fitScale();
    orbit.target.addScaledVector(right, -dx * PAN_SPEED * d).addScaledVector(up, dy * PAN_SPEED * d);
  }

  // ---------------- interactor (TwinInteractor) ----------------
  const el = renderer.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hovered = null, hoveredMeshes = [], held = null, heldTime = 0, heldPointer = null, lastPointer = null;
  let pinned = null, pinnedActive = false;   // Shift+click pins a key (ITwinPinnable) for a two-key press
  const pointers = new Map(); let drag = null, pinch = null;
  function hitAt(x, y) {
    const r = el.getBoundingClientRect();
    ndc.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (!hit) return null;
    const node = hit.object.userData.collider, ctl = clickableOf(node);
    return ctl ? { ctl, node, point: hit.point } : null;
  }
  function setHover(h) {
    const ctl = h?.ctl || null;
    if (ctl === hovered) return;
    for (const m of hoveredMeshes) if (m.userData.preHover) { m.material.color.copy(m.userData.preHover); delete m.userData.preHover; }
    hovered = ctl; hoveredMeshes = [];
    if (!ctl) return;
    // Unity tints the hit collider's renderer, else the clickable's first child renderer
    let ms = ownMeshes(h.node); if (!ms.length) { const first = []; ctl.node.traverse(o => { if (o.isMesh && !o.userData.collider && !first.length) first.push(o); }); ms = first; }
    for (const m of ms) {
      if (!m.userData.ownHover) { m.material = m.material.clone(); m.userData.ownHover = true; }
      m.userData.preHover = m.material.color.clone(); hoveredMeshes.push(m);
    }
  }
  function applyHoverTint() {   // after the device has written its colours this frame
    for (const m of hoveredMeshes) { m.userData.preHover.copy(m.material.color); m.material.color.lerp(HOVER_TINT, HOVER_STRENGTH); }
  }
  function undoHoverTint() { for (const m of hoveredMeshes) if (m.userData.preHover) m.material.color.copy(m.userData.preHover); }

  function unpin() { pinned?.setPinned?.(false); pinned = null; pinnedActive = false; }
  function press(h, shift) {
    if (shift && h.ctl.setPinned && h.ctl.onHold) {   // pin / unpin: no press is sent yet
      const same = pinned === h.ctl; unpin(); if (!same) { pinned = h.ctl; pinned.setPinned(true); }
      return;
    }
    // a pinned key is pressed in the same frame as the key being held now
    if (pinned && h.ctl.onHold && pinned !== h.ctl) { pinned.onClicked(); pinnedActive = true; }
    if (h.ctl.onClickedAt) h.ctl.onClickedAt(h.point); else h.ctl.onClicked?.();
    held = h.ctl.onHold ? h.ctl : null; heldTime = 0;
  }
  function release() {
    if (held) { held.onRelease?.(); held = null; }
    if (pinnedActive) { pinned.onRelease?.(); unpin(); }
    heldPointer = null;
  }

  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    if (modal.isOpen) return;
    el.focus(); try { el.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { release(); drag = null; pinch = pinchState(); return; }
    const h = e.button === 0 ? hitAt(e.clientX, e.clientY) : null;
    if (h) { setHover(h); press(h, e.shiftKey); heldPointer = e.pointerId; drag = null; return; }
    drag = { x: e.clientX, y: e.clientY, mode: e.button === 1 || (e.button === 0 && e.shiftKey) ? 'pan' : 'orbit' };
  });
  el.addEventListener('pointermove', e => {
    lastPointer = { x: e.clientX, y: e.clientY, type: e.pointerType };
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const n = pinchState();
      if (n.d > 0 && pinch.d > 0) zoomBy(Math.log(n.d / pinch.d) / -Math.log(1 - ZOOM_STEP));
      pan(n.x - pinch.x, n.y - pinch.y); pinch = n; return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'orbit') { orbit.yaw -= dx * ORBIT_SPEED; orbit.pitch = clamp(orbit.pitch + dy * ORBIT_SPEED, -85, 89); } else pan(dx, dy);
      return;
    }
    if (held == null && e.pointerType === 'mouse') setHover(hitAt(e.clientX, e.clientY));   // a held control stays held (desk handset)
  });
  const endPointer = e => {
    if (!pointers.delete(e.pointerId)) return;
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (e.pointerId === heldPointer) release();
    drag = null;
    if (e.pointerType !== 'mouse') setHover(null);
  };
  el.addEventListener('pointerup', endPointer); el.addEventListener('pointercancel', endPointer);
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !held) { setHover(null); lastPointer = null; } });
  function pinchState() { const [a, b] = [...pointers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  let wheelAcc = 0;
  el.addEventListener('wheel', e => {
    e.preventDefault(); if (modal.isOpen) return;
    const notches = -(e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100);
    const h = hitAt(e.clientX, e.clientY);
    if (h?.ctl.onScroll) {   // one turn per wheel notch (trackpads send many small events)
      wheelAcc += notches;
      while (Math.abs(wheelAcc) >= 1) { const d = Math.sign(wheelAcc); h.ctl.onScroll(d); wheelAcc -= d; }
    } else { wheelAcc = 0; zoomBy(notches); }
  }, { passive: false });

  // ---------------- UI (TwinUI) ----------------
  const pages = (tw.manualPages || []).map(p => ({ name: p.name, src: asset(dir + '/' + p.file) }));
  const ui = new TaskUI(tw, device, ctx, pages);
  $('twinHeader').textContent = `${(tw.product.name || 'DEVICE').toUpperCase()}  ·  DIGITAL TWIN`;
  $('help').innerHTML = richText(tw.help || '') + ' &nbsp; <b>M</b> manual &nbsp; <b>T</b> text &nbsp; <b>PgUp/PgDn</b> pages &nbsp; <b>Esc</b> menu &nbsp; <b>F8</b> report';
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || modal.isOpen || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'm' || e.key === 'M') { ui.toggleManual(); e.preventDefault(); }
    else if (e.key === 'PageDown') { ui.flip(1); e.preventDefault(); }
    else if (e.key === 'PageUp') { ui.flip(-1); e.preventDefault(); }
    else if (e.key === 't' || e.key === 'T') { toggleText(); e.preventDefault(); }
  });
  // status + task text on / off (shared with the step panel's setting)
  const textBtn = $('twinTextBtn');
  function refreshCompact() {
    const c = settings.compactPanel; $('twinPanel').classList.toggle('compact', c);
    textBtn.textContent = c ? '▼' : '▲'; textBtn.title = c ? 'Show status and task text (T)' : 'Hide status and task text (T)'; textBtn.setAttribute('aria-label', textBtn.title);
  }
  const toggleText = () => settings.set('compactPanel', !settings.compactPanel);
  textBtn.addEventListener('click', () => { toggleText(); textBtn.blur(); });
  settings.on(k => { if (k === 'compactPanel') refreshCompact(); }); refreshCompact();

  // ---------------- frame ----------------
  // portrait: shift the picture so the device sits in the middle of the free area under the panel (ray picking uses
  // the same projection, so clicks still hit)
  let viewShift = 0;
  function centreBelowPanel() {
    const r = $('twinPanel').getBoundingClientRect();
    const s = camera.aspect < 1 && r.height > 0 ? Math.round(r.bottom / 2) : 0;
    if (s === viewShift) return;
    viewShift = s;
    if (s) camera.setViewOffset(innerWidth, innerHeight, 0, -s, innerWidth, innerHeight); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function resize() { viewShift = -1; renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  const clock = new THREE.Clock();
  let trace = null;
  /** One frame in Unity's order: input (trace runner) -> controls -> device -> UI -> record. */
  function step(dt, render) {
    dt = Math.fround(dt);                 // Unity's Time.deltaTime is a float (1/60 -> 0.016666668)
    ctx.time += dt;
    if (trace) trace.pre();
    else if (held) { heldTime += dt; held.onHold(heldTime); if (pinnedActive) pinned.onHold?.(heldTime); }
    undoHoverTint();
    for (const c of controls) c.update?.(dt);
    device.update(dt);
    ui.update(dt);
    if (trace) trace.late();
    if (!render) return;
    applyHoverTint();
    if (orbit.zoomTarget > 0) {
      orbit.distance = THREE.MathUtils.lerp(orbit.distance, orbit.zoomTarget, 1 - Math.exp(-ZOOM_SHARPNESS * Math.min(dt, 0.05)));
      if (Math.abs(orbit.distance - orbit.zoomTarget) < 5e-4) { orbit.distance = orbit.zoomTarget; orbit.zoomTarget = -1; }
    }
    placeCamera(); centreBelowPanel();
    const tip = $('tip'), show = hovered && lastPointer?.type === 'mouse' && !modal.isOpen;
    tip.classList.toggle('hidden', !show);
    if (show) { tip.textContent = hovered.label; tip.style.transform = `translate(${lastPointer.x + 18}px, ${lastPointer.y + 12}px)`; }
    renderer.render(scene, camera);
  }
  function tick(fixedDt) {
    let dt = fixedDt ?? Math.min(clock.getDelta(), 0.1);
    if (modal.isOpen) dt = 0;
    step(dt, true);
  }
  function frame() { tick(); requestAnimationFrame(frame); }

  /** Replays a parity script (TwinTraceRunner semantics) synchronously; returns the records. */
  function runTrace(script, opts = {}) {
    const steps = script.steps, records = [];
    const find = p => p ? pathNode[p] : byUid[0];
    let cur = -1, frameNo = 0, pressFrames = 0, waitFrames = 0, heldT = 0, pressed = null, pinnedK = null, releaseNext = false, completes = false, beginNext = true, done = false;
    const begin = s => {
      switch (s.op) {
        case 'click': case 'hold': {
          const node = find(s.node), c = node ? clickableOf(node) : null;
          if (!c) { console.warn('[trace] no clickable at', s.node); completes = true; break; }
          pressFrames = s.op === 'click' ? 1 : Math.max(1, Math.ceil(s.seconds / TRACE_DT - 1e-4));
          if (c.onClickedAt) c.onClickedAt(node.getWorldPosition(new THREE.Vector3())); else c.onClicked();
          pressed = c; heldT = Math.fround(TRACE_DT); c.onHold?.(heldT);
          if (--pressFrames <= 0) releaseNext = true;
          break;
        }
        case 'chord': {   // pinned key (Shift+click) + held key, pressed / held / released together
          const p = find(s.pin) ? clickableOf(find(s.pin)) : null, k = find(s.node) ? clickableOf(find(s.node)) : null;
          if (!p || !k) { console.warn('[trace] chord needs two clickables', s.pin, s.node); completes = true; break; }
          p.setPinned?.(true);
          pressFrames = Math.max(1, Math.ceil(s.seconds / TRACE_DT - 1e-4));
          p.onClicked(); k.onClicked();
          pressed = k; pinnedK = p; heldT = Math.fround(TRACE_DT); k.onHold?.(heldT); p.onHold?.(heldT);
          if (--pressFrames <= 0) releaseNext = true;
          break;
        }
        case 'scroll': { const node = find(s.node), c = node ? clickableOfScroll(node) : null; if (c) c.onScroll(s.dir || 1); else console.warn('[trace] nothing scrollable at', s.node); completes = true; break; }
        case 'control': device.onControl(s.control); completes = true; break;
        case 'wait': waitFrames = Math.max(1, Math.round(s.seconds / TRACE_DT)); if (--waitFrames === 0) completes = true; break;
        default: console.warn('[trace] unknown op', s.op); completes = true;
      }
    };
    trace = {
      pre() {
        frameNo++;
        if (beginNext) { beginNext = false; if (++cur >= steps.length) { done = true; return; } begin(steps[cur]); return; }
        if (releaseNext) { pressed?.onRelease?.(); pinnedK?.onRelease?.(); pinnedK?.setPinned?.(false); pressed = pinnedK = null; releaseNext = false; completes = true; return; }
        if (pressed) { heldT = Math.fround(heldT + Math.fround(TRACE_DT)); pressed.onHold?.(heldT); pinnedK?.onHold?.(heldT); if (--pressFrames <= 0) releaseNext = true; return; }
        if (waitFrames > 0 && --waitFrames === 0) completes = true;
      },
      late() {
        if (!completes || done) return;
        completes = false; beginNext = true;
        const s = steps[cur];
        const texts = {}; for (const [node, l] of labels) texts[uidPath[node.userData.uid]] = l.shown;
        records.push({ step: cur, op: s.op, target: s.node ?? s.control ?? '', frame: frameNo, states: Object.fromEntries(device.states), lastEvent: device.lastEvent, texts, task: ui.taskIndex });
      },
    };
    ctx.muted = true; ctx.tracing = true;
    if (opts.time1 != null) ctx.time = opts.time1 - Math.fround(TRACE_DT);   // Unity's Time.time at the first trace frame (blinking)
    try { for (let i = 0; i < 1e6 && !done; i++) step(TRACE_DT, false); }
    finally { trace = null; ctx.muted = false; ctx.tracing = false; }
    return { dt: TRACE_DT, records };
  }
  function clickableOfScroll(o) { for (let n = o; n; n = n.parent) for (const c of controls) if (c.node === n && c.onScroll) return c; return null; }

  hideLoading();
  $('twinPanel').classList.remove('hidden'); $('help').classList.remove('hidden');
  const f3 = v => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
  attachScenario({
    product: { id: tw.product.id, name: tw.product.name }, mode: entry?.mode || 'twin',
    pause: () => {},
    restart: () => location.reload(),
    capture: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/jpeg', 0.85); },
    camera: () => `pos ${f3(camera.position)} target ${f3(orbit.target)} (glTF coordinates)`,
    where: () => [device.where, ui.where].filter(Boolean).join('  ·  '),
    state: () => {
      const out = [...device.states].map(([key, value]) => ({ key, value }));
      out.push({ key: 'lastEvent', value: device.lastEvent });
      for (const [key, value] of device.addState ? (() => { const l = []; device.addState(l); return l; })() : []) out.push({ key, value: String(value) });
      for (const [key, value] of ui.issueState()) out.push({ key, value: String(value) });
      return out;
    },
  });
  window.twin = { tw, device, controls, camera, orbit, tick, runTrace, ui, get hovered() { return hovered?.label ?? null; },
    get states() { return Object.fromEntries(device.states); }, node: p => pathNode[p],
    hit: (x, y) => { const h = hitAt(x, y); return h ? h.ctl.label : null; } };
  // ?parity=1: replay parity_script.json, compare with Unity's _unity_trace.json, report in the title (check_twin.py)
  if (new URLSearchParams(location.search).get('parity') === '1') {
    const [script, unity] = await Promise.all(['parity_script.json', '_unity_trace.json'].map(f => fetch(dir + '/' + f).then(r => r.json())));
    window.parityResult = compareTrace(unity, runTrace(script, { time1: unity.time1 }));
    document.title = 'PARITY ' + JSON.stringify(window.parityResult);
  }
  requestAnimationFrame(frame);
}

/** Unity trace vs web trace: frames, events and task index exact; numeric states within ±1 (float32 vs float64 rounding). */
export function compareTrace(unity, web, numericKeys = null) {
  const diffs = []; let maxNumeric = 0;
  const isNum = (k, a, b) => numericKeys ? numericKeys.includes(k) : /^-?\d+(\.\d+)?$/.test(a ?? '') && /^-?\d+(\.\d+)?$/.test(b ?? '');
  const n = Math.max(unity.records.length, web.records.length);
  for (let i = 0; i < n; i++) {
    const u = unity.records[i], w = web.records[i], at = u ? `#${i} ${u.op} ${u.target}` : `#${i}`;
    if (!u || !w) { diffs.push(`${at}: missing ${u ? 'web' : 'Unity'} record`); continue; }
    if (u.frame !== w.frame) diffs.push(`${at}: frame Unity ${u.frame} web ${w.frame}`);
    if (u.lastEvent !== w.lastEvent) diffs.push(`${at}: event Unity "${u.lastEvent}" web "${w.lastEvent}"`);
    if (u.task !== w.task) diffs.push(`${at}: task Unity ${u.task} web ${w.task}`);
    for (const k of new Set([...Object.keys(u.texts || {}), ...Object.keys(w.texts || {})]))   // displays must show the same text
      if ((u.texts || {})[k] !== (w.texts || {})[k]) diffs.push(`${at}: text ${k} Unity "${(u.texts || {})[k]}" web "${(w.texts || {})[k]}"`);
    for (const k of new Set([...Object.keys(u.states), ...Object.keys(w.states)])) {
      const a = u.states[k], b = w.states[k];
      if (isNum(k, a, b)) { const d = Math.abs(+a - +b); maxNumeric = Math.max(maxNumeric, d); if (d > 1) diffs.push(`${at}: ${k} Unity ${a} web ${b}`); }
      else if (a !== b) diffs.push(`${at}: ${k} Unity ${a} web ${b}`);
    }
  }
  return { ok: diffs.length === 0, records: [unity.records.length, web.records.length], maxNumeric, diffs: diffs.slice(0, 20), nDiffs: diffs.length };
}

/** Meshes that belong to a node itself (the node, or the primitives three.js adds under a multi-material node). */
function ownMeshes(node) {
  const out = [];
  node.traverse(o => { if (o.isMesh && !o.userData.collider && (o === node || (o.parent === node && !('uid' in o.userData)))) out.push(o); });
  return out;
}

// ---------------- guided tasks (TwinUI) ----------------
class TaskUI {
  constructor(tw, device, ctx, pages) {
    Object.assign(this, { device, ctx, pages, tasks: tw.tasks || [] });
    this.taskIndex = 0; this.taskStart = 0; this.allDone = false; this.doneAt = -1; this.events = new Set(); this.results = [];
    this.showManual = innerWidth > 760; this.pageIndex = 0;
    device.listeners.push(e => this.events.add(e));
    $('taskPrev').onclick = () => this.start(this.taskIndex - 1);
    $('taskSkip').onclick = () => { if (!this.allDone && this.doneAt < 0) { this.complete(true); this.start(this.taskIndex + 1); } };
    $('taskRestart').onclick = () => { this.results = []; this.start(0); };
    $('pagePrev').onclick = () => this.flip(-1); $('pageNext').onclick = () => this.flip(1);
    for (const b of ['taskPrev', 'taskSkip', 'taskRestart', 'pagePrev', 'pageNext']) $(b).addEventListener('click', e => e.currentTarget.blur());
    this.applyPage();
    this.start(0);
  }
  get time() { return this.ctx.time; }
  start(i) {
    this.taskIndex = clamp(i, 0, this.tasks.length);
    this.allDone = this.tasks.length > 0 && this.taskIndex >= this.tasks.length; this.doneAt = -1;
    this.taskStart = this.time; this.events.clear();
    this.refresh();
    const t = this.tasks[this.taskIndex];
    if (!this.allDone && t?.manualPage) this.showPage(t.manualPage);
  }
  satisfied(t) {
    if (!t.conditions?.length) return false;
    const num = s => { const f = parseFloat(s); return Number.isFinite(f) ? f : NaN; };
    for (const c of t.conditions) {
      const v = this.device.getState(c.key), want = c.value ?? '';
      let ok;
      switch ((c.op || 'equals').toLowerCase()) {
        case 'notequals': ok = v.toLowerCase() !== want.toLowerCase(); break;
        case 'atleast': ok = num(v) >= num(want); break;
        case 'atmost': ok = num(v) <= num(want); break;
        case 'contains': ok = v.toLowerCase().includes(want.toLowerCase()); break;
        case 'event': ok = this.events.has(want); break;
        default: ok = v.toLowerCase() === want.toLowerCase();
      }
      if (!ok) return false;
    }
    return true;
  }
  complete(skipped) {
    const secs = this.time - this.taskStart;
    this.results.push(`${this.taskIndex + 1}:${skipped ? 'skipped' : secs.toFixed(1) + 's'}`);
    this.doneAt = this.time;
    $('taskResult').innerHTML = skipped ? 'Skipped' : `Done in ${fmt0(secs)} s`;
  }
  refresh() {
    $('taskBox').classList.toggle('hidden', !this.tasks.length);
    if (!this.tasks.length) return;
    $('taskFill').style.width = (Math.min(this.taskIndex, this.tasks.length) / this.tasks.length * 100) + '%';
    $('taskPrev').disabled = this.taskIndex <= 0;
    if (this.allDone) {
      $('taskHeader').textContent = `ALL ${this.tasks.length} TASKS DONE`; $('taskTitle').textContent = 'Well done!';
      $('taskText').innerHTML = 'Results: ' + this.results.join('&nbsp;&nbsp; ') + '<br><br>Press <b>Restart</b> to try again.';
      $('taskResult').textContent = ''; $('taskSkip').disabled = true; return;
    }
    const t = this.tasks[this.taskIndex];
    $('taskHeader').textContent = `TASK ${this.taskIndex + 1} OF ${this.tasks.length}`;
    $('taskTitle').textContent = t.title; $('taskText').innerHTML = richText(t.text); $('taskResult').textContent = ''; $('taskSkip').disabled = false;
  }
  update() {
    $('twinStatus').innerHTML = richText(this.device.statusText);
    if (this.tasks.length && !this.allDone) {
      if (this.doneAt < 0 && this.satisfied(this.tasks[this.taskIndex])) { this.complete(false); this.chime(); }
      if (this.doneAt >= 0 && this.time - this.doneAt > 1.4) this.start(this.taskIndex + 1);
    }
  }
  chime() {
    if (this.ctx.muted) return;
    this.device.beep(880, 0.18, 0.3); setTimeout(() => this.device.beep(1318.5, 0.3, 0.3), 180);
  }
  // manual pages
  showPage(name) { const i = this.pages.findIndex(p => p.name === name); if (i >= 0) { this.pageIndex = i; this.applyPage(); } }
  flip(d) { if (!this.pages.length) return; this.pageIndex = (this.pageIndex + d + this.pages.length) % this.pages.length; this.applyPage(); }
  toggleManual() { this.showManual = !this.showManual; this.applyPage(); }
  applyPage() {
    const has = this.pages.length > 0;
    $('page').classList.toggle('hidden', !(has && this.showManual));
    $('pageNav').classList.toggle('hidden', !has);
    if (!has) return;
    const p = this.pages[this.pageIndex]; if ($('pageImg').getAttribute('src') !== p.src) $('pageImg').src = p.src;
    $('pageLabel').textContent = `Manual  ${this.pageIndex + 1}/${this.pages.length}`;
  }
  get where() { return !this.tasks.length ? '' : this.allDone ? 'all tasks done' : `task ${this.taskIndex + 1}/${this.tasks.length} · ${this.tasks[this.taskIndex].title}`; }
  issueState() {
    if (!this.tasks.length) return [];
    return [['task', this.allDone ? 'done' : this.taskIndex + 1], ['taskSeconds', (this.time - this.taskStart).toFixed(1)], ['taskResults', this.results.join(' ')]];
  }
}
