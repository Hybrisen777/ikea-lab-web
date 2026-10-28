// TROTTEN sit/stand desk, electric - port of Runtime/Twin/Devices/DeskController.cs + DeskButton.cs (keep in sync;
// parity_script.json + _unity_trace.json check it). Up / Down: short press (< 0.3 s) = 10 mm, long press = move
// (71-118 cm). Handset sleeps after 15 s (first press only wakes it). Up + Down 3 s = child lock / unlock (mouse:
// Shift+click pins one key, then hold the other). Down held 5 s at the bottom = reset (orange), release -> down and home.
import { TwinDevice, registerDevice, registerControl, clamp, moveTowards, roundToInt, uVec, ledHdr, ownMaterials } from '../twin-core.js';

const f32 = Math.fround;

class DeskController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    Object.assign(this, { lift: ctx.node(f.lift), led: ctx.node(f.led), minHeight: f32(f.minHeight), maxHeight: f32(f.maxHeight), homeHeight: f32(f.homeHeight),
      speed: f32(f.speed), nudge: f32(f.nudge), sleepAfter: f32(f.sleepAfter), asleep: f.asleep, locked: f.locked, resetting: f.resetting, resetArmed: f.resetArmed });
    this.idle = 0; this.chordHeld = 0; this.downHeld = 0; this.flash = 0; this.bottomSince = -1; this.resetPhase = 0;
    this.upHeldLong = false; this.downHeldLong = false; this.moving = false; this.chordFired = false;
    this.upDown = false; this.downDown = false; this.chord = false; this.chordTime = 0; this.wokeBy = null;
    // Awake
    this.motor = this.makeLoop(70, 140, 0.08);
    this.height = this.target = this.minHeight; this.liftBase = this.lift ? this.lift.position.y : 0;
    this.updateStates();
  }

  wake() { this.idle = 0; if (this.asleep) { this.asleep = false; this.beep(1500, 0.03, 0.08); this.emit('wake'); return true; } return false; }

  onControl(c) {
    if (this.resetting) { if (c.endsWith(':press')) { this.resetting = false; this.target = this.height; this.emit('reset:paused'); } this.updateStates(); return; }
    const colon = c.indexOf(':'), key = colon > 0 ? c.slice(0, colon) : c, act = colon > 0 ? c.slice(colon + 1) : '';
    if (key !== 'up' && key !== 'down') return;
    this.idle = 0;
    if (act === 'press') {
      if (key === 'up') this.upDown = true; else this.downDown = true;
      if (this.wake()) { this.wokeBy = key; this.updateStates(); return; }                 // first press after sleep only wakes
      if (this.upDown && this.downDown && this.wokeBy == null) {
        this.chord = true; this.chordTime = 0; this.chordFired = false;                     // both keys: stop, start the 3 s count
        this.target = this.height; this.upHeldLong = this.downHeldLong = false; this.resetArmed = false; this.bottomSince = -1;
      } else if (this.locked) { this.beep(500, 0.08, 0.1); this.emit('locked:ignored'); this.flash = f32(0.8); }
    } else if (act.startsWith('hold=')) {
      const s = f32(parseFloat(act.slice(5)));
      if (this.asleep || this.wokeBy === key || this.chord || this.locked) { this.updateStates(); return; }
      if (key === 'up' && s >= f32(0.3)) { this.upHeldLong = true; this.target = this.maxHeight; }
      if (key === 'down') {
        this.downHeld = s;
        if (s >= f32(0.3) && !this.resetArmed) { this.downHeldLong = true; this.target = this.minHeight; }
        // reset: keep holding Down for 5 s once the desk is at its lowest position
        const atBottom = this.height <= f32(this.minHeight + f32(0.002));
        if (!atBottom) this.bottomSince = -1; else if (this.bottomSince < 0) this.bottomSince = s;
        if (atBottom && this.bottomSince >= 0 && f32(s - this.bottomSince) >= 5 && !this.resetArmed) { this.resetArmed = true; this.target = this.height; this.beep(1200, 0.15, 0.15); this.emit('reset:armed'); }
      }
    } else if (act === 'release') {
      if (key === 'up') this.upDown = false; else this.downDown = false;
      if (this.wokeBy === key) { this.wokeBy = null; this.updateStates(); return; }
      if (this.chord) { if (!this.upDown && !this.downDown) { this.chord = false; this.chordTime = 0; } this.updateStates(); return; }   // releasing a chord never moves
      if (!this.locked && !this.asleep) {
        const longPress = key === 'up' ? this.upHeldLong : this.downHeldLong;
        if (this.resetArmed && key === 'down') { this.resetArmed = false; this.resetting = true; this.resetPhase = 0; this.target = this.minHeight; this.emit('reset:start'); }
        else if (longPress) { this.target = this.height; this.emit((key === 'up' ? 'move:up' : 'move:down') + '@' + roundToInt(f32(this.height * 100))); }
        else { this.target = clamp(f32(this.height + (key === 'up' ? this.nudge : -this.nudge)), this.minHeight, this.maxHeight); this.emit('nudge:' + key); }
      }
      if (key === 'up') this.upHeldLong = false; else { this.downHeldLong = false; this.downHeld = 0; this.bottomSince = -1; }
    }
    this.updateStates();
  }

  update(dt) {
    if (this.chord && this.upDown && this.downDown) {
      this.chordTime = f32(this.chordTime + dt); this.idle = 0;
      if (this.chordTime >= 3 && !this.chordFired) { this.chordFired = true; this.locked = !this.locked; this.beep(this.locked ? 900 : 1600, 0.2, 0.15); this.emit(this.locked ? 'lock:on' : 'lock:off'); }
    }
    const spd = this.resetting ? f32(this.speed * f32(0.6)) : this.speed;
    const prev = this.height;
    this.height = f32(moveTowards(this.height, this.target, f32(spd * dt)));
    this.moving = Math.abs(f32(this.height - prev)) > 1e-6;
    if (this.resetting && !this.moving) {
      if (this.resetPhase === 0) { this.resetPhase = 1; this.target = this.homeHeight; }
      else { this.resetting = false; this.flash = f32(1.5); this.beep(2000, 0.1, 0.15); this.emit('reset:done'); }
    }
    if (!this.moving && !this.resetting) { this.idle = f32(this.idle + dt); if (!this.asleep && this.idle > this.sleepAfter && !this.upDown && !this.downDown) { this.asleep = true; this.emit('sleep'); } }
    if (this.lift) this.lift.position.y = this.liftBase + (this.height - this.minHeight);
    if (this.moving && !this.motor.isPlaying) this.motor.play(); else if (!this.moving && this.motor.isPlaying) this.motor.stop();
    if (this.flash > 0) this.flash = f32(this.flash - dt);
    if (this.led) { const c = this.ledColor(); const black = c[0] === 0 && c[1] === 0 && c[2] === 0; ledHdr(this.led, black ? [0.15, 0.15, 0.15] : c, c, 2.5); }
    this.updateStates();
  }

  ledColor() {
    const blink = (Math.fround(this.ctx.time) * 3) % 1 < 0.5;
    if (this.resetArmed || this.resetting) return [1, 0.5, 0.05];
    if (this.locked) return blink ? [1, 0.1, 0.1] : [0, 0, 0];
    if (this.flash > 0) return blink ? [0.1, 1, 0.2] : [0, 0, 0];
    if (this.asleep) return [0, 0, 0];
    return [0.1, 1, 0.2];
  }
  ledName() { return this.resetArmed || this.resetting ? 'orange' : this.locked ? 'red' : this.asleep ? 'off' : 'green'; }

  updateStates() {
    this.setState('height', roundToInt(f32(this.height * 100)));
    this.setState('led', this.ledName());
    this.setState('asleep', this.asleep ? 'yes' : 'no');
    this.setState('locked', this.locked ? 'yes' : 'no');
    this.setState('resetting', this.resetting ? 'yes' : 'no');
    this.setState('moving', this.moving ? 'yes' : 'no');
  }

  get statusText() {
    const l = this.ledName(), col = l === 'green' ? '#2E9E4F' : l === 'red' ? '#C0392B' : l === 'orange' ? '#E08A20' : '#888';
    const st = this.resetting ? 'Reset running' : this.locked ? 'Child lock' : this.asleep ? 'Handset asleep' : this.moving ? (this.target > this.height ? 'Moving up' : 'Moving down') : 'Ready';
    return `<b>${roundToInt(f32(this.height * 100))} cm</b>  (${roundToInt(f32(this.minHeight * 100))}-${roundToInt(f32(this.maxHeight * 100))})   ${st}\nLight <b><color=${col}>${l}</color></b>   max load 50 kg`;
  }
  addState(list) { list.push(['targetCm', String(roundToInt(f32(this.target * 100)))]); }
}

