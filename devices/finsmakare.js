// FINSMAKARE (steam) / KULINARISK (pyrolytic) forced-air oven - port of Runtime/Twin/Devices/FinsmakareController.cs +
// FinsmakareShuttle.cs (keep in sync; parity_script.json + _unity_trace.json check it). Electronic programmer with a
// display, On/Off, shuttle (wheel = rotate, click = OK) or Up/Down/OK keys, Back, Time (Duration), Heating Functions
// (hold 3 s = light), Temperature (hold 3 s = Fast Heat Up), Minute Minder; water drawer (900 ml) for steam
// functions; pyrolytic cleaning locks the door. Cavity temperature and clocks run at simSpeed x real time.
import * as THREE from 'three';
import { TwinDevice, registerDevice, registerControl, clamp, moveTowards, roundToInt, uVec, uAxisAngle, srgbLerp } from '../twin-core.js?v=1964ee872d';

const f32 = Math.fround;
const fn = (id, name, def, min, max, o = {}) => ({ id, name, def, min, max, fan: !!o.fan, grill: !!o.grill, steam: !!o.steam, heats: o.heats !== false });
const FUNCTIONS = [
  fn('TrueFan', 'True Fan Cooking', 160, 30, 250, { fan: true }), fn('TrueFanSteam', 'True Fan + Steam', 150, 130, 230, { fan: true, steam: true }),
  fn('Conventional', 'Conventional Cooking', 180, 30, 250), fn('Pizza', 'Pizza Function', 200, 130, 230, { fan: true }),
  fn('SlowCooking', 'Slow Cooking', 90, 80, 150), fn('BottomHeat', 'Bottom Heat', 150, 30, 250), fn('MoistFan', 'Moist Fan Baking', 160, 30, 250, { fan: true }),
  fn('FrozenFoods', 'Frozen Foods', 200, 30, 250, { fan: true }), fn('Grill', 'Grill', 230, 30, 250, { grill: true }), fn('FastGrilling', 'Fast Grilling', 250, 30, 250, { grill: true }),
  fn('TurboGrilling', 'Turbo Grilling', 180, 30, 250, { fan: true, grill: true }), fn('SteamRegenerating', 'Steam Regenerating', 110, 50, 150, { fan: true, steam: true }),
  fn('KeepWarm', 'Keep Warm', 80, 50, 100), fn('Defrost', 'Defrost', 0, 0, 0, { fan: true, heats: false }),
];
const MAIN_MENU = ['Heating Functions', 'Recipes', 'Favourites', 'Cleaning', 'Basic Settings', 'Specials', 'Assisted Cooking'];
const CLEAN_NAMES = ['Quick (1 h)', 'Normal (1 h 30 min)', 'Intense (2 h 30 min)'], CLEAN_MINUTES = [60, 90, 150];
const S = { Off: 'Off', Main: 'Main', Functions: 'Functions', Temp: 'Temp', Home: 'Home', Duration: 'Duration', Minder: 'Minder', Message: 'Message', Cleaning: 'Cleaning' };
const clock = (a, b) => String(a).padStart(2, '0') + ':' + String(b).padStart(2, '0');
const ceilToInt = v => Math.ceil(f32(v));
const step = (v, d) => (d > 0 ? v >= 10 : v > 10) ? 5 : 1;
const FORWARD = new THREE.Vector3(0, 0, 1);

