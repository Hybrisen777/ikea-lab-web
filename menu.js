// App-level UI of the web player (port of MenuUI + IssueReporter): main menu, product browser (search + type filter +
// cards), in-scenario HUD (Report issue / Menu), pause menu (Esc), settings, issue report form (F8), loading, toasts.
// The product list comes from index.json (written by Unity's web export), so new exports appear without code changes.
import { settings, SPEEDS, speedLabel, asset } from './settings.js?v=edef65954c';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CATEGORIES = ['Bug', 'Wrong instruction', 'Visual', 'Interaction', 'Performance', 'Suggestion'];
const SEVERITIES = ['Low', 'Medium', 'High', 'Blocker'];
const FILTERS = [['', 'All'], ['assembly', 'Assembly'], ['twin', 'Digital twin']];
const modeLabel = m => m === 'assembly' ? 'Assembly' : m === 'twin' ? 'Digital twin' : m === 'both' ? 'Assembly + use' : (m || 'Assembly');
const isAssembly = m => !m || m === 'assembly' || m === 'both';
const sessionId = Math.random().toString(16).slice(2, 10);
const startTime = performance.now();

// ---------------- modal gate (AppModal): scenario frozen, scene input ignored while a modal is open ----------------
const openModals = [];
export const modal = { get isOpen() { return openModals.length > 0; } };
function openModal(el) { if (openModals.includes(el)) return; el.classList.remove('hidden'); openModals.push(el); }
function closeModal(el) { const i = openModals.indexOf(el); if (i < 0) return; openModals.splice(i, 1); el.classList.add('hidden'); }

let scenario = null;      // set by attachScenario() while a product is open
let products = [];
let issuesUrl = '';        // index.json "issuesUrl" (public site): Submit opens a pre-filled GitHub issue
let view = 'menu';        // menu | products | loading | scenario

export async function loadIndex() {
  try {
    const j = await (await fetch(asset('index.json'))).json();
    products = Array.isArray(j) ? j : (j.products || []);
    issuesUrl = (!Array.isArray(j) && j.issuesUrl) || '';
  } catch (e) { products = []; }
  return products;
}

const productUrl = p => `player.html?p=${encodeURIComponent(p.folder)}`;
const goMenu = () => { location.href = 'player.html'; };
const goProducts = () => { location.href = 'player.html?view=products'; };

// ---------------- toast ----------------
let toastTimer = 0;
export function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden', 'fade');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.add('fade'); toastTimer = setTimeout(() => t.classList.add('hidden'), 400); }, 3100);
}

// ---------------- views ----------------
export function showLoading(name) { view = 'loading'; $('loading').textContent = `Loading ${name || ''}…`; $('loading').classList.remove('hidden'); }
export function hideLoading() { $('loading').classList.add('hidden'); }

function card(p) {
  const a = document.createElement('a'); a.className = 'card'; a.href = productUrl(p); a.setAttribute('aria-label', `${p.name}, ${modeLabel(p.mode)}`);
  const sub = (p.category ? p.category + '  ·  ' : '') + (isAssembly(p.mode) ? `${p.steps ?? '?'} steps` + (p.mode === 'both' ? ' + use' : '') : 'Interactive');
  a.innerHTML = `<div class="thumb">${p.thumbnail ? `<img src="${esc(asset(p.folder + '/' + p.thumbnail))}" alt="">` : `<span class="ph">${esc(p.name)}</span>`}
      <span class="badge ${isAssembly(p.mode) ? 'asm' : 'twin'}">${esc(modeLabel(p.mode).toUpperCase())}</span></div>
    <div class="cbody"><b>${esc(p.name)}</b><span>${esc(sub)}</span><small>${esc(p.id)}</small></div>`;
  return a;
}

export function showMenu() {
  view = 'menu';
  $('products').classList.add('hidden'); $('menu').classList.remove('hidden');
  const f = $('featured'); f.innerHTML = '';
  for (const p of products.slice(0, 4)) f.appendChild(card(p));
  const asm = products.filter(p => isAssembly(p.mode)).length, twin = products.length - asm;
  const P = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('menuFooter').textContent = `${P(products.length, 'product', 'products')}  ·  ${P(asm, 'assembly guide', 'assembly guides')}  ·  ${P(twin, 'digital twin', 'digital twins')}     web player`;
  document.title = 'IKEA Product Lab';
}

