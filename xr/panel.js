// World-space step panel (there is no DOM in an immersive session): step header, title, text, timeline, the manual
// page, and buttons. Drawn on a canvas texture; ray hits are turned into canvas pixels to find the button.
// It hangs in the rig (reference space), to the left in front of the user, so it stays put in table / room mode.
import * as THREE from 'three';
import { asset } from '../settings.js?v=1454ebb398';

const W_M = 0.62, ASPECT = 0.62;                          // panel width in metres, height / width
const BLUE = '#0058a3', YELLOW = '#ffdb00', INK = '#111', GREY = '#767676';

export function createPanel(xs, { px = 1024, actions }) {
  const { host } = xs, W = px, H = Math.round(px * ASPECT), u = W / 1024;   // u: layout unit (1024 px design)
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W_M, W_M * ASPECT),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
  mesh.name = 'XRPanel'; mesh.renderOrder = 20;
  xs.rig.add(mesh);
  const pages = Object.fromEntries((host.sc.manualPages || []).map(p => [p.name, p.file]));
  const dir = new URLSearchParams(location.search).get('p');
  const images = {};
  let hover = null, sig = '', note = '', noteColor = '#c0392b', hint = '';

  // buttons: id, label, x, y, w, h (design px)
  const BTN = [];
  const row = (y, items) => { let x = 28; for (const [id, w] of items) { BTN.push({ id, x, y, w, h: 64 }); x += w + 12; } };
  row(H / u - 92, [['prev', 92], ['play', 120], ['next', 92], ['restart', 130], ['mode', 220], ['scale', 120], ['recenter', 140]]);
  BTN.push({ id: 'exit', x: 1024 - 28 - 120, y: 24, w: 120, h: 52 });
  if (xs.mode === 'immersive-vr') BTN.push({ id: 'floor', x: 1024 - 28 - 120 - 12 - 120, y: 24, w: 120, h: 52 });   // set the real floor height
  if (xs.mirrorWanted) BTN.push({ id: 'photo', x: 1024 - 28 - 3 * 120 - 2 * 12, y: 24, w: 120, h: 52 });   // PC: screenshot of the view

  function label(id) {
    const st = host.st;
    return { prev: '◀◀', next: '▶▶', play: xs.mode2 === 'handson' ? (host.st.chapter === 0 ? 'Start' : 'Do it') : st.playing ? '❚❚' : '▶', restart: 'Restart', recenter: 'Recenter', exit: 'Exit',
      floor: xs.locomotion?.calibrating ? 'Cancel' : 'Floor',
      photo: 'Photo',
      mode: xs.mode2 === 'handson' ? 'Just watch' : 'Build it yourself',   // what it switches to
      scale: xs.scaleMode === 'table' ? 'Table' : 'Room' }[id];
  }
  function wrap(text, maxW, font, maxLines) {
    g.font = font; const out = []; let line = '';
    for (const w of String(text || '').split(/\s+/)) {
      const t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > maxW && line) { out.push(line); line = w; if (out.length === maxLines) break; } else line = t;
    }
    if (out.length < maxLines && line) out.push(line);
    else if (out.length === maxLines) out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, ' …');
    return out;
  }
  function pageImage(name) {
    const f = pages[name]; if (!f) return null;
    if (!images[f]) { const im = new Image(); im.onload = () => { sig = ''; }; im.src = asset(dir + '/' + f); images[f] = im; }
    return images[f].complete && images[f].naturalWidth ? images[f] : null;
  }

  function draw() {
    const st = host.st, S = host.steps.length, c = st.chapter, P = host.sc.product, T = host.time;
    const s = c > 0 ? host.steps[c - 1] : null;
    const pageName = c === 0 ? P.partsPage : s.manualPage, img = pageImage(pageName);
    const key = [c, st.playing, Math.round(T.globalTime() * 4), hover, xs.mode2, xs.scaleMode, note, hint, !!img, !!xs.locomotion?.calibrating].join('|');
    if (key === sig) return; sig = key;
    g.setTransform(u, 0, 0, u, 0, 0);
    const w = 1024, h = H / u;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.96)'; round(0, 0, w, h, 18); g.fill();
    const textW = img ? 600 : w - 56;
    g.fillStyle = BLUE; g.font = '700 22px system-ui, sans-serif';
    g.fillText((c === 0 ? `${P.name}  ·  PARTS` : `${P.name}  ·  STEP ${c} OF ${S}`).toUpperCase(), 28, 52);
    g.fillStyle = INK; g.font = '700 34px system-ui, sans-serif';
    wrap(c === 0 ? 'Unpack and check all parts' : s.title, textW, g.font, 2).forEach((l, i) => g.fillText(l, 28, 104 + i * 40));
    g.font = '400 24px system-ui, sans-serif'; g.fillStyle = '#333';
    const body = c === 0 ? `In the box: ${P.partsSummary || ''}` : s.text;
    wrap(body, textW, g.font, 7).forEach((l, i) => g.fillText(l, 28, 190 + i * 32));
    if (note || hint) { g.fillStyle = note ? noteColor : GREY; g.font = (note ? '700' : '400') + ' 22px system-ui, sans-serif'; g.fillText(note || hint, 28, h - 140); }
    if (img) {   // manual page, right half
      const bw = w - textW - 84, bh = h - 210, sc = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      const iw = img.naturalWidth * sc, ih = img.naturalHeight * sc;
      g.drawImage(img, w - 28 - iw, 88, iw, ih);
    }
    // timeline
    const total = Math.max(host.sc.duration || 1, 1e-3), y = h - 120 + 0;
    g.fillStyle = '#ddd'; g.fillRect(28, y - 18, w - 56, 8);
    g.fillStyle = BLUE; g.fillRect(28, y - 18, (w - 56) * Math.min(1, T.globalTime() / total), 8);
    for (const b of BTN) {
      const on = hover === b.id, primary = b.id === 'play', invite = b.id === 'mode' && xs.mode2 !== 'handson';   // blue: try hands-on
      g.fillStyle = primary ? YELLOW : invite ? (on ? '#004a8a' : BLUE) : on ? '#dfe7f3' : '#f0f0f0'; round(b.x, b.y, b.w, b.h, 10); g.fill();
      if (on) { g.strokeStyle = BLUE; g.lineWidth = 4; round(b.x, b.y, b.w, b.h, 10); g.stroke(); }
      g.fillStyle = invite ? '#fff' : (b.id === 'next' && c === S && T.atEnd()) || (b.id === 'prev' && c === 0) ? GREY : INK;
      g.font = (b.id === 'mode' ? '700 24px' : '700 26px') + ' system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label(b.id), b.x + b.w / 2, b.y + b.h / 2 + 1);
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    }
    tex.needsUpdate = true;
  }
  function round(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  /** Put the panel to the left in front of the user (reference space = rig local), facing them. */
  function place(head, yaw) {
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), left = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    mesh.position.copy(head).addScaledVector(f, 0.55).addScaledVector(left, 0.42).setY(Math.max(0.95, head.y - 0.3));
    mesh.rotation.set(-0.22, yaw + 0.42, 0, 'YXZ');
    mesh.updateMatrixWorld(true);
  }
  /** Button under a ray hit (uv on the panel), or null. */
  function buttonAt(uv) {
    const x = uv.x * 1024, y = (1 - uv.y) * (H / u);
    return BTN.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.id || null;
  }
  /** Rig-local (= reference space) centre of a button - QA aims the emulated controller at it. */
  function buttonRef(id) {
    const b = BTN.find(q => q.id === id), uvx = (b.x + b.w / 2) / 1024, uvy = 1 - (b.y + b.h / 2) / (H / u);
    const p = new THREE.Vector3((uvx - 0.5) * W_M, (uvy - 0.5) * W_M * ASPECT, 0.001);
    return mesh.position.clone().add(p.applyQuaternion(mesh.quaternion));
  }
  return {
    mesh, draw, place, buttonAt, buttonRef,
    setHover(id) { hover = id; }, setHint(t) { hint = t || ''; }, get hint() { return hint; },
    flash(text, color = '#c0392b') { note = text; noteColor = color; setTimeout(() => { if (note === text) note = ''; }, 2500); },
    press(id) { actions[id]?.(); sig = ''; },
    dispose() { xs.rig.remove(mesh); tex.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); },
  };
}