class FinsmakareController extends TwinDevice {
  constructor(ctx, f) {
    super(ctx, f);
    const n = r => ctx.node(r);
    Object.assign(this, { hasSteam: f.hasSteam, hasPyrolysis: f.hasPyrolysis, display: ctx.text(f.display), shuttle: n(f.shuttle), fan: n(f.fan),
      waterDrawer: n(f.waterDrawer), jugWater: n(f.jugWater), grillElement: n(f.grillElement), lamp: ctx.light(f.lamp), glow: ctx.light(f.glow), doorRef: f.door,
      steamPuffs: (f.steamPuffs || []).map(n), simSpeed: f.simSpeed, ambient: f.ambient, heatRate: f32(f.heatRate), lossRate: f32(f.lossRate), doorLossFactor: f32(f.doorLossFactor),
      hysteresis: f32(f.hysteresis), drawerTravel: f.drawerTravel, tankMl: f.tankMl, steamMlPerMin: f.steamMlPerMin,
      screen: S[f.screen] || S.Off, cursor: f.cursor, fnIndex: f.fnIndex, setTemp: f.setTemp, durationMin: f.durationMin, minderMin: f.minderMin, editValue: f.editValue,
      durationLeft: f32(f.durationLeft), minderLeft: f32(f.minderLeft), waterMl: f32(f.waterMl), heating: f.heating, preheated: f.preheated, fastHeat: f.fastHeat,
      lightOn: f.lightOn, drawerOpen: f.drawerOpen, doorOpen: f.doorOpen, pyro: f.pyro, poured: f.poured, steamOrigin: uVec(f.steamOrigin || [0, 0, 0]) });
    this.fns = this.hasSteam ? FUNCTIONS : FUNCTIONS.filter(x => !x.steam);
    this.back = S.Off; this.message = ''; this.msgTime = 0; this.shuttleAngle = 0; this.fanSpeed = 0; this.glowLevel = 0; this.drawerT = 0; this.blink = 0;
    this.pyroLeft = 0; this.doorLocked = false; this.drawerRest = null; this.door = null;
    // Awake
    this.temp = f32(this.ambient);
    this.fanHum = this.makeLoop(95, 190, 0.12);
    this.updateStates(); this.renderDisplay();
  }
  init() { this.door = this.ctx.control(this.doorRef, 'TwinHinge'); }

  get F() { return this.fnIndex >= 0 ? this.fns[this.fnIndex] : null; }
  get running() { return this.screen !== S.Off && this.F !== null; }
  get isList() { return this.screen === S.Main || this.screen === S.Functions || this.screen === S.Cleaning; }
  get lampOn() { return !!this.lamp && this.lamp.visible; }

  onControl(c) {
    if (c === 'drawer') { this.drawerOpen = !this.drawerOpen; this.beep(900, 0.04, 0.12); this.emit(this.drawerOpen ? 'drawer:open' : 'drawer:close'); this.done(); return; }
    if (c === 'jug') {
      if (!this.drawerOpen) { this.beep(400, 0.12, 0.2); this.flash('Open the water drawer first'); this.emit('jug:blocked'); }
      else { this.waterMl = f32(this.tankMl); this.poured = true; this.beep(1800, 0.1); this.emit('water:filled'); if (this.screen !== S.Off) this.flash('Water tank full'); }
      this.done(); return;
    }
    if (c === 'door:locked') { this.beep(400, 0.2, 0.25); this.flash('Door locked - pyrolysis'); this.emit('door:blocked'); this.done(); return; }
    if (c === 'door:open') { this.doorOpen = true; this.emit('door:open'); this.done(); return; }
    if (c === 'door:close') { this.doorOpen = false; this.emit('door:close'); this.done(); return; }

    if (c === 'power') {
      if (this.screen === S.Off) { this.screen = S.Main; this.cursor = 0; this.lightOn = true; this.beep(1800, 0.1); this.emit('power:on'); }
      else {
        this.screen = S.Off; this.fnIndex = -1; this.heating = this.preheated = this.fastHeat = false;
        if (this.pyro) { this.pyro = false; this.emit('pyro:stopped'); }
        this.durationLeft = 0; this.durationMin = 0; this.lightOn = false; this.beep(1200, 0.1); this.emit('power:off');
      }
      this.done(); return;
    }
    if (this.screen === S.Off) { this.beep(500, 0.06, 0.12); return; }
    this.beep(1500, 0.03, 0.12);
    const F = this.F;
    switch (c) {
      case 'shuttle+': case 'shuttle-': this.rotate(c === 'shuttle+' ? 1 : -1); break;
      case 'up': this.rotate(this.isList ? -1 : 1); break;
      case 'down': this.rotate(this.isList ? 1 : -1); break;
      case 'ok': this.ok(); break;
      case 'back': this.goBack(); break;
      case 'functions': this.screen = S.Functions; this.cursor = Math.max(0, this.fnIndex); break;
      case 'light': this.lightOn = !this.lightOn; this.emit(this.lightOn ? 'light:on' : 'light:off'); break;
      case 'temp': if (F && F.heats) { this.back = S.Home; this.screen = S.Temp; this.editValue = this.setTemp; } break;
      case 'fastheat':
        if (F && F.heats && !F.steam) { this.fastHeat = !this.fastHeat; this.emit(this.fastHeat ? 'fastheat:on' : 'fastheat:off'); this.flash(this.fastHeat ? 'Fast Heat Up on' : 'Fast Heat Up off'); }
        else this.flash('Not available for this function');
        break;
      case 'time': if (F) { this.back = S.Home; this.screen = S.Duration; this.editValue = this.durationMin; } else this.flash('Set a heating function first'); break;
      case 'minder': this.back = this.screen === S.Minder ? S.Home : this.screen; this.screen = S.Minder; this.editValue = this.minderMin; break;
      case 'favourites': this.flash('Favourites: not simulated'); break;
    }
    this.done();
  }