let filterMode = '';
export function showProducts() {
  view = 'products';
  $('menu').classList.add('hidden'); $('products').classList.remove('hidden');
  const g = $('grid'); g.innerHTML = '';
  for (const p of products) { const c = card(p); c.dataset.folder = p.folder; g.appendChild(c); }
  applyFilter();
  document.title = 'Products - IKEA Product Lab';
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  let shown = 0;
  [...$('grid').children].forEach((el, i) => {
    const p = products[i];
    const ok = (filterMode === '' || p.mode === filterMode || p.mode === 'both' || (filterMode === 'assembly' && !p.mode)) &&
      (!q || [p.name, p.id, p.category].some(s => (s || '').toLowerCase().includes(q)));
    el.classList.toggle('hidden', !ok); if (ok) shown++;
  });
  [...$('filters').children].forEach((c, i) => c.classList.toggle('on', FILTERS[i][0] === filterMode));
  $('count').textContent = `${shown} of ${products.length}`;
  $('empty').classList.toggle('hidden', shown > 0);
}

// ---------------- pause / settings ----------------
function openPause() {
  if (!scenario) return;
  const p = scenario.product;
  $('pauseTitle').textContent = p.name;
  $('pauseSub').textContent = `${modeLabel(scenario.mode) === 'Assembly' ? 'Assembly instructions' : modeLabel(scenario.mode)}  ·  ${p.id}`;
  openModal($('pause'));
}
const closePause = () => closeModal($('pause'));

function refreshSettings() {
  [...$('setSpeed').children].forEach((c, i) => c.classList.toggle('on', Math.abs(SPEEDS[i] - settings.speed) < 1e-3));
  const pair = (id, first) => { const [a, b] = $(id).children; a.classList.toggle('on', first); b.classList.toggle('on', !first); };
  pair('setPlay', !settings.continuous); pair('setCam', settings.autoCamera); pair('setXray', settings.xray);
}
function openSettings() { refreshSettings(); openModal($('settings')); }

// ---------------- issue report (F8) ----------------
let report = { cat: 0, sev: 1, shot: null, attach: true };
function openReport() {
  if (!$('report').classList.contains('hidden')) return;
  report.shot = scenario ? scenario.capture() : null;   // before the form covers the view
  report.attach = !!report.shot;
  $('reportWhere').textContent = where();
  $('shotImg').src = report.shot || ''; $('shotFrame').classList.toggle('hidden', !report.shot);
  $('repError').textContent = '';
  // public site: the report becomes a public GitHub issue (needs a GitHub account)
  $('repSubmit').innerHTML = issuesUrl ? 'Continue on GitHub &nbsp;→' : 'Submit report';
  $('repNote').textContent = issuesUrl ? 'Opens a public issue on GitHub (account needed) - do not include personal data. You check it and press Submit there.' : '';
  $('repNameRow').classList.toggle('hidden', !!issuesUrl);   // GitHub shows who reported it
  refreshReport();
  if (scenario) scenario.pause();
  openModal($('report'));
  setTimeout(() => $('repTitle').focus(), 0);
}
function refreshReport() {
  [...$('repCats').children].forEach((c, i) => c.classList.toggle('on', i === report.cat));
  [...$('repSevs').children].forEach((c, i) => c.classList.toggle('on', i === report.sev));
  const t = $('shotToggle'); t.textContent = report.attach ? 'Screenshot attached' : 'No screenshot'; t.classList.toggle('on', report.attach);
  t.disabled = !report.shot;
  $('shotNote').textContent = report.shot ? 'The 3D view as it was when you opened this form.' : 'No 3D view on this screen.';
}
const where = () => scenario ? [scenario.product.name, scenario.where()].filter(Boolean).join('  ·  ') : (view === 'products' ? 'Product list' : 'Main menu');

function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl'); const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  } catch (e) { return ''; }
}
function submitReport() {
  const title = $('repTitle').value.trim(), description = $('repDesc').value.trim();
  if (!title) { $('repError').textContent = 'Please add a short title.'; $('repTitle').focus(); return; }
  const now = new Date();
  const id = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_') + '_' + Math.random().toString(16).slice(2, 6);
  const r = {   // same fields as Unity's IssueReport (report.json); screenshot embedded instead of screenshot.jpg
    reportId: id, createdUtc: now.toISOString(), sessionId,
    productId: scenario?.product.id || '', productName: scenario?.product.name || '', mode: scenario?.mode || '',
    where: where(), secondsInScenario: scenario ? Math.round((performance.now() - startTime) / 100) / 10 : 0,
    state: scenario ? scenario.state() : [], camera: scenario ? scenario.camera() : '',
    category: CATEGORIES[report.cat], severity: SEVERITIES[report.sev], title, description, reporter: $('repName').value.trim(),
    appVersion: 'web-player', unityVersion: '', platform: 'Web (three.js)', os: navigator.userAgent, device: navigator.platform || '',
    gpu: gpuName(), resolution: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    screenshotFile: report.attach && report.shot ? 'embedded' : '', screenshotJpeg: report.attach && report.shot ? report.shot : '',
  };
  if (issuesUrl) { openGitHubIssue(r); return; }
  download(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), `issue_${id}.json`);
  closeReport(); $('repTitle').value = $('repDesc').value = '';
  toast(`Report saved: issue_${id}.json (your downloads folder)`);
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Public site: a "New issue" page on GitHub, pre-filled with the report as Markdown. A screenshot does not fit in a
 *  URL, so it is saved as issue_<id>.jpg and the issue text asks to drag it in. */
