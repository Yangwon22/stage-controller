'use strict';
// Stage Controller client — builds an Unreal-style Details panel from live UE property data.

const $ = id => document.getElementById(id);
const ss = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
};
const S = {
  ws: null, pin: ss.get('pin'), authed: false, connected: false, reopen: false,
  st: { objects: [], snapshots: [], ueOnline: false, locked: false },
  sel: ss.get('sel'), cur: null,
  search: '', modifiedOnly: false, fine: false, dragging: null,
  open: new Set(['cat:Volume', 'cat:Color Grading · Global', 'cat:Color Grading · Temperature', 'cat:Lens · Exposure']),
  widgets: new Map(), rows: [],
};

// ------------------------------------------------------------------ helpers
const K = p => p.join('\u0001');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const getAt = (o, p) => p.reduce((c, k) => (c == null ? undefined : c[k]), o);
function setAt(o, p, v) {
  let c = o;
  for (let i = 0; i < p.length - 1; i++) { if (c[p[i]] == null || typeof c[p[i]] !== 'object') c[p[i]] = {}; c = c[p[i]]; }
  c[p[p.length - 1]] = v;
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// Port of UE FName::NameToDisplayString (used when a property has no DisplayName meta)
function displayString(name, isBool) {
  const s = String(name); let i = 0;
  if (isBool && s.length > 1 && s[0] === 'b' && /[A-Z]/.test(s[1])) i = 1;
  let out = '', inRun = false, wasSpace = false, wasOpenParen = false, wasMinus = false;
  for (; i < s.length; i++) {
    let c = s[i];
    const lower = /[a-z]/.test(c), upper = /[A-Z]/.test(c), digit = /[0-9]/.test(c), under = c === '_';
    if ((upper || (digit && !wasMinus)) && !inRun) { if (!wasSpace && out.length) { out += ' '; wasSpace = true; } inRun = true; }
    if (lower || under) inRun = false;
    if (under || /\s/.test(c)) { if (!wasSpace && out.length) { out += ' '; wasSpace = true; } wasOpenParen = wasMinus = false; continue; }
    if (!out.length || wasSpace || wasOpenParen) c = c.toUpperCase();
    out += c; wasSpace = false; wasOpenParen = c === '('; wasMinus = c === '-';
  }
  return out.trim();
}
const nice = k => displayString(k, typeof k === 'string' && /^b[A-Z]/.test(k));
const catName = c => String(c).split('|').map(x => displayString(x.trim())).join(' · ');

// ---- schema (from the engine headers): names, categories, ranges, visibility, enums
const schema = () => S.cur && S.cur.schema;
function infoAt(p) {
  const sc = schema(); if (!sc) return null;
  let t = sc.root, info = null;
  for (const k of p) {
    if (info && info.t === 'array') { info = info.elem || null; t = info && info.t === 'struct' ? info.ref : null; continue; }
    const props = t && sc.types[t];
    info = props ? props[k] || null : null;
    if (!info) return null;
    t = info.t === 'struct' ? info.ref : null;
  }
  return info;
}
function labelOf(p, key, v) {
  if (typeof key === 'number') return `[${key}]`;
  const info = infoAt(p);
  return (info && info.dn) || displayString(key, typeof v === 'boolean');
}
function shownProp(parentPath, key) {
  const info = infoAt([...parentPath, key]);
  if (!info) return true;               // not in headers (e.g. Blueprint variables): show
  return info.show !== 'hidden' && !info.toggle;
}
// Children in declaration order (as the Details panel lists them)
function orderedKeys(parentPath, v) {
  if (Array.isArray(v)) return v.map((_, i) => i);
  const keys = Object.keys(v).filter(c => !hiddenOverride(v, c) && shownProp(parentPath, c));
  const sc = schema(); if (!sc) return keys;
  const pinfo = parentPath.length ? infoAt(parentPath) : null;
  const tname = parentPath.length ? (pinfo && pinfo.t === 'struct' ? pinfo.ref : null) : sc.root;
  const order = tname && sc.types[tname] ? Object.keys(sc.types[tname]) : [];
  const idx = k => { const i = order.indexOf(k); return i < 0 ? 1e6 : i; };
  return keys.sort((a, b) => idx(a) - idx(b));
}
const shortCls = c => (c || '').split('.').pop().replace(/_C$/, '');
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function fmt(v, int) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (int) return String(Math.round(v));
  const a = Math.abs(v);
  const s = v.toFixed(a >= 1000 ? 1 : a >= 100 ? 2 : 4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', bad ? 4000 : 2200);
}
const editable = () => S.connected && S.st.ueOnline && !S.st.locked;

// value shape
const AXES = ['X', 'Y', 'Z', 'W'], RGBA = ['R', 'G', 'B', 'A'], ROT = ['Pitch', 'Yaw', 'Roll'];
function shape(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'arr';
  const ks = Object.keys(v);
  const allNum = ks.length && ks.every(k => typeof v[k] === 'number');
  if (allNum && ks.length >= 2 && ks.every(k => AXES.includes(k))) return 'vec';
  if (allNum && ks.length >= 3 && ks.every(k => RGBA.includes(k))) return 'color';
  if (allNum && ks.length === 3 && ks.every(k => ROT.includes(k))) return 'vec';
  return 'obj';
}
const isGroup = v => ['obj', 'arr'].includes(shape(v)) && !(Array.isArray(v) && v.length && v.length <= 4 && v.every(x => typeof x === 'number'));

// ------------------------------------------------------------------ PPV categories (UI grouping only)
const PPV_CATS = [
  ['Lens · Exposure', /^(AutoExposure|HistogramLog|LocalExposure|CameraISO|CameraShutterSpeed)/],
  ['Lens · Dirt Mask', /^BloomDirt/],
  ['Lens · Bloom', /^Bloom/],
  ['Lens · Chromatic Aberration', /^(SceneFringe|ChromaticAberration)/],
  ['Lens · Flares', /^LensFlare/],
  ['Lens · Image Effects', /^(Vignette|Grain|FilmGrain)/],
  ['Lens · Depth of Field', /^DepthOfField/],
  ['Lens · Motion Blur', /^MotionBlur/],
  ['Color Grading · Temperature', /^(WhiteTemp|WhiteTint|TemperatureType)$/],
  ['Color Grading · Global', /^Color(Saturation|Contrast|Gamma|Gain|Offset)$/],
  ['Color Grading · Shadows', /Shadows/],
  ['Color Grading · Midtones', /Midtones/],
  ['Color Grading · Highlights', /Highlights/],
  ['Color Grading · Misc', /^(BlueCorrection|ExpandGamut|ToneCurveAmount|SceneColorTint|ColorGrading)/],
  ['Film', /^(Film|Tonemapper)/],
  ['Ambient Occlusion', /^AmbientOcclusion/],
  ['Global Illumination', /^(DynamicGlobalIllumination|IndirectLighting|Lumen(?!Reflection)|RayTracingGI)/],
  ['Reflections', /^(Reflection|LumenReflection|ScreenSpaceReflection|RayTracingReflection)/],
  ['Ambient Cubemap', /^AmbientCubemap/],
  ['Path Tracing', /^PathTracing/],
  ['Translucency', /Translucency/],
  ['Rendering Features', /^(ScreenPercentage|RayTracing|Mobile|VirtualTexture|PostProcessMaterial|WeightedBlendables|DynamicShadow)/],
];
const isPPV = v => v && isObj(v.Settings) && Object.keys(v.Settings).some(k => k.startsWith('bOverride_'));

function sections(values) {
  if (schema()) return schemaSections(values);
  return legacySections(values);
}
function schemaSections(values) {
  const out = [];
  const add = (name, path, key) => {
    let s = out.find(x => x.name === name);
    if (!s) out.push(s = { name, items: [] });
    s.items.push({ path, key });
  };
  const keys = orderedKeys([], values);
  const flat = [];
  const addFlat = k => {
    const pinfo = infoAt([k]);
    for (const c of orderedKeys([k], values[k])) {
      const ci = infoAt([k, c]);
      add(catName((ci && ci.cat) || (pinfo && pinfo.cat) || 'General'), [k, c], c);
    }
  };
  // Component properties shown with an actor come first (Light, Static Mesh, ... under Transform, as in UE)
  for (const k of keys) if (k.startsWith('@') && isObj(values[k]) && (infoAt([k]) || {}).flat) addFlat(k);
  for (const k of keys) {
    const info = infoAt([k]);
    if (k.startsWith('@') && info && info.flat) continue;
    if (info && info.flat && isObj(values[k])) { flat.push(k); continue; }
    add(info && info.cat ? catName(info.cat) : 'General', [k], k);
  }
  for (const k of flat) {
    const pinfo = infoAt([k]);
    for (const c of orderedKeys([k], values[k])) {
      const ci = infoAt([k, c]);
      add(catName((ci && ci.cat) || (pinfo && pinfo.cat) || 'General'), [k, c], c);
    }
  }
  return out;
}
function legacySections(values) {
  const out = [];
  const add = (name, path, key) => {
    let s = out.find(x => x.name === name);
    if (!s) out.push(s = { name, items: [] });
    s.items.push({ path, key });
  };
  if (isPPV(values)) {
    for (const k of Object.keys(values)) if (k !== 'Settings') add('Volume', [k], k);
    const st = values.Settings;
    for (const k of Object.keys(st)) {
      if (hiddenOverride(st, k)) continue;
      const cat = (PPV_CATS.find(([, re]) => re.test(k)) || ['Other'])[0];
      add(cat, ['Settings', k], k);
    }
    const order = ['Volume', ...PPV_CATS.map(c => c[0]), 'Other'];
    out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return out;
  }
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (hiddenOverride(values, k)) continue;
    if (isGroup(v)) {
      const kids = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
      out.push({ name: nice(k), items: kids.filter(c => !hiddenOverride(v, c)).map(c => ({ path: [k, c], key: c })), root: [k] });
    } else add('General', [k], k);
  }
  out.sort((a, b) => (b.name === 'General') - (a.name === 'General'));
  return out;
}
const hiddenOverride = (parent, k) => typeof k === 'string' && k.startsWith('bOverride_') && isObj(parent) && (k.slice(10) in parent);

