'use strict';

const state = { user: null, organization: null, inventory: [], shipments: [] };
const titles = { dashboard: 'Overview', shipments: 'Shipments', inventory: 'Inventory', reports: 'Reports', team: 'Team', settings: 'Settings' };

const loginScreen = document.querySelector('#login-screen');
const appShell = document.querySelector('#app-shell');
const content = document.querySelector('#page-content');
const modal = document.querySelector('#modal');
modal.querySelector('[data-dialog-close]').addEventListener('click', () => modal.close());

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed');
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  document.querySelector('#toast-region').append(node);
  window.setTimeout(() => node.remove(), 3600);
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function pill(status) {
  return `<span class="pill pill-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function setIdentity() {
  document.querySelector('#org-name').textContent = state.organization.name;
  document.querySelector('#sidebar-name').textContent = state.user.name;
  document.querySelector('#sidebar-role').textContent = state.user.role;
  document.querySelector('#sidebar-avatar').textContent = initials(state.user.name);
  document.querySelectorAll('[data-view="team"]').forEach((node) => node.hidden = state.user.role === 'viewer');
  document.querySelectorAll('[data-view="settings"]').forEach((node) => node.hidden = state.user.role !== 'admin');
}

function showApp() {
  loginScreen.hidden = true;
  appShell.hidden = false;
  setIdentity();
  if (!location.hash) location.hash = '#dashboard';
  renderRoute();
}

function showLogin() {
  state.user = null;
  state.organization = null;
  appShell.hidden = true;
  loginScreen.hidden = false;
  document.querySelector('#login-form input').focus();
}

function setPage(view) {
  document.querySelector('#page-title').textContent = titles[view] || titles.dashboard;
  document.querySelectorAll('.sidebar nav a').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  document.querySelector('#topbar-actions').innerHTML = '';
}

async function renderDashboard() {
  const { summary, recent } = await api('/api/dashboard');
  content.innerHTML = `
    <div class="stats-grid">
      <article class="stat-card"><span>Open shipments</span><strong>${summary.openShipments}</strong></article>
      <article class="stat-card"><span>Dispatched today</span><strong>${summary.dispatchedToday}</strong></article>
      <article class="stat-card"><span>Inventory units</span><strong>${summary.inventoryUnits}</strong></article>
      <article class="stat-card"><span>Low-stock items</span><strong>${summary.lowStockItems}</strong></article>
    </div>
    <section class="panel">
      <header class="panel-header"><h2>Recent shipments</h2><a href="#shipments" class="button button-secondary button-small">View all</a></header>
      ${shipmentTable(recent, false)}
    </section>`;
}

function shipmentTable(shipments, actions = true) {
  if (!shipments.length) return '<div class="empty">No shipments match this view.</div>';
  return `<table class="data-table">
    <thead><tr><th>Reference</th><th>Recipient</th><th>Status</th><th>Service</th><th>Qty</th><th>Created</th>${actions ? '<th></th>' : ''}</tr></thead>
    <tbody>${shipments.map((shipment) => `<tr data-testid="shipment-row">
      <td class="mono">${escapeHtml(shipment.reference)}</td>
      <td>${escapeHtml(shipment.recipient)}</td>
      <td>${pill(shipment.status)}</td>
      <td>${escapeHtml(shipment.service)}</td>
      <td>${shipment.quantity}</td>
      <td class="muted">${formatDate(shipment.createdAt)}</td>
      ${actions ? `<td><div class="table-actions">
        ${shipment.status === 'draft' ? `<button class="button button-secondary button-small" data-dispatch="${shipment.id}">Dispatch</button>` : ''}
        ${shipment.status !== 'delivered' && shipment.status !== 'cancelled' ? `<button class="button button-danger button-small" data-cancel="${shipment.id}">Cancel</button>` : ''}
      </div></td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;
}

async function renderShipments() {
  const { shipments } = await api('/api/shipments');
  state.shipments = shipments;
  if (['admin', 'operator'].includes(state.user.role)) {
    document.querySelector('#topbar-actions').innerHTML = '<button id="new-shipment" class="button button-primary">New shipment</button>';
    document.querySelector('#new-shipment').addEventListener('click', openShipmentModal);
  }
  content.innerHTML = `<div class="page-heading"><div><h2>All shipments</h2><p>Track orders from preparation through delivery.</p></div>
    <label>Filter status<select id="shipment-filter"><option value="">All statuses</option><option>draft</option><option>dispatched</option><option>delivered</option><option>cancelled</option></select></label></div>
    <section id="shipment-panel" class="panel">${shipmentTable(shipments)}</section>`;
  document.querySelector('#shipment-filter').addEventListener('change', (event) => {
    const visible = state.shipments.filter((item) => !event.target.value || item.status === event.target.value);
    document.querySelector('#shipment-panel').innerHTML = shipmentTable(visible);
    bindShipmentActions();
  });
  bindShipmentActions();
}

function bindShipmentActions() {
  document.querySelectorAll('[data-dispatch]').forEach((button) => button.addEventListener('click', () => updateShipment(button.dataset.dispatch, 'dispatch')));
  document.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => updateShipment(button.dataset.cancel, 'cancel')));
}