function openGitHubIssue(r) {
  const shot = r.screenshotJpeg;
  if (shot) download(dataUrlBlob(shot), `issue_${r.reportId}.jpg`);
  const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');   // Markdown table cell
  const head = [`**Type:** ${r.category} · **Severity:** ${r.severity}`, `**Where:** ${r.where}`, '', r.description || '_(no description)_', ''];
  if (shot) head.push(`**Screenshot:** drag \`issue_${r.reportId}.jpg\` from your downloads folder into this box.`, '');
  const ctx = ['<details><summary>Context (added automatically)</summary>', '', '| | |', '|---|---|',
    ...[['product', `${r.productName} ${r.productId}`.trim()], ['mode', r.mode], ['seconds in scenario', r.secondsInScenario], ...r.state.map(x => [x.key, x.value]),
      ['camera', r.camera], ['browser', r.os], ['gpu', r.gpu], ['resolution', r.resolution], ['report id', r.reportId]].map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`),
    '', '</details>'];
  let body = head.concat(ctx).join('\n');
  while (body.length > 6000 && ctx.length > 8) { ctx.splice(ctx.length - 4, 1); body = head.concat(ctx, ['_(context shortened)_']).join('\n'); }   // URL length limit
  const title = `[${r.category}] ${r.productName ? r.productName + ': ' : ''}${r.title}`;
  window.open(`${issuesUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  closeReport(); $('repTitle').value = $('repDesc').value = '';
  toast(shot ? `Opened GitHub - drag issue_${r.reportId}.jpg into the issue` : 'Opened GitHub - check the issue and press Submit there');
}
function dataUrlBlob(u) {
  const [meta, b64] = u.split(','), bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: meta.split(':')[1].split(';')[0] });
}
const closeReport = () => closeModal($('report'));

// ---------------- construction ----------------
export function buildShell() {
  const chips = (id, labels, onClick) => { const r = $(id); labels.forEach((l, i) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = l; b.onclick = () => onClick(i); r.appendChild(b); }); };
  chips('setSpeed', SPEEDS.map(speedLabel), i => settings.set('speed', SPEEDS[i]));
  chips('setPlay', ['Stop after each step', 'Play all steps continuously'], i => settings.set('continuous', i === 1));
  chips('setCam', ['Follow the moving parts', 'Free camera'], i => settings.set('autoCamera', i === 0));
  chips('setXray', ['Show through other parts (x-ray)', 'Off'], i => settings.set('xray', i === 0));
  chips('filters', FILTERS.map(f => f[1]), i => { filterMode = FILTERS[i][0]; applyFilter(); });
  chips('repCats', CATEGORIES, i => { report.cat = i; refreshReport(); });
  chips('repSevs', SEVERITIES, i => { report.sev = i; refreshReport(); });
  settings.on(refreshSettings);

  const on = (id, f) => $(id).addEventListener('click', e => { e.preventDefault(); f(); });
  on('mBrowse', goProducts); on('mAll', goProducts); on('mReport', openReport); on('mSettings', openSettings);
  on('pBack', goMenu); on('pReport', openReport);
  on('hudReport', openReport); on('hudMenu', openPause);
  on('pzResume', closePause); on('pzReport', () => { closePause(); openReport(); });
  on('pzRestart', () => { closePause(); scenario?.restart(); });
  on('pzProducts', goProducts); on('pzSettings', openSettings); on('pzMenu', goMenu);
  on('setDone', () => closeModal($('settings')));
  on('shotToggle', () => { report.attach = !report.attach; refreshReport(); });
  on('repCancel', closeReport); on('repSubmit', submitReport);
  $('search').addEventListener('input', applyFilter);
  for (const id of ['pause', 'settings', 'report']) $(id).addEventListener('pointerdown', e => { if (e.target.id === id) { if (id === 'pause') closePause(); else closeModal($(id)); } });

  addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!$('report').classList.contains('hidden')) closeReport();
      else if (!$('settings').classList.contains('hidden')) closeModal($('settings'));
      else if (!$('pause').classList.contains('hidden')) closePause();
      else if (view === 'scenario') openPause();
      else if (view === 'products' && !typing) goMenu();
      else if (typing) document.activeElement.blur();
    } else if (e.key === 'F8') { e.preventDefault(); openReport(); }
  });
}

/** Called by the player once a product is shown: shows the HUD and gives the menus access to the scenario. */
export function attachScenario(api) {
  scenario = api; view = 'scenario';
  $('menu').classList.add('hidden'); $('products').classList.add('hidden');
  $('hud').classList.remove('hidden');
}