// ------------------------------------------------------------------ filtering
const cur = () => S.cur;
const modified = p => !same(getAt(S.cur.values, p), getAt(S.cur.baseline, p));
function flagPathOf(p) {
  const parent = getAt(S.cur.values, p.slice(0, -1));
  const k = p[p.length - 1];
  if (!isObj(parent) || typeof k !== 'string') return null;
  const info = infoAt(p);
  const toggle = info && info.ec && typeof parent[info.ec] === 'boolean' && (infoAt([...p.slice(0, -1), info.ec]) || {}).toggle ? info.ec : null;
  const name = toggle || (typeof parent['bOverride_' + k] === 'boolean' ? 'bOverride_' + k : null);
  return name ? [...p.slice(0, -1), name] : null;
}
function rowModified(p) { const f = flagPathOf(p); return modified(p) || (f && modified(f)); }
const filtering = () => !!(S.search || S.modifiedOnly);
function visible(p, key) {
  if (!filtering()) return true;
  const v = getAt(S.cur.values, p);
  const nameHit = !S.search || labelOf(p, key, v).toLowerCase().includes(S.search) || String(key).toLowerCase().includes(S.search);
  if (isGroup(v)) {
    if (nameHit && S.search && !S.modifiedOnly) return true;
    return childKeysAt(p, v).some(c => visible([...p, c], c));
  }
  return nameHit && (!S.modifiedOnly || rowModified(p));
}
const childKeysAt = (p, v) => orderedKeys(p, v);

