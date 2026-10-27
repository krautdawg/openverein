#!/usr/bin/env node
// ov — OpenVerein im Terminal. Eine Datei, keine Abhängigkeiten, Node 20+.
// Liest die Operationen aus /api/v1/openapi.json und ruft sie per operationId auf (dieselben Namen wie die MCP-Werkzeuge).
//
//   curl -fsSLO https://<euer-verein>/ov.mjs
//   export OV_URL=https://<euer-verein>  OV_TOKEN=ov_pat_…   # Token: Einstellungen → Agenten (oder Portal → Agenten)
//   node ov.mjs                         # alle Operationen (node ov.mjs suche rechnung)
//   node ov.mjs getAuthMe
//   node ov.mjs getMembers --status active --limit 10
//   node ov.mjs patchMembersId <id> --json '{"phone":"030 123"}'
//   node ov.mjs getPortalInvoicesIdPdf <id> --ausgabe rechnung.pdf
//   node ov.mjs postFiles --datei satzung.pdf --dateiname Satzung.pdf
//   node ov.mjs postInvoices --json @rechnung.json --idempotency-key rechnung-2026-17   # bei Wiederholung derselbe Schlüssel

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain', xml: 'application/xml' };

/** The token goes only to an HTTPS instance or a local development server. */
export function tokenTargetAllowed(base) {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** Every operation with an id: method, path (with /api/v1), summary, path placeholders. */
export function operations(openapi) {
  const ops = [];
  for (const [path, methods] of Object.entries(openapi.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op?.operationId || method === 'head') continue;
      const fields = op.requestBody?.content?.['application/json']?.schema?.properties ?? {};
      ops.push({ id: op.operationId, method: method.toUpperCase(), path, summary: op.summary ?? '', tag: op.tags?.[0] ?? '', params: Array.from(path.matchAll(/\{(\w+)\}/g), (m) => m[1]), fields });
    }
  }
  return ops.sort((a, b) => a.id.localeCompare(b.id));
}

/** argv → { positional, flags }: `--name wert`, `--name=wert`. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (a === '--help') flags.help = 'true';
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else throw new Error(`${a} braucht einen Wert. Beginnt er selbst mit --, schreib ${a}=--wert.`);
  }
  return { positional, flags };
}

const RESERVED = ['json', 'datei', 'dateiname', 'ausgabe', 'if-match', 'idempotency-key', 'help'];

/** A body flag as the schema wants it: text stays text ("12345" is a postal code), numbers, booleans, lists and objects are parsed. */
function typed(schema, v) {
  const types = [schema?.type, ...(schema?.anyOf ?? []).map((x) => x.type)].flat().filter(Boolean);
  if (!types.length || types.includes('string')) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Path, query and JSON body: --json (text or @file) is the body, other flags are query (GET/DELETE) or body fields. */
export function buildRequest(op, positional, flags, jsonText) {
  if (positional.length < op.params.length) throw new Error(`${op.id} braucht: ${op.params.map((p) => `<${p}>`).join(' ')}`);
  let path = op.path;
  op.params.forEach((p, i) => {
    const v = positional[i];
    // Dot segments would be normalised away and hit another route.
    if (!v || v === '.' || v === '..') throw new Error(`Ungültiger Wert für <${p}>.`);
    path = path.replace(`{${p}}`, encodeURIComponent(v));
  });
  const rest = Object.fromEntries(Object.entries(flags).filter(([k]) => !RESERVED.includes(k)));
  if (op.method === 'GET' || op.method === 'DELETE' || flags.datei) {
    if (jsonText !== undefined && !flags.datei && op.method === 'GET') throw new Error('--json gibt es nur für Operationen mit Body.');
    const q = new URLSearchParams(rest).toString();
    return { path: q ? `${path}?${q}` : path, ...(jsonText !== undefined && op.method === 'DELETE' ? { body: jsonText } : {}) };
  }
  let json = {};
  if (jsonText !== undefined) {
    try {
      json = JSON.parse(jsonText);
    } catch {
      throw new Error('--json ist kein gültiges JSON.');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('--json muss ein JSON-Objekt sein.');
  }
  const body = { ...json, ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typed(op.fields?.[k], v)])) };
  return { path, body: JSON.stringify(body) };
}

function help(ops, base, filter) {
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ops.filter((o) => words.every((w) => `${o.id} ${o.path} ${o.tag} ${o.summary}`.toLowerCase().includes(w)));
  const lines = shown.map((o) => `  ${(o.id + o.params.map((p) => ` <${p}>`).join('')).padEnd(44)} ${o.summary}`);
  return `ov — OpenVerein im Terminal (${base})

Aufruf:  node ov.mjs <operation> [<pfadparameter> …] [--feld wert …] [--json '{…}' | --json @datei]
         Hochladen: --datei pfad [--dateiname name]   ·   Antwort in Datei: --ausgabe pfad
         Ändern (PATCH): --if-match <version>, '*' überschreibt bewusst   ·   Geld-Aktionen: --idempotency-key <eigener schlüssel>
Suchen:  node ov.mjs suche <stichwort>
Token:   OV_TOKEN=ov_pat_… oder ov_mpt_… (Einstellungen → Agenten bzw. Portal → Agenten). Was Du nicht darfst, darf auch die CLI nicht.

Operationen (${shown.length}):
${lines.join('\n')}`;
}

