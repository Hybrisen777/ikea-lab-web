// MATTRADITION built-in microwave - port of Assets/Scripts/Microwave/MicrowaveController.cs + MicrowaveButton.cs +
// MicrowaveDoor.cs (keep in sync; parity_script.json + _unity_trace.json check it). Stop, Power, Memo, Steam, +/-,
// Jet Defrost, Start, Door; cooking only with the door closed. The idle display shows the wall clock (a fixed 12:00
// during parity traces, like Unity). Display timing uses Time.time (absolute), here ctx.time.
import { TwinDevice, registerDevice, registerControl, clamp, moveTowards, uVec, uAxisAngle } from '../twin-core.js?v=6c4f3aae27';

const f32 = Math.fround;
const FUNCTIONS = ['Stop', 'Power', 'Memo', 'Steam', 'Plus', 'Minus', 'JetDefrost', 'Start', 'DoorOpen'];
const ST = { Idle: 'Idle', Setting: 'Setting', Cooking: 'Cooking', Paused: 'Paused', Done: 'Done' };
const two = v => String(v).padStart(2, '0');
const clock = (a, b, colon) => two(a) + (colon ? ':' : ' ') + two(b);

class MicrowaveController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    Object.assign(this, { door: n(f.door), turntable: n(f.turntable), display: ctx.text(f.display), cavityLight: ctx.light(f.cavityLight),
      doorOpenAngle: f32(f.doorOpenAngle), doorSpeed: f32(f.doorSpeedDegPerSec), turntableRpm: f32(f.turntableRpm), timeStepSeconds: f.timeStepSeconds,
      maxSeconds: f.maxSeconds, powerLevelsW: f.powerLevelsW });
    this.state = ST.Idle; this.mode = ''; this.remaining = 0; this.powerIndex = 3; this.doorTarget = 0; this.doorAngle = 0;
    this.memoSeconds = -1; this.memoPower = -1; this.message = null; this.messageUntil = 0; this.doneAt = 0;
    // Awake
    this.doorClosedRot = this.door?.quaternion.clone();
    this.hum = this.makeLoop(100, 220, 0.15);
  }
  get time() { return f32(this.ctx.time); }   // Unity Time.time (float)
  get isDoorOpen() { return this.doorTarget > 0.5; }
  get remainingSeconds() { return Math.ceil(f32(this.remaining)); }
  get powerW() { return this.powerLevelsW[this.powerIndex]; }
  get displayText() { return this.display ? this.display.text : ''; }

  press(fname) {
    this.emit(fname);
    this.beep(2000, 0.15, 0.4);
    const busy = this.state === ST.Cooking;
    switch (fname) {
      case 'DoorOpen': this.openDoor(); break;
      case 'Plus': this.adjustTime(+this.timeStepSeconds); break;
      case 'Minus': this.adjustTime(-this.timeStepSeconds); break;
      case 'Power':
        if (busy) { this.flash('busy'); break; }
        this.powerIndex = (this.powerIndex + 1) % this.powerLevelsW.length;
        this.mode = ''; this.enterSetting(); this.flash(this.powerW + 'W'); break;
      case 'Start': this.startCooking(); break;
      case 'Stop': this.stop(); break;
      case 'Steam':
        if (busy) break;
        this.mode = 'Steam'; this.powerIndex = this.powerLevelsW.length - 1; this.remaining = 180; this.enterSetting(); this.flash('StEA'); break;
      case 'JetDefrost':
        if (busy) break;
        this.mode = 'Defrost'; this.powerIndex = 1; this.remaining = 300; this.enterSetting(); this.flash('dEF'); break;
      case 'Memo':
        if (this.state === ST.Setting && this.remaining > 0) { this.memoSeconds = this.remainingSeconds; this.memoPower = this.powerIndex; this.flash('SAVE'); }
        else if (this.memoSeconds > 0 && this.state !== ST.Cooking) { this.remaining = this.memoSeconds; this.powerIndex = this.memoPower; this.mode = 'Memo'; this.enterSetting(); this.flash('ME'); }
        else this.flash('----');
        break;
    }
  }
  toggleDoor() { if (this.isDoorOpen) this.closeDoor(); else this.openDoor(); }
  openDoor() {
    this.emit('door:open'); this.doorTarget = 1;
    if (this.state === ST.Cooking) { this.state = ST.Paused; this.hum.stop(); }
    if (this.state === ST.Done) this.state = ST.Idle;
  }
  closeDoor() { this.emit('door:close'); this.doorTarget = 0; }
  adjustTime(delta) {
    if (this.state === ST.Done) this.state = ST.Idle;
    if (this.state === ST.Idle) { this.remaining = 0; this.mode = ''; }
    this.remaining = clamp(this.remainingSeconds + delta, 0, this.maxSeconds);
    if (this.state !== ST.Cooking && this.state !== ST.Paused) this.enterSetting();
  }
  enterSetting() { if (this.state !== ST.Paused) this.state = ST.Setting; }
  startCooking() {
    if (this.isDoorOpen) { this.flash('door'); return; }
    switch (this.state) {
      case ST.Cooking: this.remaining = Math.min(f32(this.remaining + this.timeStepSeconds), this.maxSeconds); return;   // +30 s
      case ST.Paused: break;                                                                                             // resume
      default: if (this.remaining <= 0) { this.remaining = this.timeStepSeconds; this.powerIndex = this.powerLevelsW.length - 1; this.mode = 'JetStart'; }
    }
    if (this.remaining <= 0) return;
    this.state = ST.Cooking; this.hum.play();
  }
  stop() {
    if (this.state === ST.Cooking) { this.state = ST.Paused; this.hum.stop(); return; }
    this.state = ST.Idle; this.remaining = 0; this.mode = ''; this.powerIndex = this.powerLevelsW.length - 1; this.message = null;
  }
  flash(text, seconds = 1.2) { this.message = text; this.messageUntil = f32(this.time + f32(seconds)); }

  onControl(c) {
    if (c === 'door') { this.toggleDoor(); return; }
    const f = FUNCTIONS.find(x => x.toLowerCase() === String(c).toLowerCase());
    if (f) this.press(f);
  }

  get statusText() {
    const rs = this.remainingSeconds;
    return `<b>${this.state}</b>   door ${this.isDoorOpen ? 'open' : 'closed'}\n` +
      `Power ${this.powerW} W   Time ${two(Math.trunc(rs / 60))}:${two(rs % 60)}` + (this.mode ? `   Mode ${this.mode}` : '') + `\nDisplay  <b>${this.displayText}</b>`;
  }
  updateStates() {
    this.setState('state', this.state); this.setState('door', this.isDoorOpen ? 'open' : 'closed'); this.setState('powerW', this.powerW);
    this.setState('seconds', this.remainingSeconds); this.setState('mode', this.mode); this.setState('display', this.displayText);
  }

  update(dt) {
    if (this.door) {
      const target = this.doorTarget * this.doorOpenAngle;
      this.doorAngle = moveTowards(this.doorAngle, target, this.doorSpeed * dt);
      this.door.quaternion.copy(this.doorClosedRot).multiply(uAxisAngle([0, 1, 0], this.doorAngle));
    }
    if (this.state === ST.Cooking) {
      if (this.turntable) this.turntable.quaternion.multiply(uAxisAngle([0, 1, 0], this.turntableRpm * 6 * dt));
      this.remaining = f32(this.remaining - dt);
      if (this.remaining <= 0) {
        this.remaining = 0; this.state = ST.Done; this.doneAt = this.time; this.mode = '';
        this.hum.stop(); this.doneBeeps(); this.emit('done');
      }
    }
    if (this.cavityLight) this.cavityLight.visible = this.state === ST.Cooking || this.doorAngle > 1;
    if (this.display) this.display.text = this.composeDisplay();
    this.updateStates();
  }
  doneBeeps() { if (this.ctx.muted) return; for (let i = 0; i < 3; i++) setTimeout(() => this.beep(2000, 0.15, 0.4), i * 350); }

  composeDisplay() {
    const t = this.time;
    if (this.message != null && t < this.messageUntil) return this.message;
    const blink = (t - Math.floor(t)) < 0.5, rs = this.remainingSeconds;   // Mathf.Repeat(t, 1)
    switch (this.state) {
      case ST.Setting: case ST.Cooking: return clock(Math.trunc(rs / 60), rs % 60, true);
      case ST.Paused: return blink ? clock(Math.trunc(rs / 60), rs % 60, true) : '';
      case ST.Done:
        if (f32(t - this.doneAt) < 4) return blink ? 'End' : '';
        this.state = ST.Idle;
      // falls through
      default: {
        const now = this.ctx.tracing ? { h: 12, m: 0 } : (() => { const d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; })();
        return clock(now.h, now.m, blink);
      }
    }
  }
}

class MicrowaveButton {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.rest = node.position.clone(); this.pressTimer = 0; }
  get label() { return this.f.function === 'DoorOpen' ? 'Door open' : this.f.function; }
  onClicked() { this.pressTimer = this.f.pressDuration; this.device?.press(this.f.function); }
  update(dt) {
    this.node.position.copy(this.rest); if (this.pressTimer > 0) this.node.position.add(uVec([0, 0, -this.f.pressDepth]));
    if (this.pressTimer > 0) this.pressTimer -= dt;
  }
}

class MicrowaveDoor {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return this.device?.isDoorOpen ? 'Close door' : 'Open door'; }
  onClicked() { this.device?.toggleDoor(); }
}

registerDevice('MicrowaveController', MicrowaveController);
registerControl('MicrowaveButton', MicrowaveButton);
registerControl('MicrowaveDoor', MicrowaveDoor);
