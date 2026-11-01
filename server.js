// Stage Controller - Bridge server v1.0
// iPad/iPhone (browser) <-> WebSocket <-> this server <-> UE Remote Control HTTP API
//
// - Detects the UE Remote Control server automatically and reconnects when the editor restarts
// - Discovers every Post Process Volume and nDisplay root actor in the open level (+ components, subobjects)
// - Sends the real property structure to the client, which builds a Details-panel UI from it
// - Writes any nested property as a transaction (Multi-User friendly), enabling bOverride_ flags automatically

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const ueschema = require('./lib/ueschema');

const ROOT = __dirname;

// ---------------------------------------------------------------- config
const DEFAULTS = {
  port: 8080,
  pin: '1234',
  ue: { host: '127.0.0.1', port: 30010, passphrase: '' },
  sendIntervalMs: 50,
  pollMs: 2000,
  ueCheckMs: 3000,
  transactionMode: 'always',   // 'always' | 'onRelease'
  autoDiscover: true,
  manualObjects: [],
  maxSubobjectDepth: 2,
  ueVersion: '5.7',
  engineDir: '',
};
function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...DEFAULTS, ...raw, ue: { ...DEFAULTS.ue, ...(raw.ue || {}) } };
}
const config = loadConfig();
const UE_URL = `http://${config.ue.host}:${config.ue.port}`;
config.rootDir = ROOT;

// ---------------------------------------------------------------- utils
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function getAt(obj, p) { let c = obj; for (const k of p) { if (c == null) return undefined; c = c[k]; } return c; }
function setAt(obj, p, v) {
  let c = obj;
  for (let i = 0; i < p.length - 1; i++) {
    if (c[p[i]] == null || typeof c[p[i]] !== 'object') c[p[i]] = {};
    c = c[p[i]];
  }
  c[p[p.length - 1]] = v;
}
function setDeepClone(obj, p, v) {
  if (!p.length) return v;
  const c = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  c[p[0]] = setDeepClone(c[p[0]], p.slice(1), v);
  return c;
}
function labelOf(objectPath) {
  const tail = objectPath.split(':').pop().replace(/^PersistentLevel\./, '');
  return tail.split('.').pop();
}
function collectPaths(value, out = new Set()) {
  if (typeof value === 'string') {
    if (value.includes(':PersistentLevel.')) out.add(value);
  } else if (Array.isArray(value)) value.forEach(v => collectPaths(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collectPaths(v, out));
  return out;
}
// Leaf paths whose values differ (arrays are compared as a whole).
function diffLeaves(a, b, base = [], out = []) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffLeaves(a[k], b[k], [...base, k], out);
  } else if (!same(a, b) && a !== undefined) out.push(base);
  return out;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j]); }
  }));
  return out;
}

// ---------------------------------------------------------------- log
const logFile = path.join(ROOT, 'changes.log');
function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  fs.appendFile(logFile, entry + '\n', () => {});
}

