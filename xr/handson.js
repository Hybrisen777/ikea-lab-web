// Hands-on mode: the user assembles the product. For each move of the shown step the timeline waits at the start of
// the move; the move's parts (they glow) are picked up with a near grab (grip button / thumb-index pinch) or a
// distance grab (the same with the ray on the part: it jumps into the hand; xrPrefs.distanceGrab, off by default),
// carried and released. Inside the tolerance around the pose they have at the end of the move, a ghost shows; releasing there
// snaps and locks the part. Identical parts are interchangeable (either place point, any copy of the kind). When a move's parts are all placed the timeline jumps to the end of the move, and to the
// next move. Moves nobody places by hand (turning the whole assembly over) play as an animation. Parts released
// elsewhere stay where they are (no physics). Wrong part / step: red feedback, no snap.
// The scenario itself is not forked: everything goes through the player's transport (seekGlobal / play / pause) and
// the shared event bus (grab, place, snap, wrongPart, stepComplete with source: 'xr').
// Structure for a physics engine later: beginHold / updateHold / endHold own the held part's pose; a physics step
// would replace "stays where released" in endHold and the per-frame override in applyOverrides.
import * as THREE from 'three';
import { xrPrefs } from './quality.js?v=44a2f85a5a';
import { createTwins } from './twins.js?v=44a2f85a5a';

// Snap = attach radius: a carried part that comes within TOL_POS (+ 1/4 of its radius, at most TOL_POS_MAX) of its place
// point attaches by itself (no release needed); big parts must also be turned within TOL_ROT of the target or of any
// turn that looks the same (twins.symmetries: a square leg every 90 deg), small parts attach in any orientation.
const TOL_POS = 0.05, TOL_ROT = 30, GHOST_NEAR = 2;   // metres (real, scaled with the rig), degrees
const AUTO_NEXT = 2;                                                         // s after a completed step: next step opens
const FAR_GAP = 0.05;                                                        // distance grab: gap between hand and part
const HINT_GRAB = 'Grab a glowing part (grip / pinch - reach it or point at it).';
const HINT_START = 'Check the parts on the floor, then press Start.';      // parts overview: nothing to place yet
const HINT_PLACE = 'Now put it on its blue ghost - let go when the ghost turns green.';
const TOL_POS_MAX = 0.12;                                                    // attach radius: 5 cm + 1/4 of the part's radius, at most 12 cm
const REACH = 0.04, REACH_SMALL = 0.07;                                      // near-grab distance to the part's box (enlarged for small parts)
const SMALL = 0.08;
const ENTRY_MAX = 0.1;                                                       // the attach radius follows at most this much of the way in