  rotate(d) {
    this.shuttleAngle += d * 15;
    const F = this.F;
    switch (this.screen) {
      case S.Main: this.cursor = (this.cursor + d + MAIN_MENU.length) % MAIN_MENU.length; break;
      case S.Functions: this.cursor = (this.cursor + d + this.fns.length) % this.fns.length; break;
      case S.Cleaning: this.cursor = (this.cursor + d + CLEAN_NAMES.length) % CLEAN_NAMES.length; break;
      case S.Temp: this.editValue = clamp(this.editValue + 5 * d, F.min, F.max); break;
      case S.Duration: this.editValue = clamp(this.editValue + d * step(this.editValue, d), 0, 23 * 60 + 59); break;
      case S.Minder: this.editValue = clamp(this.editValue + d * step(this.editValue, d), 0, 150); break;
    }
  }

  ok() {
    switch (this.screen) {
      case S.Main:
        if (this.cursor === 0) { this.screen = S.Functions; this.cursor = Math.max(0, this.fnIndex); }
        else if (this.cursor === 3 && this.hasPyrolysis) { this.screen = S.Cleaning; this.cursor = 1; }
        else this.flash(MAIN_MENU[this.cursor] + ': not simulated');
        break;
      case S.Functions: {
        const f = this.fns[this.cursor];
        if (f.steam && this.waterMl <= 0) { this.flash('Water required'); this.emit('water:required'); }
        this.fnIndex = this.cursor; this.setTemp = f.def; this.preheated = false; this.fastHeat = false;
        this.emit('function:' + f.id);
        if (f.heats) { this.back = S.Home; this.screen = S.Temp; this.editValue = this.setTemp; } else this.screen = S.Home;
        break;
      }
      case S.Cleaning:
        if (this.doorOpen) { this.flash('Close the door first'); this.beep(400, 0.15, 0.25); break; }
        this.pyro = true; this.pyroLeft = f32(CLEAN_MINUTES[this.cursor] * 60); this.fnIndex = -1; this.heating = true; this.preheated = false; this.durationLeft = 0;
        this.doorLocked = true; if (this.door) this.door.locked = true; this.lightOn = false; this.emit('pyro:start'); this.emit('door:locked'); this.screen = S.Home; break;
      case S.Temp: this.setTemp = this.editValue; this.preheated = false; this.emit('temp:set'); this.screen = S.Home; break;
      case S.Duration:
        this.durationMin = this.editValue; this.durationLeft = f32(this.durationMin * 60); this.emit(this.durationMin > 0 ? 'duration:set' : 'duration:off'); this.screen = S.Home; break;
      case S.Minder:
        this.minderMin = this.editValue; this.minderLeft = f32(this.minderMin * 60); this.emit(this.minderMin > 0 ? 'minder:set' : 'minder:off');
        this.screen = this.back === S.Minder ? S.Home : this.back; if (this.screen === S.Off) this.screen = S.Main; break;
      case S.Home: if (this.F && this.F.heats) { this.back = S.Home; this.screen = S.Temp; this.editValue = this.setTemp; } break;
    }
  }