// ------------------------------------------------------------------ render
function render() {
  try { renderInner(); }
  catch (err) { console.error(err); showDetailsMessage('Could not display this object: ' + err.message); }
}
function renderInner() {
  const body = $('details');
  S.widgets.clear(); S.rows = [];
  body.innerHTML = '';
  const c = S.cur;
  $('revertAllBtn').disabled = !c; $('snapBtn').disabled = !c;
  if (!c) {
    $('objTitle').textContent = 'Details'; $('objClass').textContent = '';
    body.appendChild(el('div', 'empty', S.sel ? 'Loading…' : 'Select an actor in the Outliner.'));
    return;
  }
  $('objTitle').textContent = c.label;
  $('objClass').textContent = shortCls(c.cls) || c.kind;
  let shown = 0;
  if (c.transform && !S.modifiedOnly && (!S.search || ['location', 'rotation', 'scale', 'transform'].some(w => w.includes(S.search) || S.search.includes(w)))) {
    body.appendChild(renderTransform(c)); shown++;
  }
  const secs = sections(c.values);
  if (secs.length && !secs.some(s => S.open.has('cat:' + s.name))) S.open.add('cat:' + secs[0].name);
  for (const sec of secs) {
    const items = sec.items.filter(it => visible(it.path, it.key));
    if (!items.length) continue;
    shown++;
    const key = 'cat:' + sec.name;
    const wrap = el('section', 'cat');
    const head = el('div', 'cat-head');
    head.append(el('span', 'arrow', '▶'), el('span', null, sec.name), el('span', 'cat-count', String(items.length)));
    const bodyEl = el('div', 'cat-body');
    wrap.append(head, bodyEl);
    let built = false;
    const build = () => { if (built) return; built = true; for (const it of items) renderNode(bodyEl, it.path, it.key); refreshRows(); };
    const isOpen = filtering() || S.open.has(key);
    if (isOpen) { wrap.classList.add('open'); build(); }
    head.onclick = () => {
      const o = wrap.classList.toggle('open');
      o ? (S.open.add(key), build()) : S.open.delete(key);
    };
    body.appendChild(wrap);
  }
  if (!shown) body.appendChild(el('div', 'empty', filtering() ? 'No matching properties.' : 'No properties.'));
  body.classList.toggle('readonly', !editable());
}

// Actor Transform (root component Relative Location / Rotation / Scale, as in the Details panel)
const TF_ROWS = [['location', 'Location', ['X', 'Y', 'Z'], ['X', 'Y', 'Z'], 1],
                 ['rotation', 'Rotation', ['Roll', 'Pitch', 'Yaw'], ['X', 'Y', 'Z'], 0.5],
                 ['scale', 'Scale', ['X', 'Y', 'Z'], ['X', 'Y', 'Z'], 0.01]];
function renderTransform(c) {
  S.tfWidgets = {};
  const wrap = el('section', 'cat open');
  const head = el('div', 'cat-head');
  head.append(el('span', 'arrow', '▶'), el('span', null, 'Transform'));
  const bodyEl = el('div', 'cat-body');
  wrap.append(head, bodyEl);
  if (!S.open.has('tf-closed')) wrap.classList.add('open'); else wrap.classList.remove('open');
  head.onclick = () => { const o = wrap.classList.toggle('open'); o ? S.open.delete('tf-closed') : S.open.add('tf-closed'); };
  for (const [field, label, keys, axes, step] of TF_ROWS) {
    if (!c.transform[field]) continue;
    const row = el('div', 'row');
    const name = el('div', 'name'); name.style.paddingLeft = '8px';
    name.appendChild(el('span', 'name-text', label));
    const val = el('div', 'val');
    const vec = el('div', 'vec');
    const boxes = keys.map((k, i) => {
      const b = numBox({ p: ['__tf', field, k], label: `${label} ${axes[i]}`, value: c.transform[field][k], axis: axes[i], step,
        onSet: (v, final) => {
          if (!editable()) return;
          c.transform[field][k] = v;
          send({ type: 'setTransform', object: c.path, field, value: { ...c.transform[field] }, final });
          mark();
        } });
      vec.appendChild(b.el);
      return [k, b];
    });
    const reset = el('button', 'reset', '↺'); reset.title = 'Reset to session start';
    reset.onclick = () => {
      if (!editable() || !c.transformBaseline) return;
      send({ type: 'setTransform', object: c.path, field, value: { ...c.transformBaseline[field] }, final: true });
    };
    const mark = () => row.classList.toggle('modified', !!c.transformBaseline && !same(c.transform[field], c.transformBaseline[field]));
    val.append(vec, reset);
    row.append(name, val);
    bodyEl.appendChild(row);
    S.tfWidgets[field] = v => { for (const [k, b] of boxes) b.set(v[k]); mark(); };
    mark();
  }
  return wrap;
}

