// Ray interaction in an XR session: each side's ray hovers / selects the step panel buttons and the parts.
// Selecting a part is the same as a mouse click on the desktop (host.select: glow + identify), its label shows on a
// small tag above the part. Hover = a wire box around the part / a highlighted panel button.
import * as THREE from 'three';
import { createPanel } from './panel.js?v=1724c84f69';
import { createPageView } from './pageview.js?v=1724c84f69';
import { xrPrefs } from './quality.js?v=1724c84f69';

const RAY_MAX = 8, YELLOW = 0xffd91a;

export function createInteraction(xs) {
  const { host } = xs, input = xs.input;
  const T = host.transport;
  const panel = createPanel(xs, { px: xrPrefs.preset.panelPx, actions: {
    prev: T.previous, restart: () => { T.restart(); host.select(null); },
    next: () => xs.mode2 === 'handson' ? xs.handsOn.nextStep() : T.next(),
    play: () => xs.mode2 === 'handson' ? xs.handsOn.skipMove() : T.togglePlay(),
    recenter: () => xs.recenter(), exit: () => xs.exit(),
    scale: () => xs.setScale(xs.scaleMode === 'table' ? 'room' : 'table'),
    mode: () => xs.setMode?.(xs.mode2 === 'handson' ? 'watch' : 'handson'),
    floor: () => xs.locomotion?.calibrate(),
    pin: () => xs.panelPin(!panel.pinned),
    help: () => {   // the first-time help card again, in front of the user
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(host.camera.quaternion);
      xs.intro?.open(host.camera.position.clone(), Math.atan2(-f.x, -f.z));
    },
    photo: () => { xs.mirror?.shot(); xs.panel?.flash('Photo saved to Downloads (PC)', '#2e7d32'); },
    page: () => view.visible && view.url && panel.pageFile && view.url.includes(panel.pageFile.split('/').pop()) ? view.hide() : view.open(panel.pageFile),
  } });
  xs.panel = panel;
  const view = createPageView(xs); xs.pageView = view;                   // the enlarged manual page (tap the page on the panel)

  const ray = new THREE.Raycaster(); ray.far = RAY_MAX;
  const lines = {}, dots = {};
  for (const side of ['left', 'right']) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    lines[side] = new THREE.Line(g, new THREE.LineBasicMaterial({ color: YELLOW, transparent: true, opacity: 0.8, depthTest: false }));
    dots[side] = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: YELLOW, depthTest: false }));
    lines[side].renderOrder = dots[side].renderOrder = 30; lines[side].frustumCulled = false;
    host.scene.add(lines[side], dots[side]);
  }
  const wire = new THREE.Box3Helper(new THREE.Box3(), YELLOW); wire.visible = false; host.scene.add(wire);
  const tag = makeTag(); host.scene.add(tag.sprite);
  const hover = { left: null, right: null };
  // Moving the panel like a window in the Meta OS. Ray: pinch / trigger on the panel (not on a button) and drag - it
  // rides on the ray, pulling the hand back brings it closer, pushing away sends it further. Direct: pinch / grip with
  // the hand on (or a few cm in front of) the panel - it moves with the hand. Either way it stays upright and turns to
  // face the user. Everything rig-local (real metres): the same in Room and Table, at any scene size.
  // Pin (panel button): pinned = stays where it was put; unpinned = follows the user (lazily, same place relative to the
  // head's heading).
  const drag = { left: null, right: null };
  const headLocal = () => host.camera.position.clone();                 // the XR camera's pose in the rig (= reference space)
  const handLocal = s => xs.rig.worldToLocal(s.grabPose.position.clone());
  // windows that move this way: the step panel and the enlarged page
  const windows = [{ obj: panel.mesh, size: () => panel.size, tilt: -0.15, on: () => true },
    { obj: view.group, size: () => view.size, tilt: 0, on: () => view.visible }];
  const winOf = obj => windows.find(w => w.obj === obj || (w.obj.isGroup && obj.parent === w.obj));
  function face(win, p) {
    const head = headLocal();
    win.obj.position.copy(p);
    win.obj.rotation.set(win.tilt, Math.atan2(head.x - p.x, head.z - p.z), 0, 'YXZ');
    win.obj.updateMatrixWorld(true);
  }
  function rayDragStart(side, s, h) {
    const hit = xs.rig.worldToLocal(h.point.clone()), hand = handLocal(s);
    drag[side] = { win: h.win, mode: 'ray', dist: hit.distanceTo(xs.rig.worldToLocal(s.rayOrigin.clone())), off: h.win.obj.position.clone().sub(hit),
      reach0: hand.distanceTo(headLocal()) };
  }
  function handDragStart(side, s, win) { drag[side] = { win, mode: 'hand', off: win.obj.position.clone().sub(handLocal(s)) }; }
  function dragUpdate(side, s) {
    const d = drag[side];
    if (d.mode === 'hand') { face(d.win, handLocal(s).add(d.off)); return; }
    const o = xs.rig.worldToLocal(s.rayOrigin.clone()), dir = xs.rig.worldToLocal(s.rayOrigin.clone().add(s.rayDirection)).sub(o).normalize();
    const dist = Math.max(0.25, d.dist + (handLocal(s).distanceTo(headLocal()) - d.reach0) * 4);   // push / pull, x4
    face(d.win, o.addScaledVector(dir, dist).add(d.off));
  }
  /** The window the hand pinches / grips on: within its rectangle and up to 6 cm in front of / behind it. */
  function handOnWindow(s) {
    return windows.find(win => {
      if (!win.on()) return false;
      const q = win.obj.worldToLocal(s.grabPose.position.clone()), { w, h } = win.size();
      return Math.abs(q.z) < 0.06 && Math.abs(q.x) < w / 2 + 0.03 && Math.abs(q.y) < h / 2 + 0.03;
    }) || null;
  }
  let follow = null;                                                     // unpinned: panel offset in the head-heading frame
  const headYaw = () => { const f = new THREE.Vector3(0, 0, -1).applyQuaternion(host.camera.quaternion); return Math.atan2(-f.x, -f.z); };
  function rememberFollow() {
    const rel = panel.mesh.position.clone().sub(headLocal()).applyAxisAngle(new THREE.Vector3(0, 1, 0), -headYaw());
    follow = rel;
  }
  function followStep(dt) {
    if (!follow) rememberFollow();
    const want = headLocal().add(follow.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), headYaw()));
    face(windows[0], panel.mesh.position.clone().lerp(want, Math.min(1, (dt || 1 / 72) * 3)));
  }
  xs.panelPin = pinned => { panel.pinned = pinned; follow = null; };

  /** Nearest thing on a side's ray: { kind: 'button'|'panel'|'part', id, point, distance } or null. */
  function hitOf(s) {
    ray.set(s.rayOrigin, s.rayDirection);
    const k = xs.rig.scale.x;
    ray.far = RAY_MAX * k;
    const targets = [panel.mesh]; if (view.visible) targets.push(view.close, view.page, view.back); if (xs.intro?.visible) targets.push(xs.intro.mesh);
    const hp = ray.intersectObjects(targets, false)[0];
    const hits = ray.intersectObjects(host.pickables, false);
    const part = hits.find(h => h.object.visible);
    if (hp && (!part || hp.distance <= part.distance)) {
      if (hp.object === view.close) return { kind: 'button', id: 'viewClose', point: hp.point, distance: hp.distance };
      if (hp.object === xs.intro?.mesh) return { kind: 'button', id: 'introClose', point: hp.point, distance: hp.distance };
      const id = hp.object === panel.mesh ? panel.buttonAt(hp.uv) : null;
      return { kind: id ? 'button' : 'panel', id, win: winOf(hp.object), point: hp.point, distance: hp.distance };
    }
    if (part) return { kind: 'part', id: part.object.userData.part, point: part.point, distance: part.distance };
    return null;
  }

  function update(dt) {
    let btnHover = null, partHover = null;
    for (const side of ['left', 'right']) {
      const s = input.sides[side], line = lines[side], dot = dots[side];
      const usable = s.type !== 'none' && !(xs.holding?.[side]);
      line.visible = dot.visible = usable;
      if (!usable) { hover[side] = null; drag[side] = null; continue; }
      if (drag[side]) {
        if (drag[side].mode === 'hand' ? s.grabPressed : s.selectPressed) {
          dragUpdate(side, s); line.visible = dot.visible = false; hover[side] = { kind: 'panel', dragging: true }; continue;
        }
        if (drag[side].win === windows[0]) follow = null;               // unpinned panel: follows from where it was put
        drag[side] = null;
      }
      const h = hitOf(s); hover[side] = h;
      const onWin = s.justGrabbed && h?.kind !== 'button' && handOnWindow(s);
      if (onWin) {                                                       // direct grab (a pinch aimed at a button presses it)
        handDragStart(side, s, onWin); input.pulse(side, 0.3, 20); hover[side] = { kind: 'panel', dragging: true }; line.visible = dot.visible = false; continue;
      }
      const k = xs.rig.scale.x, len = h ? h.distance : 1.2 * k;
      line.position.copy(s.rayOrigin);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), s.rayDirection);
      line.scale.set(1, 1, len); line.updateMatrixWorld();
      dot.visible = !!h; if (h) { dot.position.copy(h.point); dot.scale.setScalar(0.006 * k); }
      if (h?.kind === 'button') btnHover = h.id;
      if (h?.kind === 'part') partHover = h.id;
      if (s.justSelected && h) {
        if (h.id === 'viewClose') { view.hide(); input.pulse(side, 0.3, 25); }
        else if (h.id === 'introClose') { xs.intro.close(); input.pulse(side, 0.3, 25); }
        else if (h.kind === 'button') { panel.press(h.id); input.pulse(side, 0.3, 25); }
        else if (h.kind === 'panel') { rayDragStart(side, s, h); input.pulse(side, 0.2, 15); }
        else if (h.kind === 'part' && !xs.handsOnSelect?.(side, h)) { host.select(h.id); input.pulse(side, 0.3, 25); }
      }
    }
    if (!panel.pinned && drag.left?.win !== windows[0] && drag.right?.win !== windows[0]) followStep(dt);
    if (view.visible && panel.pageFile) view.show(panel.pageFile);      // the enlarged page follows the shown step
    panel.setHover(btnHover);
    if (partHover) { wire.box.copy(host.partBox(host.byName[partHover])); wire.visible = true; } else wire.visible = false;
    const sel = host.st.selected;
    if (sel) tag.show(host.byName[sel].label, host.partBox(host.byName[sel]), xs.rig.scale.x); else tag.hide();
    panel.draw();
  }

  function dispose() {
    for (const side of ['left', 'right']) { host.scene.remove(lines[side], dots[side]); lines[side].geometry.dispose(); dots[side].geometry.dispose(); }
    host.scene.remove(wire, tag.sprite); tag.dispose(); panel.dispose(); view.dispose();
  }
  return { update, dispose, panel, hitOf, hover };
}

/** Name tag (sprite) above a part. */
function makeTag() {
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 96 }), g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.renderOrder = 31; sprite.visible = false;
  let text = '';
  return {
    sprite,
    show(t, box, k) {
      if (t !== text) {
        text = t; g.clearRect(0, 0, 512, 96); g.font = '700 40px system-ui, sans-serif';
        const w = Math.min(500, g.measureText(t).width + 40);
        g.fillStyle = '#ffdb00'; g.beginPath(); g.roundRect((512 - w) / 2, 14, w, 68, 12); g.fill();
        g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 256, 50); tex.needsUpdate = true;
      }
      sprite.position.set((box.min.x + box.max.x) / 2, box.max.y + 0.02 * k, (box.min.z + box.max.z) / 2);
      sprite.scale.set(0.12 * k, 0.0225 * k, 1); sprite.visible = true;   // 12 cm wide (real), any scale
    },
    hide() { sprite.visible = false; },
    dispose() { tex.dispose(); sprite.material.dispose(); },
  };
}
