// User settings shared by all products (port of AppSettings; localStorage instead of PlayerPrefs).
// settings.on(fn) is called after any change with the changed key.
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
export const speedLabel = s => (Number.isInteger(s) ? s.toFixed(0) : String(s)) + '×';

const KEY = 'ikeaLab.settings';
const DEFAULTS = { speed: 1, continuous: false, autoCamera: true, xray: true };
const listeners = [];
let values = { ...DEFAULTS };
try { values = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage blocked: defaults */ }
values.speed = Math.min(4, Math.max(0.1, +values.speed || 1));

export const settings = {
  get speed() { return values.speed; },
  get continuous() { return values.continuous; },
  get autoCamera() { return values.autoCamera; },
  get xray() { return values.xray; },
  set(key, v) {
    if (key === 'speed') v = Math.min(4, Math.max(0.1, v));
    if (values[key] === v) return;
    values[key] = v;
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { /* not persisted */ }
    for (const f of listeners) f(key);
  },
  /** Next / previous preset relative to the current speed. */
  stepSpeed(dir) {
    let best = 3; SPEEDS.forEach((s, i) => { if (Math.abs(s - values.speed) < Math.abs(SPEEDS[best] - values.speed)) best = i; });
    this.set('speed', SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, best + dir))]);
  },
  on(fn) { listeners.push(fn); },
};