  goBack() {
    switch (this.screen) {
      case S.Functions: case S.Cleaning: this.screen = this.F || this.pyro ? S.Home : S.Main; break;
      case S.Temp: case S.Duration: this.screen = this.F ? S.Home : S.Main; break;
      case S.Minder: this.screen = this.F ? S.Home : S.Main; break;
      case S.Home: this.screen = S.Main; this.cursor = 0; break;
    }
  }

  flash(m) { this.message = m; this.msgTime = f32(2.2); }
  done() { this.updateStates(); this.renderDisplay(); }

  update(rdt) {
    const dt = f32(rdt * this.simSpeed), time = this.ctx.time;
    let F = this.F;
    const steamOn = this.running && F.steam && this.waterMl > 0;
    if (this.running && F.steam && this.waterMl > 0 && this.temp > 95) {
      this.waterMl = f32(this.waterMl - f32(f32(this.steamMlPerMin / 60) * dt));
      if (this.waterMl <= 0) { this.waterMl = 0; this.emit('water:required'); this.flash('Water required'); this.ring(3); }
    }
    if (this.pyro) {
      this.pyroLeft = f32(this.pyroLeft - dt);
      if (this.pyroLeft <= 0) { this.pyro = false; this.heating = false; this.emit('pyro:end'); this.ring(3); this.flash('Cleaning finished'); this.screen = S.Main; }
    }
    if (this.doorLocked && !this.pyro && this.temp < 200) { this.doorLocked = false; if (this.door) this.door.locked = false; this.emit('door:unlocked'); }
    F = this.F;
    const canHeat = this.pyro || (this.running && F.heats && this.setTemp > 0);
    const target = this.pyro ? 480 : this.setTemp;
    if (!canHeat) this.heating = false;
    else if (this.heating && this.temp >= target) {
      this.heating = false;
      if (!this.preheated && !this.pyro) { this.preheated = true; this.fastHeat = false; this.emit('preheated'); this.ring(3); }
    } else if (!this.heating && this.temp < target - this.hysteresis) this.heating = true;
    // every operation in float32, as C# does (the cavity temperature is integrated over thousands of frames)
    const power = this.heating ? f32(f32(this.heatRate * (this.fastHeat ? f32(1.8) : 1)) * (this.pyro ? f32(2.2) : 1)) : 0;
    const loss = f32(f32(this.lossRate * (this.doorOpen ? this.doorLossFactor : 1)) * (this.running && F.fan ? f32(1.15) : 1));
    this.temp = f32(this.temp + f32(f32(power - f32(f32(this.temp - this.ambient) * loss)) * dt));

    if (this.running && this.durationLeft > 0) {
      this.durationLeft = f32(this.durationLeft - dt);
      if (this.durationLeft <= 0) {
        this.durationLeft = 0; this.durationMin = 0; this.emit('duration:end'); this.ring(5); this.fnIndex = -1; this.heating = false;
        this.screen = S.Message; this.message = 'Cooking time ended'; this.msgTime = 999;
      }
    }
    if (this.minderLeft > 0) { this.minderLeft = f32(this.minderLeft - dt); if (this.minderLeft <= 0) { this.minderLeft = 0; this.minderMin = 0; this.emit('minder:end'); this.ring(5); this.flash('Minute Minder ended'); } }
    if (this.msgTime > 0) { this.msgTime = f32(this.msgTime - rdt); if (this.msgTime <= 0) { this.message = ''; if (this.screen === S.Message) this.screen = S.Main; } }

    // visuals
    F = this.F;
    this.fanSpeed = moveTowards(this.fanSpeed, this.running && F.fan ? 1 : 0, rdt * 1.5);
    if (this.fan) this.fan.quaternion.multiply(uAxisAngle([0, 0, 1], this.fanSpeed * 1400 * rdt));
    if (this.fanSpeed > 0.01 && !this.fanHum.isPlaying) this.fanHum.play(); else if (this.fanSpeed <= 0.01 && this.fanHum.isPlaying) this.fanHum.stop();
    this.fanHum.pitch = 0.6 + 0.4 * this.fanSpeed; this.fanHum.apply();
    this.glowLevel = moveTowards(this.glowLevel, this.heating && this.running && F.grill ? 1 : 0, rdt * 0.6);
    if (this.grillElement) srgbLerp(this.grillElement, [0.25, 0.25, 0.27], [1, 0.3, 0.05], this.glowLevel, [1, 0.25, 0.02], this.glowLevel * 3);
    if (this.glow) { this.glow.visible = this.glowLevel > 0.02; this.glow.intensity = this.glowLevel * 0.25 * 0.6; }
    if (this.lamp) this.lamp.visible = this.screen !== S.Off && this.lightOn && !this.pyro;
    if (this.shuttle) this.shuttle.quaternion.copy(uAxisAngle([0, 0, -1], -this.shuttleAngle));
    this.drawerT = moveTowards(this.drawerT, this.drawerOpen ? 1 : 0, rdt * 4);
    if (this.waterDrawer) { if (!this.drawerRest) this.drawerRest = this.waterDrawer.position.clone(); this.waterDrawer.position.copy(this.drawerRest).addScaledVector(FORWARD, this.drawerTravel * this.drawerT); }
    if (this.jugWater) this.jugWater.visible = !this.poured;
    const puff = steamOn && this.temp > 100 ? 1 : 0;
    for (let i = 0; i < this.steamPuffs.length; i++) {
      const s = this.steamPuffs[i]; if (!s) continue;
      const show = puff > 0; s.visible = show;
      if (!show) continue;
      const ph = (time * 0.25 + i / this.steamPuffs.length) % 1, a = i * 2.39;
      s.position.copy(this.steamOrigin).add(new THREE.Vector3(-Math.cos(a) * 0.12 * ph, -0.02 - ph * 0.15 + Math.sin(ph * 6) * 0.01, Math.sin(a) * 0.05 * ph + ph * 0.18));
      s.scale.setScalar(0.02 + (0.09 - 0.02) * ph);
    }
    this.blink = f32(this.blink + rdt);
    this.updateStates(); this.renderDisplay();
  }
  ring(n) { if (this.ctx.muted) return; for (let i = 0; i < n; i++) setTimeout(() => this.beep(2400, 0.12, 0.3), i * 250); }

