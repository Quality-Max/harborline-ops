'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');

const northAccessCode = crypto.randomBytes(24).toString('hex');
const southAccessCode = crypto.randomBytes(24).toString('hex');
process.env.HARBORLINE_NORTH_ACCESS_CODE = northAccessCode;
process.env.HARBORLINE_SOUTH_ACCESS_CODE = southAccessCode;

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
  assert.equal(body.user.name, 'Mira Chen');
  assert.equal(body.organization.name, 'Northwind Supply Co.');

  const me = await request('/api/me', jsonOptions(cookie));
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.role, 'admin');
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

  const dispatched = await request(`/api/shipments/${created.body.shipment.id}/dispatch`, jsonOptions(cookie, 'POST', {}));
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
