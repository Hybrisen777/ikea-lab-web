// KNUVEBO wall-mounted extractor hood - port of Runtime/Twin/Devices/HoodController.cs (keep in sync; parity_script.json
// + _unity_trace.json check it). Touch keys: A = speed 1 (again = off), B = 2, C = 3, hold C = booster (6 min, then back),
// D = light max, hold D = medium. A pot produces steam, removed in proportion to the airflow (325/410/500/690 m³/h).
// Grease filter: take out, clean, refit. The steam ParticleSystem is drawn by SteamEmitter (visual only).
import * as THREE from 'three';
import { TwinDevice, registerDevice, clamp01, moveTowards, roundToInt, ledHdr, uAxisAngle } from '../twin-core.js?v=52995530e4';

const f32 = Math.fround;
const clock = (a, b) => String(a).padStart(2, '0') + ':' + String(b).padStart(2, '0');

class HoodController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    Object.assign(this, { ledA: n(f.ledA), ledB: n(f.ledB), ledC: n(f.ledC), ledD: n(f.ledD), lamps: (f.lamps || []).map(r => ctx.light(r)), lampLens: n(f.lampLens),
      greaseFilter: n(f.greaseFilter), potLid: n(f.potLid), simSpeed: f32(f.simSpeed), boostMinutes: f32(f.boostMinutes), airflow: f.airflow.map(f32), steamRate: f32(f.steamRate),
      speed: f.speed, boost: f.boost, light: f.light, cooking: f.cooking, filterIn: f.filterIn, filterClean: f.filterClean, boostLeft: f32(f.boostLeft), haze: f32(f.haze) });
    this.filterStage = 0; this.filterT = 0; this.message = ''; this.msgTime = 0;
    this.steam = f.steam ? new SteamEmitter(n(f.steam)) : null;
    // Awake
    this.filterRest = this.greaseFilter?.position.clone();
    this.motor = this.makeLoop(85, 170, 0.1);
    this.updateStates();
  }
  get level() { return this.boost ? 4 : this.speed; }

  onControl(c) {
    const key = c.startsWith('key');
    if (key && !this.filterIn) { this.beep(500, 0.1, 0.15); this.flash('Refit the grease filter first'); return; }
    switch (c) {
      case 'keyA': if (this.boost) this.endBoost(false); this.speed = this.speed === 0 ? 1 : (this.speed === 1 ? 0 : 1); this.key(); this.emit(this.speed === 0 ? 'fan:off' : 'fan:1'); break;
      case 'keyB': if (this.boost) this.endBoost(false); this.speed = 2; this.key(); this.emit('fan:2'); break;
      case 'keyC': if (this.boost) this.endBoost(false); this.speed = 3; this.key(); this.emit('fan:3'); break;
      case 'keyCLong': this.boost = true; this.boostLeft = f32(this.boostMinutes * 60); this.beep(2000, 0.15, 0.2); this.emit('boost:on'); break;
      case 'keyD': this.light = this.light > 0 ? 0 : 2; this.key(); this.emit(this.light === 0 ? 'light:off' : 'light:max'); break;
      case 'keyDLong': this.light = this.light === 1 ? 0 : 1; this.beep(1600, 0.12, 0.15); this.emit(this.light === 0 ? 'light:off' : 'light:medium'); break;
      case 'pot': this.cooking = !this.cooking; this.emit(this.cooking ? 'cooking:on' : 'cooking:off'); break;
      case 'filter':
        if (this.level > 0) { this.beep(500, 0.1, 0.15); this.flash('Switch the motor off before removing the filter'); return; }
        if (this.filterStage === 0) { this.filterStage = 1; this.filterIn = false; this.emit('filter:out'); }
        else if (this.filterStage === 1) { this.filterStage = 2; this.filterClean = true; this.beep(900, 0.05, 0.12); this.emit('filter:cleaned'); }
        else { this.filterStage = 0; this.filterIn = true; this.emit('filter:in'); }
        break;
    }
    this.updateStates();
  }
  key() { this.beep(1600, 0.04, 0.15); }
  endBoost(timeout) { this.boost = false; this.boostLeft = 0; this.emit(timeout ? 'boost:end' : 'boost:cancel'); }
  flash(m) { this.message = m; this.msgTime = f32(2.5); }

  update(rdt) {
    const dt = f32(rdt * this.simSpeed), time = this.ctx.time;
    if (this.boost) { this.boostLeft = f32(this.boostLeft - dt); if (this.boostLeft <= 0) { this.endBoost(true); this.beep(1800, 0.08, 0.15); } }
    const extract = f32(this.airflow[this.level] / 690);
    // float32 per operation, as C#
    const src = this.cooking ? f32(f32(0.012) * this.steamRate) : 0;
    this.haze = f32(this.haze + f32(f32(f32(src * f32(1 - this.haze)) - f32(this.haze * f32(f32(0.004) + f32(f32(0.05) * extract)))) * dt));
    this.haze = clamp01(this.haze);
    if (this.msgTime > 0) { this.msgTime = f32(this.msgTime - rdt); if (this.msgTime <= 0) this.message = ''; }

    this.steam?.update(rdt, this.cooking ? 30 : 0, 0.75 + (0.35 - 0.75) * extract, 0.15 + 0.6 * extract, 4 + (1.6 - 4) * extract);
    if (this.potLid) uAxisAngle([1, 0, 0], this.cooking ? -6 * Math.abs(Math.sin(time * 7)) : 0, this.potLid.quaternion);   // Unity: localRotation = Euler(x, 0, 0)
    const on = this.level > 0; if (on && !this.motor.isPlaying) this.motor.play(); else if (!on && this.motor.isPlaying) this.motor.stop();
    this.motor.pitch = 0.6 + 0.25 * this.level; this.motor.volume = 0.04 + 0.04 * this.level; this.motor.apply();
    const blink = (time * 2.5) % 1 < 0.5;
    this.led(this.ledA, this.level > 0 && !this.boost); this.led(this.ledB, this.speed === 2 && !this.boost); this.led(this.ledC, this.boost ? blink : this.speed === 3); this.led(this.ledD, this.light > 0);
    for (const l of this.lamps) if (l) { l.visible = this.light > 0; l.intensity = (this.light === 2 ? 1.2 : 0.5) * 0.6; }
    if (this.lampLens) ledHdr(this.lampLens, this.light > 0 ? [1, 1, 1] : [0.6, 0.6, 0.6], [1, 1, 1], this.light === 2 ? 3 : this.light === 1 ? 1.2 : 0);
    this.filterT = moveTowards(this.filterT, this.filterIn ? 0 : 1, rdt * 2);
    if (this.greaseFilter) this.greaseFilter.position.copy(this.filterRest).add(new THREE.Vector3(0, -0.12 * this.filterT, 0.18 * this.filterT));
    this.updateStates();
  }
  led(node, lit) { ledHdr(node, lit ? [1, 1, 1] : [0.38, 0.38, 0.4], lit ? [1, 1, 1] : [0, 0, 0], lit ? 2 : 0); }

  updateStates() {
    this.setState('fan', this.boost ? 'boost' : String(this.speed));
    this.setState('light', this.light === 2 ? 'max' : this.light === 1 ? 'medium' : 'off');
    this.setState('boostMin', Math.ceil(f32(this.boostLeft / 60)));
    this.setState('cooking', this.cooking ? 'yes' : 'no');
    this.setState('haze', roundToInt(f32(this.haze * 100)));
    this.setState('filter', this.filterIn ? (this.filterClean ? 'clean' : 'in') : (this.filterStage === 2 ? 'cleaned' : 'out'));
    this.setState('ledA', this.level > 0 && !this.boost ? 'on' : 'off');
  }

  get statusText() {
    const f = this.boost ? `<b>Booster</b> ${clock(Math.trunc(this.boostLeft / 60), Math.trunc(this.boostLeft) % 60)} → back to ${this.speed === 0 ? 'off' : 'speed ' + this.speed}`
      : this.speed === 0 ? '<b>Motor off</b>' : `<b>Speed ${this.speed}</b>`;
    const l = this.light === 2 ? 'max' : this.light === 1 ? 'medium' : 'off';
    const hz = this.haze < 0.25 ? '#2E9E4F' : this.haze < 0.6 ? '#E0A020' : '#C0392B';
    const msg = this.message.length > 0 ? `\n<color=#C0392B>${this.message}</color>` : '';
    return `${f}   ${roundToInt(this.airflow[this.level])} m³/h   Light ${l}\nSteam <b><color=${hz}>${roundToInt(f32(this.haze * 100))} %</color></b>   Pot ${this.cooking ? 'boiling' : 'off'}   ` +
      `Grease filter ${this.filterIn ? 'fitted' : 'removed'}   ×${Math.round(this.simSpeed)} time${msg}`;
  }
  addState(list) { list.push(['simSpeed', String(Math.round(this.simSpeed))]); }
}