  renderDisplay() {
    if (!this.display) return;
    const flash = (this.blink % 0.8) < 0.5, F = this.F;
    let t;
    if (this.message && this.screen !== S.Off) t = this.message;
    else switch (this.screen) {
      case S.Off: t = this.temp > 60 ? `${roundToInt(this.temp)}°C\n<size=60%>residual heat</size>` : '11:30'; break;
      case S.Main: t = `<size=60%>Main menu</size>\n› ${MAIN_MENU[this.cursor]}`; break;
      case S.Functions: t = `<size=60%>Heating Functions ${this.cursor + 1}/${this.fns.length}</size>\n› ${this.fns[this.cursor].name}`; break;
      case S.Cleaning: t = `<size=60%>Cleaning - pyrolysis</size>\n› ${CLEAN_NAMES[this.cursor]}`; break;
      case S.Temp: t = `<size=60%>${F.name}</size>\n${flash ? this.editValue + '°C' : ''}`; break;
      case S.Duration: t = `<size=60%>Duration</size>\n${flash ? clock(Math.trunc(this.editValue / 60), this.editValue % 60) : ''}`; break;
      case S.Minder: t = `<size=60%>Minute Minder</size>\n${flash ? clock(Math.trunc(this.editValue / 60), this.editValue % 60) : ''}`; break;
      default:
        if (this.pyro) { t = `<size=60%>Pyrolytic cleaning  LOCK</size>\n${clock(Math.trunc(this.pyroLeft / 3600), Math.trunc(this.pyroLeft / 60) % 60)}<size=60%>  ${roundToInt(this.temp)}°C</size>`; break; }
        if (!F) { t = '<size=60%>Main menu</size>'; break; }
        const bar = F.heats ? (this.preheated ? '' : ' ' + '|'.repeat(clamp(roundToInt(f32(5 * (this.temp - this.ambient) / Math.max(1, this.setTemp - this.ambient))), 0, 5))) : '';
        const tm = this.durationLeft > 0 ? `  D ${clock(Math.trunc(this.durationLeft / 3600), Math.trunc(this.durationLeft / 60) % 60)}` : '';
        const mm = this.minderLeft > 0 ? `  M ${clock(Math.trunc(this.minderLeft / 60), Math.trunc(this.minderLeft) % 60)}` : '';
        t = `<size=60%>${F.name}${this.fastHeat ? '  FAST' : ''}${F.steam && this.waterMl <= 0 ? '  WATER!' : ''}</size>\n${F.heats ? this.setTemp + '°C' : ''}<size=60%>${bar}${tm}${mm}</size>`;
        break;
    }
    this.display.text = t;
  }

