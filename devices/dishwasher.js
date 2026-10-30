// KALLBODA / TORSBODA integrated dishwasher - port of Runtime/Twin/Devices/DishwasherController.cs + DishwasherBasket.cs
// (keep in sync; parity_script.json + _unity_trace.json check it). Keys on the top edge of the door: programmes,
// options, delayed start, Start (then close the door within startWindow s); Time Beam on the floor; pull-out baskets
// that can be loaded; detergent dispenser, rinse aid, special salt. A programme runs at simSpeed x real time.
import { TwinDevice, registerDevice, registerControl, clamp, moveTowards, roundToInt, uAxisAngle, colorOnly, CsHashSet } from '../twin-core.js?v=1964ee872d';
import * as THREE from 'three';

const f32 = Math.fround;
const ALL = [
  ['Intensive', 'Intensive 70°', 165, 70], ['Auto', 'Auto 45-65°', 150, 65], ['Eco', 'Eco 50°', 225, 50], ['Glass', 'Glass 40°', 110, 40],
  ['Quick', 'Quick 45°', 29, 45], ['Silent', 'Silent 50°', 235, 50], ['MachineCare', 'Machine Care 70°', 120, 70], ['PreRinse', 'Pre-rinse', 15, 0],
].map(([id, name, minutes, temp]) => ({ id, name, minutes, temp }));
const OPTION_NAMES = { HalfLoad: 'Half Load', QuickPlus: 'Quick Plus', ExtraDry: 'ExtraDry', IntensiveZone: 'IntensiveZone' };
const find = id => ALL.find(p => p.id === id) || ALL[0];
const smooth = x => x * x * (3 - 2 * x);
const ceilToInt = v => Math.ceil(f32(v));
const FORWARD = new THREE.Vector3(0, 0, 1);   // Unity Vector3.forward (z is not mirrored)

