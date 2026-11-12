// Ray interaction in an XR session: each side's ray hovers / selects the step panel buttons and the parts.
// Selecting a part is the same as a mouse click on the desktop (host.select: glow + identify), its label shows on a
// small tag above the part. Hover = a wire box around the part / a highlighted panel button.
import * as THREE from 'three';
import { createPanel } from './panel.js?v=44a2f85a5a';
import { xrPrefs } from './quality.js?v=44a2f85a5a';

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
    photo: () => { xs.mirror?.shot(); xs.panel?.flash('Photo saved to Downloads (PC)', '#2e7d32'); },
  } });
  xs.panel = panel;

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

  /** Nearest thing on a side's ray: { kind: 'button'|'panel'|'part', id, point, distance } or null. */
  function hitOf(s) {
    ray.set(s.rayOrigin, s.rayDirection);
    const k = xs.rig.scale.x;
    ray.far = RAY_MAX * k;
    const hp = ray.intersectObject(panel.mesh, false)[0];
    const hits = ray.intersectObjects(host.pickables, false);
    const part = hits.find(h => h.object.visible);
    if (hp && (!part || hp.distance <= part.distance)) return { kind: panel.buttonAt(hp.uv) ? 'button' : 'panel', id: panel.buttonAt(hp.uv), point: hp.point, distance: hp.distance };
    if (part) return { kind: 'part', id: part.object.userData.part, point: part.point, distance: part.distance };
    return null;
  }

  function update() {
    let btnHover = null, partHover = null;
    for (const side of ['left', 'right']) {
      const s = input.sides[side], line = lines[side], dot = dots[side];
      const usable = s.type !== 'none' && !(xs.holding?.[side]);
      line.visible = dot.visible = usable;
      if (!usable) { hover[side] = null; continue; }
      const h = hitOf(s); hover[side] = h;
      const k = xs.rig.scale.x, len = h ? h.distance : 1.2 * k;
      line.position.copy(s.rayOrigin);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), s.rayDirection);
      line.scale.set(1, 1, len); line.updateMatrixWorld();
      dot.visible = !!h; if (h) { dot.position.copy(h.point); dot.scale.setScalar(0.006 * k); }
      if (h?.kind === 'button') btnHover = h.id;
      if (h?.kind === 'part') partHover = h.id;
      if (s.justSelected && h) {
        if (h.kind === 'button') { panel.press(h.id); input.pulse(side, 0.3, 25); }
        else if (h.kind === 'part' && !xs.handsOnSelect?.(side, h)) { host.select(h.id); input.pulse(side, 0.3, 25); }
      }
    }
    panel.setHover(btnHover);
    if (partHover) { wire.box.copy(host.partBox(host.byName[partHover])); wire.visible = true; } else wire.visible = false;
    const sel = host.st.selected;
    if (sel) tag.show(host.byName[sel].label, host.partBox(host.byName[sel]), xs.rig.scale.x); else tag.hide();
    panel.draw();
  }

  function dispose() {
    for (const side of ['left', 'right']) { host.scene.remove(lines[side], dots[side]); lines[side].geometry.dispose(); dots[side].geometry.dispose(); }
    host.scene.remove(wire, tag.sprite); tag.dispose(); panel.dispose();
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
      sprite.position.set((box.min.x + box.max.x) / 2, box.max.y + 0.03 * k, (box.min.z + box.max.z) / 2);
      sprite.scale.set(0.3 * k, 0.056 * k, 1); sprite.visible = true;
    },
    hide() { sprite.visible = false; },
    dispose() { tex.dispose(); sprite.material.dispose(); },
  };
}
