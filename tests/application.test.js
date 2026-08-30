'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');

const northAccessCode = crypto.randomBytes(24).toString('hex');
const southAccessCode = crypto.randomBytes(24).toString('hex');
const sessionSecret = crypto.randomBytes(32).toString('hex');
const resetToken = crypto.randomBytes(32).toString('hex');
process.env.HARBORLINE_NORTH_ACCESS_CODE = northAccessCode;
process.env.HARBORLINE_SOUTH_ACCESS_CODE = southAccessCode;
process.env.HARBORLINE_SESSION_SECRET = sessionSecret;
process.env.HARBORLINE_RESET_TOKEN = resetToken;

const { createServer, resetState } = require('../server');

let server;
let origin;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => resetState());

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { response, body };
}

async function login(username = 'mira', accessCode = northAccessCode) {
  const { response, body } = await request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: accessCode }),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], body };
}

function jsonOptions(cookie, method = 'GET', body) {
  return {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
}

test('health endpoint is available without authentication', async () => {
  const { response, body } = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('the application shell is served from the public directory', async () => {
  const { response, body } = await request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(body, /Harborline/);

  const source = await request('/server.js');
  assert.equal(source.response.status, 404);
});

test('protected routes require a session', async () => {
  const { response, body } = await request('/api/dashboard');
  assert.equal(response.status, 401);
  assert.equal(body.error, 'Sign in is required');
});

test('a workspace member can sign in and view their organization', async () => {
  const { cookie, body } = await login();
  assert.ok(Buffer.byteLength(cookie) < 3800);
  assert.equal(body.user.name, 'Mira Chen');
  assert.equal(body.organization.name, 'Northwind Supply Co.');

  const me = await request('/api/me', jsonOptions(cookie));
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.role, 'admin');
});

test('session state is encrypted and remains portable between server instances', async () => {
  const { cookie } = await login('leo');
  assert.doesNotMatch(cookie, /Mira|Leo|Northwind|HL-24061/);

  const created = await request('/api/shipments', jsonOptions(cookie, 'POST', {
    reference: 'HL-PORTABLE', recipient: 'Copper & Pine', itemId: 'sku-notebook',
    quantity: 1, declaredValue: 14.95, service: 'standard', insurance: false,
  }));
  assert.equal(created.response.status, 201);
  const updatedCookie = created.response.headers.get('set-cookie').split(';')[0];

  resetState();
  const shipments = await request('/api/shipments', jsonOptions(updatedCookie));
  assert.equal(shipments.response.status, 200);
  assert.ok(shipments.body.shipments.some((shipment) => shipment.reference === 'HL-PORTABLE'));
});

test('tampered session data is rejected', async () => {
  const { cookie } = await login();
  const last = cookie.at(-1);
  const tampered = `${cookie.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;
  const { response, body } = await request('/api/dashboard', jsonOptions(tampered));
  assert.equal(response.status, 401);
  assert.equal(body.error, 'Sign in is required');
});

test('expired session data is rejected by the server', async () => {
  const { cookie } = await login();
  const currentNow = Date.now;
  Date.now = () => currentNow() + (13 * 60 * 60 * 1000);
  try {
    const { response, body } = await request('/api/dashboard', jsonOptions(cookie));
    assert.equal(response.status, 401);
    assert.equal(body.error, 'Sign in is required');
  } finally {
    Date.now = currentNow;
  }
});

test('secure deployments mark session cookies as Secure', async () => {
  const { response } = await request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username: 'mira', password: northAccessCode }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure;/);
});

test('invalid credentials are rejected', async () => {
  const { response, body } = await request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mira', password: crypto.randomBytes(24).toString('hex') }),
  });
  assert.equal(response.status, 401);
  assert.match(body.error, /incorrect/);
});

test('login fails closed when workspace access is not configured', async () => {
  const configuredCode = process.env.HARBORLINE_NORTH_ACCESS_CODE;
  delete process.env.HARBORLINE_NORTH_ACCESS_CODE;
  try {
    const { response, body } = await request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mira', password: northAccessCode }),
    });
    assert.equal(response.status, 503);
    assert.match(body.error, /not configured/);
  } finally {
    process.env.HARBORLINE_NORTH_ACCESS_CODE = configuredCode;
  }
});

test('login fails closed when session security is not configured', async () => {
  delete process.env.HARBORLINE_SESSION_SECRET;
  try {
    const { response, body } = await request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mira', password: northAccessCode }),
    });
    assert.equal(response.status, 503);
    assert.match(body.error, /not configured/);
  } finally {
    process.env.HARBORLINE_SESSION_SECRET = sessionSecret;
  }
});

test('the protected reset clears the browser session', async () => {
  const { cookie } = await login();
  const reset = await request('/api/internal/reset', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resetToken}`, Cookie: cookie },
  });
  assert.equal(reset.response.status, 200);
  assert.match(reset.response.headers.get('set-cookie'), /Max-Age=0/);

  const clearedCookie = reset.response.headers.get('set-cookie').split(';')[0];
  const dashboard = await request('/api/dashboard', jsonOptions(clearedCookie));
  assert.equal(dashboard.response.status, 401);
});

