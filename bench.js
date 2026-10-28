// Benchmark overlay shared by the three.js player (?bench=1) and the Unity WebGL build (index.html includes it).
// Shows time to ready, bytes transferred, fps / frame-time percentiles over the last 5 s, frames > 50 ms, GPU.
// window.bench.report() returns the same numbers as an object; window.bench.reset() restarts the frame statistics.
// Unity URLs: index.html?product=<id>&autoplay=1&autobench=<s>.
// "Ready": three.js = window.player exists; Unity = createUnityInstance resolved (menu) and, for ?product=,
// the "[IKEA Pipeline] scenario ready" console line.
(() => {
  const marks = {};
  const mark = k => { if (!(k in marks)) marks[k] = Math.round(performance.now()); };

  // Unity: wrap createUnityInstance when the loader script has loaded (capture phase = before the template's onload).
  document.addEventListener('load', e => {
    const f = window.createUnityInstance;
    if (e.target.tagName === 'SCRIPT' && /loader\.js/.test(e.target.src) && f)
      window.createUnityInstance = (...a) => f(...a).then(u => { mark('unityReady'); return u; });
  }, true);
  const log = console.log;
  console.log = (...a) => { if (typeof a[0] === 'string' && a[0].includes('scenario ready')) mark('scenarioReady'); log.apply(console, a); };
  const poll = setInterval(() => { if (window.player) { mark('playerReady'); clearInterval(poll); } }, 20);

  let frames = [], last = performance.now(), long = 0, t0 = last;
  (function f() {
    const n = performance.now(), d = n - last; last = n;
    frames.push([n, d]); if (d > 50) long++;
    while (frames.length && frames[0][0] < n - 5000) frames.shift();
    requestAnimationFrame(f);
  })();

  const gpu = (() => {
    try { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }
    catch (e) { return '?'; }
  })();

  function bytes() {
    let enc = 0, dec = 0;
    for (const e of performance.getEntriesByType('navigation').concat(performance.getEntriesByType('resource'))) {
      enc += e.encodedBodySize || 0; dec += e.decodedBodySize || 0;
    }
    return { transferredKB: Math.round(enc / 1024), decodedKB: Math.round(dec / 1024) };
  }

  function report() {
    const d = frames.slice(1).map(f => f[1]).sort((a, b) => a - b);
    const q = p => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : 0;
    const avg = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
    return {
      ...marks, ...bytes(), fps: avg ? +(1000 / avg).toFixed(1) : 0, p50: q(0.5), p95: q(0.95), max: q(1),
      longFrames: long, statSeconds: Math.round((performance.now() - t0) / 1000),
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, gpu,
    };
  }

  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.35 monospace;pointer-events:none;white-space:pre-wrap;max-width:calc(100vw - 32px)';
  const show = () => {
    const r = report();
    box.textContent = [
      ['ready', [r.playerReady ?? r.unityReady, r.scenarioReady].filter(x => x != null).map(x => x + ' ms').join(' / ') || '…'],
      ['loaded', `${r.transferredKB} KB (${r.decodedKB} KB unpacked)`],
      ['fps', `${r.fps}  p50 ${r.p50}  p95 ${r.p95}  max ${r.max} ms  >50ms: ${r.longFrames}`],
      ['view', r.viewport], ['gpu', r.gpu],
    ].map(([k, v]) => k.padEnd(7) + v).join('\n');
  };
  const add = () => { document.body.appendChild(box); setInterval(show, 500); };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);

  const reset = () => { frames = []; long = 0; t0 = performance.now(); };
  window.bench = { report, reset, marks };

  // ?autobench=<s>: once ready, start playback (three.js: player.play(); Unity: a Space key press), wait 1 s, measure
  // <s> seconds, then put "BENCH {json}" into document.title (read back from outside via the DevTools /json list).
  const auto = +new URLSearchParams(location.search).get('autobench');
  if (auto > 0) {
    const unity = /[?&]product=/.test(location.search);
    const wait = setInterval(() => {
      if (!(unity ? marks.scenarioReady : marks.playerReady)) return;
      clearInterval(wait);
      setTimeout(() => {
        if (window.player) window.player.play();     // Unity ignores synthetic key events: it starts itself on ?autoplay=1
        setTimeout(() => { reset(); setTimeout(() => { document.title = 'BENCH ' + JSON.stringify(report()); }, auto * 1000); }, 1000);
      }, 1500);
    }, 100);
  }
})();