function renderNode(container, p, key) {
  const v = getAt(S.cur.values, p);
  if (isGroup(v)) return renderGroup(container, p, key, v);
  renderRow(container, p, key, v);
}

function renderGroup(container, p, key, v) {
  const gkey = 'grp:' + K(p);
  const depth = p.length;
  const wrap = el('div', 'grp');
  const head = el('div', 'grp-head');
  head.style.paddingLeft = (6 + (depth - 1) * 14) + 'px';
  const sum = Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : '';
  head.append(el('span', 'arrow', '▶'), el('span', null, labelOf(p, key, v)), el('span', 'grp-sum', sum));
  const bodyEl = el('div', 'grp-body');
  wrap.append(head, bodyEl);
  let built = false;
  const build = () => {
    if (built) return; built = true;
    for (const c of childKeysAt(p, v)) if (visible([...p, c], c)) renderNode(bodyEl, [...p, c], c);
    refreshRows();
  };
  if (filtering() || S.open.has(gkey)) { wrap.classList.add('open'); build(); }
  head.onclick = () => { const o = wrap.classList.toggle('open'); o ? (S.open.add(gkey), build()) : S.open.delete(gkey); };
  container.appendChild(wrap);
}

function renderRow(container, p, key, v) {
  const row = el('div', 'row');
  const name = el('div', 'name');
  name.style.paddingLeft = (8 + (p.length - 1) * 14) + 'px';
  const flagPath = flagPathOf(p);
  if (flagPath) {
    const cb = el('input', 'ovr'); cb.type = 'checkbox';
    cb.checked = !!getAt(S.cur.values, flagPath);
    cb.title = 'Override';
    cb.onchange = () => { if (!editable()) { cb.checked = !cb.checked; return; } send({ type: 'set', object: S.cur.path, path: flagPath, value: cb.checked, final: true }); };
    S.widgets.set(K(flagPath), { update: x => { cb.checked = !!x; } });
    name.appendChild(cb);
  } else if (S.cur && isPPV(S.cur.values) && p[0] === 'Settings' && p.length === 2) name.appendChild(el('span', 'ovr-slot'));
  const label = labelOf(p, key, v);
  const nt = el('span', 'name-text', label); nt.title = String(key);
  const pinfo = infoAt(p);
  if (pinfo && pinfo.show === 'visible') row.classList.add('readonly');
  const md = p.length === 1 && S.cur.meta && S.cur.meta[p[0]];
  if (md && md.desc) nt.title += ' — ' + md.desc;
  name.appendChild(nt);
  const val = el('div', 'val');
  buildWidget(val, p, key, v, label);
  const reset = el('button', 'reset', '↺'); reset.title = 'Reset to session start';
  reset.onclick = () => {
    if (!editable()) return;
    const paths = [p]; if (flagPath && modified(flagPath)) paths.push(flagPath);
    send({ type: 'revert', object: S.cur.path, paths });
  };
  val.appendChild(reset);
  row.append(name, val);
  container.appendChild(row);
  S.rows.push({ row, p, flagPath });
}

function refreshRows() {
  for (const r of S.rows) {
    r.row.classList.toggle('modified', rowModified(r.p));
    if (r.flagPath) r.row.classList.toggle('dim', !getAt(S.cur.values, r.flagPath));
  }
}

function setValue(p, value, final) {
  if (!editable()) return;
  send({ type: 'set', object: S.cur.path, path: p, value, final });
}

function rangeOf(p) {
  const info = infoAt(p);
  if (info) {
    const n = x => (typeof x === 'number' && isFinite(x) ? x : undefined);
    return { min: n(info.ClampMin), max: n(info.ClampMax), uiMin: n(info.UIMin ?? info.ClampMin), uiMax: n(info.UIMax ?? info.ClampMax) };
  }
  if (p.length !== 1 || !S.cur.meta || !S.cur.meta[p[0]]) return {};
  const m = S.cur.meta[p[0]].metadata || {};
  const n = x => (x === undefined || x === '' ? undefined : Number(x));
  const min = n(m.ClampMin ?? m.UIMin), max = n(m.ClampMax ?? m.UIMax);
  return { min: isFinite(min) ? min : undefined, max: isFinite(max) ? max : undefined };
}
function intLike(p, key, v) {
  const info = infoAt(p);
  if (info && info.t === 'int') return true;
  if (info && info.t === 'float') return false;
  if (p.length === 1 && S.cur.meta && S.cur.meta[p[0]]) {
    const t = S.cur.meta[p[0]].type || '';
    if (/float|double/i.test(t)) return false;
    if (/int|byte/i.test(t)) return true;
  }
  return Number.isInteger(v) && /(Count|Samples|Quality|Index|Iterations|Steps|Resolution)$|^Num[A-Z]/.test(String(key));
}

