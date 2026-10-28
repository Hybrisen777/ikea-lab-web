// STARKVIND air purifier - port of Runtime/Twin/Devices/StarkvindController.cs + StarkvindKnob.cs (keep in sync;
// parity_script.json + _unity_trace.json check it). Knob: press = Auto / Off, turn = fixed speed 1-5, long press =
// control lock. Auto follows PM2.5 (good 0-35, OK 36-85, not good 86+ µg/m³). Room: one well-mixed room, particle
// source (candle) + decay through the filter (CADR per speed). Filter change: unplug, cover off, filter out / new,
// cover on, plug in, hold RESET 3 s.
import * as THREE from 'three';
import { TwinDevice, registerDevice, registerControl, clamp, lerp, moveTowards, roundToInt, uVec, uAxisAngle, led, fmt0 } from '../twin-core.js?v=edef65954c';

const Mode = { Off: 'Off', Auto: 'Auto', Manual: 'Manual' };
export const quality = pm => pm <= 35 ? 'good' : pm <= 85 ? 'ok' : 'notgood';

class StarkvindController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    this.fan = n(f.fan); this.frontCover = n(f.frontCover); this.filter = n(f.filter); this.candleFlame = n(f.candleFlame); this.plug = n(f.plug);
    this.speedLeds = (f.speedLeds || []).map(n); this.autoLed = n(f.autoLed); this.filterLed = n(f.filterLed); this.lockLed = n(f.lockLed);
    this.coverOpenOffset = uVec(f.coverOpenOffset); this.filterOutOffset = uVec(f.filterOutOffset); this.plugOutOffset = uVec(f.plugOutOffset);
    this.fanAxis = f.fanAxis;
    Object.assign(this, { simSpeed: f.simSpeed, roomVolume: f.roomVolume, ambientPm: f.ambientPm, cadr: f.cadr, candleEmission: f.candleEmission,
      ventilation: f.ventilation, filterHours: f.filterHours, filterLife: f.filterLife });
    this.mode = Mode[f.mode] || Mode.Off; this.speed = f.speed; this.fanSpeed = f.fanSpeed;
    Object.assign(this, { locked: f.locked, plugged: f.plugged, coverOpen: f.coverOpen, filterIn: f.filterIn, filterNew: f.filterNew, candleLit: f.candleLit });
    this.fanShown = 0; this.coverT = 0; this.filterT = 0; this.lockBlink = 0; this.message = ''; this.msgTime = 0;
    // Awake
    this.pm = this.ambientPm;
    this.coverRest = this.frontCover?.position.clone(); this.filterRest = this.filter?.position.clone(); this.plugRest = this.plug?.position.clone();
    this.flameScale = this.candleFlame ? this.candleFlame.scale.clone() : new THREE.Vector3(1, 1, 1);
    this.hum = this.makeLoop(110, 220, 0.1);
    this.updateStates();
  }

  get powered() { return this.plugged && this.coverClosedAndFilter; }
  get coverClosedAndFilter() { return !this.coverOpen && this.filterIn; }
  get filterWarn() { return this.filterLife <= 0.05; }

  onControl(c) {
    const knob = c === 'press' || c === 'turn+' || c === 'turn-' || c === 'lock';
    if (knob && !this.powered) return;
    if (knob && this.locked && c !== 'lock') { this.lockBlink = 1.2; this.emit('locked:ignored'); this.updateStates(); return; }
    switch (c) {
      case 'press':
        this.mode = this.mode === Mode.Off ? Mode.Auto : Mode.Off; this.beep(1800, 0.05, 0.15);
        this.emit(this.mode === Mode.Auto ? 'mode:auto' : 'mode:off'); break;
      case 'turn+':
      case 'turn-':
        if (this.mode === Mode.Manual) this.speed = clamp(this.speed + (c === 'turn+' ? 1 : -1), 1, 5);
        else this.speed = c === 'turn+' ? 1 : 5;
        this.mode = Mode.Manual; this.beep(1600, 0.03, 0.1); this.emit('speed:' + this.speed); break;
      case 'lock':
        this.locked = !this.locked; this.beep(this.locked ? 1200 : 2000, 0.15, 0.2); this.emit(this.locked ? 'lock:on' : 'lock:off'); break;
      case 'candle':
        this.candleLit = !this.candleLit; this.emit(this.candleLit ? 'candle:lit' : 'candle:out'); break;
      case 'reset':
        if (!this.plugged) break;
        if (this.filterNew) { this.filterLife = 1; this.filterNew = false; this.beep(2000, 0.2, 0.2); this.emit('filter:reset'); }
        else { this.beep(1200, 0.05, 0.1); this.emit('filter:reset-ignored'); }
        break;
      case 'plug':
        this.plugged = !this.plugged; if (!this.plugged) { this.mode = Mode.Off; this.locked = false; }
        this.emit(this.plugged ? 'plug:in' : 'plug:out'); break;
      case 'cover':
        if (this.plugged && !this.coverOpen) { this.beep(500, 0.15, 0.2); this.flash('Disconnect the power first'); this.emit('cover:blocked'); break; }
        this.coverOpen = !this.coverOpen; this.emit(this.coverOpen ? 'cover:open' : 'cover:closed'); break;
      case 'filter':
        if (!this.coverOpen) break;
        if (this.filterIn) { this.filterIn = false; this.emit('filter:out'); }
        else { this.filterIn = true; this.filterNew = true; this.emit('filter:new'); }
        break;
    }
    this.updateStates();
  }

  flash(m) { this.message = m; this.msgTime = 2.5; }

  update(dt) {
    const time = this.ctx.time;
    const dtMin = dt * this.simSpeed / 60;   // simulated minutes
    if (!this.powered && this.mode !== Mode.Off) this.mode = Mode.Off;
    if (this.mode === Mode.Auto) this.fanSpeed = this.pm <= 35 ? (this.pm <= 12 ? 1 : 2) : this.pm <= 85 ? 3 : 5;
    else this.fanSpeed = this.mode === Mode.Manual ? this.speed : 0;

    const q = this.fanSpeed > 0 ? this.cadr[this.fanSpeed - 1] * (this.filterIn ? lerp(0.6, 1, this.filterLife) : 0) : 0;   // m³/h
    const src = this.candleLit ? this.candleEmission : 0;
    this.pm += (src - (this.pm - this.ambientPm) * (q + this.ventilation) / 60) / this.roomVolume * dtMin;
    this.pm = Math.max(this.ambientPm * 0.5, this.pm);
    if (this.fanSpeed > 0) this.filterLife = Math.max(0, this.filterLife - dtMin / 60 / this.filterHours * (0.5 + this.fanSpeed * 0.2));
    if (this.msgTime > 0) { this.msgTime -= dt; if (this.msgTime <= 0) this.message = ''; }
    if (this.lockBlink > 0) this.lockBlink -= dt;

    // visuals
    this.fanShown = moveTowards(this.fanShown, this.fanSpeed / 5, dt * 0.8);
    if (this.fan) this.fan.quaternion.multiply(uAxisAngle(this.fanAxis, this.fanShown * 2200 * dt));
    if (this.fanShown > 0.01 && !this.hum.isPlaying) this.hum.play(); else if (this.fanShown <= 0.01 && this.hum.isPlaying) this.hum.stop();
    this.hum.pitch = 0.5 + 0.7 * this.fanShown; this.hum.volume = 0.03 + 0.12 * this.fanShown; this.hum.apply();
    this.coverT = moveTowards(this.coverT, this.coverOpen ? 1 : 0, dt * 2);
    if (this.frontCover) this.frontCover.position.copy(this.coverRest).addScaledVector(this.coverOpenOffset, this.coverT);
    this.filterT = moveTowards(this.filterT, this.filterIn ? 0 : 1, dt * 2);
    if (this.filter) this.filter.position.copy(this.filterRest).addScaledVector(this.filterOutOffset, this.filterT);
    if (this.plug) this.plug.position.copy(this.plugRest).add(this.plugged ? new THREE.Vector3() : this.plugOutOffset);
    if (this.candleFlame) {
      this.candleFlame.visible = this.candleLit;
      if (this.candleLit) this.candleFlame.scale.copy(this.flameScale).multiplyScalar(0.9 + 0.15 * noise(time * 8));
    }
    const blinkOn = (time * 3) % 1 < 0.5;
    for (let i = 0; i < this.speedLeds.length; i++) led(this.speedLeds[i], this.powered && this.fanSpeed > i && !(this.lockBlink > 0 && !blinkOn), [1, 1, 1]);
    led(this.autoLed, this.powered && this.mode === Mode.Auto, [1, 1, 1]);
    led(this.filterLed, this.powered && this.filterWarn, [1, 0.6, 0.1]);
    led(this.lockLed, this.powered && this.locked, [1, 1, 1]);
    this.updateStates();
  }

  updateStates() {
    this.setState('mode', this.mode === Mode.Manual ? String(this.speed) : this.mode.toLowerCase());
    this.setState('fanSpeed', this.fanSpeed);
    this.setState('pm25', roundToInt(this.pm));
    this.setState('quality', quality(this.pm));
    this.setState('locked', this.locked ? 'yes' : 'no');
    this.setState('plugged', this.plugged ? 'yes' : 'no');
    this.setState('cover', this.coverOpen ? 'open' : 'closed');
    this.setState('filter', this.filterIn ? (this.filterNew ? 'new' : 'in') : 'out');
    this.setState('filterLife', roundToInt(this.filterLife * 100));
    this.setState('filterLed', this.filterWarn ? 'on' : 'off');
    this.setState('candle', this.candleLit ? 'lit' : 'out');
  }

  get statusText() {
    const m = !this.powered ? (this.plugged ? '<color=#C0392B>Cover open / no filter</color>' : 'Unplugged') :
      this.mode === Mode.Off ? 'Off' : this.mode === Mode.Auto ? `Auto (speed ${this.fanSpeed})` : `Speed ${this.speed}`;
    const ql = quality(this.pm), qc = ql === 'good' ? '#2E9E4F' : ql === 'ok' ? '#E0A020' : '#C0392B';
    const qt = ql === 'good' ? 'good' : ql === 'ok' ? 'OK' : 'not good';
    const extra = (this.locked ? '   <b>Locked</b>' : '') + (this.filterWarn ? '   <color=#E08A20>● check filter</color>' : '');
    const msg = this.message.length > 0 ? `\n<color=#C0392B>${this.message}</color>` : '';
    return `<b>${m}</b>${extra}\nPM2.5 <b><color=${qc}>${roundToInt(this.pm)} µg/m³ (${qt})</color></b>   Candle ${this.candleLit ? 'lit' : 'out'}\n` +
      `Filter ${this.filterIn ? roundToInt(this.filterLife * 100) + ' %' : 'removed'}   Cover ${this.coverOpen ? 'open' : 'closed'}   ×${fmt0(this.simSpeed)} time${msg}`;
  }

  addState(list) { list.push(['simSpeed', fmt0(this.simSpeed)]); }
}