test('the reset endpoint rejects missing authorization', async () => {
  const { response } = await request('/api/internal/reset', { method: 'POST' });
  assert.equal(response.status, 403);
});

test('shipment list contains only the signed-in organization', async () => {
  const { cookie } = await login('nora', southAccessCode);
  const { response, body } = await request('/api/shipments', jsonOptions(cookie));
  assert.equal(response.status, 200);
  assert.equal(body.shipments.length, 1);
  assert.equal(body.shipments[0].reference, 'BF-89014');
});

test('an operator can create and dispatch a shipment', async () => {
  const { cookie } = await login('leo');
  const created = await request('/api/shipments', jsonOptions(cookie, 'POST', {
    reference: 'HL-24070', recipient: 'Copper & Pine', itemId: 'sku-notebook',
    quantity: 4, declaredValue: 59.8, service: 'express', insurance: false,
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.shipment.status, 'draft');
  const updatedCookie = created.response.headers.get('set-cookie').split(';')[0];

  const dispatched = await request(`/api/shipments/${created.body.shipment.id}/dispatch`, jsonOptions(updatedCookie, 'POST', {}));
  assert.equal(dispatched.response.status, 200);
  assert.equal(dispatched.body.shipment.status, 'dispatched');
});

test('duplicate shipment references are rejected', async () => {
  const { cookie } = await login();
  const duplicate = await request('/api/shipments', jsonOptions(cookie, 'POST', {
    reference: ' hl 24061 ', recipient: 'Juniper Coffee', itemId: 'sku-canvas',
    quantity: 1, declaredValue: 29.99, service: 'standard', insurance: false,
  }));
  assert.equal(duplicate.response.status, 409);
});

test('a viewer cannot change inventory', async () => {
  const { cookie } = await login('sana');
  const result = await request('/api/inventory/adjust', jsonOptions(cookie, 'POST', {
    itemId: 'sku-canvas', delta: 5, reason: 'Cycle count',
  }));
  assert.equal(result.response.status, 403);
});

test('an administrator can update workspace settings', async () => {
  const { cookie } = await login();
  const result = await request('/api/settings', jsonOptions(cookie, 'PATCH', {
    timezone: 'Europe/London', lowStockThreshold: 15,
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.organization.timezone, 'Europe/London');
  assert.equal(result.body.organization.lowStockThreshold, 15);
});

test('shipment reports are returned as CSV', async () => {
  const { cookie } = await login();
  const { response, body } = await request('/api/reports/shipments.csv?from=2026-08-28&to=2026-08-31', jsonOptions(cookie));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(body, /HL-24061/);
  assert.match(body, /HL-24063/);
});