/** Soft steam puffs rising from a node (stands in for the Unity ParticleSystem; visual only). */
class SteamEmitter {
  constructor(node) {
    this.node = node; this.max = 160; this.parts = []; this.acc = 0;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.max * 3); this.alpha = new Float32Array(this.max); this.size = new Float32Array(this.max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1)); this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const tex = new THREE.CanvasTexture(cv);
    this.mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { map: { value: tex }, color: { value: new THREE.Color(0.85, 0.88, 0.92) } },
      vertexShader: 'attribute float alpha; attribute float size; varying float vA; void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * 900.0 / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform sampler2D map; uniform vec3 color; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(color, t.a * vA); }' });
    this.points = new THREE.Points(this.geo, this.mat); this.points.frustumCulled = false; node.add(this.points);
  }
  update(dt, rate, peakAlpha, rise, life) {
    this.acc += rate * dt;
    while (this.acc >= 1 && this.parts.length < this.max) { this.acc -= 1; this.parts.push({ x: (Math.random() - 0.5) * 0.08, y: 0, z: (Math.random() - 0.5) * 0.08, vx: (Math.random() - 0.5) * 0.03, vz: (Math.random() - 0.5) * 0.03, age: 0, life }); }
    if (this.acc >= 1) this.acc = 0;
    this.parts = this.parts.filter(p => (p.age += dt) < p.life);
    this.parts.forEach((p, i) => {
      p.x += p.vx * dt; p.z += p.vz * dt; p.y += rise * dt;
      const u = p.age / p.life, a = u < 0.15 ? u / 0.15 * peakAlpha : peakAlpha * (1 - (u - 0.15) / 0.85);
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; this.alpha[i] = a; this.size[i] = 0.06 + 0.12 * u;
    });
    this.geo.setDrawRange(0, this.parts.length);
    this.geo.attributes.position.needsUpdate = this.geo.attributes.alpha.needsUpdate = this.geo.attributes.size.needsUpdate = true;
  }
}

registerDevice('HoodController', HoodController);