/** Smooth 1D noise in [0, 1] (stands in for Mathf.PerlinNoise on the candle flame; visual only). */
function noise(x) { const i = Math.floor(x), f = x - i, h = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }; const u = f * f * (3 - 2 * f); return h(i) * (1 - u) + h(i + 1) * u; }

/** Knob: press = Auto / Off, turn (wheel) = fan speed 1-5, long press = control lock. */
class StarkvindKnob {
  constructor(node, f, device) {
    Object.assign(this, { node, f, device });
    this.rest = node.quaternion.clone(); this.restPos = node.position.clone(); this.angle = 0; this.shown = 0; this.pressT = 0; this.fired = false;
  }
  get label() { return `${this.f.label} (click: Auto / Off, wheel: speed 1-5, hold ${fmt0(this.f.lockHold)} s: lock)`; }
  onClicked() { this.pressT = 0.15; this.fired = false; this.device?.onControl('press'); }
  onScroll(dir) { this.angle += dir * this.f.stepAngle; this.device?.onControl(dir > 0 ? 'turn+' : 'turn-'); }
  onHold(s) { this.pressT = 0.15; if (!this.fired && s >= this.f.lockHold) { this.fired = true; this.device?.onControl('lock'); } }
  onRelease() { this.fired = false; }
  update(dt) {
    this.shown = moveTowards(this.shown, this.angle, 720 * dt);
    this.node.quaternion.copy(this.rest).multiply(uAxisAngle(this.f.localAxis, this.shown));
    this.node.position.copy(this.restPos); if (this.pressT > 0) this.node.position.add(uVec(this.f.pressTravel));
    if (this.pressT > 0) this.pressT -= dt;
  }
}

registerDevice('StarkvindController', StarkvindController);
registerControl('StarkvindKnob', StarkvindKnob);