export async function main(argv, env = process.env) {
  const base = (env.OV_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    console.error('OV_URL fehlt, z. B. export OV_URL=https://verein.example.org');
    return 2;
  }
  const res = await fetch(`${base}/api/v1/openapi.json`, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new Error(`${base} leitet weiter nach ${res.headers.get('location')}. Setz OV_URL auf die endgültige Adresse.`);
  if (!res.ok) throw new Error(`openapi.json nicht erreichbar (HTTP ${res.status})`);
  const ops = operations(await res.json());
  const { positional, flags } = parseArgs(argv);
  const name = positional.shift();
  if (!name || name === 'hilfe' || name === 'help' || flags.help) {
    console.log(help(ops, base));
    return 0;
  }
  if (name === 'suche') {
    console.log(help(ops, base, positional.join(' ')));
    return 0;
  }
  const op = ops.find((o) => o.id === name);
  if (!op) {
    console.error(`Unbekannte Operation „${name}". \`node ov.mjs suche <stichwort>\` hilft.`);
    return 2;
  }
  const token = env.OV_TOKEN;
  if (token?.startsWith('ov_oat_')) {
    console.error('ov_oat_-Tokens (OAuth) gelten nur für /mcp. Die CLI braucht ein Token aus Einstellungen → Agenten oder Portal → Agenten.');
    return 2;
  }
  if (token && !tokenTargetAllowed(base)) {
    console.error(`Das Token geht nur an eine HTTPS-Adresse oder einen lokalen Server, nicht an ${base}.`);
    return 2;
  }
  const jsonText = flags.json?.startsWith('@') ? await readFile(flags.json.slice(1), 'utf8') : flags.json;
  const req = buildRequest(op, positional, flags, jsonText);
  const headers = { 'x-ov-channel': 'cli' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (op.method === 'POST') {
    // Reuse the key on a retry: the server answers the first result instead of booking twice.
    headers['idempotency-key'] = flags['idempotency-key'] ?? randomUUID();
    if (!flags['idempotency-key']) console.error(`Idempotency-Key: ${headers['idempotency-key']} (bei einem erneuten Versuch mit --idempotency-key mitgeben)`);
  }
  // No default: without a version the server answers 428 with the current one instead of overwriting someone's change.
  if (op.method === 'PATCH' && flags['if-match']) headers['if-match'] = flags['if-match'];
  let body = req.body;
  if (flags.datei) {
    const ext = flags.datei.split('.').pop().toLowerCase();
    headers['content-type'] = 'application/octet-stream';
    headers['x-file-type'] = MIME[ext] ?? 'application/octet-stream';
    // The name travels in the header, never in the URL (names can be personal: access logs keep URLs).
    headers['x-file-name'] = encodeURIComponent(flags.dateiname ?? basename(flags.datei));
    body = await readFile(flags.datei);
  } else if (body !== undefined) headers['content-type'] = 'application/json';
  const url = new URL(req.path, `${base}/`);
  if (url.origin !== new URL(base).origin) throw new Error('Die Operation zeigt auf eine andere Adresse.');
  // No redirects: the token belongs to exactly this address.
  const answer = await fetch(url, { method: op.method, headers, body, redirect: 'manual' });
  const type = answer.headers.get('content-type') ?? '';
  if (answer.ok && flags.ausgabe) {
    const bytes = Buffer.from(await answer.arrayBuffer());
    await writeFile(flags.ausgabe, bytes);
    console.error(`${bytes.length} Bytes → ${flags.ausgabe}`);
    return 0;
  }
  if (answer.ok && !type.includes('json') && !type.startsWith('text/')) {
    if (process.stdout.isTTY) {
      console.error(`Die Antwort ist eine Datei (${type}). Bitte mit --ausgabe <pfad> speichern.`);
      return 2;
    }
    process.stdout.write(Buffer.from(await answer.arrayBuffer()));
    return 0;
  }
  const text = await answer.text();
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: print as it came
  }
  if (answer.ok) {
    if (out) console.log(out);
    return 0;
  }
  const wait = answer.headers.get('retry-after');
  console.error(`HTTP ${answer.status}${wait ? ` (erneut versuchen in ${wait} s)` : ''}`);
  console.error(out);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not exit(): piped output must be written completely first.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