function buildWidget(val, p, key, v, label) {
  const s = shape(v);
  if (s === 'num') {
    const box = numBox({ p, label, value: v, int: intLike(p, key, v), ...rangeOf(p) });
    val.appendChild(box.el);
    S.widgets.set(K(p), { update: box.set });
  } else if (s === 'bool') {
    const cb = el('input', 'bool'); cb.type = 'checkbox'; cb.checked = v;
    cb.onchange = () => { if (!editable()) { cb.checked = !cb.checked; return; } setValue(p, cb.checked, true); };
    val.appendChild(cb);
    S.widgets.set(K(p), { update: x => { cb.checked = !!x; } });
  } else if (s === 'vec' || s === 'color' || Array.isArray(v)) {
    const wrap = el('div', 'vec');
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    let swatch;
    if (s === 'color') { swatch = el('div', 'swatch'); val.appendChild(swatch); }
    const paint = obj => { if (swatch) swatch.style.background = cssColor(obj); };
    const boxes = keys.map(k => {
      const b = numBox({ p: [...p, k], label: `${label} ${k}`, value: v[k], axis: typeof k === 'string' ? k : null, ...rangeOf(p),
        onLive: () => paint(getAt(S.cur.values, p)) });
      wrap.appendChild(b.el);
      return [k, b];
    });
    val.appendChild(wrap);
    paint(v);
    const upd = obj => { if (!obj) return; for (const [k, b] of boxes) b.set(obj[k]); paint(obj); };
    S.widgets.set(K(p), { update: upd });
    for (const [k] of boxes) S.widgets.set(K([...p, k]), { update: () => upd(getAt(S.cur.values, p)) });
  } else if (s === 'str' && enumOf(p)) {
    const entries = enumOf(p);
    const sel = el('select', 'sel');
    const qualified = v.includes('::') ? v.split('::')[0] + '::' : '';
    const short = x => String(x).split('::').pop();
    const fill = cur => {
      sel.innerHTML = '';
      const list = entries.some(([id]) => id === short(cur)) ? entries : [[short(cur), short(cur)], ...entries];
      for (const [id, dn] of list) { const o = el('option', null, dn); o.value = id; sel.appendChild(o); }
      sel.value = short(cur);
    };
    fill(v);
    sel.onchange = () => { if (!editable()) { fill(getAt(S.cur.values, p)); return; } setValue(p, qualified + sel.value, true); };
    val.appendChild(sel);
    S.widgets.set(K(p), { update: x => { if (typeof x === 'string') fill(x); } });
  } else if (s === 'str') {
    const target = S.st.objects.find(o => o.path === v);
    const owned = !target && v.includes(':PersistentLevel.') && S.st.objects.some(o => !o.parent && v.startsWith(o.path + '.'));
    if (target || owned) {
      const a = el('span', 'ro link', '→ ' + (target ? target.label : v.split('.').pop())); a.title = v;
      a.onclick = () => openObject(v); val.appendChild(a);
    } else if (/^\/(Game|Script|Engine)\//.test(v) || v.includes(':PersistentLevel.')) {
      const r = el('span', 'ro', v.split('.').pop() || v); r.title = v; val.appendChild(r);
    } else {
      const t = el('input', 'txtfield'); t.value = v; t.spellcheck = false; t.autocapitalize = 'off';
      const commit = () => { if (t.value !== getAt(S.cur.values, p)) setValue(p, t.value, true); };
      t.onkeydown = e => { if (e.key === 'Enter') t.blur(); };
      t.onblur = commit;
      val.appendChild(t);
      S.widgets.set(K(p), { update: x => { if (document.activeElement !== t) t.value = x ?? ''; } });
    }
  } else {
    val.appendChild(el('span', 'ro', s === 'null' ? 'None' : JSON.stringify(v)));
  }
}

function enumOf(p) {
  const info = infoAt(p);
  return info && info.t === 'enum' && S.cur.schema.enums && S.cur.schema.enums[info.ref] ? S.cur.schema.enums[info.ref] : null;
}

function cssColor(c) {
  if (!c) return '#000';
  // FColor (0-255 sRGB bytes) vs FLinearColor (0-1 linear)
  const bytes = [c.R, c.G, c.B].every(x => Number.isInteger(x)) && [c.R, c.G, c.B].some(x => x > 1);
  if (bytes) return `rgb(${c.R},${c.G},${c.B})`;
  const g = x => { x = Math.max(0, Math.min(1, x || 0)); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); };
  return `rgb(${g(c.R)},${g(c.G)},${g(c.B)})`;
}

