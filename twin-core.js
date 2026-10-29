// Digital-twin runtime pieces shared by every device port: the TwinDevice base (states, events, sounds), the generic
// controls (TwinButton, TwinKnob, TwinHinge, TwinSlider, TwinClickTarget) and Unity-exact helpers.
// Ports of Assets/IKEAPipeline/Runtime/Twin/*.cs - keep the behaviour identical (checked by the parity trace).
// Component fields come raw from twin.json (Unity convention): positions / offsets via uVec, rotations via uAxisAngle.
import * as THREE from 'three';
import { srgb } from './stage.js?v=76fd8115a3';

export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clamp01 = v => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * clamp01(t);
export const moveTowards = (cur, target, maxDelta) => Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;
export function moveTowardsAngle(cur, target, maxDelta) {     // Mathf.MoveTowardsAngle
  let d = ((target - cur) % 360 + 540) % 360 - 180;
  if (-maxDelta < d && d < maxDelta) return target;
  return moveTowards(cur, cur + d, maxDelta);
}
/** Mathf.RoundToInt = System.Math.Round: halves to even. */
export function roundToInt(v) { const f = Math.floor(v), r = v - f; return r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1); }
/** C# ToString("0.#") */
export const fmt1 = v => String(Math.round(v * 10) / 10);
/** C# ToString("0") */
export const fmt0 = v => String(roundToInt(v));
/** Convert.ToString(value, InvariantCulture) as SetState uses it. */
export const stateString = v => typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);

/** Unity local vector (position / offset) -> glTF. */
export const uVec = a => new THREE.Vector3(-a[0], a[1], a[2]);
/** Unity Quaternion.AngleAxis(deg, axis) -> glTF quaternion (axis (x,-y,-z), same angle). */
const _ax = new THREE.Vector3();
export const uAxisAngle = (axis, deg, out = new THREE.Quaternion()) => out.setFromAxisAngle(_ax.set(axis[0], -axis[1], -axis[2]).normalize(), deg * DEG);