  updateStates() {
    const F = this.F;
    this.setState('power', this.screen === S.Off ? 'off' : 'on');
    this.setState('screen', this.screen);
    this.setState('function', F ? F.id : 'None');
    this.setState('setTemp', this.setTemp);
    this.setState('temp', roundToInt(this.temp));
    this.setState('heating', this.heating ? 'yes' : 'no');
    this.setState('preheated', this.preheated ? 'yes' : 'no');
    this.setState('fastHeat', this.fastHeat ? 'on' : 'off');
    this.setState('durationMin', ceilToInt(this.durationLeft / 60 - 0.001));
    this.setState('minderMin', ceilToInt(this.minderLeft / 60 - 0.001));
    this.setState('waterMl', roundToInt(this.waterMl));
    this.setState('drawer', this.drawerOpen ? 'open' : 'closed');
    this.setState('door', this.doorOpen ? 'open' : 'closed');
    this.setState('light', this.lampOn ? 'on' : 'off');
    this.setState('pyro', this.pyro ? 'on' : 'off');
    this.setState('doorLocked', this.doorLocked ? 'yes' : 'no');
    this.setState('pyroMin', ceilToInt(this.pyroLeft / 60 - 0.001));
  }

  get statusText() {
    const F = this.F, sim = String(Math.round(this.simSpeed));
    const head = this.pyro ? `<b>Pyrolytic cleaning</b>  ${clock(Math.trunc(this.pyroLeft / 3600), Math.trunc(this.pyroLeft / 60) % 60)} left  -  door locked`
      : this.screen === S.Off ? '<b>Off</b>' + (this.doorLocked ? '  -  door locked until cool' : '')
      : F ? `<b>${F.name}</b>${F.heats ? `  |  ${this.setTemp} °C` : ''}${this.fastHeat ? '  Fast Heat Up' : ''}` : '<b>On</b> - choose a heating function';
    const clk = (this.durationLeft > 0 ? `   Duration <b>${clock(Math.trunc(this.durationLeft / 60), Math.trunc(this.durationLeft) % 60)}</b>` : '') +
      (this.minderLeft > 0 ? `   Minder <b>${clock(Math.trunc(this.minderLeft / 60), Math.trunc(this.minderLeft) % 60)}</b>` : '');
    const heat = this.heating ? '<color=#FF9A2E>heating</color>' : this.preheated ? 'temperature reached' : '';
    const water = this.hasSteam ? `Water tank <b>${roundToInt(this.waterMl)} ml</b> (drawer ${this.drawerOpen ? 'open' : 'closed'})   ` : '';
    return `${head}\nCavity <b>${roundToInt(this.temp)} °C</b> ${heat}${clk}\n${water}Door ${this.doorOpen ? 'open' : 'closed'}   ×${sim} time`;
  }
  addState(list) { list.push(['simSpeed', String(Math.round(this.simSpeed))]); }
}

class FinsmakareShuttle {
  constructor(node, f, device) { Object.assign(this, { node, f, device }); }
  get label() { return 'OK / shuttle (wheel to rotate, click = OK)'; }
  onClicked() { this.device?.onControl('ok'); }
  onScroll(dir) { this.device?.onControl(dir > 0 ? 'shuttle+' : 'shuttle-'); }
}

registerDevice('FinsmakareController', FinsmakareController);
registerControl('FinsmakareShuttle', FinsmakareShuttle);