// Drag-to-change number box (tap to type)
function numBox(o) {
  const box = el('div', 'num' + (o.axis ? ' axis' : ''));
  if (o.axis) box.appendChild(el('span', 'ax ' + o.axis));
  const lo = o.uiMin ?? o.min, hi = o.uiMax ?? o.max;
  const hasRange = lo !== undefined && hi !== undefined && hi > lo;
  const bar = hasRange ? box.appendChild(el('span', 'bar')) : null;
  const txt = box.appendChild(el('span', 'txt'));
  let value = o.value;
  const key = K(o.p);
  const show = v => {
    txt.textContent = fmt(v, o.int);
    if (bar) bar.style.width = (Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100) + '%';
  };
  const clampTo = (v, a, b) => {
    if (a !== undefined) v = Math.max(a, v);
    if (b !== undefined) v = Math.min(b, v);
    return o.int ? Math.round(v) : v;
  };
  const clamp = v => clampTo(v, o.min, o.max);              // typed values: Clamp range
  const inUi = v => hasRange && v >= lo && v <= hi;
  // dragging stays in the UI range like the Details panel, unless the value is already outside it
  const clampDrag = (v, start) => (inUi(start) ? clampTo(v, lo, hi) : clamp(v));
  const sens = v => {
    if (o.step) return S.fine ? o.step / 10 : o.step;
    const a = Math.abs(v);
    const base = a < 1 ? 1 : Math.pow(10, Math.floor(Math.log10(a)));
    let s = inUi(v) ? (hi - lo) / 400 : base / 100;
    if (o.int) s = Math.max(base / 40, 0.125);
    return S.fine ? s / 10 : s;
  };
  show(value);
  let d = null;
  box.addEventListener('pointerdown', e => {
    if (!editable()) return;
    box.setPointerCapture(e.pointerId);
    d = { x: e.clientX, v: value, moved: false, last: value };
  });
  box.addEventListener('pointermove', e => {
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 6) return;
      d.moved = true; d.x = e.clientX; S.dragging = key; box.classList.add('drag');
    }
    const v = clampDrag(d.v + (e.clientX - d.x) * sens(d.v), d.v);
    if (v === d.last) return;
    d.last = v; value = v; show(v);
    if (o.onSet) { o.onSet(v, false); return; }
    setAt(S.cur.values, o.p, v);
    if (o.onLive) o.onLive();
    setValue(o.p, v, false);
  });
  const end = (e, cancel) => {
    if (!d) return;
    const wasDrag = d.moved, v = d.last;
    d = null; S.dragging = null; box.classList.remove('drag');
    if (wasDrag) (o.onSet ? o.onSet(v, true) : setValue(o.p, v, true));
    else if (!cancel) openEditor(o.label, fmt(value, o.int), str => {
      const n = Number(str.trim());
      if (!isFinite(n)) return toast('Not a number', true);
      const v2 = clamp(n);
      value = v2; show(v2); o.onSet ? o.onSet(v2, true) : setValue(o.p, v2, true);
    });
  };
  box.addEventListener('pointerup', e => end(e, false));
  box.addEventListener('pointercancel', e => end(e, true));
  return { el: box, set: v => { if (S.dragging === key || typeof v !== 'number') return; value = v; show(v); } };
}

function openEditor(label, initial, onOk) {
  $('editorLabel').textContent = label;
  const inp = $('editorInput');
  inp.value = initial;
  $('editor').hidden = false;
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  const close = () => { $('editor').hidden = true; inp.onkeydown = null; };
  $('editorOk').onclick = () => { close(); onOk(inp.value); };
  $('editorCancel').onclick = close;
  inp.onkeydown = e => { if (e.key === 'Enter') $('editorOk').click(); if (e.key === 'Escape') close(); };
}

// ------------------------------------------------------------------ outliner (UE-style tree)
const ICON = { PPV: '▣', NDC: '▤', Actor: '●', Component: '◇', Subobject: '·', Object: '○' };
S.olOpen = new Set();      // expanded actors / components
S.olClosed = new Set();    // collapsed folders (folders start open, like UE)
S.olSearch = '';
const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });

function olRow(list, { depth, label, sub, icon, cls = '', arrow = null, onArrow, onClick, title }) {
  const it = el('div', 'ol-item ' + cls);
  it.style.paddingLeft = (6 + depth * 16) + 'px';
  const ar = el('span', 'ol-arrow', arrow === null ? '' : arrow ? '▾' : '▸');
  if (arrow !== null) ar.onclick = e => { e.stopPropagation(); onArrow(); };
  it.append(ar, el('span', 'ol-icon', icon), el('span', 'ol-label', label), el('span', 'ol-sub', sub || ''));
  if (title) it.title = title;
  it.onclick = onClick || onArrow;
  list.appendChild(it);
}

