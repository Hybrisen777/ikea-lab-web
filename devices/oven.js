// MATTRADITION built-in oven - port of Runtime/Twin/Devices/OvenController.cs + OvenTray.cs (keep in sync;
// parity_script.json + _unity_trace.json check it). Selection knob A, minute-minder knob B, thermostat knob C,
// thermostat LED D (on while the elements heat), bottom-hinged door, fan, grill element, lamp, removable tray.
// Cavity temperature is a first-order model at simSpeed x real time.
import { TwinDevice, registerDevice, registerControl, moveTowards, roundToInt, uVec, uAxisAngle, srgbLerp, ledHdr } from '../twin-core.js?v=6c4f3aae27';

const f32 = Math.fround;
const F = ['Off', 'ForcedAir', 'Conventional', 'Grill', 'GrillFan', 'ConvectionBake', 'Defrost', 'Light'];
const NAMES = ['Off', 'Forced air', 'Conventional', 'Grill', 'Grill + fan', 'Convection bake', 'Defrost', 'Light'];
const smooth = x => x * x * (3 - 2 * x);
const clock = (a, b) => String(a).padStart(2, '0') + ':' + String(b).padStart(2, '0');

class OvenController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    Object.assign(this, { refs: { selector: f.selector, thermostat: f.thermostat, timer: f.timer, door: f.door },
      fan: n(f.fan), tray: n(f.tray), grillElement: n(f.grillElement), led: n(f.led), lamp: ctx.light(f.lamp), glow: ctx.light(f.glow),
      simSpeed: f32(f.simSpeed), ambient: f32(f.ambient), heatRate: f32(f.heatRate), lossRate: f32(f.lossRate), doorLossFactor: f32(f.doorLossFactor), hysteresis: f32(f.hysteresis),
      trayPath: (f.trayPath || []).map(uVec), fn: Math.max(0, F.indexOf(f.function)), setTemp: f.setTemp, heating: f.heating, preheated: f.preheated,
      trayInside: f.trayInside, timerLeft: f32(f.timerLeft) });
    this.lastTimerSetting = 0; this.fanSpeed = 0; this.glowLevel = 0; this.trayT = 0; this.doorOpen = false;
    // Awake
    this.temp = this.ambient;
    this.fanHum = this.makeLoop(95, 190, 0.12);
    if (this.tray && this.trayPath.length > 0) this.tray.position.copy(this.trayPath[0]);
    this.updateStates();
  }
  init() { const c = this.ctx; this.timer = c.control(this.refs.timer, 'TwinKnob'); this.door = c.control(this.refs.door, 'TwinHinge'); }

  get function() { return F[this.fn]; }
  get hasFan() { return ['ForcedAir', 'GrillFan', 'ConvectionBake', 'Defrost'].includes(this.function); }
  get heatsElements() { return ['ForcedAir', 'Conventional', 'Grill', 'GrillFan', 'ConvectionBake'].includes(this.function); }
  get usesGrill() { return this.function === 'Grill' || this.function === 'GrillFan'; }

  onControl(c) {
    const eq = c.indexOf('=');
    if (eq > 0) {
      const key = c.slice(0, eq), v = c.slice(eq + 1);
      switch (key) {
        case 'function': {
          const i = NAMES.indexOf(v);
          if (i >= 0 && i !== this.fn) { this.fn = i; this.beep(1400, 0.03, 0.15); this.emit('function:' + this.function); if (this.function === 'Off') this.preheated = false; }
          break;
        }
        case 'thermostat': {
          const t = v === 'Off' ? 0 : parseInt(v);
          if (t !== this.setTemp) { this.setTemp = t; this.preheated = false; this.beep(1400, 0.03, 0.15); this.emit('thermostat:' + t); }
          break;
        }
        case 'timer': {
          const m = parseInt(v);
          if (m !== this.lastTimerSetting) {
            // the minute minder is wound up: only a change of setting resets the remaining time
            this.lastTimerSetting = m; this.timerLeft = f32(m * 60);
            this.beep(1400, 0.03, 0.15); this.emit(m > 0 ? 'timer:set' : 'timer:off');
          }
          break;
        }
      }
    } else if (c === 'door:open') { this.doorOpen = true; this.emit('door:open'); }
    else if (c === 'door:close') { this.doorOpen = false; this.emit('door:close'); }
    else if (c === 'tray') {
      if (!this.doorOpen && this.door) { this.beep(400, 0.15, 0.25); this.emit('tray:blocked'); }
      else { this.trayInside = !this.trayInside; this.emit(this.trayInside ? 'tray:in' : 'tray:out'); }
    }
    this.updateStates();
  }

  update(rdt) {
    const dt = f32(rdt * this.simSpeed);
    // thermostat with hysteresis; LED D shows "elements heating"
    const canHeat = this.heatsElements && this.setTemp > 0;
    if (!canHeat) this.heating = false;
    else if (this.heating && this.temp >= this.setTemp) { this.heating = false; if (!this.preheated) { this.preheated = true; this.emit('preheated'); this.beep(2200, 0.08, 0.2); } }
    else if (!this.heating && this.temp < this.setTemp - this.hysteresis) this.heating = true;

    // float32 per operation, as C#
    const power = this.heating ? f32(this.heatRate * (this.usesGrill && this.function === 'Grill' ? f32(0.8) : 1)) : 0;
    const loss = f32(f32(this.lossRate * (this.doorOpen ? this.doorLossFactor : 1)) * (this.hasFan ? f32(1.15) : 1));
    this.temp = f32(this.temp + f32(f32(power - f32(f32(this.temp - this.ambient) * loss)) * dt));

    // minute minder (independent of the oven, does not switch it off)
    if (this.timerLeft > 0) {
      this.timerLeft = f32(this.timerLeft - dt);
      if (this.timerLeft <= 0) { this.timerLeft = 0; this.lastTimerSetting = 0; this.timer?.setIndexSilently(0); this.emit('timer:done'); this.ring(); }
      else this.timer?.setIndexSilently(this.knobIndexFor(f32(this.timerLeft / 60)));
    }

    // visuals
    this.fanSpeed = moveTowards(this.fanSpeed, this.hasFan ? 1 : 0, rdt * 1.5);
    if (this.fan) this.fan.quaternion.multiply(uAxisAngle([0, 0, 1], this.fanSpeed * 1400 * rdt));
    if (this.fanSpeed > 0.01 && !this.fanHum.isPlaying) this.fanHum.play(); else if (this.fanSpeed <= 0.01 && this.fanHum.isPlaying) this.fanHum.stop();
    this.fanHum.pitch = 0.6 + 0.4 * this.fanSpeed; this.fanHum.apply();
    this.glowLevel = moveTowards(this.glowLevel, this.heating && this.usesGrill ? 1 : 0, rdt * 0.6);
    if (this.grillElement) srgbLerp(this.grillElement, [0.25, 0.25, 0.27], [1, 0.3, 0.05], this.glowLevel, [1, 0.25, 0.02], this.glowLevel * 3);
    if (this.glow) { this.glow.visible = this.glowLevel > 0.02; this.glow.intensity = this.glowLevel * 0.25 * 0.6; }
    if (this.led) ledHdr(this.led, this.heating ? [1, 0.55, 0.1] : [0.18, 0.09, 0.03], this.heating ? [1, 0.45, 0.05] : [0, 0, 0], 2.5);
    if (this.lamp) this.lamp.visible = this.function !== 'Off';
    if (this.tray && this.trayPath.length > 1) {
      this.trayT = moveTowards(this.trayT, this.trayInside ? 1 : 0, rdt * 0.9);
      const u = this.trayT * (this.trayPath.length - 1), k = Math.min(Math.trunc(u), this.trayPath.length - 2);
      this.tray.position.lerpVectors(this.trayPath[k], this.trayPath[k + 1], smooth(u - k));
    }
    this.updateStates();
  }

  knobIndexFor(minutes) {
    // show the smallest marked position that still covers the remaining time
    const p = this.timer.f.positions;
    for (let i = 0; i < p.length; i++) if (parseInt(p[i]) >= f32(minutes - f32(0.01))) return i;
    return p.length - 1;
  }
  ring() { if (this.ctx.muted) return; for (let i = 0; i < 6; i++) setTimeout(() => this.beep(2600, 0.12, 0.35), i * 250); }

  updateStates() {
    this.setState('function', this.function);
    this.setState('setTemp', this.setTemp);
    this.setState('temp', roundToInt(this.temp));
    this.setState('led', this.heating ? 'on' : 'off');
    this.setState('preheated', this.preheated ? 'yes' : 'no');
    this.setState('fan', this.hasFan ? 'on' : 'off');
    this.setState('lamp', this.function !== 'Off' ? 'on' : 'off');
    this.setState('timerMin', Math.ceil(f32(this.timerLeft / 60)));
    this.setState('door', this.doorOpen ? 'open' : 'closed');
    this.setState('tray', this.trayInside ? 'inside' : 'outside');
  }

  get statusText() {
    const f = NAMES[this.fn], t = this.setTemp > 0 ? this.setTemp + ' °C' : 'thermostat off';
    const led = this.heating ? '<color=#FF9A2E>● heating</color>' : (this.preheated ? '● ready' : '○ off');
    const tm = this.timerLeft > 0 ? `   Minder <b>${clock(Math.trunc(this.timerLeft / 60), Math.trunc(this.timerLeft) % 60)}</b>` : '';
    const warn = this.heatsElements && this.setTemp === 0 ? '\n<color=#C0392B>Set the thermostat (C) - the elements stay off at 0.</color>' :
      (!this.heatsElements && this.setTemp > 0 && this.function !== 'Off' ? `\n<color=#888>${f} does not heat.</color>` : '');
    return `<b>${f}</b>  |  ${t}\nCavity <b>${roundToInt(this.temp)} °C</b>   LED ${led}${tm}\nDoor ${this.doorOpen ? 'open' : 'closed'}   Tray ${this.trayInside ? 'inside' : 'outside'}   ×${Math.round(this.simSpeed)} time${warn}`;
  }
  addState(list) { list.push(['simSpeed', String(Math.round(this.simSpeed))]); }
}

class OvenTray {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return this.device?.trayInside ? 'Take out the baking tray' : 'Put the baking tray in (level 2)'; }
  onClicked() { this.device?.onControl('tray'); }
}

registerDevice('OvenController', OvenController);
registerControl('OvenTray', OvenTray);
