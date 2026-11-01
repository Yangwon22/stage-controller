// Reads the installed engine's C++ headers to get exactly what the UE Details panel uses:
// DisplayName, Category, UI/Clamp ranges, edit/visible flags, inline override toggles, enum entries.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------- FName::NameToDisplayString (port)
function displayString(name, isBool) {
  let s = String(name);
  let i = 0;
  if (isBool && s.length > 1 && s[0] === 'b' && /[A-Z]/.test(s[1])) i = 1;
  // A space starts each run of capitals/digits; lowercase or '_' ends the run.
  let out = '';
  let inRun = false, wasSpace = false, wasOpenParen = false, wasMinus = false;
  for (; i < s.length; i++) {
    let c = s[i];
    const lower = /[a-z]/.test(c), upper = /[A-Z]/.test(c), digit = /[0-9]/.test(c), under = c === '_';
    if ((upper || (digit && !wasMinus)) && !inRun) {
      if (!wasSpace && out.length) { out += ' '; wasSpace = true; }
      inRun = true;
    }
    if (lower || under) inRun = false;
    if (under || /\s/.test(c)) {
      if (!wasSpace && out.length) { out += ' '; wasSpace = true; }
      wasOpenParen = false; wasMinus = false;
      continue;
    }
    if (!out.length || wasSpace || wasOpenParen) c = c.toUpperCase();
    out += c;
    wasSpace = false;
    wasOpenParen = c === '(';
    wasMinus = c === '-';
  }
  return out.trim();
}

// ---------------------------------------------------------------- engine location
function findEngineDir(config) {
  const version = config.ueVersion || '5.7';
  const candidates = [];
  if (config.engineDir) candidates.push(config.engineDir);
  if (process.platform === 'win32') {
    try {
      const out = execSync(`reg query "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${version}" /v InstalledDirectory`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/InstalledDirectory\s+REG_SZ\s+(.+)/);
      if (m) candidates.push(m[1].trim());
    } catch {}
    for (const d of ['C', 'D', 'E', 'F']) {
      candidates.push(`${d}:\\Program Files\\Epic Games\\UE_${version}`, `${d}:\\Epic Games\\UE_${version}`, `${d}:\\UE_${version}`);
    }
  } else {
    candidates.push(`/Users/Shared/Epic Games/UE_${version}`, `${process.env.HOME}/UnrealEngine`);
  }
  return candidates.find(d => d && fs.existsSync(path.join(d, 'Engine', 'Source', 'Runtime', 'Engine'))) || null;
}

const SCAN_DIRS = [
  'Engine/Source/Runtime/Engine/Classes',
  'Engine/Source/Runtime/Engine/Public',
  'Engine/Source/Runtime/CinematicCamera',
  'Engine/Plugins/Runtime/nDisplay/Source',
  'Engine/Plugins/VirtualProduction',
  'Engine/Plugins/Compositing',
  'Engine/Plugins/Media',
  'Engine/Plugins/Runtime/LiveLink',
  'Engine/Plugins/Animation/LiveLink',
];
function listHeaders(root, extra = []) {
  const out = [];
  const walk = d => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(Private|Tests?|ThirdParty)$/i.test(e.name)) walk(p); }
      else if (e.name.endsWith('.h')) out.push(p);
    }
  };
  for (const rel of [...SCAN_DIRS, ...extra]) walk(path.isAbsolute(rel) ? rel : path.join(root, rel));
  return out;
}

// ---------------------------------------------------------------- C++ header parsing
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1;
      while (j < src.length && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}