async function updateShipment(id, action) {
  try {
    await api(`/api/shipments/${id}/${action}`, { method: 'POST', body: '{}' });
    toast(action === 'dispatch' ? 'Shipment dispatched.' : 'Shipment cancelled.');
    await renderShipments();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openShipmentModal() {
  const { inventory } = await api('/api/inventory');
  modal.querySelector('#modal-eyebrow').textContent = 'Shipping';
  modal.querySelector('#modal-title').textContent = 'Create shipment';
  modal.querySelector('#modal-content').innerHTML = `<form id="shipment-form" class="form-grid">
    <label>Reference<input name="reference" required placeholder="HL-24064"></label>
    <label>Recipient<input name="recipient" required></label>
    <label class="wide">Inventory item<select name="itemId" required><option value="">Select an item</option>${inventory.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${item.available} available</option>`).join('')}</select></label>
    <label>Quantity<input name="quantity" type="number" min="1" step="1" required></label>
    <label>Declared value<input name="declaredValue" type="number" min="0" step="0.01" required></label>
    <label>Service<select name="service"><option value="standard">Standard</option><option value="express">Express</option></select></label>
    <label class="checkbox"><input name="insurance" type="checkbox"> Add shipment insurance</label>
    <div class="modal-actions wide"><button type="button" class="button button-secondary" data-close>Cancel</button><button class="button button-primary" type="submit">Create shipment</button></div>
  </form>`;
  modal.showModal();
  modal.querySelector('[data-close]').addEventListener('click', () => modal.close());
  modal.querySelector('#shipment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/shipments', { method: 'POST', body: JSON.stringify({
        reference: form.get('reference'), recipient: form.get('recipient'), itemId: form.get('itemId'),
        quantity: Number(form.get('quantity')), declaredValue: Number(form.get('declaredValue')),
        service: form.get('service'), insurance: form.get('insurance') === 'on',
      }) });
      modal.close();
      toast('Shipment created.');
      await renderShipments();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderInventory() {
  const { inventory } = await api('/api/inventory');
  state.inventory = inventory;
  content.innerHTML = `<div class="page-heading"><div><h2>Current stock</h2><p>Available and reserved units across this workspace.</p></div></div>
    <section class="panel"><table class="data-table"><thead><tr><th>Item</th><th>Available</th><th>Reserved</th>${state.user.role !== 'viewer' ? '<th></th>' : ''}</tr></thead>
    <tbody>${inventory.map((item) => `<tr><td><div class="inventory-name"><strong>${escapeHtml(item.name)}</strong><span class="mono">${escapeHtml(item.sku)}</span></div></td>
      <td><div class="stock-meter"><span>${item.available}</span><span class="meter"><i style="width:${Math.min(100, item.available)}%"></i></span></div></td><td>${item.reserved}</td>
      ${state.user.role !== 'viewer' ? `<td><div class="table-actions"><button class="button button-secondary button-small" data-adjust="${item.id}">Adjust</button></div></td>` : ''}</tr>`).join('')}</tbody></table></section>`;
  document.querySelectorAll('[data-adjust]').forEach((button) => button.addEventListener('click', () => openAdjustmentModal(button.dataset.adjust)));
}

function openAdjustmentModal(itemId) {
  const item = state.inventory.find((candidate) => candidate.id === itemId);
  modal.querySelector('#modal-eyebrow').textContent = 'Inventory';
  modal.querySelector('#modal-title').textContent = `Adjust ${item.name}`;
  modal.querySelector('#modal-content').innerHTML = `<form id="adjustment-form" class="stack">
    <div class="notice">Current available quantity: <strong>${item.available}</strong></div>
    <label>Quantity change<input name="delta" type="number" step="1" required placeholder="Use a negative number to remove stock"></label>
    <label>Reason<input name="reason" required></label>
    <div class="modal-actions"><button type="button" class="button button-secondary" data-close>Cancel</button><button class="button button-primary" type="submit">Save adjustment</button></div>
  </form>`;
  modal.showModal();
  modal.querySelector('[data-close]').addEventListener('click', () => modal.close());
  modal.querySelector('#adjustment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/inventory/adjust', { method: 'POST', body: JSON.stringify({ itemId, delta: Number(form.get('delta')), reason: form.get('reason') }) });
      modal.close(); toast('Inventory updated.'); await renderInventory();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderReports() {
  content.innerHTML = `<section class="panel report-card"><p class="eyebrow">Shipment activity</p><h2>Export shipment report</h2>
    <p>Download a CSV file for reconciliation or handoff to another operations team.</p>
    <form id="report-form" class="form-grid"><label>From date<input name="from" type="date" required value="2026-08-28"></label>
      <label>To date<input name="to" type="date" required value="2026-08-30"></label>
      <div class="modal-actions wide"><button class="button button-primary" type="submit">Download CSV</button></div></form></section>`;
  document.querySelector('#report-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    location.href = `/api/reports/shipments.csv?from=${encodeURIComponent(form.get('from'))}&to=${encodeURIComponent(form.get('to'))}`;
  });
}

async function renderTeam() {
  const { members } = await api('/api/team');
  content.innerHTML = `<div class="page-heading"><div><h2>Workspace members</h2><p>Manage who can view and update operations data.</p></div></div>
    <section class="panel"><table class="data-table"><thead><tr><th>Member</th><th>Username</th><th>Role</th><th></th></tr></thead><tbody>
      ${members.map((member) => `<tr><td><strong>${escapeHtml(member.name)}</strong></td><td class="mono">${escapeHtml(member.username)}</td><td>${pill(member.role)}</td><td><div class="table-actions">
        <select data-role-for="${member.id}" aria-label="Role for ${escapeHtml(member.name)}"><option ${member.role === 'viewer' ? 'selected' : ''}>viewer</option><option ${member.role === 'operator' ? 'selected' : ''}>operator</option><option ${member.role === 'admin' ? 'selected' : ''}>admin</option></select>
      </div></td></tr>`).join('')}</tbody></table></section>`;
  document.querySelectorAll('[data-role-for]').forEach((select) => select.addEventListener('change', async () => {
    try {
      await api(`/api/team/${select.dataset.roleFor}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      toast('Member role updated.');
    } catch (error) { toast(error.message, 'error'); await renderTeam(); }
  }));
}

