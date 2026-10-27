import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { actorFromRequest } from '../auth/session.ts';
import type { Actor } from '../policy.ts';
import { level, MODULES, type Module } from '../policy.ts';
import { INTERNAL_HEADER, internalSecret, type PersonalToken } from './tokens.ts';

/**
 * Remote MCP server at POST /mcp (change agent-access, slice 2). Stateless: one server and transport per request.
 * Every tool is one API operation (name = operationId) and runs as an in-process call of that same route with the
 * caller's token, so authorisation, validation, idempotency, audit, log and limit happen exactly where the web app's
 * requests go. A tool can never do more than the API.
 */
export const MCP_PATH = '/mcp';
const PDF_MAX = 5 * 1024 * 1024;
/** Above this many operations (a full admin has ~300, about 250 kB of schemas) the list would swamp the agent's
 *  context: it gets three tools instead, to search, describe and call the same operations. */
const DIRECT_MAX = 60;
const TEXT_MAX = 1024 * 1024;

interface OpenApiOp { operationId?: string; summary?: string; tags?: string[]; security?: unknown[]; parameters?: { name: string; in: string; required?: boolean; schema?: object; description?: string }[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: object }> } }
export interface Tool { name: string; method: string; path: string; description: string; tag: string | null; inputSchema: { type: 'object'; properties: Record<string, object>; required: string[] }; pathParams: string[]; queryParams: string[]; hasBody: boolean }

// Not for agents: sign-in and token management (people only), the operator API, uploads of raw bytes.
const EXCLUDED = /^\/(auth\/(?!me$)|setup$|operator\/|personal-tokens|portal\/(auth|tokens)|files(\/\{[^}]+\}\/versions)?$|receipts\/files$|portal\/expenses\/files$|unsubscribe\/|forms\/|applications\/public)/;

/** All operations of the OpenAPI document as tools (computed once). */
export function toolsFrom(doc: { paths: Record<string, Record<string, OpenApiOp>> }): Tool[] {
  const tools: Tool[] = [];
  for (const [fullPath, methods] of Object.entries(doc.paths)) {
    const path = fullPath.replace(/^\/api\/v1/, '');
    if (EXCLUDED.test(path)) continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!op.operationId || method === 'head' || method === 'options') continue;
      // Public routes (forms, unsubscribe, health) need no agent; the portal is public in OpenAPI but a member's home.
      if (op.security?.length === 0 && !path.startsWith('/portal/')) continue;
      const properties: Record<string, object> = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      for (const p of op.parameters ?? []) {
        if (p.in !== 'path' && p.in !== 'query') continue;
        properties[p.name] = { ...(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
        if (p.in === 'path') {
          pathParams.push(p.name);
          required.push(p.name);
        } else {
          queryParams.push(p.name);
          if (p.required) required.push(p.name);
        }
      }
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body) {
        properties.body = { ...body, description: 'JSON-Body der Anfrage' };
        if (op.requestBody?.required) required.push('body');
      }
      if (method === 'patch') properties.ifMatch = { type: 'string', description: 'ETag aus der letzten Antwort (verhindert, dass Du fremde Änderungen überschreibst); ohne Angabe: *' };
      tools.push({
        name: op.operationId,
        method: method.toUpperCase(),
        path,
        description: `${op.summary ?? ''} (${method.toUpperCase()} ${path})`.trim(),
        tag: op.tags?.[0] ?? null,
        inputSchema: { type: 'object', properties, required },
        pathParams,
        queryParams,
        hasBody: !!body,
      });
    }
  }
  return tools;
}

/** What this token may see in tools/list: member tokens the portal, admin tokens what their (capped) rights reach. */
export function visibleTools(tools: Tool[], t: PersonalToken, actor: Actor | null) {
  return tools.filter((tool) => {
    if (t.access === 'read' && tool.method !== 'GET') return false;
    const portal = tool.path.startsWith('/portal/');
    if (t.kind === 'member') return portal;
    if (portal || !actor) return false;
    const mod = MODULES.includes(tool.tag as Module) ? (tool.tag as Module) : null;
    if (!mod) return true;
    const have = level(actor, mod);
    return tool.method === 'GET' ? have !== 'none' : have === 'write';
  });
}