function renderOutliner() {
  const list = $('outlinerList'); list.innerHTML = '';
  const objs = S.st.objects;
  const kidsOf = p => objs.filter(o => o.parent === p).sort(byLabel);

  const objRow = (o, depth) => {
    const kids = kidsOf(o.path);
    const expandable = kids.length > 0 || (!o.parent && !o.compsLoaded);
    const open = S.olOpen.has(o.path);
    olRow(list, {
      depth, label: o.label, sub: shortCls(o.cls), icon: ICON[o.kind] || '·',
      cls: (o.path === S.sel ? 'sel ' : '') + (o.kind === 'PPV' || o.kind === 'NDC' ? 'key' : ''),
      arrow: expandable ? open : null, title: o.path,
      onArrow: () => {
        if (open) S.olOpen.delete(o.path);
        else { S.olOpen.add(o.path); if (!o.parent && !o.compsLoaded) send({ type: 'expand', path: o.path }); }
        renderOutliner();
      },
      onClick: () => openObject(o.path),
    });
    if (open) {
      if (!kids.length && !o.compsLoaded) list.appendChild(Object.assign(el('div', 'ol-loading', 'Loading components…'), { style: `padding-left:${38 + depth * 16}px` }));
      for (const k of kids) objRow(k, depth + 1);
    }
  };

  if (S.olSearch) {
    const q = S.olSearch;
    const hits = objs.filter(o => o.label.toLowerCase().includes(q) || shortCls(o.cls).toLowerCase().includes(q)).sort(byLabel);
    for (const o of hits.slice(0, 300)) {
      const owner = o.parent ? objs.find(x => x.path === o.parent) : null;
      olRow(list, { depth: 0, label: o.label, sub: owner ? owner.label : shortCls(o.cls), icon: ICON[o.kind] || '·',
        cls: o.path === S.sel ? 'sel' : '', arrow: null, title: o.path, onClick: () => openObject(o.path) });
    }
    if (!hits.length) list.appendChild(el('div', 'ol-empty', 'No matches.'));
  } else {
    // Folder tree from actor folder paths ("Lighting/Key")
    const roots = objs.filter(o => !o.parent);
    const tree = { folders: {}, actors: [] };
    for (const o of roots) {
      let node = tree;
      for (const part of (o.folder || '').split('/').filter(Boolean)) {
        node = node.folders[part] = node.folders[part] || { folders: {}, actors: [] };
      }
      node.actors.push(o);
    }
    const walk = (node, depth, prefix) => {
      for (const name of Object.keys(node.folders).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        const key = prefix + '/' + name;
        const open = !S.olClosed.has(key);
        const n = node.folders[name];
        const count = (function c(x) { return x.actors.length + Object.values(x.folders).reduce((s, f) => s + c(f), 0); })(n);
        olRow(list, { depth, label: name, sub: String(count), icon: '▰', cls: 'folder', arrow: open,
          onArrow: () => { open ? S.olClosed.add(key) : S.olClosed.delete(key); renderOutliner(); } });
        if (open) walk(n, depth + 1, key);
      }
      for (const o of node.actors.sort(byLabel)) objRow(o, depth);
    };
    walk(tree, 0, '');
  }

  if (!objs.length) {
    const msg = !S.st.ueOnline ? 'Waiting for Unreal Editor…'
      : S.st.discovering ? 'Scanning level…'
      : 'No actors found in the open level.';
    list.appendChild(el('div', 'ol-empty', msg));
  }
  const actors = objs.filter(o => !o.parent).length;
  $('scanNote').textContent = S.st.discovering ? (S.st.discoveryNote || 'Scanning level…') : (S.st.discoveryNote || `${actors} actors`);
  $('rescanBtn').disabled = !S.st.ueOnline || S.st.discovering;
}
let olT;
$('olSearch').oninput = e => { clearTimeout(olT); olT = setTimeout(() => { S.olSearch = e.target.value.trim().toLowerCase(); renderOutliner(); }, 120); };

function showDetailsMessage(msg) {
  const body = $('details'); body.innerHTML = '';
  body.appendChild(el('div', 'empty', msg));
}
function openObject(p) {
  S.sel = p; ss.set('sel', p);
  for (let o = S.st.objects.find(x => x.path === p); o && o.parent; o = S.st.objects.find(x => x.path === o.parent)) S.olOpen.add(o.parent);
  if (!S.cur || S.cur.path !== p) { S.cur = null; render(); }
  renderOutliner();
  send({ type: 'open', path: p });
  clearTimeout(S.loadT);
  S.loadT = setTimeout(() => { if (S.sel === p && (!S.cur || S.cur.path !== p)) showDetailsMessage('Still loading… If this does not finish, check the Bridge console for errors.'); }, 8000);
  closeDrawer();
}

// ------------------------------------------------------------------ chrome
function renderChrome() {
  $('bridgeDot').className = 'dot' + (S.connected ? ' on' : '');
  $('ueDot').className = 'dot' + (S.connected && S.st.ueOnline ? (S.st.discovering ? ' busy' : ' on') : '');
  const lb = $('lockBtn');
  lb.textContent = S.st.locked ? 'Locked' : 'Lock';
  lb.classList.toggle('locked', !!S.st.locked);
  $('fineBtn').classList.toggle('on', S.fine);
  const b = $('banner');
  let msg = '', bad = false;
  if (!S.connected) { msg = 'Connection to bridge lost — reconnecting…'; bad = true; }
  else if (!S.st.ueOnline) { msg = 'Unreal Editor not detected. Start UE and run WebControl.StartServer.'; bad = true; }
  else if (S.st.locked) msg = 'Controls are locked. Tap Locked to unlock.';
  b.hidden = !msg; b.textContent = msg; b.className = 'banner' + (bad ? ' bad' : '');
  $('details').classList.toggle('readonly', !editable());
}

const closeDrawer = () => { $('outliner').classList.remove('open'); $('scrim').classList.remove('open'); };
$('menuBtn').onclick = () => { $('outliner').classList.add('open'); $('scrim').classList.add('open'); };
$('scrim').onclick = closeDrawer;
$('lockBtn').onclick = () => send({ type: 'lock', locked: !S.st.locked });
$('fineBtn').onclick = () => { S.fine = !S.fine; renderChrome(); };
$('rescanBtn').onclick = () => send({ type: 'rescan' });
$('revertAllBtn').onclick = () => {
  if (!S.cur || !editable()) return;
  if (confirm(`Revert all changes made to ${S.cur.label} since this session started?`)) send({ type: 'revertAll', object: S.cur.path });
};
let searchT;
$('search').oninput = e => { clearTimeout(searchT); searchT = setTimeout(() => { S.search = e.target.value.trim().toLowerCase(); render(); }, 150); };
$('modifiedOnly').onchange = e => { S.modifiedOnly = e.target.checked; render(); };

