// First-time help in VR / AR: a card in front of the user with the few gestures there are (hands first - controllers
// in one line). Shown on the first entry in this browser (localStorage ikeaLab.xr.intro), again from the panel's "?"
// button; any pinch / trigger on it closes it (interact.js hit 'introClose').
import * as THREE from 'three';

const W_M = 0.56, ASPECT = 0.7, KEY = 'ikeaLab.xr.intro';
const BLUE = '#0058a3', YELLOW = '#ffdb00', INK = '#111', GREY = '#555';

export function createIntro(xs) {
  const W = 1024, H = Math.round(W * ASPECT);
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W_M, W_M * ASPECT), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
  mesh.name = 'XRIntro'; mesh.renderOrder = 25; mesh.visible = false;
  xs.rig.add(mesh);

  function draw() {
    const ar = xs.mode === 'immersive-ar';
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.97)'; g.beginPath(); g.roundRect(0, 0, W, H, 22); g.fill();
    g.fillStyle = BLUE; g.font = '700 24px system-ui, sans-serif'; g.fillText('HOW IT WORKS', 44, 64);
    g.fillStyle = INK; g.font = '700 40px system-ui, sans-serif'; g.fillText('Build it with your hands', 44, 118);
    const rows = [
      ['Point and pinch', 'presses a button on the panel (the yellow ray shows where you point).'],
      ['"Build it yourself"', 'then pinch a glowing part and bring it to its blue outline - it clicks in.'],
      ['Both hands', 'pinch in empty space and pull apart: bigger / smaller; move both: move or turn it.'],
      ['Pinch the panel', 'and drag it where you like. "Pinned" / "Follows" keeps it there or with you.'],
      ar ? ['Place it', 'look at the floor or a table and pinch: the product moves to the yellow ring.']
        : ['Controllers', 'trigger = point and press, grip = grab. Thumbstick: walk and turn.'],
    ];
    let y = 190;
    for (const [a, b] of rows) {
      g.fillStyle = YELLOW; g.beginPath(); g.arc(58, y - 11, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK; g.font = '700 27px system-ui, sans-serif'; g.fillText(a, 80, y);
      const aw = g.measureText(a + '  ').width;
      g.fillStyle = GREY; g.font = '400 25px system-ui, sans-serif';
      wrap(b, W - 120 - aw).forEach((l, i) => g.fillText(l, i ? 80 : 80 + aw, y + i * 32));
      y += wrap(b, W - 120 - aw).length > 1 ? 84 : 58;
    }
    const bw = 380, bx = (W - bw) / 2, by = H - 104;
    g.fillStyle = YELLOW; g.beginPath(); g.roundRect(bx, by, bw, 68, 12); g.fill();
    g.fillStyle = INK; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Got it - pinch here', W / 2, by + 35); g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    tex.needsUpdate = true;
  }
  function wrap(text, maxW) {
    const out = []; let line = '';
    for (const w of text.split(' ')) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line);
    return out;
  }
  /** In front of the user (head position + heading in the rig = reference space), a bit below eye level. */
  function open(head, yaw) {
    draw();
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    mesh.position.copy(head).addScaledVector(f, 0.55).setY(head.y - 0.12);
    mesh.rotation.set(-0.1, yaw, 0, 'YXZ');
    mesh.visible = true; mesh.updateMatrixWorld(true);
    xs.host.events.emit('intro', { source: 'xr', open: true });
  }
  function close() {
    mesh.visible = false;
    try { localStorage.setItem(KEY, 'seen'); } catch (e) { /* private mode */ }
    xs.host.events.emit('intro', { source: 'xr', open: false });
  }
  let seen = false;
  try { seen = localStorage.getItem(KEY) === 'seen'; } catch (e) { /* private mode: show it */ }
  function dispose() { xs.rig.remove(mesh); tex.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
  return { mesh, open, close, dispose, get visible() { return mesh.visible; }, get seen() { return seen; } };
}
