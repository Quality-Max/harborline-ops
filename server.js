'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'harborline_session';
const SESSION_AAD = Buffer.from('harborline-session-v1');
const SESSION_MAX_AGE_SECONDS = 43_200;
const SESSION_COOKIE_LIMIT = 3_800;
const requestState = new AsyncLocalStorage();

function initialState() {
  return {
    users: [
      { id: 'u-101', orgId: 'org-north', username: 'mira', name: 'Mira Chen', role: 'admin' },
      { id: 'u-102', orgId: 'org-north', username: 'leo', name: 'Leo Martins', role: 'operator' },
      { id: 'u-103', orgId: 'org-north', username: 'sana', name: 'Sana Patel', role: 'viewer' },
      { id: 'u-201', orgId: 'org-south', username: 'nora', name: 'Nora Ellis', role: 'admin' },
    ],
    organizations: [
      { id: 'org-north', name: 'Northwind Supply Co.', timezone: 'Europe/Berlin', lowStockThreshold: 12 },
      { id: 'org-south', name: 'Bayfront Retail Group', timezone: 'America/Los_Angeles', lowStockThreshold: 8 },
    ],
    inventory: [
      { id: 'sku-canvas', orgId: 'org-north', sku: 'CV-TOTE-NVY', name: 'Canvas Tote — Navy', available: 48, reserved: 4 },
      { id: 'sku-bottle', orgId: 'org-north', sku: 'BT-750-SGE', name: '750ml Bottle — Sage', available: 11, reserved: 2 },
      { id: 'sku-notebook', orgId: 'org-north', sku: 'NB-A5-STN', name: 'A5 Notebook — Stone', available: 92, reserved: 10 },
      { id: 'sku-cable', orgId: 'org-south', sku: 'CB-USBC-2M', name: 'USB-C Cable — 2m', available: 31, reserved: 3 },
    ],
    shipments: [
      {
        id: 'shp-1042', orgId: 'org-north', reference: 'HL-24061', recipient: 'Juniper Coffee',
        status: 'draft', service: 'standard', itemId: 'sku-canvas', quantity: 3,
        declaredValue: 89.97, insurance: true, createdAt: '2026-08-28T09:15:00.000Z', dispatchedAt: null,
      },
      {
        id: 'shp-1043', orgId: 'org-north', reference: 'HL-24062', recipient: 'Fieldwork Studio',
        status: 'dispatched', service: 'express', itemId: 'sku-notebook', quantity: 5,
        declaredValue: 74.75, insurance: false, createdAt: '2026-08-29T14:30:00.000Z', dispatchedAt: '2026-08-29T15:02:00.000Z',
      },
      {
        id: 'shp-1044', orgId: 'org-north', reference: 'HL-24063', recipient: 'Atelier Nør',
        status: 'delivered', service: 'standard', itemId: 'sku-bottle', quantity: 2,
        declaredValue: 51.98, insurance: true, createdAt: '2026-08-30T00:10:00.000Z', dispatchedAt: '2026-08-30T07:25:00.000Z',
      },
      {
        id: 'shp-8801', orgId: 'org-south', reference: 'BF-89014', recipient: 'Lumen Workshop',
        status: 'draft', service: 'standard', itemId: 'sku-cable', quantity: 2,
        declaredValue: 29.98, insurance: false, createdAt: '2026-08-29T18:00:00.000Z', dispatchedAt: null,
      },
    ],
    adjustments: [],
    audit: [],
    sequence: 1100,
    summaryCache: new Map(),
  };
}

let fallbackState = initialState();

function activeState() {
  return requestState.getStore()?.state || fallbackState;
}

const state = new Proxy({}, {
  get(_target, property) {
    return activeState()[property];
  },
  set(_target, property, value) {
    activeState()[property] = value;
    return true;
  },
});

function serializableState(appState) {
  return {
    ...appState,
    summaryCache: [...appState.summaryCache.entries()],
  };
}

function restoredState(value) {
  if (!value || typeof value !== 'object') throw new Error('Session state is invalid');
  return {
    ...initialState(),
    ...value,
    summaryCache: new Map(Array.isArray(value.summaryCache) ? value.summaryCache : []),
  };
}