export function createHandsOn(xs) {
  const { host } = xs, input = xs.input, root = host.root, ev = host.events;
  const T = host.transport;
  let on = false, stepKey = '', moveIdx = -1, move = null, targets = new Map(), autoUntil = null, advanceAt = null, hint = null, resumeAt = null, finishing = false;
  const overrides = new Map();          // part name -> { p, q } local pose that replaces the timeline pose
  const locked = new Set();             // snapped in this move
  const held = { left: null, right: null };
  xs.holding = held;
  const ghosts = new THREE.Group(); ghosts.name = 'XRGhosts'; host.scene.add(ghosts);
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x3fb950, transparent: true, opacity: 0.35, depthWrite: false });
  const ghostNear = new THREE.MeshBasicMaterial({ color: 0xffd91a, transparent: true, opacity: 0.25, depthWrite: false });
  const ghostWhere = new THREE.MeshBasicMaterial({ color: 0x2fb7ff, transparent: true, opacity: 0.3, depthWrite: false });    // where it goes
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x2fb7ff, transparent: true, opacity: 0.95, depthTest: false });
  const edgeCache = new Map();                                                                      // geometry -> its edges
  const arrowGeo = new THREE.ConeGeometry(0.04, 0.11, 16).rotateX(Math.PI).translate(0, 0.055, 0);   // tip down, at y = 0
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0x2fb7ff, transparent: true, opacity: 0.95, depthTest: false });
  const audio = beeper();

  const g = () => host.time.globalTime();
  const stepOf = () => host.st.chapter > 0 ? host.steps[host.st.chapter - 1] : null;
  const isSmall = p => p.radius <= SMALL;
  const tolPos = () => TOL_POS * xs.rig.scale.x;
  const tolOf = part => Math.min(TOL_POS + 0.25 * part.radius, TOL_POS_MAX) * xs.rig.scale.x;   // bigger part, bigger radius

  // ---------------- step / move sequencing ----------------
  /** resume: continue the shown step where the timeline is (re-entering VR), instead of from the step's start. */
  function setMode(m, { resume = false } = {}) {
    xs.mode2 = m;
    if (m === 'handson') { on = true; stepKey = ''; T.pause(); hint = null; resumeAt = resume ? g() : null; }
    else { on = false; releaseAll(false); clearMove(); overrides.clear(); xs.panel?.setHint(xs.walkHint || ''); host.dirty(); }
  }
  xs.setMode = setMode;

  function clearMove() { move = null; moveIdx = -1; targets.clear(); locked.clear(); autoUntil = null; finishing = false; ghosts.clear(); }

  /** The shown step changed (panel next / prev / restart) or hands-on was switched on: start its first move. */
  function beginStep() {
    releaseAll(false); clearMove(); overrides.clear();
    const s = stepOf();
    stepKey = host.st.chapter + '';
    if (!s) return;
    T.pause();
    if (resumeAt != null) {                                         // the moves that ended before now are done
      let after = -1;
      s.moves.forEach((m, i) => { if (m.spans[m.spans.length - 1][1] <= resumeAt + 1e-4) after = i; });
      resumeAt = null; nextMove(after); return;
    }
    seekInStep(s.start);
    nextMove(-1);
  }
  function nextMove(after) {
    const s = stepOf(); if (!s) return;
    targets.clear(); locked.clear(); ghosts.clear();
    autoUntil = null;                                               // a skip during a turn: its end would seek back
    for (let i = after + 1; i < s.moves.length; i++) {
      const m = s.moves[i], t0 = m.spans[0][0];
      const parts = (m.moving || m.parts).filter(n => host.byName[n]);
      if (!parts.length) continue;
      moveIdx = i; move = m;
      autoUntil = t0 > g() + 1e-3 && overlapsRoot(s, g(), t0) ? t0 : null;   // turning the assembly: play it
      if (!autoUntil) seekInStep(t0);
      for (const n of parts) targets.set(n, { ...poseAt(host.byName[n], m.spans[m.spans.length - 1][1]), e: entryOf(m, host.byName[n]) });
      return;
    }
    // no hand-placed move left: a turn still to come (lower the frame onto the seat, turn the chair upright) plays first
    move = null; moveIdx = s.moves.length;
    const end = s.start + s.duration;
    if (overlapsRoot(s, g() + 1e-3, end)) { autoUntil = end; finishing = true; return; }
    finishStep();
  }
  function finishStep() {
    const s = stepOf();
    finishing = false; autoUntil = null;
    seekInStep(s.start + s.duration);
    ev.emit('stepComplete', { step: host.st.chapter, source: 'xr' });
    const last = host.st.chapter >= host.steps.length;
    xs.panel?.flash(last ? 'Done - the product is assembled!' : 'Step done - next step…', '#2e7d32');
    if (!last) advanceAt = performance.now() + AUTO_NEXT * 1000;   // the next step opens by itself
  }
  /** Where the part starts its insertion (a bolt at the mouth of its hole): the start of the last insert phase that
   *  moves it. The attach radius covers the whole way in, not only the fully inserted pose (whose centre is in the wood). */
  function entryOf(m, part) {
    for (const [a, b, kind] of [...(m.phases || [])].reverse()) {
      if (kind !== 'insert') continue;
      const pa = poseAt(part, a).p, pb = poseAt(part, b).p, len = pa.distanceTo(pb);
      if (len > 1e-4) return len > ENTRY_MAX ? pb.clone().lerp(pa, ENTRY_MAX / len) : pa;   // long slides: only the last 10 cm
    }
    return null;
  }
  const overlapsRoot = (s, a, b) => (s.rootSpans || []).some(r => r[0] < b && r[1] > a);
  /** Seek inside the shown step. Not seekGlobal: at a step boundary it can open the neighbouring step (the end of this
   *  one; or rounding: step 6 of STEFAN ends at 35.133340000000004, step 7 starts at 35.13334 and would seek back to 6). */
  function seekInStep(t) {
    const s = stepOf();
    T.pause(); host.st.local = THREE.MathUtils.clamp(t - s.start, 0, s.duration);
  }

  /** Local pose (relative to the model root) of a part at a global time, without disturbing the frame. */
  function poseAt(part, t) {
    const n = part.node, p = n.position.clone(), q = n.quaternion.clone();
    host.applyPose(part, t, true);
    const out = { p: n.position.clone(), q: n.quaternion.clone() };
    n.position.copy(p); n.quaternion.copy(q);
    return out;
  }
  // ---------------- part hierarchy (like parenting in Unity) ----------------
  // A move with attachTo X fits its parts INTO the loose part X (brackets into a rail, dowels into a backrest). From
  // the end of that move they are X's children: when X is carried or dropped elsewhere, they move with it, and the
  // targets of parts still to be fitted into X move with X too. The timeline already bakes this; the per-part
  // overrides of hands-on did not.
  const M = o => new THREE.Matrix4().compose(o.p, o.q, one.set(1, 1, 1));
  const follow = new Map();                                         // child name -> pose derived from its carrier
  function childrenOf(name) {
    const out = [], now = g() + 1e-4;
    for (const st of host.steps) for (const m of st.moves)
      if (m.attachTo === name && m.spans[m.spans.length - 1][1] <= now) for (const c of m.parts) if (host.byName[c] && !out.includes(c)) out.push(c);
    return out;
  }
  function descendantsOf(name, out = []) { for (const c of childrenOf(name)) if (!out.includes(c)) { out.push(c); descendantsOf(c, out); } return out; }
  const effPose = name => overrides.get(name) || follow.get(name) || null;   // null: on the timeline
  /** Carrier delta: (pose the carrier has now) * (its timeline pose)^-1, or null when it is on the timeline. */
  function carrierDelta(name) {
    const e = effPose(name); if (!e) return null;
    return M(e).multiply(M(poseAt(host.byName[name], g())).invert());
  }
  /** A part's target, moved with its carrier (the current move's attachTo) when the user moved that. */
  function targetOf(name) {
    const t = targets.get(name); if (!t) return null;
    const d = move?.attachTo && carrierDelta(move.attachTo);
    if (!d) return t;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const e = t.e && t.e.clone().applyMatrix4(d);
    d.multiply(M(t)).decompose(p, q, sc);
    return { p, q, e };
  }
  /** Children follow carriers that are held / dropped / placed off the timeline (recomputed every frame). Parts
   *  already snapped into this move's carrier are its children too, before the move has ended. */
  function updateFollow() {
    follow.clear();
    const roots = [...overrides.keys()];
    for (const r of roots) {
      const d = carrierDelta(r); if (!d) continue;
      for (const c of descendantsOf(r)) {
        if (overrides.has(c) || follow.has(c)) continue;
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
        d.clone().multiply(M(poseAt(host.byName[c], g()))).decompose(p, q, sc);
        follow.set(c, { p, q });
      }
    }
    if (move?.attachTo) for (const n of locked) if (!overrides.has(n)) follow.set(n, targetOf(n));   // after the carriers' own follow poses
  }

  // ---------------- interchangeable parts ----------------
  // Identical parts (twins.js: same shape in any orientation - the dowels of KALLAX lying along x or z, a bolt of a
  // later step) may go to any of their place points: a part is swapped with the expected part of the same kind (they
  // look the same, so the swap is invisible: b takes a's pose times the shape transform). Grabbing a non-expected twin
  // swaps on grab; releasing at a twin's place point swaps on release. Left / right mirror pairs differ.
  const twins = createTwins();
  const swappable = (a, b) => a !== b && !Object.values(held).some(h => h?.part === b) && !!twins.twin(a, b) && childrenMatch(a, b);
  const poseNow = part => overrides.get(part.name) || follow.get(part.name) || { p: part.node.position.clone(), q: part.node.quaternion.clone() };
  /** Parts already fitted into a and b correspond one to one (a twin each, at the same spot of the shape: the dowel in
   *  either ALEX drawer side). Then the swap is still invisible: the fitted parts follow their carrier's new pose. */
  function childrenMatch(a, b) {
    const ca = descendantsOf(a.name), cb = descendantsOf(b.name);
    if (ca.length !== cb.length) return false;
    if (!ca.length) return true;
    const Ma = M(poseNow(a)).invert(), Mb = M(poseNow(b)).invert(), Tinv = twins.twin(a, b).clone().invert(), used = new Set();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p2 = new THREE.Vector3(), q2 = new THREE.Quaternion();
    for (const c of ca) {
      const pc = host.byName[c], Rc = Ma.clone().multiply(M(poseNow(pc)));
      const d = cb.find(n => {
        if (used.has(n)) return false;
        const pd = host.byName[n], tw = twins.twin(pc, pd); if (!tw) return false;
        Tinv.clone().multiply(Rc).multiply(tw).decompose(p, q, sc);              // where d would have to sit on b
        Mb.clone().multiply(M(poseNow(pd))).decompose(p2, q2, sc);               // where it sits
        return p.distanceTo(p2) <= 0.003 && THREE.MathUtils.radToDeg(q.angleTo(q2)) <= 5;
      });
      if (!d) return false;
      used.add(d);
    }
    return true;
  }
  /** Pose o of part a, given to its twin b (b's mesh lands where a's mesh is). */
  function asTwin(o, a, b) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    M(o).multiply(twins.twin(a, b)).decompose(p, q, sc);
    return { p, q };
  }
  /** a (held at side) and b change identities: b is now in the hand, a lies where b was. */
  function swapInto(side, a, b) {
    const pa = poseNow(a), pb = poseNow(b);
    overrides.set(b.name, asTwin(pa, a, b)); overrides.set(a.name, asTwin(pb, b, a));
    held[side].part = b; held[side].offset.multiply(twins.twin(a, b));
    ev.emit('swap', { from: a.name, to: b.name, source: 'xr' });
    applyOverrides();
  }
  /** Unplaced expected part of a's kind whose target fits a's pose o (or any, when o is null), or null. */
  function twinTarget(a, o) {
    for (const n of targets.keys()) {
      const b = host.byName[n];
      if (locked.has(n) || !swappable(a, b)) continue;
      if (!o || within(asTwin(o, a, b), targetOf(n), b)) return b;
    }
    return null;
  }

  function moveDone() {
    const m = move, end = m.spans[m.spans.length - 1][1];
    for (const n of targets.keys()) overrides.delete(n);            // snapped = timeline end pose, or a child of a moved carrier
    seekInStep(end);
    nextMove(moveIdx);
  }

  // ---------------- holding (structure for physics later) ----------------
  const tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
  const grabMatrix = s => tmpM.compose(s.grabPose.position, s.grabPose.quaternion, one.set(1, 1, 1));
  function grabbable(part) {
    if (locked.has(part.name)) return false;
    if (targets.has(part.name)) return true;
    return !host.inRanges(part.installed, g()) && !fitted(part.name);   // already built in / fitted into its carrier
  }
  /** The part's own move has ended: it is in place (on the assembly or on a loose carrier) and stays there. */
  function fitted(name) {
    const now = g() + 1e-4;
    return host.steps.some(st => st.moves.some(m => (m.moving || m.parts).includes(name) && m.spans[m.spans.length - 1][1] <= now));
  }
  function nearestPart(s) {
    let best = null, bd = Infinity;
    const k = xs.rig.scale.x, pt = s.grabPose.position;
    for (const p of host.parts) {
      if (!grabbable(p)) continue;
      const d = host.partBox(p).distanceToPoint(pt), lim = (isSmall(p) ? REACH_SMALL : REACH) * k;
      if (d <= lim && d < bd) { bd = d; best = p; }
    }
    return best;
  }
  /** Grabbable part under a side's ray (distance grab), or null. */
  function rayPart(side) {
    const h = xs.interaction?.hover[side];
    const p = h?.kind === 'part' ? host.byName[h.id] : null;
    return p && grabbable(p) ? p : null;
  }
  function beginHold(side, part, far = false) {
    const s = input.sides[side];
    part.node.updateMatrixWorld(true);
    const M = part.node.matrixWorld.clone();
    if (far) {   // distance grab: the part comes to the hand and hangs just in front of it along the ray, orientation kept
      const box = host.partBox(part), c = box.getCenter(new THREE.Vector3());
      const r = box.getSize(new THREE.Vector3()).length() / 2;           // so it clears the controller / hand
      const at = s.grabPose.position.clone().addScaledVector(s.rayDirection, r + FAR_GAP * xs.rig.scale.x);
      M.premultiply(new THREE.Matrix4().makeTranslation(at.x - c.x, at.y - c.y, at.z - c.z));
    }
    const offset = grabMatrix(s).clone().invert().multiply(M);
    held[side] = { part, offset };
    if (!targets.has(part.name)) { const b = twinTarget(part, null); if (b) swapInto(side, part, b); }   // a twin of an expected part
    ev.emit('grab', { part: held[side].part.name, side, input: s.type, distance: far, source: 'xr' });
    input.pulse(side, 0.5, 30); audio(660, 0.05);
  }
  function updateHold(side) {
    const h = held[side], s = input.sides[side];
    tmpM2.multiplyMatrices(grabMatrix(s), h.offset);                 // world pose of the part
    const local = root.matrixWorld.clone().invert().multiply(tmpM2);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    local.decompose(p, q, sc);
    overrides.set(h.part.name, { p, q });
    return { p, q };
  }
  /** The place point a held part is within the attach radius of: its own, or an identical part's (a twin), or null. */
  function snapCandidate(h) {
    const o = overrides.get(h.part.name);
    if (targets.has(h.part.name) && !locked.has(h.part.name) && within(o, targetOf(h.part.name), h.part)) return h.part;
    return twinTarget(h.part, o);
  }
  function endHold(side, judge = true) {
    const h = held[side];
    if (!h || !judge) { held[side] = null; return; }
    const b = snapCandidate(h);
    if (b && b !== h.part) swapInto(side, h.part, b);              // at a twin's place point: take its place
    held[side] = null;
    const t = targetOf(h.part.name);
    if (b) {
      locked.add(h.part.name);
      if (move.attachTo) overrides.delete(h.part.name);              // fitted into the carrier: follows it from now on
      else overrides.set(h.part.name, { p: t.p.clone(), q: t.q.clone() });
      for (const c of descendantsOf(h.part.name)) overrides.delete(c);   // they ride along with the snapped carrier
      ev.emit('place', { part: h.part.name, snapped: true, side, source: 'xr' });
      ev.emit('snap', { part: h.part.name, step: host.st.chapter, move: moveIdx, source: 'xr' });
      input.pulse(side, 1.0, 60); audio(990, 0.09); xs.panel?.flash('✓ ' + h.part.label, '#2e7d32');
      if ([...targets.keys()].every(n => locked.has(n))) moveDone();
    } else {
      ev.emit('place', { part: h.part.name, snapped: false, side, source: 'xr' });
      if (!t) {
        ev.emit('wrongPart', { part: h.part.name, step: host.st.chapter, expected: [...targets.keys()], source: 'xr' });
        input.pulse(side, 0.8, 120); audio(220, 0.15); xs.panel?.flash('Not this part - take a glowing one', '#c0392b');
      }
    }
  }
  function releaseAll(judge) { for (const side of ['left', 'right']) if (held[side]) endHold(side, judge); }
  function within(o, t, part) {
    if (!o || !t) return false;
    const dp = (t.e ? new THREE.Line3(t.e, t.p).closestPointToPoint(o.p, true, new THREE.Vector3()) : t.p).distanceTo(o.p) * root.matrixWorld.getMaxScaleOnAxis();
    if (dp > tolOf(part)) return false;
    if (isSmall(part)) return true;                                   // small parts: any orientation
    // big parts: within TOL_ROT of the target or of any turn that looks the same (a square leg: every 90 deg)
    const tq = new THREE.Quaternion();
    return twins.symmetries(part).some(s => THREE.MathUtils.radToDeg(o.q.angleTo(tq.copy(t.q).multiply(s))) <= TOL_ROT);
  }
  function errorOf(name) {   // QA: distance (world units) and angle of a held / released part to its target
    const o = overrides.get(name), t = targetOf(name);
    return o && t ? { d: o.p.distanceTo(t.p), a: THREE.MathUtils.radToDeg(o.q.angleTo(t.q)) } : null;
  }

  // ---------------- per frame (after the player has applied the timeline poses) ----------------
  function applyOverrides() {
    updateFollow();
    for (const map of [overrides, follow]) for (const [n, o] of map) { const nd = host.byName[n].node; nd.position.copy(o.p); nd.quaternion.copy(o.q); }
    if (overrides.size || follow.size) root.updateMatrixWorld(true);
  }
  /** Ghost copy of a part at its target, in material mat. */
  function addGhost(part, t, mat, outline = false) {
    const m = new THREE.Matrix4().compose(t.p, t.q, new THREE.Vector3(1, 1, 1)).premultiply(root.matrixWorld);
    addMeshes(part, m, mat, outline);
    const tl = M(poseAt(part, g())).invert();                       // its children, where they will be with it
    for (const c of descendantsOf(part.name)) {
      const cp = host.byName[c], rel = M(poseAt(cp, g()));
      addMeshes(cp, new THREE.Matrix4().compose(t.p, t.q, one.set(1, 1, 1)).multiply(tl).multiply(rel).premultiply(root.matrixWorld), mat, outline);
    }
  }
  function addMeshes(part, m, mat, outline) {
    for (const mesh of part.meshes) {
      const rel = part.node.matrixWorld.clone().invert().multiply(mesh.matrixWorld), at = new THREE.Matrix4().multiplyMatrices(m, rel);
      const gm = new THREE.Mesh(mesh.geometry, mat);
      gm.matrixAutoUpdate = false; gm.matrix.copy(at); gm.renderOrder = 15; gm.raycast = () => {};
      ghosts.add(gm);
      if (!outline) continue;   // blue outline of the target, seen through the other parts
      if (!edgeCache.has(mesh.geometry)) edgeCache.set(mesh.geometry, new THREE.EdgesGeometry(mesh.geometry, 30));
      const ln = new THREE.LineSegments(edgeCache.get(mesh.geometry), outlineMat);
      ln.matrixAutoUpdate = false; ln.matrix.copy(at); ln.renderOrder = 16; ln.raycast = () => {};
      ghosts.add(ln);
    }
  }
  /** Every part still to place shows where it goes (faint blue); a carried part near its target turns its ghost
   *  yellow (near) / green (release = snap). */
  function showGhosts() {
    ghosts.clear();
    const carried = new Map();
    for (const side of ['left', 'right']) { const h = held[side]; if (h) carried.set(h.part.name, h); }
    for (const name of targets.keys()) {
      if (locked.has(name)) continue;
      const t = targetOf(name), h = carried.get(name), part = host.byName[name];
      if (h) {
        const o = overrides.get(name);
        const near = o.p.distanceTo(t.p) * root.matrixWorld.getMaxScaleOnAxis() <= tolOf(part) * GHOST_NEAR;
        if (near) { addGhost(part, t, within(o, t, part) ? ghostMat : ghostNear); continue; }
      }
      const first = ghosts.children.length;
      addGhost(part, t, ghostWhere, true);
      const box = new THREE.Box3();                                  // a bobbing arrow above the target: small parts
      for (let i = first; i < ghosts.children.length; i++) { const o = ghosts.children[i]; o.updateMatrixWorld(); box.expandByObject(o); }
      const k = xs.rig.scale.x, arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.position.set((box.min.x + box.max.x) / 2, box.max.y + (0.06 + 0.03 * Math.sin(performance.now() / 250)) * k, (box.min.z + box.max.z) / 2);
      arrow.scale.setScalar(k); arrow.renderOrder = 17; arrow.raycast = () => {};
      ghosts.add(arrow);
    }
  }

  function update(dt) {
    if (!on) { advanceAt = null; return; }
    if (advanceAt != null && performance.now() >= advanceAt) { advanceAt = null; if (!move) T.next(); }
    if (stepKey !== host.st.chapter + '') { advanceAt = null; beginStep(); }
    if (autoUntil != null) {                                        // the assembly turns over: play it (timeline 1:1)
      T.pause(); seekInStep(Math.min(autoUntil, g() + Math.max(dt, 1 / 90)));
      if (g() >= autoUntil - 1e-4) { autoUntil = null; if (finishing) finishStep(); } else return;
    }
    if (host.st.playing) T.pause();                                 // hands-on: the user drives, not the clock
    applyOverrides();                                               // dropped parts are where they were dropped before grabbing
    for (const side of ['left', 'right']) {
      const s = input.sides[side];
      if (held[side] && (s.type === 'none' || s.justReleased)) endHold(side);
      else if (!held[side] && s.justGrabbed && s.type !== 'none') {
        let p = nearestPart(s), far = false;
        if (!p && xrPrefs.distanceGrab) { p = rayPart(side); far = !!p; }      // distance grab: the part on the ray
        if (p && !Object.values(held).some(h => h?.part === p)) beginHold(side, p, far);
      }
      if (held[side]) { updateHold(side); applyOverrides(); if (snapCandidate(held[side])) endHold(side); }   // in the radius: attaches by itself
    }
    applyOverrides();
    showGhosts();
    const want = held.left || held.right ? HINT_PLACE : move ? HINT_GRAB : host.st.chapter === 0 ? HINT_START : '';   // the panel says what to do now
    if (want !== hint) { hint = want; xs.panel?.setHint(want); }
  }

  function dispose() {
    releaseAll(false); overrides.clear(); host.scene.remove(ghosts); ghostMat.dispose(); ghostNear.dispose(); ghostWhere.dispose(); outlineMat.dispose(); arrowGeo.dispose(); arrowMat.dispose(); for (const e of edgeCache.values()) e.dispose();
    xs.mode2 = 'watch'; host.dirty();
  }
  /** Panel buttons in hands-on mode: ▶ = do this move for me, ▶▶ = next step (or finish this one first). */
  function skipMove() { if (host.st.chapter === 0) { T.next(); return; }   // parts overview: Start = open step 1
    if (finishing) { finishStep(); return; } if (!move) return; releaseAll(false); for (const n of targets.keys()) locked.add(n); ev.emit('skip', { step: host.st.chapter, move: moveIdx, source: 'xr' }); moveDone(); }
  function nextStep() {
    if (move) { releaseAll(false); while (move) { for (const n of targets.keys()) locked.add(n); moveDone(); } return; }
    if (finishing) { finishStep(); return; }                       // the closing turn is playing: skip it
    T.next();
  }
  return {
    update, dispose, setMode, skipMove, nextStep,
    debug: () => ({ on, step: host.st.chapter, move: moveIdx, expected: [...targets.keys()], locked: [...locked],
      held: { left: held.left?.part.name || null, right: held.right?.part.name || null }, autoUntil, finishing, overrides: [...overrides.keys()], follow: [...follow.keys()] }),
    targetWorld(name) {   // QA: world pose of a part's target
      const t = targetOf(name); if (!t) return null;
      const m = new THREE.Matrix4().compose(t.p, t.q, new THREE.Vector3(1, 1, 1)).premultiply(root.matrixWorld);
      return m.toArray();
    },
    errorOf,
    twinMatrix(a, b) { const t = twins.twin(host.byName[a], host.byName[b]); return t ? t.toArray() : null; },   // QA
    canSwap(a, b) { return swappable(host.byName[a], host.byName[b]); },                                                  // QA
    insertLength(name) {   // QA: world length of a target's way in (entry -> fully inserted)
      const t = targetOf(name); return t?.e ? t.e.distanceTo(t.p) * root.matrixWorld.getMaxScaleOnAxis() : 0;
    },
    reach(side) {   // QA: parts within near-grab reach of a side, nearest first
      const s = input.sides[side], k = xs.rig.scale.x, pt = s.grabPose.position;
      return host.parts.map(p => ({ name: p.name, d: host.partBox(p).distanceToPoint(pt), lim: (isSmall(p) ? REACH_SMALL : REACH) * k, ok: grabbable(p) }))
        .filter(r => r.d <= r.lim).sort((a, b) => a.d - b.d);
    },
  };
}

/** Short beeps (WebAudio) for grab / snap / wrong part - controllers and hands alike. */
function beeper() {
  let ctx = null;
  return (hz, s) => {
    try {
      ctx ||= new AudioContext();
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.frequency.value = hz; gn.gain.setValueAtTime(0.15, ctx.currentTime); gn.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + s);
      o.connect(gn).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + s);
    } catch (e) { /* no audio */ }
  };
}