/** C# float.ToString("0.###", InvariantCulture) */
const fmt3 = v => { const r = Math.round(v * 1000) / 1000; return String(r); };

class DeskButton {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); this.rest = node.position.clone(); this.down = false; this.pinned = false; }
  get label() { return this.f.label + (this.pinned ? '  (pinned - now hold the other key)' : ''); }
  setPinned(p) {
    if (p && !this.base) this.base = ownMaterials(this.node).map(m => m.color.clone());
    this.pinned = p;
    if (!p && this.base) ownMaterials(this.node).forEach((m, i) => m.color.copy(this.base[i]));   // Unity: SetPropertyBlock(null)
  }
  onClicked() { this.down = true; this.device?.onControl(this.f.id + ':press'); }
  onHold(s) { this.down = true; this.device?.onControl(this.f.id + ':hold=' + fmt3(s)); }
  onRelease() { this.down = false; this.device?.onControl(this.f.id + ':release'); }
  update() {
    this.node.position.copy(this.rest); if (this.down || this.pinned) this.node.position.add(uVec(this.f.pressTravel));
    if (this.pinned) ledHdr(this.node, [1, 0.72, 0.05], [0, 0, 0], 0);   // pinned keys stay tinted
  }
}

registerDevice('DeskController', DeskController);
registerControl('DeskButton', DeskButton);