function sessionKey() {
  const secret = process.env.HARBORLINE_SESSION_SECRET;
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

function sealSession(session, appState) {
  const key = sessionKey();
  if (!key) throw new Error('Session security is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(SESSION_AAD);
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({
    version: 1,
    session,
    state: serializableState(appState),
  })));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function openSession(req) {
  const key = sessionKey();
  const token = cookies(req)[SESSION_COOKIE];
  if (!key || !token) return null;
  try {
    const packed = Buffer.from(token, 'base64url');
    if (packed.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
    decipher.setAAD(SESSION_AAD);
    decipher.setAuthTag(packed.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const payload = JSON.parse(zlib.inflateRawSync(plaintext).toString('utf8'));
    const createdAt = Number(payload.session?.createdAt);
    const sessionAge = Date.now() - createdAt;
    if (
      payload.version !== 1
      || !payload.session?.userId
      || !payload.session?.orgId
      || !payload.session?.role
      || !Number.isFinite(createdAt)
      || sessionAge < -300_000
      || sessionAge > SESSION_MAX_AGE_SECONDS * 1_000
    ) return null;
    return { session: payload.session, state: restoredState(payload.state) };
  } catch {
    return null;
  }
}

function secureCookie(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return Boolean(req.socket.encrypted) || forwarded === 'https';
}

function sessionCookie(req, value, options = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Priority=High',
  ];
  if (secureCookie(req)) attributes.push('Secure');
  if (options.clear) attributes.push('Max-Age=0');
  else attributes.push(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  return attributes.join('; ');
}

function sendJson(res, status, payload, headers = {}) {
  const context = res.harborlineSessionContext;
  const responseHeaders = { ...headers };
  if (context?.persist) {
    const cookie = sessionCookie(context.req, sealSession(context.session, context.state));
    if (Buffer.byteLength(cookie) > SESSION_COOKIE_LIMIT) {
      context.persist = false;
      return sendJson(res, 507, { error: 'This session has reached its storage limit' });
    }
    responseHeaders['Set-Cookie'] = cookie;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...responseHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('Request body is too large');
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function currentSession(req) {
  return req.harborlineSession || null;
}

function requireSession(req, res) {
  const session = currentSession(req);
  if (!session) {
    sendError(res, 401, 'Sign in is required');
    return null;
  }
  return session;
}

function requireRole(session, res, roles) {
  if (!roles.includes(session.role)) {
    sendError(res, 403, 'Your role does not allow this action');
    return false;
  }
  return true;
}

function publicUser(user) {
  return { ...user };
}

function configuredAccessCode(orgId) {
  return orgId === 'org-south'
    ? process.env.HARBORLINE_SOUTH_ACCESS_CODE
    : process.env.HARBORLINE_NORTH_ACCESS_CODE;
}

function accessCodeMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateHash = crypto.createHash('sha256').update(String(candidate)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function organization(orgId) {
  return state.organizations.find((item) => item.id === orgId);
}

function record(session, action, subject, details = {}) {
  state.audit.unshift({
    id: crypto.randomUUID(), orgId: session.orgId, actorId: session.userId,
    action, subject, details, occurredAt: new Date().toISOString(),
  });
}

function normalizeReference(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
}

function calculateInsurance(value, quantity) {
  if (!Number.isFinite(value) || !Number.isFinite(quantity)) return 0;
  return Math.round(value * 0.0125 * quantity * 100) / 100;
}

function listShipments(orgId) {
  return state.shipments.filter((shipment) => shipment.orgId === orgId);
}

function summaryFor(orgId) {
  if (state.summaryCache.has(orgId)) return state.summaryCache.get(orgId);
  const shipments = listShipments(orgId);
  const inventory = state.inventory.filter((item) => item.orgId === orgId);
  const summary = {
    openShipments: shipments.filter((item) => ['draft', 'ready'].includes(item.status)).length,
    dispatchedToday: shipments.filter((item) => item.dispatchedAt?.slice(0, 10) === '2026-08-30').length,
    lowStockItems: inventory.filter((item) => item.available <= organization(orgId).lowStockThreshold).length,
    inventoryUnits: inventory.reduce((total, item) => total + item.available, 0),
  };
  state.summaryCache.set(orgId, summary);
  return summary;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const resolved = path.resolve(PUBLIC_DIR, requested);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    sendError(res, 404, 'Not found');
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      sendError(res, 404, 'Not found');
      return;
    }
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' }[path.extname(resolved)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    const body = await readJson(req);
    const user = state.users.find((candidate) => candidate.username === body.username);
    if (user && !configuredAccessCode(user.orgId)) return sendError(res, 503, 'Workspace access is not configured');
    if (user && !accessCodeMatches(body.password, configuredAccessCode(user.orgId))) return sendError(res, 401, 'The username or password is incorrect');
    if (!user) return sendError(res, 401, 'The username or password is incorrect');
    if (!sessionKey()) return sendError(res, 503, 'Session security is not configured');
    const session = { userId: user.id, orgId: user.orgId, role: user.role, createdAt: Date.now() };
    const token = sealSession(session, activeState());
    return sendJson(res, 200, { user: publicUser(user), organization: organization(user.orgId) }, {
      'Set-Cookie': sessionCookie(req, token),
    });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/session') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', { clear: true }) });
  }

  if (req.method === 'POST' && url.pathname === '/api/internal/reset') {
    const resetToken = process.env.HARBORLINE_RESET_TOKEN;
    if (!resetToken) return sendError(res, 404, 'API route not found');
    if (!accessCodeMatches(bearerToken(req), resetToken)) return sendError(res, 403, 'Reset authorization failed');
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', { clear: true }) });
  }

  const session = requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = state.users.find((item) => item.id === session.userId);
    return sendJson(res, 200, { user: publicUser(user), organization: organization(session.orgId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    return sendJson(res, 200, { summary: summaryFor(session.orgId), recent: listShipments(session.orgId).slice(-4).reverse() });
  }

  if (req.method === 'GET' && url.pathname === '/api/shipments') {
    const status = url.searchParams.get('status');
    const shipments = listShipments(session.orgId).filter((item) => !status || item.status === status);
    return sendJson(res, 200, { shipments });
  }

  const shipmentMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)$/);
  if (req.method === 'GET' && shipmentMatch) {
    const shipment = state.shipments.find((item) => item.id === shipmentMatch[1]);
    if (!shipment) return sendError(res, 404, 'Shipment not found');
    return sendJson(res, 200, { shipment });
  }

  if (req.method === 'POST' && url.pathname === '/api/shipments') {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    const body = await readJson(req);
    const reference = normalizeReference(body.reference);
    const item = state.inventory.find((candidate) => candidate.id === body.itemId && candidate.orgId === session.orgId);
    const quantity = Number(body.quantity);
    const declaredValue = Number(body.declaredValue);
    if (!reference || !body.recipient || !item) return sendError(res, 400, 'Reference, recipient, and inventory item are required');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.available) return sendError(res, 400, 'Quantity must be a whole number within available stock');
    if (!Number.isFinite(declaredValue) || declaredValue < 0) return sendError(res, 400, 'Declared value must be zero or greater');
    if (state.shipments.some((candidate) => candidate.orgId === session.orgId && normalizeReference(candidate.reference) === reference)) {
      return sendError(res, 409, 'A shipment with this reference already exists');
    }
    state.sequence += 1;
    const shipment = {
      id: `shp-${state.sequence}`, orgId: session.orgId, reference, recipient: String(body.recipient).trim(),
      status: 'draft', service: body.service === 'express' ? 'express' : 'standard', itemId: item.id, quantity,
      declaredValue, insurance: Boolean(body.insurance), insuranceFee: body.insurance ? calculateInsurance(declaredValue, quantity) : 0,
      createdAt: new Date().toISOString(), dispatchedAt: null,
    };
    state.shipments.push(shipment);
    item.reserved += quantity;
    record(session, 'shipment.created', shipment.id, { reference: shipment.reference });
    return sendJson(res, 201, { shipment });
  }

  const dispatchMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)\/dispatch$/);
  if (req.method === 'POST' && dispatchMatch) {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    const shipment = state.shipments.find((item) => item.id === dispatchMatch[1] && item.orgId === session.orgId);
    if (!shipment) return sendError(res, 404, 'Shipment not found');
    if (shipment.status === 'cancelled' || shipment.status === 'delivered') return sendError(res, 409, 'Shipment cannot be dispatched from its current state');
    const item = state.inventory.find((candidate) => candidate.id === shipment.itemId);
    if (!item || item.available < shipment.quantity) return sendError(res, 409, 'There is not enough inventory to dispatch this shipment');
    item.available -= shipment.quantity;
    item.reserved = Math.max(0, item.reserved - shipment.quantity);
    shipment.status = 'dispatched';
    shipment.dispatchedAt = new Date().toISOString();
    record(session, 'shipment.dispatched', shipment.id);
    return sendJson(res, 200, { shipment });
  }

  const cancelMatch = url.pathname.match(/^\/api\/shipments\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    const shipment = state.shipments.find((item) => item.id === cancelMatch[1] && item.orgId === session.orgId);
    if (!shipment) return sendError(res, 404, 'Shipment not found');
    if (shipment.status === 'delivered') return sendError(res, 409, 'Delivered shipments cannot be cancelled');
    const item = state.inventory.find((candidate) => candidate.id === shipment.itemId);
    if (shipment.status === 'draft' && item) item.reserved = Math.max(0, item.reserved - shipment.quantity);
    if (shipment.status === 'dispatched' && item) item.available += shipment.quantity;
    shipment.status = 'cancelled';
    record(session, 'shipment.cancelled', shipment.id);
    return sendJson(res, 200, { shipment });
  }

  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    return sendJson(res, 200, { inventory: state.inventory.filter((item) => item.orgId === session.orgId) });
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/adjust') {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    const body = await readJson(req);
    const item = state.inventory.find((candidate) => candidate.id === body.itemId && candidate.orgId === session.orgId);
    const delta = Number(body.delta);
    if (!item) return sendError(res, 404, 'Inventory item not found');
    if (!Number.isFinite(delta) || delta === 0 || item.available + delta < 0) return sendError(res, 400, 'Adjustment is not valid');
    item.available += delta;
    state.adjustments.push({ id: crypto.randomUUID(), orgId: session.orgId, itemId: item.id, delta, reason: String(body.reason || '').trim(), at: new Date().toISOString() });
    record(session, 'inventory.adjusted', item.id, { delta });
    return sendJson(res, 200, { item });
  }

  if (req.method === 'GET' && url.pathname === '/api/team') {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    return sendJson(res, 200, { members: state.users.filter((item) => item.orgId === session.orgId).map(publicUser) });
  }

  const memberMatch = url.pathname.match(/^\/api\/team\/([^/]+)$/);
  if (req.method === 'PATCH' && memberMatch) {
    if (!requireRole(session, res, ['admin', 'operator'])) return;
    const body = await readJson(req);
    const member = state.users.find((item) => item.id === memberMatch[1] && item.orgId === session.orgId);
    if (!member) return sendError(res, 404, 'Team member not found');
    if (!['admin', 'operator', 'viewer'].includes(body.role)) return sendError(res, 400, 'Role is not valid');
    member.role = body.role;
    record(session, 'team.role_changed', member.id, { role: member.role });
    return sendJson(res, 200, { member: publicUser(member) });
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    if (!requireRole(session, res, ['admin'])) return;
    return sendJson(res, 200, { organization: organization(session.orgId) });
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    if (!requireRole(session, res, ['admin'])) return;
    const body = await readJson(req);
    const org = organization(session.orgId);
    if (body.timezone) org.timezone = String(body.timezone);
    if (body.lowStockThreshold !== undefined) {
      const threshold = Number(body.lowStockThreshold);
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 1000) return sendError(res, 400, 'Low-stock threshold is not valid');
      org.lowStockThreshold = threshold;
    }
    state.summaryCache.delete(session.orgId);
    record(session, 'organization.updated', org.id);
    return sendJson(res, 200, { organization: org });
  }

  if (req.method === 'GET' && url.pathname === '/api/reports/shipments.csv') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const rows = listShipments(session.orgId).filter((item) => {
      const day = item.createdAt.slice(0, 10);
      return (!from || day >= from) && (!to || day < to);
    });
    const header = ['Reference', 'Recipient', 'Status', 'Service', 'Quantity', 'Declared value', 'Created'];
    const lines = [header, ...rows.map((item) => [item.reference, item.recipient, item.status, item.service, item.quantity, item.declaredValue.toFixed(2), item.createdAt])];
    const csv = lines.map((line) => line.map(csvCell).join(',')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shipments.csv"',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(csv);
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (!requireRole(session, res, ['admin'])) return;
    return sendJson(res, 200, { events: state.audit.filter((item) => item.orgId === session.orgId).slice(0, 100) });
  }

  sendError(res, 404, 'API route not found');
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (!url.pathname.startsWith('/api/')) {
        serveStatic(req, res, url.pathname);
        return;
      }

      const startsFresh = req.method === 'POST' && url.pathname === '/api/session';
      const opened = startsFresh ? null : openSession(req);
      const appState = opened?.state || initialState();
      req.harborlineSession = opened?.session || null;
      const persists = Boolean(opened) && ['POST', 'PUT', 'PATCH'].includes(req.method)
        && url.pathname !== '/api/internal/reset';
      res.harborlineSessionContext = opened
        ? { req, session: opened.session, state: appState, persist: persists }
        : null;
      await requestState.run({ state: appState }, () => routeApi(req, res, url));
    } catch (error) {
      if (res.harborlineSessionContext) res.harborlineSessionContext.persist = false;
      sendError(res, 400, error.message || 'The request could not be completed');
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    process.stdout.write(`Harborline is listening on http://localhost:${PORT}\n`);
  });
}

module.exports = {
  createServer,
  resetState() {
    fallbackState = initialState();
  },
};
