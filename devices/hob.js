// SMAKLIG / BLIXTSNABB induction hob - port of Runtime/Twin/Devices/HobController.cs + HobPot.cs + HobPlaceTarget.cs
// (keep in sync; parity_script.json + _unity_trace.json check it). 4 zones with touch sliders 0-9 + Boost, On/Off,
// Bridge (zones 1+2), timer per zone (- / +), Pause, OK / key lock. Pot detection ("U", zone off after 30 s without a
// pot), residual heat ("H"). One pot with 1.5 l water; heating runs at simSpeed x.
import { TwinDevice, registerDevice, registerControl, clamp, clamp01, uVec, colorOnly, roundToInt } from '../twin-core.js?v=6e9bd70d3f';

const f32 = Math.fround;
const WATTS = [0, 100, 200, 350, 550, 800, 1100, 1450, 1850, 2300], BOOST_WATTS = 3000;
const LED_ON = [1, 0.18, 0.1], LED_OFF = [0.12, 0.03, 0.03];
const ceilToInt = v => Math.ceil(f32(v));
const clock = (a, b) => String(a).padStart(2, '0') + ':' + String(b).padStart(2, '0');

class HobController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    this.zones = f.zones.map(z => ({ center: uVec(z.center), radius: z.radius, display: ctx.text(z.display), activeLed: n(z.activeLed), timerLed: n(z.timerLed),
      sliderRef: z.slider, slider: null, level: 0, boost: false, boostLeft: 0, timerLeft: 0, noPotTime: 0, glass: 0 }));
    Object.assign(this, { bridgeA: f.bridgeA, bridgeB: f.bridgeB, timerDisplay: ctx.text(f.timerDisplay), powerLed: n(f.powerLed), lockLed: n(f.lockLed), bridgeLed: n(f.bridgeLed),
      pot: n(f.pot), water: n(f.water), potPark: uVec(f.potPark), steam: (f.steam || []).map(n),
      simSpeed: f.simSpeed, ambient: f.ambient, waterKg: f.waterKg, efficiency: f.efficiency, lossWPerK: f.lossWPerK, boostMinutes: f.boostMinutes, noPotSeconds: f.noPotSeconds,
      on: f.on, locked: f.locked, paused: f.paused, resumePending: f.resumePending, bridge: f.bridge, carrying: f.carrying, potZone: f.potZone, selected: f.selected });
    this.potLift = 0; this.blink = 0; this.potT = 1; this.potFrom = null; this.potTo = null;
    // Awake
    this.waterTemp = this.ambient;
    for (const z of this.zones) z.glass = this.ambient;
    if (this.water) this.waterRest = this.water.position.y;
    if (this.pot) this.pot.position.copy(this.potPark);
    this.hum = this.makeLoop(180, 360, 0.05);
    this.updateStates(); this.refresh();
  }
  init() { for (const z of this.zones) z.slider = this.ctx.control(z.sliderRef, 'TwinSlider'); }

  inBridge(zi) { return this.bridge && (zi === this.bridgeA || zi === this.bridgeB); }
  hasPot(zi) {
    return (this.potZone === zi + 1 && !this.carrying) ||
      (this.inBridge(zi) && (this.potZone === this.bridgeA + 1 || this.potZone === this.bridgeB + 1) && !this.carrying);
  }
  power(z) { return z.boost ? BOOST_WATTS : WATTS[clamp(z.level, 0, 9)]; }

  onControl(c) {
    // pot handling works with the hob off or locked
    if (c === 'pot') { this.carrying = !this.carrying; if (this.carrying) { this.movePot(this.liftedAbove(this.potZone)); this.emit('pot:lift'); } else this.place(this.potZone); return; }
    if (c.startsWith('place:')) { if (this.carrying) this.place(parseInt(c.slice(6))); return; }

    if (c === 'power') {
      this.on = !this.on; this.paused = this.resumePending = false;
      if (!this.on) for (const z of this.zones) { z.level = 0; z.boost = false; z.timerLeft = 0; z.slider?.setIndexSilently(-1); }
      this.bridge = this.on && this.bridge; this.selected = -1;
      this.beep(this.on ? 1800 : 1200, 0.1); this.emit(this.on ? 'power:on' : 'power:off'); this.done(); return;
    }
    if (!this.on) { this.beep(500, 0.08, 0.15); return; }
    if (c === 'ok') { this.locked = !this.locked; this.beep(2200, 0.15); this.emit(this.locked ? 'lock:on' : 'lock:off'); this.done(); return; }
    if (this.locked) { this.beep(500, 0.08, 0.15); this.emit('locked'); return; }

    if (c === 'pause') {
      if (!this.paused) { this.paused = true; this.resumePending = false; this.emit('pause:on'); }
      else this.resumePending = true;                 // resume = Pause, then touch the slider of an active zone
      this.beep(1600, 0.06); this.done(); return;
    }
    const eq = c.indexOf('=');
    if (c.startsWith('level:')) {
      const zi = parseInt(c.slice(6, eq)) - 1, lv = parseInt(c.slice(eq + 1));
      if (this.paused) {
        if (this.resumePending && this.zones[zi].level > 0) { this.paused = this.resumePending = false; this.emit('pause:off'); this.zones[zi].slider?.setIndexSilently(this.zones[zi].level - 1); this.beep(1600, 0.05); this.done(); }
        return;
      }
      this.setLevel(zi, lv); this.selected = zi; this.beep(1500, 0.03, 0.15); this.emit(`zone${zi + 1}:level`); this.done(); return;
    }
    if (this.paused) return;
    if (c.startsWith('off:')) { const zi = parseInt(c.slice(4)) - 1; this.setLevel(zi, 0); this.selected = zi; this.beep(1500, 0.03, 0.15); this.emit(`zone${zi + 1}:off`); this.done(); return; }
    if (c.startsWith('boost:')) {
      const zi = parseInt(c.slice(6)) - 1;
      for (const k of this.linked(zi)) { const z = this.zones[k]; z.boost = true; z.boostLeft = f32(this.boostMinutes * 60); z.level = 9; z.noPotTime = 0; z.slider?.setIndexSilently(8); }
      this.selected = zi; this.beep(1700, 0.05); this.emit(`zone${zi + 1}:boost`); this.done(); return;
    }
    if (c === 'bridge') {
      this.bridge = !this.bridge;
      if (this.bridge) { const lv = Math.max(this.zones[this.bridgeA].level, this.zones[this.bridgeB].level); this.setLevel(this.bridgeA, lv); }
      this.beep(1500, 0.05); this.emit(this.bridge ? 'bridge:on' : 'bridge:off'); this.done(); return;
    }
    if (c === 'timer+' || c === 'timer-') {
      if (this.selected < 0 || this.zones[this.selected].level === 0) { this.beep(500, 0.08, 0.15); this.emit('timer:nozone'); return; }
      const z = this.zones[this.selected];
      const m = ceilToInt(z.timerLeft / 60 - 0.001) + (c === 'timer+' ? 1 : -1);
      z.timerLeft = clamp(m, 0, 99) * 60;
      this.beep(1500, 0.03, 0.15); this.emit(z.timerLeft > 0 ? 'timer:set' : 'timer:off'); this.done(); return;
    }
    if (c === 'auto') { this.beep(500, 0.08, 0.15); this.emit('auto:na'); return; }
    if (c === 'timersel') {
      // step through the zones that are switched on
      for (let k = 1; k <= this.zones.length; k++) { const zi = ((this.selected < 0 ? -1 : this.selected) + k) % this.zones.length; if (this.zones[zi].level > 0) { this.selected = zi; break; } }
      this.beep(1500, 0.03, 0.15); this.emit('timer:select'); this.done(); return;
    }
  }

  linked(zi) { return this.inBridge(zi) ? [this.bridgeA, this.bridgeB] : [zi]; }
  setLevel(zi, lv) {
    for (const k of this.linked(zi)) {
      const z = this.zones[k]; z.level = lv; z.boost = false; z.noPotTime = 0;
      if (lv === 0) z.timerLeft = 0;
      z.slider?.setIndexSilently(lv > 0 ? lv - 1 : -1);
    }
  }
  zonePos(zi) { return zi <= 0 ? this.potPark : this.zones[zi - 1].center; }
  liftedAbove(zi) { return this.zonePos(zi).clone().setY(this.zonePos(zi).y + 0.09); }
  movePot(to) { if (!this.pot) return; this.potFrom = this.pot.position.clone(); this.potTo = to.clone(); this.potT = 0; }
  place(zi) { this.carrying = false; this.potZone = zi; this.movePot(this.zonePos(zi)); this.emit(zi === 0 ? 'pot:worktop' : `pot:zone${zi}`); this.done(); }
  done() { this.updateStates(); this.refresh(); }

  update(rdt) {
    const dt = f32(rdt * this.simSpeed), time = this.ctx.time;
    let heat = 0;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const active = this.on && !this.paused && z.level > 0;
      if (active && !this.hasPot(i)) {
        z.noPotTime = f32(z.noPotTime + rdt);                      // real seconds, as on the appliance
        if (z.noPotTime > this.noPotSeconds) { this.setLevel(i, 0); this.emit(`zone${i + 1}:nopot-off`); this.beep(900, 0.3); }
      } else z.noPotTime = 0;
      if (active && z.boost) { z.boostLeft = f32(z.boostLeft - dt); if (z.boostLeft <= 0) { z.boost = false; this.emit(`zone${i + 1}:boost-end`); } }
      if (this.on && !this.paused && z.timerLeft > 0 && z.level > 0) {
        z.timerLeft = f32(z.timerLeft - dt);
        if (z.timerLeft <= 0) { z.timerLeft = 0; this.setLevel(i, 0); this.emit(`zone${i + 1}:timer-done`); this.ring(); }
      }
      if (active && this.hasPot(i) && this.potZone === i + 1) heat += this.power(z) * this.efficiency;
      else if (active && this.hasPot(i) && this.inBridge(i)) heat += this.power(z) * this.efficiency * 0.5;
      // glass under the pot follows the pot base, otherwise cools down (residual heat "H")
      const target = this.hasPot(i) && !this.carrying ? this.ambient + (this.waterTemp - this.ambient) * 0.85 : this.ambient;
      z.glass = f32(z.glass + (target - z.glass) * (1 - Math.exp(-dt / (this.hasPot(i) ? 60 : 420))));
    }
    // water: P = m c dT/dt + losses, clamped at boiling
    const loss = (this.waterTemp - this.ambient) * this.lossWPerK;
    if (this.carrying || this.potZone === 0) heat = 0;
    this.waterTemp = f32(this.waterTemp + (heat - loss) / (this.waterKg * 4186) * dt);
    this.waterTemp = clamp(this.waterTemp, this.ambient - 1, 100);

    // pot motion + boiling visuals
    if (this.pot && this.potT < 1) {
      this.potT = Math.min(1, this.potT + rdt * 2.5); const k = this.potT * this.potT * (3 - 2 * this.potT);
      this.pot.position.lerpVectors(this.potFrom, this.potTo, k); this.pot.position.y += Math.sin(k * Math.PI) * 0.03;
    }
    const boil = clamp01((this.waterTemp - 88) / 12) * (heat > 400 ? 1 : 0.3);
    if (this.water) this.water.position.y = this.waterRest + Math.sin(time * 30) * 0.0012 * boil;
    for (let i = 0; i < this.steam.length; i++) {
      const s = this.steam[i]; if (!s) continue;
      const show = boil > 0.05; s.visible = show;
      if (!show) continue;
      const ph = (time * 0.35 + i / this.steam.length) % 1, a = i * 2.4;
      s.position.set(-Math.cos(a) * 0.04 * ph, 0.12 + ph * 0.25, Math.sin(a) * 0.04 * ph);   // Unity local, x mirrored
      s.scale.setScalar((0.015 + (0.06 - 0.015) * ph) * boil);
    }
    const anyHeat = heat > 0; if (anyHeat && !this.hum.isPlaying) this.hum.play(); else if (!anyHeat && this.hum.isPlaying) this.hum.stop();
    this.blink = f32(this.blink + rdt);
    this.updateStates(); this.refresh();
  }

  ring() { if (this.ctx.muted) return; for (let i = 0; i < 5; i++) setTimeout(() => this.beep(2600, 0.12, 0.3), i * 250); }

  refresh() {
    const flash = (this.blink % 0.8) < 0.5;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i]; if (!z.display) continue;
      let s;
      if (!this.on) s = z.glass > 50 ? 'H' : '';
      else if (this.paused) s = 'II';
      else if (z.level > 0 && !this.hasPot(i)) s = flash ? 'U' : '';
      else if (z.boost) s = 'b';
      else if (z.level > 0) s = String(z.level);
      else s = z.glass > 50 ? 'H' : '0';
      z.display.text = s;
      colorOnly(z.activeLed, this.on && this.selected === i ? LED_ON : LED_OFF);
      colorOnly(z.timerLed, this.on && z.timerLeft > 0 ? LED_ON : LED_OFF);
    }
    if (this.timerDisplay) {
      const z = this.selected >= 0 ? this.zones[this.selected] : null;
      this.timerDisplay.text = !this.on ? '' : z && z.timerLeft > 0 ? String(ceilToInt(z.timerLeft / 60 - 0.001)).padStart(2, '0') : (this.on ? '--' : '');
    }
    colorOnly(this.powerLed, this.on ? LED_ON : LED_OFF); colorOnly(this.lockLed, this.locked ? LED_ON : LED_OFF); colorOnly(this.bridgeLed, this.on && this.bridge ? LED_ON : LED_OFF);
  }

  updateStates() {
    this.setState('power', this.on ? 'on' : 'off');
    this.setState('locked', this.locked ? 'yes' : 'no');
    this.setState('paused', this.paused ? 'yes' : 'no');
    this.setState('bridge', this.bridge ? 'on' : 'off');
    this.setState('potZone', this.carrying ? -1 : this.potZone);
    this.setState('waterTemp', roundToInt(this.waterTemp));
    this.setState('boiling', this.waterTemp >= 99.5 ? 'yes' : 'no');
    this.setState('selectedZone', this.selected + 1);
    this.setState('selTimer', this.selected >= 0 ? ceilToInt(this.zones[this.selected].timerLeft / 60 - 0.001) : 0);
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      this.setState(`z${i + 1}`, z.boost ? 'B' : String(z.level));
      this.setState(`z${i + 1}Timer`, ceilToInt(z.timerLeft / 60 - 0.001));
      this.setState(`z${i + 1}Residual`, z.glass > 50 ? 'yes' : 'no');
    }
  }

  get statusText() {
    const wt = roundToInt(this.waterTemp), sim = String(Math.round(this.simSpeed));
    if (!this.on && !this.carrying) {
      let h = ''; for (let i = 0; i < this.zones.length; i++) if (this.zones[i].glass > 50) h += ` ${i + 1}`;
      return `<b>Hob off</b>${h !== '' ? `  -  residual heat H on zone${h}` : ''}\nPot: ${this.potText()}   Water <b>${wt} °C</b>   ×${sim} time`;
    }
    let s = this.on ? '<b>On</b>' : '<b>Off</b>';
    if (this.locked) s += '  <color=#C0392B>locked</color>';
    if (this.paused) s += this.resumePending ? '  paused - touch a zone slider to resume' : '  paused';
    if (this.bridge) s += `  Bridge ${this.bridgeA + 1}+${this.bridgeB + 1}`;
    s += '\n';
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      s += `Z${i + 1} <b>${z.boost ? 'Boost' : z.level}</b>`;
      if (z.timerLeft > 0) s += ` timer ${clock(Math.trunc(z.timerLeft / 60), Math.trunc(z.timerLeft) % 60)}`;
      if (z.level > 0 && !this.hasPot(i)) s += ' <color=#C0392B>no pot</color>';
      s += i < this.zones.length - 1 ? '   ' : '';
    }
    s += `\nPot: ${this.potText()}   Water <b>${wt} °C</b>${this.waterTemp >= 99.5 ? ' boiling' : ''}   ×${sim} time`;
    return s;
  }
  potText() { return this.carrying ? 'in your hand - click a zone or the worktop' : this.potZone === 0 ? 'on the worktop' : `zone ${this.potZone}`; }
  addState(list) { list.push(['simSpeed', String(Math.round(this.simSpeed))]); }
}

class HobPot {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return this.device?.carrying ? 'Put the pot back' : 'Pick up the pot'; }
  onClicked() { this.device?.onControl('pot'); }
}

class HobPlaceTarget {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { const z = this.f.zone; return this.device?.carrying ? (z === 0 ? 'Put the pot on the worktop' : `Put the pot on zone ${z}`) : (z === 0 ? 'Worktop' : `Cooking zone ${z}`); }
  onClicked() { this.device?.onControl('place:' + this.f.zone); }
}

registerDevice('HobController', HobController);
registerControl('HobPot', HobPot);
registerControl('HobPlaceTarget', HobPlaceTarget);