class DishwasherController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    Object.assign(this, { programmeIds: f.programmeIds, optionIds: f.optionIds, doorRef: f.door,
      lowerBasket: n(f.lowerBasket), upperBasket: n(f.upperBasket), cutleryDrawer: n(f.cutleryDrawer), sprayLower: n(f.sprayLower), sprayUpper: n(f.sprayUpper),
      dispenserLid: n(f.dispenserLid), platesLower: n(f.platesLower), cupsUpper: n(f.cupsUpper),
      display: ctx.text(f.display), timeBeam: ctx.text(f.timeBeam), interiorLight: ctx.light(f.interiorLight),
      programmeLeds: (f.programmeLeds || []).map(n), optionLeds: (f.optionLeds || []).map(n), powerLed: n(f.powerLed), saltLed: n(f.saltLed), rinseLed: n(f.rinseLed),
      simSpeed: f.simSpeed, basketTravel: f.basketTravel, startWindow: f.startWindow,
      on: f.on, running: f.running, finished: f.finished, detergent: f.detergent, lidOpen: f.lidOpen, startArmed: f.startArmed,
      lowerOut: f.lowerOut, upperOut: f.upperOut, drawerOut: f.drawerOut, lowerLoaded: f.lowerLoaded, upperLoaded: f.upperLoaded,
      programme: f.programme, delayHours: f.delayHours, remaining: f32(f.remaining), delayLeft: f32(f.delayLeft), salt: f.salt, rinseAid: f.rinseAid, startTimer: f32(f.startTimer) });
    this.options = new CsHashSet();
    this.tLower = 0; this.tUpper = 0; this.tDrawer = 0; this.tLid = 0; this.blink = 0; this.message = ''; this.msgTime = 0; this.door = null;
    // Awake
    this.restLower = this.lowerBasket?.position.clone(); this.restUpper = this.upperBasket?.position.clone(); this.restDrawer = this.cutleryDrawer?.position.clone();
    this.lidRest = this.dispenserLid?.quaternion.clone();
    this.wash = this.makeLoop(140, 210, 0.08);
    if (this.platesLower) this.platesLower.visible = false;
    if (this.cupsUpper) this.cupsUpper.visible = false;
    this.updateStates(); this.refresh();
  }
  init() { this.door = this.ctx.control(this.doorRef, 'TwinHinge'); this.updateStates(); }

  get P() { return find(this.programmeIds[clamp(this.programme, 0, this.programmeIds.length - 1)]); }
  get doorOpen() { return !!this.door && this.door.open; }

  onControl(c) {
    switch (c) {
      case 'door:open':
        if (this.running) this.emit('pause:door');
        this.emit('door:open'); break;
      case 'door:close':
        if (this.lowerOut || this.upperOut || this.drawerOut) { this.lowerOut = this.upperOut = this.drawerOut = false; this.emit('baskets:in'); }
        if (this.lidOpen) this.lidOpen = false;
        this.emit('door:close');
        if (this.startArmed) { this.startArmed = false; this.begin(); }
        break;
      case 'lowerClick':
        if (!this.doorOpen) { this.flash('Open the door first'); return; }
        if (!this.lowerOut) this.onControl('lower'); else if (!this.lowerLoaded) this.onControl('loadLower'); else this.onControl('lower');
        return;
      case 'upperClick':
        if (!this.doorOpen) { this.flash('Open the door first'); return; }
        if (!this.upperOut) this.onControl('upper'); else if (!this.upperLoaded) this.onControl('loadUpper'); else this.onControl('upper');
        return;
      case 'lower': if (!this.doorOpen) return; this.lowerOut = !this.lowerOut; this.emit(this.lowerOut ? 'lower:out' : 'lower:in'); break;
      case 'upper': if (!this.doorOpen) return; this.upperOut = !this.upperOut; this.emit(this.upperOut ? 'upper:out' : 'upper:in'); break;
      case 'drawer': if (!this.doorOpen) return; this.drawerOut = !this.drawerOut; this.emit(this.drawerOut ? 'drawer:out' : 'drawer:in'); break;
      case 'loadLower': if (this.lowerOut) { this.lowerLoaded = !this.lowerLoaded; this.emit(this.lowerLoaded ? 'lower:loaded' : 'lower:emptied'); } break;
      case 'loadUpper': if (this.upperOut) { this.upperLoaded = !this.upperLoaded; this.emit(this.upperLoaded ? 'upper:loaded' : 'upper:emptied'); } break;
      case 'dispenser':
        if (!this.doorOpen) return;
        if (!this.lidOpen) { this.lidOpen = true; this.emit('dispenser:open'); }
        else { this.detergent = true; this.lidOpen = false; this.beep(900, 0.05, 0.12); this.emit('detergent:added'); }
        break;
      case 'rinse': if (!this.doorOpen) return; this.rinseAid = 1; this.beep(900, 0.05, 0.12); this.emit('rinse:filled'); break;
      case 'salt': if (!this.doorOpen || !this.lowerOut) { this.flash('Pull out the lower basket first'); return; } this.salt = 1; this.beep(900, 0.05, 0.12); this.emit('salt:filled'); break;
      case 'power':
        this.on = !this.on; this.beep(this.on ? 1800 : 1200, 0.08);
        if (!this.on) { this.running = false; this.startArmed = false; this.finished = false; this.remaining = 0; this.delayLeft = 0; this.delayHours = 0; this.options.clear(); }
        this.emit(this.on ? 'power:on' : 'power:off'); break;
      case 'start':
        if (!this.on) { this.beep(500, 0.08, 0.12); return; }
        if (this.running) { this.flash('Running - hold power to cancel'); return; }
        this.beep(2000, 0.08);
        if (this.doorOpen) { this.startArmed = true; this.startTimer = f32(this.startWindow); this.emit('start:armed'); }
        else this.begin();
        break;
      case 'delay+': if (this.on && !this.running) { this.delayHours = Math.min(24, this.delayHours + 1); this.beep(1500, 0.03, 0.12); this.emit('delay:set'); } break;
      case 'delay-': if (this.on && !this.running) { this.delayHours = Math.max(0, this.delayHours - 1); this.beep(1500, 0.03, 0.12); this.emit('delay:set'); } break;
      default:
        if (c.startsWith('prog:') && this.on && !this.running) {
          const i = this.programmeIds.indexOf(c.slice(5));
          if (i >= 0) { this.programme = i; this.beep(1500, 0.03, 0.12); this.emit('programme:' + this.programmeIds[i]); }
        } else if (c.startsWith('opt:') && this.on && !this.running) {
          const o = c.slice(4);
          if (!this.options.delete(o)) this.options.add(o);
          this.beep(1500, 0.03, 0.12); this.emit('option:' + o);
        } else if (!this.on && (c.startsWith('prog:') || c.startsWith('opt:') || c.startsWith('delay'))) this.beep(500, 0.08, 0.12);
        break;
    }
    this.updateStates(); this.refresh();
  }

  flash(m) { this.message = m; this.msgTime = f32(2.5); }

  minutes() {
    let m = f32(this.P.minutes);
    if (this.options.has('HalfLoad')) m = f32(m * f32(0.85));
    if (this.options.has('QuickPlus')) m = f32(m * 0.5);
    if (this.options.has('ExtraDry')) m = f32(m + 15);
    if (this.options.has('IntensiveZone')) m = f32(m + 10);
    return roundToInt(m);
  }

  begin() {
    this.running = true; this.finished = false; this.remaining = f32(this.minutes() * 60); this.delayLeft = f32(this.delayHours * 3600);
    this.emit(this.delayLeft > 0 ? 'delay:running' : 'programme:start');
    if (!this.detergent) this.flash('No detergent added!');
  }

  update(rdt) {
    const dt = f32(rdt * this.simSpeed);
    if (this.startArmed) { this.startTimer = f32(this.startTimer - rdt); if (this.startTimer <= 0) { this.startArmed = false; this.flash('Close the door within 4 s after Start'); this.emit('start:timeout'); } }
    const washing = this.running && !this.doorOpen && this.delayLeft <= 0;
    if (this.running && !this.doorOpen) {
      if (this.delayLeft > 0) { this.delayLeft = f32(this.delayLeft - dt); if (this.delayLeft <= 0) this.emit('programme:start'); }
      else {
        this.remaining = f32(this.remaining - dt);
        if (this.remaining <= 0) { this.remaining = 0; this.running = false; this.finished = true; this.detergent = false; this.ring(); this.emit('programme:end'); }
      }
    }
    if (this.msgTime > 0) { this.msgTime = f32(this.msgTime - rdt); if (this.msgTime <= 0) this.message = ''; }
    // motion
    this.tLower = moveTowards(this.tLower, this.lowerOut ? 1 : 0, rdt * 2.5);
    this.tUpper = moveTowards(this.tUpper, this.upperOut ? 1 : 0, rdt * 2.5);
    this.tDrawer = moveTowards(this.tDrawer, this.drawerOut ? 1 : 0, rdt * 2.5);
    this.tLid = moveTowards(this.tLid, this.lidOpen ? 1 : 0, rdt * 4);
    if (this.lowerBasket) this.lowerBasket.position.copy(this.restLower).addScaledVector(FORWARD, this.basketTravel * smooth(this.tLower));
    if (this.upperBasket) this.upperBasket.position.copy(this.restUpper).addScaledVector(FORWARD, this.basketTravel * 0.95 * smooth(this.tUpper));
    if (this.cutleryDrawer) this.cutleryDrawer.position.copy(this.restDrawer).addScaledVector(FORWARD, this.basketTravel * 0.75 * smooth(this.tDrawer));
    if (this.dispenserLid) this.dispenserLid.quaternion.copy(this.lidRest).multiply(uAxisAngle([1, 0, 0], -100 * this.tLid));
    if (this.platesLower) this.platesLower.visible = this.lowerLoaded;
    if (this.cupsUpper) this.cupsUpper.visible = this.upperLoaded;
    if (this.sprayLower && washing) this.sprayLower.quaternion.multiply(uAxisAngle([0, 1, 0], 220 * rdt));
    if (this.sprayUpper && washing) this.sprayUpper.quaternion.multiply(uAxisAngle([0, 1, 0], -180 * rdt));
    if (washing && !this.wash.isPlaying) this.wash.play(); else if (!washing && this.wash.isPlaying) this.wash.stop();
    if (this.interiorLight) this.interiorLight.visible = this.doorOpen;
    this.blink = f32(this.blink + rdt);
    this.updateStates(); this.refresh();
  }
  ring() { if (this.ctx.muted) return; for (let i = 0; i < 3; i++) setTimeout(() => this.beep(2400, 0.15, 0.3), i * 350); }

  led(node, lit, onColor = [1, 1, 1]) { colorOnly(node, lit ? onColor : [0.12, 0.12, 0.13]); }
  timeText(sec) { const m = ceilToInt(sec / 60); return `${Math.trunc(m / 60)}:${String(m % 60).padStart(2, '0')}`; }

  refresh() {
    const flash = (this.blink % 1) < 0.6;
    if (this.display) {
      let t;
      if (!this.on) t = '';
      else if (this.message) t = this.message;
      else if (this.finished) t = flash ? '0:00' : '';
      else if (this.running && this.delayLeft > 0) t = `${ceilToInt(this.delayLeft / 3600)}h`;
      else if (this.running) t = this.timeText(this.remaining);
      else if (this.delayHours > 0) t = `${this.delayHours}h`;
      else t = this.timeText(this.minutes() * 60);
      this.display.text = t;
    }
    if (this.timeBeam) {
      const show = this.running && !this.doorOpen;
      this.timeBeam.text = show ? (this.delayLeft > 0 ? `${ceilToInt(this.delayLeft / 3600)}h` : this.timeText(this.remaining)) : (this.finished && !this.doorOpen && this.on ? '0:00' : '');
    }
    for (let i = 0; i < this.programmeLeds.length; i++) this.led(this.programmeLeds[i], this.on && i === this.programme);
    for (let i = 0; i < this.optionLeds.length && i < this.optionIds.length; i++) this.led(this.optionLeds[i], this.on && this.options.has(this.optionIds[i]));
    this.led(this.powerLed, this.on, [0.3, 0.8, 1]);
    this.led(this.saltLed, this.on && this.salt <= 0, [1, 0.6, 0.1]);
    this.led(this.rinseLed, this.on && this.rinseAid <= 0, [1, 0.6, 0.1]);
  }

  updateStates() {
    this.setState('power', this.on ? 'on' : 'off');
    this.setState('door', this.doorOpen ? 'open' : 'closed');
    this.setState('programme', this.programmeIds[this.programme]);
    this.setState('options', this.options.values().join('+'));
    this.setState('halfLoad', this.options.has('HalfLoad') ? 'on' : 'off');
    this.setState('delayHours', this.delayHours);
    this.setState('running', this.running ? 'yes' : 'no');
    this.setState('finished', this.finished ? 'yes' : 'no');
    this.setState('remainingMin', ceilToInt(this.remaining / 60));
    this.setState('lower', this.lowerOut ? 'out' : 'in');
    this.setState('upper', this.upperOut ? 'out' : 'in');
    this.setState('lowerLoaded', this.lowerLoaded ? 'yes' : 'no');
    this.setState('upperLoaded', this.upperLoaded ? 'yes' : 'no');
    this.setState('detergent', this.detergent ? 'yes' : 'no');
    this.setState('salt', this.salt > 0 ? 'ok' : 'empty');
    this.setState('rinseAid', this.rinseAid > 0 ? 'ok' : 'empty');
  }

  get statusText() {
    const P = this.P, opts = this.options.values().map(o => OPTION_NAMES[o] || o);
    const head = !this.on ? '<b>Off</b>' : this.running ? (this.delayLeft > 0 ? `<b>Delayed start</b> in ${this.timeText(this.delayLeft)}` : `<b>${P.name}</b> running - ${this.timeText(this.remaining)} left${this.doorOpen ? '  <color=#C0392B>paused (door open)</color>' : ''}`)
      : this.finished ? '<b>Finished</b> - open the door' : `<b>${P.name}</b>${opts.length ? ' + ' + opts.join(', ') : ''}${this.delayHours > 0 ? `  start in ${this.delayHours} h` : ''}  (${this.timeText(this.minutes() * 60)})`;
    const arm = this.startArmed ? `\n<color=#C0392B>Close the door to start (${ceilToInt(this.startTimer)} s)</color>` : '';
    return `${head}${arm}\nDoor ${this.doorOpen ? 'open' : 'closed'}   Lower basket ${this.lowerLoaded ? 'loaded' : 'empty'}, upper ${this.upperLoaded ? 'loaded' : 'empty'}   Detergent ${this.detergent ? 'yes' : 'no'}   ` +
      `Salt ${this.salt > 0 ? 'ok' : '<color=#E67E22>refill</color>'}   Rinse aid ${this.rinseAid > 0 ? 'ok' : '<color=#E67E22>refill</color>'}   ×${Math.round(this.simSpeed)} time`;
  }
  basketLabel(upper) {
    const outNow = upper ? this.upperOut : this.lowerOut, loaded = upper ? this.upperLoaded : this.lowerLoaded, n = upper ? 'upper basket' : 'lower basket';
    if (!this.doorOpen) return n;
    return !outNow ? `Pull out the ${n}` : !loaded ? `Load the ${n}` : `Push the ${n} in`;
  }
  addState(list) { list.push(['simSpeed', String(Math.round(this.simSpeed))]); }
}

class DishwasherBasket {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return this.device ? this.device.basketLabel(this.f.upper) : 'basket'; }
  onClicked() { this.device?.onControl(this.f.upper ? 'upperClick' : 'lowerClick'); }
}

registerDevice('DishwasherController', DishwasherController);
registerControl('DishwasherBasket', DishwasherBasket);
