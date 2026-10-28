// IKEA Product Lab - web assembly player (three.js), data-driven from <FOLDER>/scenario.json + model.glb.
// Port of the Unity runtime: AssemblyPlayer (transport), AssemblyUI (panel), AssemblyFocus (auto camera, glow,
// callouts, click-to-identify, x-ray), OrbitCamera + ZoomInput. Menus and settings: menu.js / settings.js. Format: README.md.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createStage, srgb } from './stage.js?v=1b3df3769f';
import { settings, speedLabel, SPEEDS, asset, BASE_RATE } from './settings.js?v=1b3df3769f';
import { buildShell, loadIndex, showMenu, showProducts, showLoading, hideLoading, attachScenario, modal } from './menu.js?v=1b3df3769f';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = v => clamp(v, 0, 1);
const DEG = Math.PI / 180;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- tuning (AssemblyFocus / OrbitCamera defaults) ----------------
const FRAME_STEP = 1 / 30;
const HIGHLIGHT = [1, 0.72, 0], GLOW = 2.2;
const XRAY_MAX_RADIUS = 0.08, BIG_XRAY_ALPHA = 0.3;
const FRAMING = 1.25, SMOOTH_TIME = 0.55, FRAME_MIN = 0.45, FRAME_MAX = 3.6, SELECT_MIN = 0.22;
const ORBIT_SPEED = 0.25, PAN_SPEED = 0.0015, CAM_MIN = 0.35, CAM_MAX = 6;
const ZOOM_STEP = 0.15, ZOOM_SHARPNESS = 14;

const params = new URLSearchParams(location.search);
const folder = params.get('p');
buildShell();
const index = await loadIndex();
if (!folder) { hideLoading(); if (params.get('view') === 'products') showProducts(); else showMenu(); }
else {
  const entry = index.find(p => p.folder === folder);
  showLoading(entry?.name || folder);
  const useTwin = entry?.mode === 'twin' || (entry?.mode === 'both' && params.get('use') === '1');   // "both": the use phase
  if (useTwin) await import('./twin.js?v=1b3df3769f').then(m => m.runTwin(folder, entry)).catch(fail);              // digital twins
  else await run(folder, entry).catch(fail);
}

function fail(e) {
  console.error(e); hideLoading();
  const s = $('status'); s.classList.remove('hidden'); s.classList.add('error');
  s.innerHTML = `Could not load: ${esc(e.message || e)}<br><br><a href="player.html?view=products">‹ Products</a>`;
}

