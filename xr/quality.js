// XR quality presets. Quest 3 (and anything unknown) gets "high"; Quest 2 is detected from the Oculus Browser user agent
// and gets "low". The choice is remembered per browser (localStorage 'ikeaLab.xr'), next to the room / table placement.
const KEY = 'ikeaLab.xr';
export const PRESETS = {
  high: { framebufferScale: 1.0, shadows: true, shadowMap: 2048, panelPx: 1024 },
  low: { framebufferScale: 0.75, shadows: false, shadowMap: 1024, panelPx: 512 },
};
export const isQuest2 = () => /Quest 2/i.test(navigator.userAgent);

// floor: real floor height in the reference space (Floor button); farGrab: distance grab, opt-in until it feels right
// (2026-11-02; renamed from distanceGrab so values saved while it defaulted to on are ignored)
let prefs = { quality: 'auto', scale: 'room', floor: 0, farGrab: false };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage blocked */ }

export const xrPrefs = {
  get quality() { return prefs.quality === 'auto' ? (isQuest2() ? 'low' : 'high') : prefs.quality; },
  get scale() { return prefs.scale; },
  get floor() { return +prefs.floor || 0; },
  get distanceGrab() { return prefs.farGrab === true; },
  get preset() { return PRESETS[this.quality]; },
  set(k, v) { prefs[k] = v; try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* not persisted */ } },
};

/** Apply the preset; returns a function that restores the desktop renderer settings. */
export function applyQuality(renderer, scene) {
  const q = xrPrefs.preset, sun = scene.children.find(o => o.isDirectionalLight);
  const before = { shadows: renderer.shadowMap.enabled, map: sun?.shadow.mapSize.x };
  renderer.xr.setFramebufferScaleFactor(q.framebufferScale);   // only takes effect before setSession
  renderer.shadowMap.enabled = q.shadows;
  if (sun && sun.shadow.mapSize.x !== q.shadowMap) { sun.shadow.mapSize.set(q.shadowMap, q.shadowMap); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  renderer.shadowMap.needsUpdate = true;
  return () => {
    renderer.shadowMap.enabled = before.shadows;
    if (sun && before.map && sun.shadow.mapSize.x !== before.map) { sun.shadow.mapSize.set(before.map, before.map); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
  };
}
