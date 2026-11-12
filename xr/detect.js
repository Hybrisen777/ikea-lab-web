// WebXR entry: the only XR code every visitor loads. "Enter VR / AR" buttons (top right, in #hud) when supported;
// the rest (session.js, input, models) is imported on the click. Kill switch: XR_ENABLED = false or ?xr=0.
export const XR_ENABLED = true;

/** host: what player.js lends the XR layer (see session.js). Resolves to the supported modes. */
export async function offerXR(host, n = 0) {
  const none = { vr: false, ar: false };
  if (!XR_ENABLED || new URLSearchParams(location.search).get('xr') === '0' || !navigator.xr?.isSessionSupported) return none;
  const ask = m => navigator.xr.isSessionSupported(m).catch(() => false);
  const [vr, ar] = await Promise.all([ask('immersive-vr'), ask('immersive-ar')]);
  if (!vr && !ar) {   // headset / Link started later: Chrome sends no devicechange - ask again for 1 min and on focus
    const again = () => document.getElementById('xrButtons') || offerXR(host, n + 1);
    if (n < 20) setTimeout(again, 3000); else addEventListener('focus', again, { once: true });
    return none;
  }
  const box = document.createElement('div'), hud = document.getElementById('hud');
  box.id = 'xrButtons';
  box.style.cssText = (hud ? '' : 'position:fixed;right:16px;top:16px;z-index:5;') + 'display:flex;gap:7px';
  for (const [mode, ok, label] of [['immersive-vr', vr, 'Enter VR'], ['immersive-ar', ar, 'Enter AR']]) {
    if (!ok) continue;
    const b = document.createElement('button');
    b.className = 'btn blue'; b.textContent = label; b.dataset.mode = mode;
    b.addEventListener('click', async () => {
      b.disabled = true; b.title = ''; b.textContent = 'Starting…';   // Quest Link: up to ~1.5 min (README)
      try { await (await import('./session.js?v=1454ebb398')).enterXR(mode, host); }
      catch (e) { console.error('WebXR:', e); b.title = 'Could not start: ' + (e?.message || e); }
      finally { b.disabled = false; b.textContent = label; b.blur(); }
    });
    box.appendChild(b);
  }
  if (hud) hud.prepend(box); else document.body.appendChild(box);
  return { vr, ar };
}