async function run(dir, entry) {
  const sc = await (await fetch(asset(dir + '/scenario.json'))).json();
  if (sc.format !== 'ikea-lab-assembly') throw new Error('not an assembly scenario: ' + sc.format);
  const gltf = await new GLTFLoader().loadAsync(asset(dir + '/' + (sc.model || 'model.glb')));
  document.title = `${sc.product.name} - IKEA Product Lab`;

  // ---------------- renderer / scene / stage ----------------
  const { renderer, scene, fitShadow, stageMat } = createStage($('view'), sc.stage.background);
  scene.add(gltf.scene);

  if (sc.stage.floor) {
    const f = sc.stage.floor.box;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(f.size[0], f.size[2]), stageMat(sc.stage.floor.color));
    m.rotation.x = -Math.PI / 2; m.position.set(f.center[0], f.center[1], f.center[2]); m.receiveShadow = true; scene.add(m);
  }
  const addBox = (b, color, cast) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...b.size), stageMat(color));
    m.position.set(...b.center); m.receiveShadow = true; m.castShadow = cast; scene.add(m);
  };
  if (sc.stage.kitMat) addBox(sc.stage.kitMat.box, sc.stage.kitMat.color, false);
  for (const o of sc.stage.obstacles || []) addBox(o.box, o.color, true);

  // ---------------- parts ----------------
  const nodes = {}; gltf.scene.traverse(o => { if (o.name && !nodes[o.name]) nodes[o.name] = o; });
  const parts = [], byName = {};
  for (const p of sc.parts) {
    const node = nodes[p.name];
    if (!node) { console.warn('part missing in model.glb:', p.name); continue; }
    const meshes = []; node.traverse(o => { if (o.isMesh) { meshes.push(o); o.castShadow = o.receiveShadow = true; o.userData.part = p.name; } });
    const tr = p.track;
    const part = { name: p.name, label: p.label || p.name, radius: p.radius ?? 1, installed: p.installed || [], node, meshes,
      t: Float64Array.from(tr.t), p: Float64Array.from(tr.p), q: Float64Array.from(tr.q), box: new THREE.Box3(), glowMats: null, ghosts: null };
    parts.push(part); byName[p.name] = part;
  }
  const pickables = parts.flatMap(p => p.meshes);
  const steps = sc.steps, S = steps.length;
  const total = sc.duration || (S ? steps[S - 1].start + steps[S - 1].duration : 0);
  const pages = Object.fromEntries((sc.manualPages || []).map(p => [p.name, asset(dir + '/' + p.file)]));

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  // Linear / slerp between keys. Two keys at the same time = jump at a step boundary: the later key wins, except when
  // showing the END of a step (preferEarlier), where the earlier one is that step's last pose.
  function applyPose(part, g, preferEarlier) {
    const ts = part.t; let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= g) lo = mid; else hi = mid - 1; }
    if (preferEarlier) while (lo > 0 && ts[lo - 1] === ts[lo] && Math.abs(ts[lo] - g) < 1e-4) lo--;
    const i = lo, j = Math.min(i + 1, ts.length - 1);
    const u = ts[j] > ts[i] ? clamp01((g - ts[i]) / (ts[j] - ts[i])) : 0;
    const P = part.p, Q = part.q, n = part.node;
    n.position.set(P[3*i] + (P[3*j] - P[3*i]) * u, P[3*i+1] + (P[3*j+1] - P[3*i+1]) * u, P[3*i+2] + (P[3*j+2] - P[3*i+2]) * u);
    qa.set(Q[4*i], Q[4*i+1], Q[4*i+2], Q[4*i+3]); qb.set(Q[4*j], Q[4*j+1], Q[4*j+2], Q[4*j+3]);
    n.quaternion.copy(qa.slerp(qb, u)).normalize();   // keys are rounded in the JSON
  }
  const inRanges = (rs, g) => rs.some(r => g >= r[0] - 1e-4 && g <= r[1] + 1e-4);
  const partBox = part => part.box.makeEmpty().expandByObject(part.node);   // world AABB like Unity's renderer.bounds

  // kit area (nothing installed at t 0) and assembly anchor (centre of the finished product on the floor)
  for (const p of parts) applyPose(p, total, true);
  gltf.scene.updateMatrixWorld(true);
  const finalBox = new THREE.Box3(); for (const p of parts) if (inRanges(p.installed, total)) finalBox.union(partBox(p));
  const anchor = finalBox.isEmpty() ? new THREE.Vector3(...sc.camera.target) : finalBox.getCenter(new THREE.Vector3()).setY(0);
  for (const p of parts) applyPose(p, 0, false);
  gltf.scene.updateMatrixWorld(true);
  const kitBox = new THREE.Box3(); for (const p of parts) kitBox.union(partBox(p));
  kitBox.min.y = 0; kitBox.max.y = 0.2;

  // shadow camera covers the stage
  { const b = kitBox.clone().union(finalBox).expandByScalar(0.6); fitShadow(b.getCenter(new THREE.Vector3()), b.getSize(new THREE.Vector3()).length() / 2); }

  // ---------------- playback state (AssemblyPlayer) ----------------
  // speed / continuous / auto camera / x-ray live in settings (shared, persisted; Settings dialog in menu.js)
  if (params.has('continuous')) settings.set('continuous', params.get('continuous') === '1');
  const st = { chapter: 0, local: 0, playing: false, reversing: false, showPage: innerWidth > 760,
    selected: null, selFraming: false, userControlled: false };
  settings.on(key => {
    if (key === 'xray') visualsDirty = true;
    if (key === 'autoCamera') st.userControlled = false;
  });
  const dur = c => c >= 1 ? steps[c - 1].duration : 0;
  const start = c => c >= 1 ? steps[c - 1].start : 0;
  const atEnd = () => st.chapter === 0 || st.local >= dur(st.chapter) - 1e-4;
  const globalTime = () => st.chapter === 0 ? 0 : start(st.chapter) + st.local;
  const currentStep = () => st.chapter === 0 ? 0 : (atEnd() ? st.chapter : st.chapter - 1);
  let stepDirty = true;

  function setChapter(c) { st.chapter = clamp(c, 0, S); st.local = 0; stepDirty = true; handBackToStep(); }
  const startForward = () => { st.reversing = false; st.playing = true; };
  const pause = () => { st.playing = false; st.reversing = false; };
  function play() { if (st.chapter === 0 || atEnd()) { next(); return; } st.reversing = false; st.playing = true; }
  function playReverse() {
    if (st.chapter === 0) return;
    if (st.local <= 1e-4) { if (st.chapter <= 1) return; setChapter(st.chapter - 1); st.local = dur(st.chapter); }
    st.reversing = true; st.playing = true;
  }
  function togglePlay() { if (st.playing) { pause(); return; } if (st.chapter > 0 && atEnd() && st.chapter === S) { replay(); return; } play(); }
  function next() {
    if (!S) return;
    if (st.chapter === 0) { setChapter(1); startForward(); return; }
    if (!atEnd()) { if (st.playing && !st.reversing) { pause(); st.local = dur(st.chapter); } else startForward(); return; }
    if (st.chapter < S) { setChapter(st.chapter + 1); startForward(); }
  }
  function previous() {
    if (st.chapter === 0) return;
    pause();
    if (st.local > 0.3) { st.local = 0; return; }
    setChapter(st.chapter - 1);
  }
  function replay() { if (st.chapter === 0) { next(); return; } st.local = 0; startForward(); }
  function restart() { pause(); setChapter(0); }
  function seekGlobal(g) {
    if (!S) return;
    g = clamp(g, 0, total);
    let c = 1; while (c < S && g >= start(c) + dur(c)) c++;
    if (c !== st.chapter) setChapter(c);
    st.local = clamp(g - start(c), 0, dur(c));
  }
  function stepFrame(dir) {
    if (!S) return;
    pause();
    if (st.chapter === 0) { if (dir < 0) return; setChapter(1); }
    let t = st.local + dir * FRAME_STEP;
    if (t > dur(st.chapter) + 1e-4 && st.chapter < S && atEnd()) { setChapter(st.chapter + 1); t = FRAME_STEP; }
    else if (t < -1e-4 && st.chapter > 1 && st.local <= 1e-4) { setChapter(st.chapter - 1); t = dur(st.chapter) - FRAME_STEP; }
    st.local = clamp(t, 0, dur(st.chapter));
  }
  function advance(dt) {
    if (!st.playing || st.chapter === 0) return;
    let t = st.local + dt * settings.speed * BASE_RATE * (st.reversing ? -1 : 1);
    const d = dur(st.chapter);
    if (!st.reversing && t >= d) {
      if (settings.continuous && st.chapter < S) { const over = t - d; setChapter(st.chapter + 1); t = Math.min(over, dur(st.chapter)); }
      else { t = d; st.playing = false; }
    } else if (st.reversing && t <= 0) {
      if (settings.continuous && st.chapter > 1) { const over = -t; setChapter(st.chapter - 1); t = Math.max(0, dur(st.chapter) - over); }
      else { t = 0; st.playing = false; st.reversing = false; }
    }
    st.local = t;
  }

  // ---------------- camera (OrbitCamera + ZoomInput) ----------------
  const camera = new THREE.PerspectiveCamera(sc.camera.fovDeg || 60, 1, 0.02, 100);
  const orbit = { target: new THREE.Vector3(...sc.camera.target), distance: 1, yaw: 0, pitch: 0, zoomBias: 1, zoomTarget: -1 };
  { const o = new THREE.Vector3(...sc.camera.position).sub(orbit.target);
    orbit.distance = o.length(); orbit.pitch = Math.asin(o.y / orbit.distance) / DEG; orbit.yaw = Math.atan2(o.x, o.z) / DEG; }
  const vel = { target: new THREE.Vector3(), dist: 0 };
  function placeCamera() {
    const p = orbit.pitch * DEG, y = orbit.yaw * DEG;
    camera.position.set(Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)).multiplyScalar(orbit.distance).add(orbit.target);
    camera.lookAt(orbit.target);
  }
  function handBackToStep() {   // step change / play: drop the clicked part and give the camera back to the step
    if (st.selected) select(null);
    st.selFraming = false; st.userControlled = false;
    vel.target.set(0, 0, 0); vel.dist = 0;
  }
  // Unity Mathf.SmoothDamp
  function smoothDamp(cur, target, v, smoothTime, dt) {
    smoothTime = Math.max(1e-4, smoothTime);
    const omega = 2 / smoothTime, x = omega * dt, exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = cur - target, temp = (v + omega * change) * dt;
    let nv = (v - omega * temp) * exp, out = target + (change + temp) * exp;
    if ((target - cur > 0) === (out > target)) { out = target; nv = dt > 0 ? (out - target) / dt : 0; }
    return [out, nv];
  }
  function dampVec(cur, target, v, dt) {
    for (const k of ['x', 'y', 'z']) { const [o, nv] = smoothDamp(cur[k], target[k], v[k], SMOOTH_TIME, dt); cur[k] = o; v[k] = nv; }
  }
  const zoomFactor = notches => Math.pow(1 - ZOOM_STEP, clamp(notches, -6, 6));
  const tanHalf = () => Math.tan(camera.fov * 0.5 * DEG);

  function updateCamera(dt, moveActive, glowBox) {
    let b = null, dist = 0;
    if (st.selFraming && st.userControlled) st.selFraming = false;
    if (!st.userControlled && st.selFraming && st.selected) {
      b = partBox(byName[st.selected]);
      const radius = Math.max(b.getSize(tmpV).length() / 2, 0.02);
      const fill = THREE.MathUtils.lerp(2.2, 1.2, clamp01((radius - 0.03) / 0.3));   // small parts: context; big: fill the view
      dist = clamp(radius * fill / tanHalf(), SELECT_MIN, FRAME_MAX);
      orbit.zoomBias = clamp(orbit.zoomBias, Math.min(SELECT_MIN, CAM_MIN) / dist, CAM_MAX / dist);
    } else if ((settings.autoCamera || st.selFraming) && !st.userControlled) {
      if (moveActive && glowBox) b = glowBox;
      else if (currentStep() === 0 && !st.playing) b = kitBox;
      else b = assemblyBox();
      const radius = Math.max(b.getSize(tmpV).length() / 2, 0.05);
      dist = clamp(radius * FRAMING / tanHalf(), FRAME_MIN, FRAME_MAX);
      orbit.zoomBias = clamp(orbit.zoomBias, CAM_MIN / dist, CAM_MAX / dist);   // no dead zone in the wheel
    }
    if (b) {
      orbit.zoomTarget = -1;   // the framing owns the distance; wheel = bias
      dampVec(orbit.target, b.getCenter(tmpC), vel.target, dt);
      [orbit.distance, vel.dist] = smoothDamp(orbit.distance, dist * orbit.zoomBias, vel.dist, SMOOTH_TIME, dt);
    } else if (orbit.zoomTarget > 0) {
      orbit.distance = THREE.MathUtils.lerp(orbit.distance, orbit.zoomTarget, 1 - Math.exp(-ZOOM_SHARPNESS * Math.min(dt, 0.05)));
      if (Math.abs(orbit.distance - orbit.zoomTarget) < 5e-4) { orbit.distance = orbit.zoomTarget; orbit.zoomTarget = -1; }
    }
    placeCamera();
    return !!b;
  }
  const tmpV = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const asmBox = new THREE.Box3();
  function assemblyBox() {
    asmBox.makeEmpty();
    const g = globalTime();
    for (const p of parts) if (inRanges(p.installed, g)) asmBox.union(partBox(p));
    if (asmBox.isEmpty()) asmBox.setFromCenterAndSize(anchor.clone().setY(0.4), new THREE.Vector3(0.8, 0.8, 0.8));
    return asmBox;
  }

  // ---------------- pointer: drag = orbit, middle / shift-drag = pan, wheel = zoom, click = identify ----------------
  const el = renderer.domElement, pointers = new Map();
  let drag = null, pinch = null;
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    el.focus(); el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = null; pinch = pinchState(); return; }
    drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false,
      mode: e.button === 1 || (e.button === 0 && e.shiftKey) ? 'pan' : 'orbit', click: e.button === 0 && !e.shiftKey };
  });
  el.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const n = pinchState();
      if (n.d > 0 && pinch.d > 0) wheelZoom(Math.log(n.d / pinch.d) / -Math.log(1 - ZOOM_STEP));
      pan(n.x - pinch.x, n.y - pinch.y);
      pinch = n; return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    if (!drag.moved) { drag.moved = true; st.userControlled = true; }
    if (drag.mode === 'orbit') { orbit.yaw -= dx * ORBIT_SPEED; orbit.pitch = clamp(orbit.pitch + dy * ORBIT_SPEED, -5, 85); }
    else pan(dx, dy);
  });
  const endPointer = e => {
    if (!pointers.delete(e.pointerId)) return;
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (drag && !drag.moved && drag.click && e.type === 'pointerup') select(pick(e.clientX, e.clientY));
    drag = null;
  };
  el.addEventListener('pointerup', endPointer); el.addEventListener('pointercancel', endPointer);
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  function pan(dx, dy) {
    st.userControlled = true;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    orbit.target.addScaledVector(right, -dx * PAN_SPEED * orbit.distance).addScaledVector(up, dy * PAN_SPEED * orbit.distance);
  }
  let lastFramed = false;
  function wheelZoom(notches) {   // positive = zoom in
    orbit.zoomBias = clamp(orbit.zoomBias * zoomFactor(notches), 0.15, 4);
    if (!lastFramed) {
      if (orbit.zoomTarget < 0) orbit.zoomTarget = orbit.distance;
      orbit.zoomTarget = clamp(orbit.zoomTarget * zoomFactor(notches), CAM_MIN, CAM_MAX);
      st.userControlled = true;
    }
  }
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const raw = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;   // -> notches
    if (Math.abs(raw) > 1e-3) wheelZoom(-raw);
  }, { passive: false });

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(x, y) {
    const r = el.getBoundingClientRect();
    ndc.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.part : null;
  }
  function select(name) {
    if (name === st.selected) { if (name) { st.selFraming = true; st.userControlled = false; } return; }
    st.selected = name;
    if (name) { $('selCallout').textContent = byName[name].label; st.selFraming = true; st.userControlled = false; }
    else st.selFraming = false;
    visualsDirty = true;
  }

  // ---------------- glow + x-ray (AssemblyFocus.RefreshVisuals) ----------------
  const glowColor = new THREE.Color(...HIGHLIGHT);
  const xrayMat = (alpha, rim) => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(1, 0.72, 0.05) }, alpha: { value: alpha }, rim: { value: rim } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float alpha; uniform float rim; varying vec3 vN; varying vec3 vV;
      void main(){ float r = 1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        gl_FragColor = vec4(color, clamp(alpha * (0.6 + rim * r * r), 0.0, 1.0));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth, side: THREE.FrontSide   // only where hidden
  });
  const xraySmall = xrayMat(0.5, 1.6), xrayBig = xrayMat(BIG_XRAY_ALPHA, 1.0);
  let visualsDirty = true, glowParts = new Set(), activeMove = null, activeMoveKey = '';
  const isSmall = p => p.radius <= XRAY_MAX_RADIUS;

  function setGlow(p, on) {
    for (const m of p.meshes) {
      if (on) {
        if (!m.userData.baseMat) m.userData.baseMat = m.material;
        if (!m.userData.glowMat) { m.userData.glowMat = m.material.clone(); m.userData.glowMat.emissive = glowColor.clone(); }
        m.material = m.userData.glowMat;
      } else if (m.userData.baseMat) m.material = m.userData.baseMat;
    }
  }
  function setGhost(p, mat) {
    if (!p.ghosts && mat) p.ghosts = p.meshes.map(m => { const g = new THREE.Mesh(m.geometry, mat); g.renderOrder = 10; g.raycast = () => {}; m.add(g); return g; });
    if (p.ghosts) for (const g of p.ghosts) { g.visible = !!mat; if (mat) g.material = mat; }
  }
  function refreshVisuals() {
    visualsDirty = false;
    const glow = new Set(activeMove ? (activeMove.rendererParts || activeMove.moving || activeMove.parts) : []);
    if (st.selected) glow.add(st.selected);
    const xset = new Set();
    if (settings.xray && st.selected && isSmall(byName[st.selected])) xset.add(st.selected);
    if (settings.xray && st.chapter > 0) {
      let focus = [];
      if (activeMove) focus = [...(activeMove.rendererParts || activeMove.parts)];
      else for (const m of steps[st.chapter - 1].moves) focus.push(...m.parts);
      focus = focus.filter(n => byName[n]);
      if (focus.length) {
        const zones = activeMove ? [new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...activeMove.target.center), new THREE.Vector3(...activeMove.target.size))]
                                 : focus.map(n => partBox(byName[n]).clone());
        for (const n of focus) if (isSmall(byName[n]) || activeMove) xset.add(n);   // big parts only while moving
        for (const p of parts) {
          if (xset.has(p.name) || !isSmall(p)) continue;
          const b = partBox(p);
          if (zones.some(z => z.clone().expandByScalar(0.01).intersectsBox(b))) xset.add(p.name);
        }
      }
    }
    for (const p of parts) {
      setGlow(p, glow.has(p.name));
      setGhost(p, xset.has(p.name) ? (isSmall(p) ? xraySmall : xrayBig) : null);
    }
    glowParts = glow;
  }

  // ---------------- UI (AssemblyUI) ----------------
  const ui = { panel: $('panel'), header: $('header'), title: $('title'), body: $('body'), page: $('page'), pageImg: $('pageImg'),
    fill: $('tl-fill'), stepMark: $('tl-step'), handle: $('tl-handle'), steptime: $('steptime'), total: $('total'),
    prev: $('prev'), rev: $('rev'), play: $('play'), next: $('next'), speed: $('speed'), pageBtn: $('pageBtn'),
    playIcon: $('playIcon'), callout: $('callout'), selCallout: $('selCallout') };
  const fmt = t => { t = Math.max(0, t) / BASE_RATE; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
  for (let c = 2; c <= S; c++) {
    const t = document.createElement('div'); t.className = 'tl-tick'; t.style.left = (start(c) / total * 100) + '%'; $('tl-ticks').appendChild(t);
  }
  function refreshStep() {
    stepDirty = false;
    const c = st.chapter, P = sc.product;
    ui.header.textContent = c === 0 ? `${P.name}  ·  PARTS` : `${P.name}  ·  STEP ${c} OF ${S}`;
    let pageName;
    if (c === 0) {
      ui.title.textContent = 'Unpack and check all parts';
      ui.body.innerHTML = (P.introText ? esc(P.introText) + '<br><br>' : '') + '<b>In the box:</b> ' + esc(P.partsSummary) + '<br><br>Press <b>Play</b> to start.';
      pageName = P.partsPage;
    } else {
      const s = steps[c - 1];
      ui.title.textContent = s.title; ui.body.textContent = s.text; pageName = s.manualPage;
    }
    const src = pages[pageName];
    if (src && !ui.pageImg.src.endsWith(src)) ui.pageImg.src = src;
    ui.page.classList.toggle('hidden', !(st.showPage && src));
    ui.pageBtn.textContent = st.showPage ? 'Hide page' : 'Show page';
    visualsDirty = true;
  }
  function refreshTransport() {
    const c = st.chapter;
    ui.playIcon.setAttribute('d', st.playing ? 'M4 3h3v10H4zM9 3h3v10H9z' : 'M4 3v10l9-5z');
    ui.rev.classList.toggle('on', st.reversing);
    ui.prev.disabled = c === 0;
    ui.rev.disabled = !(c > 1 || (c === 1 && st.local > 1e-4));
    ui.next.disabled = !S || (c === S && atEnd());
    const g = globalTime(), T = Math.max(total, 1e-3);
    ui.fill.style.width = (g / T * 100) + '%'; ui.handle.style.left = (g / T * 100) + '%';
    if (c > 0) {
      ui.stepMark.style.display = ''; ui.stepMark.style.left = (start(c) / T * 100) + '%'; ui.stepMark.style.width = (dur(c) / T * 100) + '%';
      ui.steptime.innerHTML = `<b>Step ${c}</b> &nbsp; ${fmt(st.local)} / ${fmt(dur(c))}`;
    } else { ui.stepMark.style.display = 'none'; ui.steptime.innerHTML = '<b>Parts</b>'; }
    ui.total.textContent = `Total ${fmt(g)} / ${fmt(total)}`;
    ui.speed.textContent = speedLabel(settings.speed);
    $('useBtn').classList.toggle('hidden', !canUse());
  }
  const toggleManual = () => { st.showPage = !st.showPage; stepDirty = true; };
  // step text on / off (the panel covers much of a phone screen); remembered in settings
  const textBtn = $('textBtn');
  function refreshCompact() {
    const c = settings.compactPanel; ui.panel.classList.toggle('compact', c);
    textBtn.textContent = c ? '▼' : '▲'; textBtn.title = c ? 'Show step text (T)' : 'Hide step text (T)'; textBtn.setAttribute('aria-label', textBtn.title);
  }
  const toggleText = () => settings.set('compactPanel', !settings.compactPanel);
  settings.on(k => { if (k === 'compactPanel') refreshCompact(); }); refreshCompact();
  const stepSpeed = d => settings.stepSpeed(d);
  const cycleSpeed = () => { const i = SPEEDS.findIndex(s => s > settings.speed + 1e-3); settings.set('speed', i >= 0 ? SPEEDS[i] : SPEEDS[0]); };
  const btn = (b, f) => b.addEventListener('click', () => { f(); b.blur(); });
  btn(ui.prev, previous); btn(ui.rev, () => st.reversing ? pause() : playReverse()); btn(ui.play, togglePlay); btn(ui.next, next);
  btn(ui.speed, cycleSpeed); btn(ui.pageBtn, toggleManual); btn(textBtn, toggleText);
  // "both" products: once the last step has finished, switch to the digital twin (AssemblyUI "Assembled - now use it")
  function canUse() { return entry?.mode === 'both' && st.chapter === S && atEnd(); }
  function useIt() { if (canUse()) location.href = `player.html?p=${encodeURIComponent(dir)}&use=1`; }
  btn($('useBtn'), useIt);

  // timeline scrubbing: pause while dragging, resume afterwards
  const tl = $('timeline'); let scrub = null;
  const scrubTo = e => { const r = tl.getBoundingClientRect(); seekGlobal(clamp01((e.clientX - r.left) / r.width) * total); };
  tl.addEventListener('pointerdown', e => { tl.setPointerCapture(e.pointerId); scrub = { fwd: st.playing && !st.reversing, rev: st.reversing }; pause(); scrubTo(e); });
  tl.addEventListener('pointermove', e => { if (scrub) scrubTo(e); });
  const endScrub = () => { if (!scrub) return; const s = scrub; scrub = null; if (s.fwd) play(); else if (s.rev) playReverse(); };
  tl.addEventListener('pointerup', endScrub); tl.addEventListener('pointercancel', endScrub);

  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || modal.isOpen) return;   // menus / forms take the keyboard
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    const k = e.key, handled = {
      ' ': togglePlay, ArrowRight: next, ArrowLeft: previous, j: playReverse, k: pause, l: play,
      ',': () => stepFrame(-1), '.': () => stepFrame(1), r: replay, Home: restart, '-': () => stepSpeed(-1), '=': () => stepSpeed(1), '+': () => stepSpeed(1),
      m: toggleManual, t: toggleText, c: () => settings.set('autoCamera', !settings.autoCamera), x: () => settings.set('xray', !settings.xray),
      f: () => { st.selFraming = true; st.userControlled = false; },
      u: useIt,
    }[k.length === 1 ? k.toLowerCase() : k];
    if (handled) { e.preventDefault(); handled(); }
  });

  // ---------------- frame loop ----------------
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  const clock = new THREE.Clock();
  let wasPlaying = false;
  const sp = new THREE.Vector3();
  function project(box, lift, elx, dy) {   // place a callout above a box; false if behind the camera
    sp.set((box.min.x + box.max.x) / 2, box.max.y + lift, (box.min.z + box.max.z) / 2).project(camera);
    if (sp.z > 1) return null;
    const x = (sp.x + 1) / 2 * innerWidth, y = (1 - sp.y) / 2 * innerHeight - dy;
    elx.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    return { x, y };
  }
  function frame() { tick(); requestAnimationFrame(frame); }
  function tick(fixedDt) {   // one frame; fixedDt for QA without requestAnimationFrame (hidden tab)
    let dt = fixedDt ?? Math.min(clock.getDelta(), 0.1);
    if (modal.isOpen) dt = 0;   // like Unity's timeScale 0 while the pause menu / a form is open
    const time = clock.elapsedTime;
    advance(dt);
    if (st.playing && !wasPlaying) handBackToStep();   // pressing play always returns to the step's view
    wasPlaying = st.playing;
    if (stepDirty) refreshStep();

    // poses
    const g = globalTime(), preferEarlier = st.chapter > 0 && st.chapter < S && atEnd();
    for (const p of parts) applyPose(p, g, preferEarlier);
    gltf.scene.updateMatrixWorld(true);

    // active move of the shown step
    let move = null;
    if (st.chapter > 0) for (const m of steps[st.chapter - 1].moves) if (inRanges(m.spans, g)) { move = m; break; }
    const key = move ? st.chapter + ':' + steps[st.chapter - 1].moves.indexOf(move) : '';
    if (key !== activeMoveKey) { activeMoveKey = key; activeMove = move; visualsDirty = true; if (move) ui.callout.textContent = move.label || autoLabel(move); }
    if (visualsDirty) refreshVisuals();

    // pulse
    const e = GLOW * (0.55 + 0.45 * Math.sin(time * 6)) * 0.5;
    for (const p of parts) if (glowParts.has(p.name)) for (const m of p.meshes) if (m.userData.glowMat) m.userData.glowMat.emissiveIntensity = e;

    // camera: moving parts + their target
    let litBox = null;
    if (activeMove) {
      litBox = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...activeMove.target.center), new THREE.Vector3(...activeMove.target.size));
      for (const n of (activeMove.rendererParts || activeMove.parts)) if (byName[n]) litBox.union(partBox(byName[n]));
    }
    lastFramed = updateCamera(dt, !!activeMove, litBox);
    camera.updateMatrixWorld();

    // callouts
    let mc = null;
    if (activeMove) {
      const b = new THREE.Box3(); for (const n of (activeMove.rendererParts || activeMove.parts)) if (byName[n]) b.union(partBox(byName[n]));
      if (!b.isEmpty()) mc = project(b, 0.02, ui.callout, 14);
    }
    ui.callout.classList.toggle('hidden', !mc);
    let sel = null;
    if (st.selected) {
      sel = project(partBox(byName[st.selected]), 0.01, ui.selCallout, 10);
      if (sel && mc && Math.abs(sel.y - mc.y) < 30 && Math.abs(sel.x - mc.x) < 160) project(partBox(byName[st.selected]), 0.01, ui.selCallout, 44);
    }
    ui.selCallout.classList.toggle('hidden', !sel);

    refreshTransport();
    renderer.render(scene, camera);
  }
  function autoLabel(m) {
    if (!m.parts?.length) return '';
    let n = m.parts[0]; const us = n.lastIndexOf('_');
    if (us > 0) { const suf = n.slice(us + 1); if (/^\d+$/.test(suf) || /^[A-Z]$/.test(suf)) n = n.slice(0, us); }
    n = n.replace(/_/g, ' ').toLowerCase();
    return m.parts.length > 1 ? `${m.parts.length}x ${n}` : n;
  }

  // ?t=<seconds> opens paused at that global time (QA / deep links)
  if (params.has('t')) { const t = parseFloat(params.get('t')); if (t > 0) seekGlobal(t); }
  hideLoading();
  for (const id of ['panel', 'help']) $(id).classList.remove('hidden');
  const f3 = v => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
  attachScenario({   // what the pause menu and the issue report need (AssemblyIssueContext)
    product: { id: sc.product.id, name: sc.product.name }, mode: entry?.mode || 'assembly',
    pause,
    restart: () => {
      restart(); select(null); st.userControlled = false;
      orbit.target.set(...sc.camera.target); orbit.zoomBias = 1; orbit.zoomTarget = -1;
      const o = new THREE.Vector3(...sc.camera.position).sub(orbit.target);
      orbit.distance = o.length(); orbit.pitch = Math.asin(o.y / orbit.distance) / DEG; orbit.yaw = Math.atan2(o.x, o.z) / DEG;
    },
    capture: () => { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/jpeg', 0.85); },
    camera: () => `pos ${f3(camera.position)} target ${f3(orbit.target)} (glTF coordinates)`,
    where: () => {
      if (st.chapter === 0) return 'parts overview';
      const s = steps[st.chapter - 1], parts = [`step ${st.chapter}/${S}`, s.title];
      const ph = phaseAt(globalTime()); if (ph) parts.push('phase ' + ph);
      return parts.join('  ·  ');
    },
    state: () => {
      const F = v => v.toFixed(3), s = steps[st.chapter - 1], out = [
        ['step', st.chapter], ['stepCount', S], ['stepTime', F(st.local)], ['stepDuration', F(dur(st.chapter))], ['globalTime', F(globalTime())],
        ['playback', st.playing ? (st.reversing ? 'reverse' : 'forward') : 'paused'], ['speed', settings.speed], ['phase', phaseAt(globalTime()) || ''],
      ];
      if (activeMove) out.push(['movingParts', (activeMove.rendererParts || activeMove.parts).join(', ')]);
      if (s?.manualPage) out.push(['manualPage', s.manualPage]);
      if (st.selected) out.push(['selectedPart', st.selected]);
      return out.map(([key, value]) => ({ key, value: String(value) }));
    },
  });
  function phaseAt(g) {
    for (const ph of activeMove?.phases || []) if (g >= ph[0] - 1e-4 && g <= ph[1] + 1e-4) return ph[2];
    return activeMove ? 'move' : 'idle';
  }
  window.player = { sc, st, parts, camera, orbit, tick, seekGlobal, play, pause, next, previous, select, get globalTime() { return globalTime(); },
    get activeMove() { return activeMove; }, get ghosts() { return parts.filter(p => p.ghosts?.some(g => g.visible)).map(p => p.name); }, get glow() { return [...glowParts]; } };
  requestAnimationFrame(frame);
}