// ---------------------------------------------------------------- UE client
function ueHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (config.ue.passphrase) h.Passphrase = config.ue.passphrase;
  return h;
}
async function ue(route, body) {
  try {
    const res = await fetch(`${UE_URL}${route}`, { method: 'PUT', headers: ueHeaders(), body: JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch {}
    return { ok: res.ok, status: res.status, body: json ?? text };
  } catch (err) {
    return { ok: false, status: 0, body: `request failed: ${err.message}` };
  }
}
function ueError(r) {
  if (r.body && typeof r.body === 'object') return r.body.errorMessage || r.body.ErrorMessage || JSON.stringify(r.body).slice(0, 200);
  return String(r.body).slice(0, 200);
}
async function ueAlive() {
  try {
    const res = await fetch(`${UE_URL}/remote/info`, { headers: ueHeaders() });
    return res.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- state
const state = {
  ueOnline: false,
  locked: false,
  discovering: false,
  discoveryMethod: null,
  discoveryNote: '',
  lastScan: null,
  objects: new Map(), // path -> {path, kind, label, cls, parent, depth, describe, meta, values, baseline, loaded}
};

// Ways to list level actors; the first that returns actors wins.
const LIST_METHODS = [
  { name: 'EditorActorSubsystem.GetAllLevelActors',
    body: { objectPath: '/Script/UnrealEd.Default__EditorActorSubsystem', functionName: 'GetAllLevelActors' } },
  { name: 'EditorLevelLibrary.GetAllLevelActors',
    body: { objectPath: '/Script/EditorScriptingUtilities.Default__EditorLevelLibrary', functionName: 'GetAllLevelActors' } },
  { name: 'GameplayStatics.GetAllActorsOfClass',
    body: { objectPath: '/Script/Engine.Default__GameplayStatics', functionName: 'GetAllActorsOfClass',
            parameters: { ActorClass: '/Script/Engine.Actor' } } },
];

function propNames(describeBody) {
  return describeBody && Array.isArray(describeBody.Properties) ? describeBody.Properties.map(p => p.Name) : [];
}
function classifyActor(p, d) {
  const cls = (d && d.Class) || '';
  const names = propNames(d);
  if (/PostProcessVolume/i.test(cls) || /^PostProcessVolume/i.test(labelOf(p))) return 'PPV';
  if (/DisplayCluster/i.test(cls) || names.includes('CurrentConfigData')) return 'NDC';
  return null;
}

async function discover() {
  if (state.discovering || !state.ueOnline) return;
  state.discovering = true;
  broadcastState();
  try {
    let actors = [];
    state.discoveryMethod = null;
    for (const m of LIST_METHODS) {
      const r = await ue('/remote/object/call', m.body);
      const found = [...collectPaths(r.body)];
      if (found.length) { actors = found; state.discoveryMethod = m.name; break; }
    }
    const manual = config.manualObjects || [];
    const all = [...new Set([...actors, ...manual])];

    // Every actor: class, Outliner label and folder (as the UE Outliner shows them)
    let done = 0;
    const described = await mapLimit(all, 8, async p => {
      const d = await ue('/remote/object/describe', { objectPath: p });
      let label = labelOf(p), folder = '';
      if (d.ok) {
        const l = await ue('/remote/object/call', { objectPath: p, functionName: 'GetActorLabel' });
        if (l.ok && l.body && typeof l.body.ReturnValue === 'string' && l.body.ReturnValue) label = l.body.ReturnValue;
        const f = await ue('/remote/object/call', { objectPath: p, functionName: 'GetFolderPath' });
        if (f.ok && f.body && typeof f.body.ReturnValue === 'string' && f.body.ReturnValue !== 'None') folder = f.body.ReturnValue;
      }
      if (++done % 25 === 0) { state.discoveryNote = `Scanning ${done}/${all.length} actors...`; broadcastState(); }
      return { p, d, label, folder };
    });
    const next = new Map();
    const keepPrev = (p, entry) => {
      const prev = state.objects.get(p);
      if (prev && prev.loaded) Object.assign(entry, { values: prev.values, baseline: prev.baseline, meta: prev.meta, schema: prev.schema, loaded: true });
      if (prev && prev.compsLoaded) entry.compsLoaded = true;
      next.set(p, entry);
    };

    for (const { p, d, label, folder } of described) {
      if (!d.ok) continue;
      const kind = classifyActor(p, d.body) || 'Actor';
      keepPrev(p, { path: p, kind, label, folder, cls: d.body.Class || '', parent: null, depth: 0, describe: d.body });
    }

    // Keep components and subobjects found before, while their owner still exists
    for (let pass = 0; pass < 4; pass++) {   // owners may themselves be components
      for (const [p, e] of state.objects) {
        if ((e.kind === 'Component' || e.kind === 'Subobject') && next.has(e.parent) && !next.has(p)) next.set(p, e);
      }
    }
    state.objects = next;
    for (const entry of [...next.values()].filter(e => e.kind === 'NDC' && !e.compsLoaded)) await loadComponents(entry.path, false);
    state.lastScan = new Date().toISOString();
    const counts = [...state.objects.values()].reduce((a, e) => (a[e.kind] = (a[e.kind] || 0) + 1, a), {});
    state.discoveryNote = state.discoveryMethod
      ? `${all.length} actors scanned via ${state.discoveryMethod}`
      : (manual.length ? 'Actor listing unavailable; using manualObjects from config.json' : 'Actor listing unavailable. See README > Troubleshooting.');
    log(`SCAN ${state.discoveryNote} | ${JSON.stringify(counts)}`);
  } finally {
    state.discovering = false;
    broadcastState();
  }
}

// All components of one actor (loaded when the actor is expanded in the Outliner)
async function loadComponents(actorPath, notify = true) {
  const actor = state.objects.get(actorPath);
  if (!actor || actor.parent) return;
  const r = await ue('/remote/object/call', {
    objectPath: actorPath, functionName: 'GetComponentsByClass',
    parameters: { ComponentClass: '/Script/Engine.ActorComponent' },
  });
  const comps = [...collectPaths(r.body)].filter(c => c !== actorPath && c.startsWith(actorPath + '.'));
  const cd = await mapLimit(comps, 8, async c => ({ c, d: await ue('/remote/object/describe', { objectPath: c }) }));
  for (const { c, d } of cd) {
    if (!d.ok || state.objects.has(c)) continue;
    state.objects.set(c, { path: c, kind: 'Component', label: labelOf(c), cls: d.body.Class || '', parent: actorPath, depth: 1, describe: d.body });
  }
  actor.compsLoaded = true;
  if (notify) broadcastState();
}

// An object path that is not listed yet but lives inside a listed actor (a component or subobject reference)
function adoptOwned(objectPath) {
  if (state.objects.has(objectPath)) return state.objects.get(objectPath);
  let owner = null;
  for (const e of state.objects.values()) {
    if (objectPath.startsWith(e.path + '.') && (!owner || e.path.length > owner.path.length)) owner = e;
  }
  if (!owner) return null;
  const entry = { path: objectPath, kind: 'Subobject', label: labelOf(objectPath), cls: '', parent: owner.path, depth: owner.depth + 1 };
  state.objects.set(objectPath, entry);
  return entry;
}

// Components whose properties the Details panel shows together with the actor:
// the root component and components the actor exposes as visible properties (e.g. LightComponent, StaticMeshComponent).
const RELATIVE_PROPS = ['RelativeLocation', 'RelativeRotation', 'RelativeScale3D'];
async function attachInline(entry) {
  if (entry.parent || !entry.values) return;
  const sc = entry.schema;
  const rootInfo = sc && sc.types[sc.root];
  const cands = [];
  const add = cp => { if (typeof cp === 'string' && cp.startsWith(entry.path + '.') && !cands.includes(cp)) cands.push(cp); };
  if (entry.transform && entry.transform.mode === 'component') add(entry.transform.object);
  add(entry.values.RootComponent);
  if (rootInfo) {
    for (const [k, v] of Object.entries(entry.values)) {
      const info = rootInfo[k];
      if (info && info.t === 'object' && info.show !== 'hidden') add(v);
    }
  }
  entry.inline = entry.inline || {};
  for (const cp of cands.slice(0, 4)) {
    const ce = state.objects.get(cp) || adoptOwned(cp);
    if (!ce) continue;
    if (ce.kind === 'Subobject') ce.kind = 'Component';
    if (!ce.loaded && !(await loadObject(cp))) continue;
    const key = '@' + ce.label;
    entry.inline[key] = cp;
    ce.owner = { path: entry.path, key };
    // the reference rows to an inlined component are redundant (UE shows its properties instead)
    if (rootInfo) for (const [k, v] of Object.entries(entry.values)) if (v === cp && rootInfo[k]) rootInfo[k] = { ...rootInfo[k], show: 'hidden' };
    entry.values[key] = ce.values;
    if (entry.baseline && !(key in entry.baseline)) entry.baseline[key] = ce.baseline;
    if (sc && ce.schema && ce.schema.root) {
      for (const [k, v] of Object.entries(ce.schema.types)) if (!sc.types[k]) sc.types[k] = v;
      Object.assign(sc.enums, ce.schema.enums || {});
      // Location/Rotation/Scale are already in the Transform section
      const compRoot = ce.schema.root, copy = { ...sc.types[compRoot] };
      for (const rp of RELATIVE_PROPS) if (copy[rp]) copy[rp] = { ...copy[rp], show: 'hidden' };
      const vkey = compRoot + '@inline';
      sc.types[vkey] = copy;
      rootInfo[key] = { t: 'struct', ref: vkey, flat: true, show: 'edit', cat: 'Components' };
    }
  }
}

// Full read of an object; falls back to reading each property when a bulk read is refused.
async function readAll(entry) {
  const r = await ue('/remote/object/property', { objectPath: entry.path, access: 'READ_ACCESS' });
  if (r.ok && r.body && typeof r.body === 'object' && Object.keys(r.body).length) return r.body;
  const names = propNames(entry.describe);
  if (!names.length) return null;
  const values = {};
  await mapLimit(names, 8, async n => {
    const pr = await ue('/remote/object/property', { objectPath: entry.path, propertyName: n, access: 'READ_ACCESS' });
    if (pr.ok && pr.body && typeof pr.body === 'object' && n in pr.body) values[n] = pr.body[n];
  });
  return Object.keys(values).length ? values : null;
}

async function loadObject(objectPath) {
  const entry = state.objects.get(objectPath);
  if (!entry) return null;
  if (!entry.describe) {
    const d = await ue('/remote/object/describe', { objectPath });
    if (d.ok) { entry.describe = d.body; entry.cls = d.body.Class || entry.cls; }
  }
  const values = await readAll(entry);
  if (!values) return null;
  entry.values = values;
  if (!entry.baseline) entry.baseline = clone(values);
  entry.meta = Object.fromEntries((entry.describe?.Properties || []).map(p => [p.Name, {
    type: p.Type || '', desc: p.Description || '', metadata: p.Metadata || {},
  }]));
  entry.schema = ueschema.buildSchema(namesDb, entry.cls, values);
  entry.transform = await readTransform(entry);
  if (entry.transform && !entry.transformBaseline) entry.transformBaseline = clone(entry.transform);
  entry.inline = null;
  await attachInline(entry);
  entry.loaded = true;

  // Owned subobjects (e.g. nDisplay CurrentConfigData) become their own entries
  if (entry.depth < config.maxSubobjectDepth) {
    const subs = [...collectPaths(values)]
      .filter(s => s !== objectPath && s.startsWith(objectPath + '.') && !state.objects.has(s))
      .slice(0, 20);
    if (subs.length) {
      for (const s of subs) {
        state.objects.set(s, { path: s, kind: 'Subobject', label: labelOf(s), cls: '', parent: objectPath, depth: entry.depth + 1 });
      }
      broadcastState();
    }
  }
  return entry;
}

// ---------------------------------------------------------------- actor transform (root component, as in the Details panel)
// Two ways, tried in order:
//  component: RootComponent Relative* properties, written with K2_SetRelative* (exactly what the Details panel shows)
//  actor:     K2_GetActor* / K2_SetActor* functions (fallback when the relative properties are not exposed)
const TF = {
  component: {
    location: { prop: 'RelativeLocation', fn: 'K2_SetRelativeLocation', param: 'NewLocation', extra: { bSweep: false, bTeleport: true } },
    rotation: { prop: 'RelativeRotation', fn: 'K2_SetRelativeRotation', param: 'NewRotation', extra: { bSweep: false, bTeleport: true } },
    scale:    { prop: 'RelativeScale3D',  fn: 'SetRelativeScale3D',     param: 'NewScale3D',  extra: {} },
  },
  actor: {
    location: { get: 'K2_GetActorLocation', fn: 'K2_SetActorLocation', param: 'NewLocation', extra: { bSweep: false, bTeleport: true } },
    rotation: { get: 'K2_GetActorRotation', fn: 'K2_SetActorRotation', param: 'NewRotation', extra: { bTeleportPhysics: true } },
    scale:    { get: 'GetActorScale3D',     fn: 'SetActorScale3D',     param: 'NewScale3D',  extra: {} },
  },
};
const TF_FIELDS = ['location', 'rotation', 'scale'];
const isVec = v => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'number');

async function readTransform(entry) {
  if (entry.parent) return null;
  const notes = [];
  // 1) root component
  let root = entry.values && entry.values.RootComponent;
  if (typeof root !== 'string' || !root.includes(':PersistentLevel.')) {
    const r = await ue('/remote/object/call', { objectPath: entry.path, functionName: 'K2_GetRootComponent' });
    root = r.ok && r.body && typeof r.body.ReturnValue === 'string' ? r.body.ReturnValue : null;
    if (!root) notes.push(`root component: ${r.ok ? 'none' : ueError(r)}`);
  }
  if (root && root.includes(':PersistentLevel.')) {
    const tf = { mode: 'component', object: root };
    for (const f of TF_FIELDS) {
      const spec = TF.component[f];
      const r = await ue('/remote/object/property', { objectPath: root, propertyName: spec.prop, access: 'READ_ACCESS' });
      if (r.ok && r.body && isVec(r.body[spec.prop])) tf[f] = r.body[spec.prop];
      else notes.push(`${spec.prop}: ${r.ok ? 'missing' : ueError(r)}`);
    }
    if (TF_FIELDS.every(f => tf[f])) return tf;
  }
  // 2) actor functions
  const tf = { mode: 'actor', object: entry.path };
  for (const f of TF_FIELDS) {
    const r = await ue('/remote/object/call', { objectPath: entry.path, functionName: TF.actor[f].get });
    if (r.ok && r.body && isVec(r.body.ReturnValue)) tf[f] = r.body.ReturnValue;
    else notes.push(`${TF.actor[f].get}: ${r.ok ? 'missing' : ueError(r)}`);
  }
  if (TF_FIELDS.every(f => tf[f])) {
    if (notes.length) log(`TRANSFORM ${entry.label}: using actor functions (${notes.join('; ')})`);
    return tf;
  }
  if (!entry.tfWarned) { log(`TRANSFORM UNAVAILABLE ${entry.label}: ${notes.join('; ')}`); entry.tfWarned = true; }
  return null;
}

async function writeTransform(actorPath, field, value, final) {
  const entry = state.objects.get(actorPath);
  const tf = entry && entry.transform;
  if (!tf || !TF_FIELDS.includes(field)) return { ok: false, error: 'No transform' };
  const call = (mode, objectPath) => {
    const spec = TF[mode][field];
    return ue('/remote/object/call', {
      objectPath, functionName: spec.fn, parameters: { [spec.param]: value, ...spec.extra },
      generateTransaction: config.transactionMode === 'always' || !!final,
    });
  };
  let r = await call(tf.mode, tf.object);
  if (!r.ok && tf.mode === 'component') {
    const r2 = await call('actor', actorPath);
    if (r2.ok) { log(`TRANSFORM ${entry.label}: component setter refused (${ueError(r)}), switched to actor functions`); tf.mode = 'actor'; tf.object = actorPath; r = r2; }
  }
  if (!r.ok) {
    const error = ueError(r);
    log(`TRANSFORM FAILED ${entry.label} ${field}: ${error}`);
    return { ok: false, error };
  }
  tf[field] = clone(value);
  broadcast({ type: 'transform', object: actorPath, field, value });
  return { ok: true };
}

// ---------------------------------------------------------------- writes
const pending = new Map();   // key -> {object, path, value, final}
const inFlight = new Set();
const keyOf = (object, p) => object + '|' + p.join('\u0001');
const objectBusy = object => [...pending.values(), ...[...inFlight].map(k => ({ object: k.split('|')[0] }))]
  .some(x => x.object === object);

// Builds the partial value for the top-level property and lists bOverride_ flags it switches on.
// Small all-number structs (vectors, colors, rotators) are always sent complete.
const isLeafStruct = v => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length > 0 && Object.keys(v).length <= 4 && Object.values(v).every(x => typeof x === 'number');

function buildPartial(cur, sub, value, prefix, overrides) {
  if (!sub.length) return value;
  const k = sub[0];
  if (Array.isArray(cur)) return setDeepClone(cur, sub, value); // arrays are sent whole
  if (sub.length === 1 && isLeafStruct(cur)) return { ...cur, [k]: value };
  const out = {};
  out[k] = buildPartial(cur ? cur[k] : undefined, sub.slice(1), value, [...prefix, k], overrides);
  // A bOverride_<k> sibling governs field k (and everything inside it)
  const flag = 'bOverride_' + k;
  if (!String(k).startsWith('bOverride_') && cur && cur[flag] === false) {
    out[flag] = true;
    overrides.push([...prefix, flag]);
  }
  return out;
}

// Set<Name> function for a top-level property: from the engine headers, else from the object's describe
function setterFor(entry, top) {
  const sc = entry.schema;
  const info = sc && sc.types[sc.root] && sc.types[sc.root][top];
  if (info && info.setter) return info.setter;
  const fns = entry.describe && Array.isArray(entry.describe.Functions) ? entry.describe.Functions : [];
  const f = fns.find(x => x.Name === 'Set' + top || x.Name === 'Set' + String(top).replace(/^b(?=[A-Z])/, ''));
  const arg = f && Array.isArray(f.Arguments) && f.Arguments[0];
  return f && arg && arg.Name ? { fn: f.Name, param: arg.Name } : null;
}

async function writeNow(object, p, value, final) {
  const entry = state.objects.get(object);
  if (!entry || !entry.values) return { ok: false, error: 'Object not loaded' };
  // Component properties shown inside an actor's Details: write to the component itself
  if (entry.inline && typeof p[0] === 'string' && entry.inline[p[0]]) {
    return writeNow(entry.inline[p[0]], p.slice(1), value, final);
  }
  const top = p[0];
  const overrides = [];
  const partial = buildPartial(entry.values[top], p.slice(1), value, [top], overrides);
  const tx = config.transactionMode === 'always' || final;
  let r = await ue('/remote/object/property', {
    objectPath: object, propertyName: top, access: tx ? 'WRITE_TRANSACTION_ACCESS' : 'WRITE_ACCESS', propertyValue: { [top]: partial },
  });
  if (!r.ok) {
    // Some properties only accept changes through their setter (e.g. light Intensity -> SetIntensity)
    const setter = setterFor(entry, top);
    if (setter) {
      const full = p.length > 1 ? setDeepClone(entry.values[top], p.slice(1), value) : value;
      const r2 = await ue('/remote/object/call', {
        objectPath: object, functionName: setter.fn, parameters: { [setter.param]: full }, generateTransaction: !!tx,
      });
      if (r2.ok) {
        if (!entry.setterNoted) { log(`${entry.label}: ${top} written through ${setter.fn}() (direct write refused: ${ueError(r)})`); entry.setterNoted = true; }
        overrides.length = 0;
        r = r2;
      }
    }
  }
  if (!r.ok) {
    const error = ueError(r);
    log(`WRITE FAILED ${entry.label} ${p.join('.')}=${JSON.stringify(value)}: ${error}`);
    return { ok: false, error };
  }
  setAt(entry.values, p, clone(value));
  for (const o of overrides) setAt(entry.values, o, true);
  const changes = [[p, value], ...overrides.map(o => [o, true])];
  broadcast({ type: 'patch', object, changes });
  if (entry.owner) broadcast({ type: 'patch', object: entry.owner.path, changes: changes.map(([cp, v]) => [[entry.owner.key, ...cp], v]) });
  return { ok: true };
}

function queueWrite(object, p, value, final, field) {
  const key = field ? object + '|transform.' + field : keyOf(object, p);
  const prev = pending.get(key);
  pending.set(key, { object, path: p, value, field, final: final || (prev && prev.final) });
  pump(key);
}
async function pump(key) {
  if (inFlight.has(key) || !pending.has(key)) return;
  const job = pending.get(key);
  pending.delete(key);
  inFlight.add(key);
  const r = job.field
    ? await writeTransform(job.object, job.field, job.value, job.final)
    : await writeNow(job.object, job.path, job.value, job.final);
  const what = job.field ? job.field : job.path.join('.');
  if (!r.ok) broadcast({ type: 'error', message: `Write failed (${job.field || job.path.at(-1)}): ${r.error}` });
  else if (job.final) log(`SET ${labelOf(job.object)} ${what}=${JSON.stringify(job.value)}`);
  setTimeout(() => { inFlight.delete(key); pump(key); }, config.sendIntervalMs);
}

async function revertAll(object) {
  const entry = state.objects.get(object);
  if (!entry || !entry.baseline) return;
  const paths = diffLeaves(entry.baseline, entry.values)
    .sort((a, b) => String(a.at(-1)).startsWith('bOverride_') - String(b.at(-1)).startsWith('bOverride_'));
  let failed = 0;
  for (const p of paths) {
    const r = await writeNow(object, p, clone(getAt(entry.baseline, p)), true);
    if (!r.ok) failed++;
  }
  log(`REVERT ALL ${entry.label}: ${paths.length - failed}/${paths.length}`);
  return { count: paths.length, failed };
}

// ---------------------------------------------------------------- snapshots
const presetFile = path.join(ROOT, 'snapshots.json');
let presets = [];
try { presets = JSON.parse(fs.readFileSync(presetFile, 'utf8')); } catch { presets = []; }
const savePresets = () => fs.writeFile(presetFile, JSON.stringify(presets, null, 2), () => {});
const isPPVSettings = v => v && typeof v.Settings === 'object' && Object.keys(v.Settings).some(k => k.startsWith('bOverride_'));

function makeSnapshot(entry, name) {
  let data;
  if (isPPVSettings(entry.values)) {
    // A PPV look = every overridden setting with its value
    const s = entry.values.Settings, settings = {};
    for (const k of Object.keys(s)) {
      if (k.startsWith('bOverride_') && s[k] === true) {
        const f = k.slice('bOverride_'.length);
        settings[k] = true;
        if (f in s) settings[f] = clone(s[f]);
      }
    }
    data = { type: 'ppv', settings };
  } else {
    data = { type: 'diff', changes: diffLeaves(entry.baseline, entry.values).map(p => [p, clone(getAt(entry.values, p))]) };
  }
  return { id: Date.now().toString(36), name, kind: entry.kind, cls: entry.cls, source: entry.label, createdAt: new Date().toISOString(), data };
}

async function applySnapshot(snap, object) {
  const entry = state.objects.get(object);
  if (!entry || !entry.values) return { ok: false, error: 'Object not loaded' };
  if (snap.data.type === 'ppv') {
    if (!isPPVSettings(entry.values)) return { ok: false, error: 'Target is not a Post Process Volume' };
    const settings = {};
    for (const k of Object.keys(entry.values.Settings)) if (k.startsWith('bOverride_')) settings[k] = false;
    Object.assign(settings, snap.data.settings);
    const r = await ue('/remote/object/property', {
      objectPath: object, propertyName: 'Settings', access: 'WRITE_TRANSACTION_ACCESS', propertyValue: { Settings: settings },
    });
    if (!r.ok) return { ok: false, error: ueError(r) };
  } else {
    for (const [p, v] of snap.data.changes) {
      const r = await writeNow(object, p, v, true);
      if (!r.ok) return { ok: false, error: r.error };
    }
  }
  const fresh = await readAll(entry);
  if (fresh) entry.values = fresh;
  log(`SNAPSHOT APPLIED "${snap.name}" -> ${entry.label}`);
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const PUBLIC = path.join(ROOT, 'public');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(PUBLIC, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  if (!full.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(full, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': (TYPES[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server });
const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcast = msg => { for (const ws of wss.clients) if (ws.authed) send(ws, msg); };
function stateMsg() {
  return {
    type: 'state', ueOnline: state.ueOnline, locked: state.locked, discovering: state.discovering,
    discoveryNote: state.discoveryNote, lastScan: state.lastScan,
    objects: [...state.objects.values()].map(({ path: p, kind, label, cls, parent, folder, compsLoaded }) => ({ path: p, kind, label, cls, parent, folder: folder || '', compsLoaded: !!compsLoaded })),
    snapshots: presets.map(({ id, name, kind, cls, source, createdAt }) => ({ id, name, kind, cls, source, createdAt })),
  };
}
const broadcastState = () => broadcast(stateMsg());
function objectMsg(entry) {
  return { type: 'object', path: entry.path, kind: entry.kind, label: entry.label, cls: entry.cls,
    values: entry.values, baseline: entry.baseline, meta: entry.meta, schema: entry.schema || null,
    transform: entry.transform || null, transformBaseline: entry.transformBaseline || null };
}

async function handle(ws, msg, ip) {
  const mutating = ['set', 'revert', 'revertAll', 'applySnapshot'];
  if (state.locked && mutating.includes(msg.type)) return send(ws, { type: 'error', message: 'Controls are locked' });

  switch (msg.type) {
    case 'open': {
      if (!state.objects.has(msg.path) && !adoptOwned(msg.path)) return send(ws, { type: 'error', message: 'Object not found. Rescan the level.' });
      ws.viewing = msg.path;
      const entry = state.objects.get(msg.path);
      if (!entry.loaded && !(await loadObject(msg.path))) {
        log(`OPEN FAILED ${entry.label} (${msg.path})`);
        return send(ws, { type: 'loadFailed', path: msg.path, message: `Could not read ${entry.label} from Unreal. See the Bridge console.` });
      }
      if (!entry.cls && entry.describe) entry.cls = entry.describe.Class || '';
      if (ws.viewing === msg.path) send(ws, objectMsg(entry));
      broadcastState();
      break;
    }
    case 'expand':
      if (state.objects.has(msg.path) && !state.objects.get(msg.path).compsLoaded) await loadComponents(msg.path);
      break;
    case 'set': {
      const entry = state.objects.get(msg.object);
      if (!entry || !entry.loaded || !Array.isArray(msg.path) || !msg.path.length) return;
      if (getAt(entry.values, msg.path) === undefined) return send(ws, { type: 'error', message: 'Unknown property' });
      queueWrite(msg.object, msg.path, msg.value, !!msg.final);
      break;
    }
    case 'setTransform': {
      const entry = state.objects.get(msg.object);
      if (!entry || !entry.transform || !TF_FIELDS.includes(msg.field) || !msg.value || typeof msg.value !== 'object') return;
      const v = {};
      for (const k of Object.keys(entry.transform[msg.field] || {})) {
        const n = Number(msg.value[k]);
        if (!isFinite(n)) return send(ws, { type: 'error', message: 'Invalid transform value' });
        v[k] = n;
      }
      queueWrite(msg.object, null, v, !!msg.final, msg.field);
      break;
    }
    case 'revert': {
      // Value first, then its bOverride_ flag, sequentially so the flag ends at its original state
      const entry = state.objects.get(msg.object);
      if (!entry || !entry.baseline) return;
      const paths = (Array.isArray(msg.paths) ? msg.paths : [msg.path]).filter(p => Array.isArray(p) && p.length);
      for (const p of paths) {
        const base = getAt(entry.baseline, p);
        if (base === undefined) continue;
        const r = await writeNow(msg.object, p, clone(base), true);
        if (!r.ok) { send(ws, { type: 'error', message: `Reset failed: ${r.error}` }); break; }
        log(`RESET ${entry.label} ${p.join('.')}`);
      }
      break;
    }
    case 'revertAll': {
      const r = await revertAll(msg.object);
      if (r) send(ws, { type: 'info', message: r.failed ? `Reverted ${r.count - r.failed}/${r.count}` : `Reverted ${r.count} changes` });
      break;
    }
    case 'lock':
      state.locked = !!msg.locked;
      log(`${state.locked ? 'LOCK' : 'UNLOCK'} ${ip}`);
      broadcastState();
      break;
    case 'rescan':
      discover();
      break;
    case 'reload': {
      const entry = state.objects.get(msg.path);
      if (entry && await loadObject(msg.path)) send(ws, objectMsg(entry));
      break;
    }
    case 'saveSnapshot': {
      const entry = state.objects.get(msg.object);
      if (!entry || !entry.loaded) return;
      const snap = makeSnapshot(entry, String(msg.name || 'Snapshot').slice(0, 60));
      presets.unshift(snap);
      savePresets();
      log(`SNAPSHOT SAVED "${snap.name}" from ${entry.label}`);
      send(ws, { type: 'info', message: `Saved "${snap.name}"` });
      broadcastState();
      break;
    }
    case 'applySnapshot': {
      const snap = presets.find(p => p.id === msg.id);
      if (!snap) return;
      const r = await applySnapshot(snap, msg.object);
      if (!r.ok) return send(ws, { type: 'error', message: `Apply failed: ${r.error}` });
      const entry = state.objects.get(msg.object);
      for (const c of wss.clients) if (c.authed && c.viewing === msg.object) send(c, objectMsg(entry));
      send(ws, { type: 'info', message: `Applied "${snap.name}"` });
      break;
    }
    case 'deleteSnapshot':
      presets = presets.filter(p => p.id !== msg.id);
      savePresets();
      broadcastState();
      break;
  }
}

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  ws.authed = false;
  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!ws.authed) {
      if (msg.type === 'auth' && String(msg.pin) === String(config.pin)) {
        ws.authed = true;
        log(`CONNECT ${ip}`);
        send(ws, stateMsg());
      } else {
        log(`AUTH FAILED ${ip}`);
        send(ws, { type: 'authFailed' });
      }
      return;
    }
    try { await handle(ws, msg, ip); }
    catch (err) { log(`ERROR ${msg.type}: ${err.message}`); send(ws, { type: 'error', message: err.message }); }
  });
  ws.on('close', () => { if (ws.authed) log(`DISCONNECT ${ip}`); });
});

// ---------------------------------------------------------------- loops
async function checkUe() {
  const online = await ueAlive();
  if (online === state.ueOnline) return;
  state.ueOnline = online;
  log(online ? `UE connected (${UE_URL})` : 'UE disconnected');
  broadcastState();
  if (online && config.autoDiscover) discover();
}

let polling = false;
async function poll() {
  if (polling || !state.ueOnline) return;
  polling = true;
  try {
    const viewed = new Set([...wss.clients].filter(c => c.authed && c.viewing).map(c => c.viewing));
    for (const p of viewed) {
      const entry = state.objects.get(p);
      if (!entry || !entry.loaded || objectBusy(p)) continue;
      const fresh = await readAll(entry);
      if (fresh && entry.inline) {
        for (const [key, cp] of Object.entries(entry.inline)) {
          const ce = state.objects.get(cp);
          if (!ce) continue;
          const cf = await readAll(ce);
          if (cf) ce.values = cf;
          fresh[key] = ce.values;
        }
      }
      const tf = entry.transform ? await readTransform({ ...entry, values: fresh || entry.values }) : null;
      if (objectBusy(p)) continue;
      const valuesChanged = fresh && !same(fresh, entry.values);
      const tfChanged = tf && !same(tf, entry.transform);
      if (!valuesChanged && !tfChanged) continue;
      if (valuesChanged) entry.values = fresh;
      if (tfChanged) entry.transform = tf;
      for (const c of wss.clients) if (c.authed && c.viewing === p) send(c, { type: 'values', path: p, values: entry.values, transform: entry.transform });
    }
  } finally { polling = false; }
}

let namesDb = null;
try { namesDb = ueschema.loadDatabase(config, log); } catch (err) { log(`Engine header parse failed: ${err.message}`); }

server.listen(config.port, '0.0.0.0', () => {
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:${config.port}`);
  console.log('Stage Controller bridge v1.4');
  console.log('Open on iPad / iPhone (same Wi-Fi):');
  for (const a of addrs) console.log('  ' + a);
  console.log(`Looking for UE Remote Control at ${UE_URL} ...`);
  checkUe();
  setInterval(checkUe, config.ueCheckMs);
  setInterval(poll, config.pollMs);
});