/** Unity rich text (<b>, <color=#..>) -> HTML. */
export function richText(s) {
  return String(s ?? '').replace(/&/g, '&amp;')
    .replace(/<color=(#[0-9a-fA-F]{3,8})>/g, '<span style="color:$1">').replace(/<\/color>/g, '</span>')
    .replace(/<(?!\/?b>|span\b|\/span>)[^>]*>/g, '').replace(/\n/g, '<br>');   // other Unity tags dropped
}

// ---------------- sound (Unity TwinDevice.Beep / MakeLoop: generated tones) ----------------
let audio = null;
export function audioContext() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
  if (audio?.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}
addEventListener('pointerdown', () => audioContext(), { once: true, capture: true });   // browsers start audio on a gesture

/**
 * .NET HashSet<T> enumeration order: removed slots go on a LIFO free list and are reused by the next Add, so
 * string.Join("+", set) can differ from a JS Set after remove + add. Ports that expose a set in a state use this.
 */
export class CsHashSet {
  constructor() { this.slots = []; this.free = []; }
  has(v) { return this.slots.includes(v); }
  add(v) { if (this.has(v)) return false; if (this.free.length) this.slots[this.free.pop()] = v; else this.slots.push(v); return true; }
  delete(v) { const i = this.slots.indexOf(v); if (i < 0) return false; this.slots[i] = undefined; this.free.push(i); return true; }
  clear() { this.slots = []; this.free = []; }
  get size() { return this.slots.filter(x => x !== undefined).length; }
  values() { return this.slots.filter(x => x !== undefined); }
  [Symbol.iterator]() { return this.values()[Symbol.iterator](); }
}

// ---------------- device base ----------------
export class TwinDevice {
  constructor(ctx, fields) { this.ctx = ctx; this.f = fields; this.states = new Map(); this.lastEvent = ''; this.listeners = []; this.help = ctx.help || ''; }
  onControl(c) {}
  update(dt) {}
  get statusText() { return ''; }
  getState(k) { return this.states.get(k) ?? ''; }
  setState(k, v) { this.states.set(k, stateString(v)); }
  emit(e) { this.lastEvent = e; for (const f of this.listeners) f(e); }
  get where() { const s = this.statusText; const i = s.indexOf('\n'); return (i > 0 ? s.slice(0, i) : s).replace(/<\/?b>/g, ''); }
  beep(freq = 2000, seconds = 0.12, volume = 0.35) {
    const a = this.ctx.muted ? null : audioContext(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
    o.frequency.value = freq; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(volume * 0.5, t + Math.min(0.02, seconds / 2));
    g.gain.setValueAtTime(volume * 0.5, t + seconds - Math.min(0.02, seconds / 2)); g.gain.linearRampToValueAtTime(0, t + seconds);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + seconds + 0.02);
  }
  /** Looping hum (fan, motor): {play(), stop(), isPlaying, pitch, volume}. */
  makeLoop(freq, freq2, volume) {
    const dev = this, loop = { isPlaying: false, pitch: 1, volume, nodes: null,
      play() { const a = dev.ctx.muted ? null : audioContext(); if (!a || this.isPlaying) return; this.isPlaying = true;
        const g = a.createGain(); g.gain.value = this.volume * 0.5; g.connect(a.destination);
        const o1 = a.createOscillator(), o2 = a.createOscillator(), g1 = a.createGain(), g2 = a.createGain();
        o1.frequency.value = freq; o2.frequency.value = freq2; g1.gain.value = 0.6; g2.gain.value = 0.4;
        o1.connect(g1).connect(g); o2.connect(g2).connect(g); o1.start(); o2.start(); this.nodes = { g, o1, o2 }; },
      stop() { if (!this.isPlaying) return; this.isPlaying = false; const n = this.nodes; this.nodes = null;
        try { n.o1.stop(); n.o2.stop(); n.g.disconnect(); } catch (e) {} },
      apply() { if (!this.nodes) return; this.nodes.g.gain.value = this.volume * 0.5; this.nodes.o1.frequency.value = freq * this.pitch; this.nodes.o2.frequency.value = freq2 * this.pitch; } };
    return loop;
  }
  static clock(a, b, colon = true) { return String(a).padStart(2, '0') + (colon ? ':' : ' ') + String(b).padStart(2, '0'); }
}

// ---------------- material helpers ----------------
/** Per-node materials (shared glTF materials are cloned once so one LED / zone can change alone). */
export function ownMaterials(node) {
  const out = [];
  // the node itself, or the primitive meshes three.js adds under a multi-material node (they carry no uid)
  node.traverse(o => { if (o.isMesh && (o === node || (o.parent === node && !('uid' in o.userData)))) out.push(o); });
  for (const m of out) if (!m.userData.ownMat) { m.material = m.material.clone(); m.userData.ownMat = true; m.userData.baseColor = m.material.color.clone(); }
  return out.map(m => m.material);
}
/** Unity Led(): lit = colour + emission (colour x 2), unlit = dark grey. */
export function led(node, lit, color) {
  if (!node) return;
  for (const mat of ownMaterials(node)) {
    mat.color.copy(srgb(lit ? color : [0.12, 0.12, 0.12]));
    if (mat.emissive) { if (lit) { mat.emissive.copy(srgb(color)); mat.emissiveIntensity = 2; } else mat.emissive.setRGB(0, 0, 0); }
  }
}

/** Unity property block with a lerped _BaseColor and an HDR _EmissionColor (heating elements): colour a->b by t, emission e x k. */
export function srgbLerp(node, a, b, t, e, k) {
  if (!node) return; const tt = clamp01(t);
  for (const mat of ownMaterials(node)) {
    mat.color.copy(srgb([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt]));
    if (mat.emissive) { mat.emissive.copy(srgb(e)); mat.emissiveIntensity = k; }
  }
}

/** Unity property block with _BaseColor and an HDR _EmissionColor (emission colour x k). */
export function ledHdr(node, color, emission, k) {
  if (!node) return;
  for (const mat of ownMaterials(node)) { mat.color.copy(srgb(color)); if (mat.emissive) { mat.emissive.copy(srgb(emission)); mat.emissiveIntensity = k; } }
}

/** TMP rich text -> lines of runs {text, size (em factor), bold, color}: <size=NN%>, <b>, <color=#..>, \n; other tags dropped. */
function richRuns(s, bold0, color0) {
  const lines = [{ runs: [], size: 1 }]; const st = { size: [1], bold: [bold0], color: [color0] };
  const top = k => st[k][st[k].length - 1];
  for (const tok of s.split(/(<[^>]+>|\n)/)) {
    if (!tok) continue;
    if (tok === '\n') { lines.push({ runs: [], size: top('size') }); continue; }
    let m;
    if ((m = /^<size=(\d+(?:\.\d+)?)%>$/i.exec(tok))) st.size.push(+m[1] / 100);
    else if (/^<\/size>$/i.test(tok)) { if (st.size.length > 1) st.size.pop(); }
    else if (/^<b>$/i.test(tok)) st.bold.push(true);
    else if (/^<\/b>$/i.test(tok)) { if (st.bold.length > 1) st.bold.pop(); }
    else if ((m = /^<color=(#[0-9a-f]{3,8})>$/i.exec(tok))) st.color.push(m[1]);
    else if (/^<\/color>$/i.test(tok)) { if (st.color.length > 1) st.color.pop(); }
    else if (!/^<[^>]+>$/.test(tok)) lines[lines.length - 1].runs.push({ text: tok, size: top('size'), bold: top('bold'), color: top('color') });
  }
  return lines;
}

/** Unity Led() variants that only set _BaseColor (hob keys, displays): colour change, emission untouched. */
export function colorOnly(node, color) { if (!node) return; for (const mat of ownMaterials(node)) mat.color.copy(srgb(color)); }

// ---------------- text (TextMeshPro 3D / TextMesh) ----------------
/**
 * A Unity text object drawn as a canvas-textured plane. Geometry follows TMP: rect (w, h) with pivot, alignment,
 * em = world height of the font size. Unity text lies in local XY, readable from -Z, running along +X; in glTF axes
 * (x mirrored) that is a plane turned 180° about Y. Set `.text` like TMP_Text.text (redraws only on change).
 */
export class TextLabel {
  constructor(node, d) {
    Object.assign(this, { node, d });
    this.enabled = d.enabled !== false; this._text = null;
    this.mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.y = Math.PI; this.mesh.renderOrder = 3; this.mesh.userData.textOf = node;
    node.add(this.mesh);
    this.text = d.text ?? '';
  }
  get text() { return this._text; }
  set text(v) { v = String(v ?? ''); if (v === this._text) return; this._text = v; this.draw(); }
  set color(c) { this.d.color = c; this._text = null; this.text = this.d.text; }
  get shown() { if (!this.enabled) return ''; for (let n = this.node; n; n = n.parent) if (!n.visible) return ''; return this._text; }
  draw() {
    const d = this.d, s = this._text;
    this.mesh.visible = this.enabled && s.length > 0;
    if (!s.length) return;
    const em = d.em, PX = 96;                                // canvas pixels per em
    const base = new THREE.Color().setRGB(d.color[0], d.color[1], d.color[2], THREE.SRGBColorSpace).getStyle();   // Unity colours are sRGB
    const lines = richRuns(s, !!d.bold, base);
    const cv = this.canvas || (this.canvas = document.createElement('canvas')), g = cv.getContext('2d');
    const fontOf = r => `${r.bold ? 'bold ' : ''}${Math.round(PX * r.size)}px "Liberation Sans", Arial, Helvetica, sans-serif`;
    for (const l of lines) {
      l.w = 0; l.h = l.runs.length ? 0 : l.size;
      for (const r of l.runs) { g.font = fontOf(r); r.w = g.measureText(r.text).width; l.w += r.w; l.h = Math.max(l.h, r.size); }
    }
    const tw = Math.max(1, ...lines.map(l => l.w)), th = lines.reduce((a, l) => a + l.h * PX * 1.2, 0);
    cv.width = Math.ceil(tw + PX * 0.4); cv.height = Math.ceil(th + PX * 0.2);
    g.globalAlpha = d.color[3] ?? 1; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    const a = d.align || 'Center', hl = /Left/.test(a) ? 'left' : /Right/.test(a) ? 'right' : 'center';
    let y = PX * 0.1;
    for (const l of lines) {
      const lh = l.h * PX * 1.2, x0 = hl === 'left' ? PX * 0.2 : hl === 'right' ? cv.width - PX * 0.2 - l.w : (cv.width - l.w) / 2;
      let x = x0;
      for (const r of l.runs) { g.font = fontOf(r); g.fillStyle = r.color; g.fillText(r.text, x, y + lh * 0.78); x += r.w; }
      y += lh;
    }
    if (this.tex) this.tex.dispose();
    this.tex = new THREE.CanvasTexture(cv); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 4;
    this.mat.map = this.tex; this.mat.needsUpdate = true;
    // plane size and placement in Unity local units (x is mirrored when assigned)
    const w = cv.width / PX * em, h = cv.height / PX * em;
    this.mesh.scale.set(w, h, 1);
    const [rw, rh] = d.rect || [0, 0], [px, py] = d.pivot || [0.5, 0.5];
    let cx = rw * (0.5 - px), cy = rh * (0.5 - py);                       // rect centre relative to the pivot
    if (d.kind === 'textmesh') {                                         // TextMesh: anchored at the origin
      cx = /Left/.test(a) ? w / 2 : /Right/.test(a) ? -w / 2 : 0;
      cy = /Upper/.test(a) ? -h / 2 : /Lower/.test(a) ? h / 2 : 0;
    } else {
      if (hl === 'left') cx += -rw / 2 + w / 2; else if (hl === 'right') cx += rw / 2 - w / 2;
      if (/Top/.test(a)) cy += rh / 2 - h / 2; else if (/Bottom|Baseline/.test(a)) cy += -rh / 2 + h / 2;
    }
    this.mesh.position.set(-cx, cy, 0);
  }
}

// ---------------- generic controls ----------------
// Every control: label (getter), and any of onClicked(), onClickedAt(worldPoint), onHold(seconds), onRelease(),
// onScroll(dir), start(), update(dt). `node` = the Object3D the component sits on, `device` = its TwinDevice.
export class TwinButton {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.rest = node.position.clone(); this.t = 0; this.fired = false; }
  get dual() { return this.f.holdSeconds > 0 && !!this.f.holdControl; }
  get label() {
    const f = this.f, base = f.label || f.control;
    return base + (f.holdSeconds <= 0 ? '' : this.dual ? ` (hold ${fmt1(f.holdSeconds)} s: ${f.holdLabel || f.holdControl})` : ` (hold ${fmt1(f.holdSeconds)} s)`);
  }
  onClicked() { this.t = this.f.pressDuration; this.fired = false; if (this.f.holdSeconds <= 0 || this.dual) this.device?.onControl(this.f.control); }
  onHold(s) {
    this.t = this.f.pressDuration;
    if (this.f.holdSeconds > 0 && !this.fired && s >= this.f.holdSeconds) { this.fired = true; this.device?.onControl(this.dual ? this.f.holdControl : this.f.control); }
  }
  onRelease() { this.fired = false; }
  update(dt) { this.node.position.copy(this.rest); if (this.t > 0) this.node.position.add(uVec(this.f.pressTravel)); if (this.t > 0) this.t -= dt; }
}

export class TwinKnob {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.rest = node.quaternion.clone(); this.index = f.index; this.shown = this.index * f.stepAngle; }
  get value() { const p = this.f.positions; return p.length ? p[clamp(this.index, 0, p.length - 1)] : ''; }
  get label() { return `${this.f.label}: ${this.value}`; }
  start() { this.device?.onControl(`${this.f.control}=${this.value}`); }
  onClicked() { this.turn(1); }
  onScroll(dir) { this.turn(dir); }
  turn(dir) {
    const n = this.f.positions.length; if (!n) return;
    let next = this.index + dir; next = this.f.wrap ? ((next % n) + n) % n : clamp(next, 0, n - 1);
    if (next === this.index) return;
    this.index = next; this.device?.onControl(`${this.f.control}=${this.value}`);
  }
  setIndexSilently(i) { this.index = clamp(i, 0, this.f.positions.length - 1); }
  update(dt) {
    this.shown = moveTowardsAngle(this.shown, this.index * this.f.stepAngle, 720 * dt);
    this.node.quaternion.copy(this.rest).multiply(uAxisAngle(this.f.localAxis, -this.shown));
  }
}

export class TwinHinge {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.rest = node.quaternion.clone(); this.open = !!f.open; this.locked = !!f.locked; this.angle = 0; }
  get label() { return this.locked ? this.f.label + ' (locked)' : (this.open ? 'Close ' : 'Open ') + this.f.label; }
  onClicked() { if (this.locked) { this.device?.onControl(`${this.f.id}:locked`); return; } this.set(!this.open); }
  set(o) { if (o === this.open) return; this.open = o; this.device?.onControl(`${this.f.id}:${this.open ? 'open' : 'close'}`); }
  update(dt) {
    this.angle = moveTowards(this.angle, this.open ? this.f.openAngle : 0, this.f.speed * dt);
    this.node.quaternion.copy(this.rest).multiply(uAxisAngle(this.f.localAxis, this.angle));
  }
}

export class TwinSlider {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.index = f.index; }
  get label() { return `${this.f.label}` + (this.index >= 0 ? `: ${this.f.positions[this.index]}` : '') + ' (click along it / wheel)'; }
  onClicked() { this.set(Math.max(0, this.index)); }
  onClickedAt(world) {
    this.node.updateWorldMatrix(true, false);
    const a = uVec(this.f.localStart).applyMatrix4(this.node.matrixWorld), b = uVec(this.f.localEnd).applyMatrix4(this.node.matrixWorld);
    const ab = b.clone().sub(a), u = clamp01(world.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()));
    this.set(roundToInt(u * (this.f.positions.length - 1)));
  }
  onScroll(dir) { this.set(clamp(this.index + dir, 0, this.f.positions.length - 1)); }
  setIndexSilently(i) { this.index = clamp(i, -1, this.f.positions.length - 1); }
  set(i) { this.index = clamp(i, 0, this.f.positions.length - 1); this.device?.onControl(`${this.f.control}=${this.f.positions[this.index]}`); }
}

export class TwinClickTarget {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return this.f.label || this.f.control; }
  onClicked() { this.device?.onControl(this.f.control); }
}

/** type name (Unity class) -> control class; device modules add their own (registerControl). */
export const controlTypes = { TwinButton, TwinKnob, TwinHinge, TwinSlider, TwinClickTarget };
export const deviceTypes = {};
export const registerControl = (name, cls) => { controlTypes[name] = cls; };
export const registerDevice = (name, cls) => { deviceTypes[name] = cls; };