const GUIDE = `# OpenVerein für Agenten

Du handelst im Namen genau einer Person: der, der das Token gehört. Du siehst und darfst, was sie in OpenVerein sieht und darf, nicht mehr.

- Verwaltungs-Token: frag zuerst \`getAuthMe\` (wer bin ich, welche Rechte).
- Mitglieder-Token: frag zuerst \`getPortalMe\` (Mitgliedschaften, Rechnungen, Daten).
- Ändere nichts ohne ausdrückliche Zustimmung Deiner Person. Geld-Aktionen mit zweitem Faktor (Zahlungsexporte u. a.) gehen nur im Browser.
- Fehler kommen als RFC 9457 (\`title\`, \`detail\`, bei Eingabefehlern \`errors\`). Bei 429 warte so viele Sekunden, wie \`retry-after\` sagt.
- Beträge sind Cent-Ganzzahlen, Daten ISO 8601.
`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const META_TOOLS = [
  { name: 'operationen_suchen', description: 'Findet Operationen der OpenVerein-API, die dieses Token aufrufen darf (Stichwort wie „Rechnung", „Mitglied", „Termin" oder Pfad). Ohne Stichwort: alle, nach Bereich.', inputSchema: { type: 'object', properties: { suche: { type: 'string', description: 'Stichwort, leer für alle' } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'operation_beschreiben', description: 'Zeigt Beschreibung und Eingabe-Schema einer Operation (Name aus operationen_suchen).', inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'operation_aufrufen', description: 'Ruft eine Operation auf, mit Deinen Rechten. Eingabe wie in operation_beschreiben: Pfad- und Query-Parameter als Felder, JSON-Body unter "body", bei PATCH optional "ifMatch". Ändere nichts ohne Zustimmung Deiner Person.', inputSchema: { type: 'object', properties: { operation: { type: 'string' }, eingabe: { type: 'object' } }, required: ['operation'] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];

/** Operations whose name, path, area or summary contain every word of the query (case-insensitive). */
export function search(tools: Tool[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .filter((t) => words.every((w) => `${t.name} ${t.path} ${t.tag ?? ''} ${t.description}`.toLowerCase().includes(w)))
    .slice(0, 80)
    .map((t) => ({ operation: t.name, bereich: t.tag, beschreibung: t.description }));
}

/** Executes one tool as a call of its API route, with the caller's token, from the caller's address. */
async function callTool(app: FastifyInstance, req: FastifyRequest, tool: Tool, args: Record<string, unknown>) {
  let url = tool.path;
  for (const p of tool.pathParams) {
    const v = String(args[p] ?? '');
    // Dot segments would be normalised away and hit another route.
    if (!v || v === '.' || v === '..') return { content: [{ type: 'text' as const, text: `Ungültiger Wert für ${p}.` }], isError: true };
    url = url.replace(`{${p}}`, encodeURIComponent(v));
  }
  const query = new URLSearchParams();
  for (const q of tool.queryParams) {
    const v = args[q];
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) query.append(q, String(x));
  }
  const qs = query.toString();
  const res = await app.inject({
    method: tool.method as 'GET',
    url: `/api/v1${url}${qs ? `?${qs}` : ''}`,
    remoteAddress: req.ip,
    headers: {
      authorization: req.headers.authorization!,
      [INTERNAL_HEADER]: internalSecret,
      ...(tool.method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      ...(tool.method === 'PATCH' ? { 'if-match': typeof args.ifMatch === 'string' ? args.ifMatch : '*' } : {}),
      ...(tool.method !== 'GET' && tool.method !== 'DELETE' ? { 'content-type': 'application/json' } : {}),
    },
    ...(tool.method !== 'GET' && tool.method !== 'DELETE' ? { payload: JSON.stringify(args.body ?? {}) } : {}),
  });
  const type = String(res.headers['content-type'] ?? '');
  if (res.statusCode >= 400) {
    const wait = res.headers['retry-after'];
    return { content: [{ type: 'text' as const, text: `HTTP ${res.statusCode}${wait ? ` (erneut versuchen in ${wait} s)` : ''}\n${res.body}` }], isError: true };
  }
  if (type.startsWith('application/pdf')) {
    if (res.rawPayload.length > PDF_MAX) return { content: [{ type: 'text' as const, text: 'Das PDF ist größer als 5 MB. Bitte im Browser oder per API/CLI öffnen.' }], isError: true };
    return { content: [{ type: 'resource' as const, resource: { uri: `openverein:/${url}`, mimeType: 'application/pdf', blob: res.rawPayload.toString('base64') } }] };
  }
  const textual = !type || type.includes('json') || type.startsWith('text/') || type.includes('xml') || type.includes('svg');
  if (!textual) return { content: [{ type: 'text' as const, text: `Die Antwort ist eine Datei (${type}, ${res.rawPayload.length} Bytes). Bitte per API oder CLI herunterladen.` }] };
  if (res.rawPayload.length > TEXT_MAX) return { content: [{ type: 'text' as const, text: 'Die Antwort ist größer als 1 MB. Bitte mit Filtern oder Seiten (limit, cursor) eingrenzen.' }], isError: true };
  return { content: [{ type: 'text' as const, text: res.body || `HTTP ${res.statusCode}` }] };
}

export function registerMcp(app: FastifyInstance) {
  let all: Tool[] | undefined;
  const tools = () => (all ??= toolsFrom(app.swagger() as never));

  const unauthorized = (reply: FastifyReply, detail: string) => {
    reply.header('www-authenticate', 'Bearer realm="openverein"');
    return reply.status(401).type('application/problem+json').send({ type: 'https://openverein.org/probleme/unauthenticated', title: 'Der MCP-Zugang braucht ein Token.', status: 401, detail });
  };

  app.post(MCP_PATH, { config: { mcp: true }, bodyLimit: 64 * 1024, schema: { hide: true } }, async (req, reply) => {
    const t = req.agentToken;
    if (!t) return unauthorized(reply, 'Authorization: Bearer ov_pat_… (Verwaltung) oder ov_mpt_… (Mitgliederportal); erstellen unter Einstellungen → Agenten bzw. im Portal unter Agenten.');
    // /mcp is outside /api, where the actor hook runs: resolve it here, the same way.
    const actor = await actorFromRequest(app.db, req, reply);
    const visible = visibleTools(tools(), t, actor);
    const byName = new Map(visible.map((x) => [x.name, x]));
    const server = new Server({ name: 'openverein', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: GUIDE });
    const direct = visible.length <= DIRECT_MAX;
    const listed = direct
      ? visible.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema, annotations: { readOnlyHint: x.method === 'GET', destructiveHint: x.method === 'DELETE', openWorldHint: false } }))
      : META_TOOLS;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const args = (r.params.arguments ?? {}) as Record<string, unknown>;
      const unknown = (name: unknown) => ({ content: [{ type: 'text' as const, text: `Unbekannte oder für dieses Token nicht erlaubte Operation: ${String(name)}` }], isError: true });
      if (!direct && r.params.name === 'operationen_suchen') return text(JSON.stringify(search(visible, String(args.suche ?? '')), null, 1));
      if (!direct && r.params.name === 'operation_beschreiben') {
        const tool = byName.get(String(args.operation));
        return tool ? text(JSON.stringify({ operation: tool.name, beschreibung: tool.description, eingabe: tool.inputSchema })) : unknown(args.operation);
      }
      if (!direct && r.params.name === 'operation_aufrufen') {
        const tool = byName.get(String(args.operation));
        return tool ? callTool(app, req, tool, (args.eingabe ?? {}) as Record<string, unknown>) : unknown(args.operation);
      }
      const tool = direct ? byName.get(r.params.name) : undefined;
      return tool ? callTool(app, req, tool, args) : unknown(r.params.name);
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'openverein://agents.md', name: 'Anleitung für Agenten', mimeType: 'text/markdown' }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (r) => ({ contents: r.params.uri === 'openverein://agents.md' ? [{ uri: r.params.uri, mimeType: 'text/markdown', text: GUIDE }] : [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => void server.close().catch(() => undefined));
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // Stateless: no event stream to open, no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: MCP_PATH, config: { mcp: true }, schema: { hide: true }, handler: async (_req, reply) => reply.status(405).header('allow', 'POST').send() });
  }
}
