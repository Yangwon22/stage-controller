// Auto-discovery test: finds actors in the open level through Remote Control only
// (no Python, no manual paths), then dumps the structure of every PPV / nDisplay actor found.
// Usage: UE running + WebControl.StartServer, then: node discover.js

const fs = require('fs');
const path = require('path');

const UE_URL = 'http://127.0.0.1:30010';
const log = { ue: UE_URL, startedAt: new Date().toISOString(), listAttempts: [], actors: [], targets: {} };

async function put(route, body) {
  try {
    const res = await fetch(`${UE_URL}${route}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, body: json ?? text };
  } catch (err) {
    return { status: 0, ok: false, body: `request failed: ${err.message}` };
  }
}

// Pull every string that looks like an object path out of a response.
function collectPaths(value, out = new Set()) {
  if (typeof value === 'string' && value.includes(':PersistentLevel.')) out.add(value);
  else if (Array.isArray(value)) value.forEach(v => collectPaths(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collectPaths(v, out));
  return out;
}

// Several ways to list level actors; whichever works on this engine is the one the real tool will use.
const LIST_METHODS = [
  { name: 'EditorActorSubsystem.GetAllLevelActors',
    body: { objectPath: '/Script/UnrealEd.Default__EditorActorSubsystem', functionName: 'GetAllLevelActors' } },
  { name: 'EditorLevelLibrary.GetAllLevelActors',
    body: { objectPath: '/Script/EditorScriptingUtilities.Default__EditorLevelLibrary', functionName: 'GetAllLevelActors' } },
  { name: 'GameplayStatics.GetAllActorsOfClass(Actor)',
    body: { objectPath: '/Script/Engine.Default__GameplayStatics', functionName: 'GetAllActorsOfClass',
            parameters: { ActorClass: '/Script/Engine.Actor' } } },
];

async function main() {
  const info = await fetch(`${UE_URL}/remote/info`).catch(() => null);
  if (!info || !info.ok) {
    console.error('UE Remote Control not found at ' + UE_URL);
    console.error('Start UE and run WebControl.StartServer, then try again.');
    process.exit(1);
  }
  console.log('UE Remote Control found.');

  let actorPaths = new Set();
  for (const m of LIST_METHODS) {
    const r = await put('/remote/object/call', m.body);
    const found = collectPaths(r.body);
    log.listAttempts.push({ method: m.name, status: r.status, found: found.size,
      sample: typeof r.body === 'string' ? r.body.slice(0, 500) : undefined });
    console.log(`  ${m.name}: HTTP ${r.status}, ${found.size} actors`);
    if (found.size > actorPaths.size) actorPaths = found;
  }

  if (actorPaths.size === 0) {
    console.log('\nNo method could list actors. Saving results anyway.');
  } else {
    console.log(`\nDescribing ${actorPaths.size} actors to find PPV and nDisplay...`);
  }

  for (const p of actorPaths) {
    const d = await put('/remote/object/describe', { objectPath: p });
    const cls = d.ok && d.body ? (d.body.Class || '') : '';
    const props = d.ok && d.body && Array.isArray(d.body.Properties) ? d.body.Properties.map(x => x.Name) : [];
    log.actors.push({ path: p, class: cls });
    const isPPV = /PostProcessVolume/i.test(cls) || /PostProcessVolume/i.test(p);
    const isNDC = /DisplayCluster/i.test(cls) || props.includes('CurrentConfigData');
    if (isPPV || isNDC) log.targets[p] = { kind: isPPV ? 'PPV' : 'NDC', class: cls, describe: d };
  }

  for (const [p, t] of Object.entries(log.targets)) {
    console.log(`  ${t.kind}: ${p}`);
    t.read = await put('/remote/object/property', { objectPath: p, access: 'READ_ACCESS' });
    if (t.kind === 'NDC') {
      // Components (ICVFX cameras, screens, origin) through Remote Control as well.
      const c = await put('/remote/object/call', {
        objectPath: p, functionName: 'GetComponentsByClass',
        parameters: { ComponentClass: '/Script/Engine.ActorComponent' },
      });
      const comps = [...collectPaths(c.body)].filter(x => x !== p);
      t.componentsCall = { status: c.status, found: comps.length,
        sample: typeof c.body === 'string' ? c.body.slice(0, 500) : undefined };
      t.components = {};
      for (const cp of comps) {
        t.components[cp] = {
          describe: await put('/remote/object/describe', { objectPath: cp }),
          read: await put('/remote/object/property', { objectPath: cp, access: 'READ_ACCESS' }),
        };
      }
      console.log(`    components: ${comps.length}`);
    }
  }

  const file = path.join(__dirname, 'discover-output.json');
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  console.log(`\nSaved: ${file}\nSend this file back.`);
}

main();