// snapshots
function renderSnapshots() {
  const list = $('snapList'); list.innerHTML = '';
  if (!S.cur) return;
  const ppv = isPPV(S.cur.values);
  const items = S.st.snapshots.filter(s => (ppv ? s.kind === 'PPV' : s.cls === S.cur.cls));
  if (!items.length) list.appendChild(el('div', 'empty', ppv ? 'No PPV snapshots yet.' : 'No snapshots for this object type yet.'));
  for (const s of items) {
    const row = el('div', 'snap');
    const info = el('div', 'snap-info');
    info.append(el('div', 'snap-name', s.name), el('div', 'snap-meta', `${s.source} · ${new Date(s.createdAt).toLocaleString()}`));
    const apply = el('button', 'btn small primary', 'Apply');
    apply.onclick = () => {
      if (!editable()) return toast('Controls are locked or Unreal is offline', true);
      if (confirm(`Apply "${s.name}" to ${S.cur.label}?`)) { send({ type: 'applySnapshot', id: s.id, object: S.cur.path }); $('sheet').hidden = true; }
    };
    const del = el('button', 'btn small danger', 'Delete');
    del.onclick = () => { if (confirm(`Delete "${s.name}"?`)) send({ type: 'deleteSnapshot', id: s.id }); };
    row.append(info, apply, del);
    list.appendChild(row);
  }
}
$('snapBtn').onclick = () => { renderSnapshots(); $('sheet').hidden = false; };
$('sheetClose').onclick = () => { $('sheet').hidden = true; };
$('snapSave').onclick = () => {
  if (!S.cur) return;
  const t = new Date();
  const name = prompt('Snapshot name', `${S.cur.label} ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`);
  if (name) send({ type: 'saveSnapshot', object: S.cur.path, name });
};

// ------------------------------------------------------------------ socket
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

function applyPatch(objectPath, changes) {
  if (!S.cur || S.cur.path !== objectPath) return;
  for (const [p, v] of changes) {
    setAt(S.cur.values, p, v);
    for (let i = p.length; i > 0; i--) {
      const w = S.widgets.get(K(p.slice(0, i)));
      if (w) { w.update(getAt(S.cur.values, p.slice(0, i))); break; }
    }
  }
  refreshRows();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}`);
  S.ws.onopen = () => { S.reopen = true; if (S.pin) send({ type: 'auth', pin: S.pin }); };
  S.ws.onmessage = ev => {
    try { onMessage(JSON.parse(ev.data)); }
    catch (err) { console.error(err); toast('UI error: ' + err.message, true); if (S.sel && !S.cur) showDetailsMessage('UI error: ' + err.message); }
  };
  function onMessage(m) {
    switch (m.type) {
      case 'authFailed':
        S.authed = false; S.pin = null; ss.set('pin', '');
        $('app').hidden = true; $('auth').hidden = false; $('authMsg').textContent = 'Wrong PIN'; $('authMsg').classList.remove('shake'); void $('authMsg').offsetWidth; $('authMsg').classList.add('shake');
        break;
      case 'state': {
        if (!S.authed) { S.authed = true; ss.set('pin', S.pin); $('auth').hidden = true; $('app').hidden = false; }
        S.connected = true;
        S.st = m;
        if (S.sel && !m.objects.some(o => o.path === S.sel) && !m.discovering && m.ueOnline) { S.sel = null; S.cur = null; render(); }
        if (!S.sel && m.objects.length) {
          const first = m.objects.find(o => o.kind === 'PPV') || m.objects[0];
          openObject(first.path);
        } else if (S.reopen && S.sel && m.objects.some(o => o.path === S.sel)) {
          S.reopen = false; send({ type: 'open', path: S.sel });
        }
        renderOutliner(); renderChrome();
        if (!$('sheet').hidden) renderSnapshots();
        break;
      }
      case 'object':
        if (m.path === S.sel) { clearTimeout(S.loadT); S.cur = m; render(); }
        break;
      case 'loadFailed':
        if (m.path === S.sel) { clearTimeout(S.loadT); showDetailsMessage(m.message); }
        break;
      case 'transform':
        if (S.cur && m.object === S.cur.path && S.cur.transform) {
          S.cur.transform[m.field] = m.value;
          if (S.tfWidgets && S.tfWidgets[m.field]) S.tfWidgets[m.field](m.value);
        }
        break;
      case 'values':
        if (S.cur && m.path === S.cur.path) {
          if (m.transform && S.cur.transform) {
            S.cur.transform = m.transform;
            for (const f of Object.keys(m.transform)) if (S.tfWidgets && S.tfWidgets[f] && typeof m.transform[f] === 'object') S.tfWidgets[f](m.transform[f]);
          }
          const structural = !same(Object.keys(m.values), Object.keys(S.cur.values));
          S.cur.values = m.values;
          if (structural) render();
          else { for (const [k, w] of S.widgets) w.update(getAt(S.cur.values, k.split('\u0001').map(x => (/^\d+$/.test(x) && x.length < 6 ? Number(x) : x)))); refreshRows(); }
        }
        break;
      case 'patch': applyPatch(m.object, m.changes); break;
      case 'error': toast(m.message, true); break;
      case 'info': toast(m.message); break;
    }
  }
  S.ws.onclose = () => {
    S.connected = false;
    if (S.authed) renderChrome();
    setTimeout(connect, 1500);
  };
}

$('pinBtn').onclick = () => {
  S.pin = $('pin').value.trim(); $('authMsg').textContent = '';
  if (S.ws && S.ws.readyState === 1) send({ type: 'auth', pin: S.pin });
};
$('pin').onkeydown = e => { if (e.key === 'Enter') $('pinBtn').click(); };
connect();
