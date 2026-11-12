// Desktop mirror of an immersive session (PC + Quest Link; not loaded in the Quest Browser or on phones; ?mirror=0 = off,
// ?mirror=1 = on anyway, e.g. QA with IWER which reports the Quest Browser):
// the page shows what the headset sees (the head pose, one frame late, wider than one eye), with a Screenshot button
// (PNG download) and Hide / Show. A second WebGLRenderer on its own canvas renders the same scene; it renders every
// other XR frame and nothing while hidden. Removed with the session.
import * as THREE from 'three';

export function createMirror(xs) {
  const { host } = xs, src = host.renderer;
  const wrap = document.createElement('div');
  wrap.id = 'xrMirror';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:50;background:#1b1b1b';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;right:16px;top:16px;display:flex;gap:7px;align-items:center;font:12px system-ui,sans-serif;color:#ddd';
  bar.innerHTML = '<span style="margin-right:6px">VR view (mirror) - you are in the headset</span>';
  const btn = (label, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.onclick = fn; bar.appendChild(b); return b; };
  btn('Screenshot', () => shot());
  const hideBtn = btn('Hide', () => { shown = !shown; canvas.style.visibility = shown ? '' : 'hidden'; wrap.style.background = shown ? '#1b1b1b' : 'rgba(27,27,27,0.9)'; hideBtn.textContent = shown ? 'Hide' : 'Show'; });
  wrap.append(canvas, bar);
  document.body.appendChild(wrap);

  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });   // preserve: screenshots
  r.outputColorSpace = src.outputColorSpace; r.toneMapping = src.toneMapping; r.toneMappingExposure = src.toneMappingExposure;
  r.shadowMap.enabled = src.shadowMap.enabled; r.shadowMap.type = src.shadowMap.type;
  r.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const cam = new THREE.PerspectiveCamera(80, 1, 0.01, 1000);
  let shown = true, n = 0, w = 0, h = 0;

  function update() {
    if (!shown || (n++ & 1)) return;
    render();
  }
  function render() {
    if (innerWidth !== w || innerHeight !== h) { w = innerWidth; h = innerHeight; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    const xc = src.xr.getCamera();                                   // head pose of the last XR frame (world)
    if (!xc.cameras.length) return;
    xc.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.scale.set(1, 1, 1); cam.near = 0.01 * xs.rig.scale.x; cam.far = 1000 * xs.rig.scale.x; cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    r.shadowMap.enabled = src.shadowMap.enabled;
    r.render(host.scene, cam);
  }
  /** PNG of the mirror view -> download (the drawing buffer is preserved, so it is the last rendered frame). */
  function shot() {
    render();                                                        // also when hidden: the current view
    canvas.toBlob(b => {
      if (!b) return;
      const a = document.createElement('a'), t = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(b); a.download = `vr-${host.sc.product?.name || 'view'}-${t}.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      host.events.emit('screenshot', { source: 'xr' });
    }, 'image/png');
  }
  function dispose() { r.dispose(); r.forceContextLoss(); wrap.remove(); }
  return { update, dispose, shot, canvas, get shown() { return shown; } };
}