async function renderSettings() {
  const { organization } = await api('/api/settings');
  content.innerHTML = `<section class="panel report-card"><p class="eyebrow">Workspace preferences</p><h2>Operations settings</h2>
    <p>Configure the timezone used for reporting and when stock should be highlighted for replenishment.</p>
    <form id="settings-form" class="form-grid"><label class="wide">Timezone<select name="timezone">
      ${['Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore'].map((zone) => `<option ${zone === organization.timezone ? 'selected' : ''}>${zone}</option>`).join('')}
      </select></label><label>Low-stock threshold<input name="lowStockThreshold" type="number" min="0" max="1000" step="1" value="${organization.lowStockThreshold}"></label>
      <div class="modal-actions wide"><button class="button button-primary" type="submit">Save settings</button></div></form></section>`;
  document.querySelector('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ timezone: form.get('timezone'), lowStockThreshold: Number(form.get('lowStockThreshold')) }) });
      state.organization = result.organization; toast('Settings saved.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderRoute() {
  let view = location.hash.replace('#', '') || 'dashboard';
  if (view === 'team' && state.user.role === 'viewer') view = 'dashboard';
  if (view === 'settings' && state.user.role !== 'admin') view = 'dashboard';
  setPage(view);
  content.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const renderers = { dashboard: renderDashboard, shipments: renderShipments, inventory: renderInventory, reports: renderReports, team: renderTeam, settings: renderSettings };
    await (renderers[view] || renderDashboard)();
    content.focus({ preventScroll: true });
  } catch (error) {
    if (error.message === 'Sign in is required') showLogin();
    else content.innerHTML = `<div class="notice">${escapeHtml(error.message)}</div>`;
  }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  document.querySelector('#login-error').textContent = '';
  try {
    const result = await api('/api/session', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
    state.user = result.user; state.organization = result.organization; showApp();
  } catch (error) { document.querySelector('#login-error').textContent = error.message; }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  await api('/api/session', { method: 'DELETE' });
  showLogin();
});

window.addEventListener('hashchange', () => { if (state.user) renderRoute(); });

(async function bootstrap() {
  try {
    const result = await api('/api/me');
    state.user = result.user; state.organization = result.organization; showApp();
  } catch { showLogin(); }
})();
