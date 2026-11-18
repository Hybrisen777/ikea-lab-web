// Enlarged manual page: tap the page on the step panel and it opens as its own window (0.8 m tall, real size, in front
// of the user), drawn straight from the image file - mipmapped, full anisotropy, not squeezed into the panel canvas.
// High-resolution pages (manual_hd/, rendered from IKEA's PDFs) are used when they exist, else the normal page. The
// window follows the shown step, moves like the panel (interact.js: ray drag / direct grab) and closes with its ✕.
import * as THREE from 'three';
import { asset } from '../settings.js?v=1724c84f69';

const H = 0.8, FRAME = 0.015;                                   // page height, white frame (real metres)

export function createPageView(xs) {
  const { host } = xs, renderer = host.renderer;
  const group = new THREE.Group(); group.name = 'XRPageView'; group.visible = false;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const page = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  page.position.z = 0.001;
  const close = new THREE.Mesh(new THREE.CircleGeometry(0.032, 32), new THREE.MeshBasicMaterial({ map: closeTexture(), transparent: true, toneMapped: false }));
  close.position.z = 0.002;
  for (const m of [back, page, close]) m.renderOrder = 21;
  group.add(back, page, close);
  xs.rig.add(group);
  let url = null, tex = null, aspect = 0.707, want = null;
  const lists = new Map();                                       // folder -> Promise<Set of HD page files> (manual_hd/index.json)
  const hdList = folder => {
    if (!lists.has(folder)) lists.set(folder, fetch(asset(folder + '/manual_hd/index.json')).then(r => r.ok ? r.json() : []).catch(() => []).then(a => new Set(a)));
    return lists.get(folder);
  };

  function layout() {
    const w = H * aspect;
    page.scale.set(w, H, 1); back.scale.set(w + 2 * FRAME, H + 2 * FRAME, 1);
    close.position.set(w / 2 + FRAME - 0.04, H / 2 + FRAME - 0.04, 0.002);
  }
  layout();
  /** Show a page (its normal path, e.g. STEFAN_00211088/manual/x.png); the HD copy is tried first. */
  function show(src) {
    if (!src || src === want) return;
    want = src;
    const folder = src.split('/')[0], file = src.split('/').pop(), hd = src.replace('/manual/', '/manual_hd/');
    const load = (u, fallback) => {
      const im = new Image();
      im.onload = () => {
        if (want !== src) return;
        const t = new THREE.Texture(im);
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
        tex?.dispose(); tex = t; url = u;
        page.material.map = t; page.material.needsUpdate = true;
        aspect = im.naturalWidth / im.naturalHeight; layout();
      };
      im.onerror = () => fallback && load(fallback, null);
      im.src = u;
    };
    hdList(folder).then(list => { if (want === src) load(list.has(file) ? asset(hd) : asset(src), list.has(file) ? asset(src) : null); });
  }
  /** Open in front of the user (head pose in the rig), facing them. */
  function open(src) {
    show(src);
    const head = host.camera.position.clone(), f = new THREE.Vector3(0, 0, -1).applyQuaternion(host.camera.quaternion).setY(0).normalize();
    const p = head.clone().addScaledVector(f, 0.7).setY(Math.max(1.0, head.y - 0.1));
    group.position.copy(p);
    group.rotation.set(0, Math.atan2(head.x - p.x, head.z - p.z), 0, 'YXZ');
    group.visible = true; group.updateMatrixWorld(true);
    host.events.emit('pageView', { source: 'xr', open: true, page: src });
  }
  function hide() { group.visible = false; host.events.emit('pageView', { source: 'xr', open: false }); }
  function dispose() { xs.rig.remove(group); tex?.dispose(); for (const m of [back, page, close]) { m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); } }
  return {
    group, page, back, close, open, hide, show, dispose,
    get visible() { return group.visible; }, get url() { return url; },
    get size() { return { w: H * aspect + 2 * FRAME, h: H + 2 * FRAME }; },
  };
}

function closeTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), g = c.getContext('2d');
  g.fillStyle = '#111'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 12; g.lineCap = 'round';
  g.beginPath(); g.moveTo(42, 42); g.lineTo(86, 86); g.moveTo(86, 42); g.lineTo(42, 86); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