function closeOf(s, open, o = '(', c = ')') {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}
function splitTop(s) {
  const parts = []; let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { cur += ch; if (ch === '\\') { cur += s[++i]; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if ('(<{'.includes(ch)) depth++;
    if (')>}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function metaBlock(args) {
  const m = /\bmeta\s*=\s*\(/i.exec(args);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  const close = closeOf(args, open);
  return close > 0 ? args.slice(open + 1, close) : '';
}
const metaStr = (meta, key) => {
  const m = new RegExp(`\\b${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^,)\\s]+))`, 'i').exec(meta);
  return m ? (m[1] ?? m[2]) : undefined;
};
const metaFlag = (meta, key) => new RegExp(`(^|[,\\s(])${key}\\s*(?:=\\s*"?true"?)?\\s*(?=,|$|\\))`, 'i').test(meta);
const norm = n => String(n).replace(/^[FUAI](?=[A-Z])/, '');

function parseHeader(src, db) {
  const s = stripComments(src);

  // enums: enum EFoo : uint8 { ... }, enum class, and namespace EFoo { enum Type { ... } }
  const enumRe = /\b(?:namespace\s+([A-Za-z_]\w*)\s*\{\s*)?enum\s+(?:class\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w:]+\s*)?\{/g;
  let m;
  while ((m = enumRe.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(s, open, '{', '}');
    if (close < 0) continue;
    const name = m[1] && m[2] === 'Type' ? m[1] : m[2];
    const entries = [];
    for (const part of splitTop(s.slice(open + 1, close))) {
      const em = /^([A-Za-z_]\w*)/.exec(part);
      if (!em) continue;
      const id = em[1];
      const umeta = /UMETA\s*\(([\s\S]*)\)/.exec(part);
      const um = umeta ? umeta[1] : '';
      if (/\bHidden\b/.test(um) || /(^|_)MAX$/.test(id)) continue;
      entries.push([id, metaStr(um, 'DisplayName') || displayString(id, false)]);
    }
    if (entries.length) db.enums[name] = entries;
  }

  // class / struct bodies
  const scopes = [];
  const typeRe = /\b(struct|class)\s+(?:alignas\s*\([^)]*\)\s*)?(?:[A-Z0-9_]+_API\s+)?([A-Za-z_]\w*)(?:\s+final)?\s*(:\s*[^{;()]*)?\{/g;
  while ((m = typeRe.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(s, open, '{', '}');
    if (close < 0) continue;
    const base = m[3] ? (/(?:public|protected|private)?\s*([A-Za-z_]\w*)/.exec(m[3].replace(/^:\s*/, '')) || [])[1] : null;
    scopes.push({ name: m[2], open, close, base });
    const key = norm(m[2]);
    if (!db.types[key]) db.types[key] = { name: m[2], kind: m[1], base: base ? norm(base) : null, props: {} };
  }

  // UPROPERTY declarations
  const upRe = /\bUPROPERTY\s*\(/g;
  while ((m = upRe.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(s, open);
    if (close < 0) continue;
    const args = s.slice(open + 1, close);
    const semi = s.indexOf(';', close);
    if (semi < 0) continue;
    let decl = s.slice(close + 1, semi).replace(/#[^\n]*\n/g, ' ');
    decl = decl.replace(/\s*(=|\{)[\s\S]*$/, '').replace(/:\s*\d+\s*$/, '').trim();
    const nm = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(decl);
    if (!nm) continue;
    const prop = nm[1];
    const type = decl.slice(0, nm.index).trim();
    const owner = scopes.filter(sc => sc.open < m.index && sc.close > m.index).sort((a, b) => b.open - a.open)[0];
    if (!owner) continue;
    const meta = metaBlock(args);
    const spec = args.replace(/\bmeta\s*=\s*\([\s\S]*\)/i, '');
    const catM = /\bCategory\s*=\s*(?:"([^"]*)"|([\w|]+))/i.exec(args);
    const info = {
      type,
      dn: metaStr(meta, 'DisplayName'),
      cat: catM ? (catM[1] ?? catM[2]) : undefined,
      edit: /\b(EditAnywhere|EditInstanceOnly|Interp)\b/i.test(spec),
      visible: /\b(VisibleAnywhere|VisibleInstanceOnly)\b/.test(spec),
      toggle: metaFlag(meta, 'InlineEditConditionToggle'),
      flat: metaFlag(meta, 'ShowOnlyInnerProperties') || metaFlag(meta, 'ShowPostProcessCategories'),
      advanced: /\bAdvancedDisplay\b/.test(spec),
    };
    for (const k of ['UIMin', 'UIMax', 'ClampMin', 'ClampMax']) {
      const v = metaStr(meta, k);
      if (v !== undefined && isFinite(parseFloat(v))) info[k] = parseFloat(v);
    }
    const ec = metaStr(meta, 'EditCondition');
    if (ec) info.editCondition = ec;
    const bs = /\bBlueprintSetter\s*=\s*"?(\w+)/.exec(spec);
    if (bs) info.setter = bs[1];
    db.types[norm(owner.name)].props[prop] = info;
  }

  // UFUNCTION declarations: name -> parameter names (to call Set... functions)
  const ufRe = /\bUFUNCTION\s*\(/g;
  while ((m = ufRe.exec(s))) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(s, open);
    if (close < 0) continue;
    const after = s.slice(close + 1, close + 600);
    const fm = /([A-Za-z_]\w*)\s*\(/.exec(after.replace(/^\s*(?:virtual|static|inline|FORCEINLINE|[A-Z0-9_]+_API)\s+/g, ''));
    if (!fm) continue;
    const pOpen = close + 1 + after.indexOf(fm[0]) + fm[0].length - 1;
    const pClose = closeOf(s, pOpen);
    if (pClose < 0) continue;
    const params = splitTop(s.slice(pOpen + 1, pClose)).map(x => x.replace(/=.*$/s, '').trim())
      .map(x => (/([A-Za-z_]\w*)\s*$/.exec(x) || [])[1]).filter(Boolean);
    const owner = scopes.filter(sc => sc.open < m.index && sc.close > m.index).sort((a, b) => b.open - a.open)[0];
    if (!owner) continue;
    const ty = db.types[norm(owner.name)];
    (ty.funcs = ty.funcs || {})[fm[1]] = params;
  }
}

function headersFingerprint(files) {
  let sum = 0;
  for (const f of files) { try { sum += fs.statSync(f).mtimeMs; } catch {} }
  return `${files.length}:${Math.round(sum)}`;
}

function loadDatabase(config, log) {
  const engineDir = findEngineDir(config);
  if (!engineDir) {
    log(`Engine headers not found (UE ${config.ueVersion || '5.7'}). Set "engineDir" in config.json for Unreal names. Using generated names.`);
    return null;
  }
  const files = listHeaders(engineDir, config.extraHeaderDirs || []);
  const fp = headersFingerprint(files);
  const cacheFile = path.join(config.rootDir, 'schema-cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.engineDir === engineDir && cache.fingerprint === fp && cache.parserVersion === PARSER_VERSION) {
      log(`Unreal names loaded from cache (${Object.keys(cache.db.types).length} types)`);
      return cache.db;
    }
  } catch {}
  log(`Reading engine headers from ${engineDir} (${files.length} files)...`);
  const t0 = Date.now();
  const db = { types: {}, enums: {} };
  let failed = 0;
  for (const f of files) {
    try { parseHeader(fs.readFileSync(f, 'utf8'), db); } catch { failed++; }
  }
  for (const k of Object.keys(db.types)) if (!Object.keys(db.types[k].props).length && !db.types[k].funcs && db.types[k].kind === 'struct') delete db.types[k];
  log(`Parsed ${Object.keys(db.types).length} types, ${Object.keys(db.enums).length} enums in ${((Date.now() - t0) / 1000).toFixed(1)}s${failed ? `, ${failed} files skipped` : ''}`);
  try { fs.writeFileSync(cacheFile, JSON.stringify({ engineDir, fingerprint: fp, parserVersion: PARSER_VERSION, db })); } catch {}
  return db;
}
const PARSER_VERSION = 3;

// ---------------------------------------------------------------- schema for one object
function resolveType(db, raw) {
  let s = String(raw || '').replace(/\b(const|mutable|class|struct|enum|volatile)\b/g, ' ').replace(/\s+/g, '');
  const tmpl = /^(\w+)<(.+)>$/.exec(s);
  if (tmpl) {
    const [, outer, inner] = tmpl;
    if (outer === 'TArray') return { t: 'array', elem: resolveType(db, inner) };
    if (outer === 'TEnumAsByte') return resolveType(db, inner);
    if (/^T(Object|Soft|Weak|Lazy|SoftObject|SoftClass|Sub)Ptr$|^TSubclassOf$/.test(outer)) return { t: 'object' };
    return { t: 'other' };
  }
  s = s.replace(/\*+$/, '');
  if (/^(float|double)$/.test(s)) return { t: 'float' };
  if (/^u?int(8|16|32|64)?$|^int$|^uint$/.test(s)) return { t: 'int' };
  if (s === 'bool') return { t: 'bool' };
  if (db.enums[s]) return { t: 'enum', ref: s };
  if (db.types[norm(s)] && db.types[norm(s)].kind === 'struct') return { t: 'struct', ref: norm(s) };
  if (db.types[norm(s)]) return { t: 'object' };
  return { t: 'other' };
}

// Base-class properties first, as the Details panel lists them
function propsWithInheritance(db, key) {
  const chain = [];
  const seen = new Set();
  for (let t = db.types[key]; t && !seen.has(t); t = t.base ? db.types[t.base] : null) { seen.add(t); chain.unshift(t); }
  const out = {};
  for (const t of chain) for (const [n, p] of Object.entries(t.props)) out[n] = p;
  return out;
}

function funcsWithInheritance(db, key) {
  const out = {};
  const seen = new Set();
  for (let t = db.types[key]; t && !seen.has(t); t = t.base ? db.types[t.base] : null) {
    seen.add(t);
    for (const [n, p] of Object.entries(t.funcs || {})) if (!(n in out)) out[n] = p;
  }
  return out;
}

function findRoot(db, cls, values) {
  const name = norm(String(cls || '').split('.').pop().replace(/_C$/, ''));
  if (db.types[name]) return name;
  // Blueprint subclasses (e.g. an nDisplay config actor): the native class that declares most of these properties
  const keys = new Set(Object.keys(values || {}));
  let best = null, score = 0;
  for (const [k, t] of Object.entries(db.types)) {
    if (t.kind !== 'class') continue;
    const own = Object.keys(t.props).filter(p => keys.has(p)).length;
    if (own > score) { best = k; score = own; }
  }
  return score >= 2 ? best : null;
}

function buildSchema(db, cls, values) {
  if (!db) return null;
  const root = findRoot(db, cls, values);
  if (!root) return null;
  const types = {}, enums = {};
  const visit = key => {
    if (types[key] || !db.types[key]) return;
    types[key] = {};
    const funcs = funcsWithInheritance(db, key);
    for (const [n, p] of Object.entries(propsWithInheritance(db, key))) {
      const rt = resolveType(db, p.type);
      const info = { t: rt.t };
      if (p.dn) info.dn = p.dn;
      if (p.cat) info.cat = p.cat;
      info.show = p.edit ? 'edit' : p.visible ? 'visible' : 'hidden';
      if (p.toggle) info.toggle = true;
      if (p.flat || rt.ref === 'PostProcessSettings') info.flat = true;
      for (const k of ['UIMin', 'UIMax', 'ClampMin', 'ClampMax']) if (k in p) info[k] = p[k];
      if (p.editCondition && /^\w+$/.test(p.editCondition.trim())) info.ec = p.editCondition.trim();
      if (rt.ref) info.ref = rt.ref;
      if (rt.elem) info.elem = rt.elem;
      const setName = p.setter || (funcs['Set' + n] ? 'Set' + n : funcs['Set' + n.replace(/^b(?=[A-Z])/, '')] ? 'Set' + n.replace(/^b(?=[A-Z])/, '') : null);
      if (setName && funcs[setName] && funcs[setName].length) info.setter = { fn: setName, param: funcs[setName][0] };
      types[key][n] = info;
      for (const r of [rt, rt.elem].filter(Boolean)) {
        if (r.t === 'struct') visit(r.ref);
        if (r.t === 'enum') enums[r.ref] = db.enums[r.ref];
      }
    }
  };
  visit(root);
  return { root, types, enums };
}

module.exports = { loadDatabase, buildSchema, displayString, parseHeader, findEngineDir };
