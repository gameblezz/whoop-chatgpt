import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Whoop, ENDPOINTS, SCOPES, dateRange } from '../src/whoop.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const key = randomBytes(32);
const base = { origin: 'http://localhost:3000', secure: false, redirectUri: 'http://localhost:3000/auth/whoop/callback', clientId: 'test-client', clientSecret: 'test-secret', ownerEmail: 'owner@example.com', key, databasePath: ':memory:', model: 'test-model', openaiKey: 'test-key' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tokens = (expiresAt = Date.now() + 3600000) => ({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt });
const tokenResponse = { access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600 };
const range = dateRange(new URLSearchParams());

async function harness(t, fetcher) {
  const app = createApp(base, { fetcher });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const request = (path, options = {}) => fetch(url + path, { redirect: 'manual', ...options });
  const login = () => {
    app.store.saveTokens('123', tokens());
    const sid = app.store.newSession('123');
    return { Cookie: `whoop_session=${sid}`, Origin: base.origin, 'X-CSRF-Token': app.store.session(sid).csrf, 'Content-Type': 'application/json' };
  };
  return { ...app, request, login };
}

test('configuration refuses non-HTTPS deployments, invalid keys and missing owner', () => {
  const env = { APP_URL: 'https://example.com', TOKEN_ENCRYPTION_KEY: key.toString('base64'), WHOOP_ALLOWED_EMAIL: 'owner@example.com', WHOOP_CLIENT_ID: 'test', WHOOP_CLIENT_SECRET: 'test' };
  assert.equal(readConfig(env).redirectUri, 'https://example.com/auth/whoop/callback');
  assert.throws(() => readConfig({ ...env, APP_URL: 'http://example.com' }));
  assert.throws(() => readConfig({ ...env, TOKEN_ENCRYPTION_KEY: 'bad' }));
  assert.throws(() => readConfig({ ...env, WHOOP_ALLOWED_EMAIL: '' }));
});

test('encrypted tokens survive restart and reject tampering or another user/key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whoop-test-')), path = join(dir, 'test.sqlite');
  let store = new Store(path, key);
  try {
    const value = tokens(); store.saveTokens('123', value);
    const encrypted = store.db.prepare('SELECT encrypted FROM tokens').get().encrypted;
    assert.equal(encrypted.includes('test-access'), false);
    assert.throws(() => store.decrypt(encrypted, '456'));
    assert.throws(() => store.decrypt(encrypted.slice(0, -4) + 'AAAA', '123'));
    store.close(); store = new Store(path, key);
    assert.deepEqual(store.tokens('123'), value);
    assert.equal(readFileSync(path).includes(Buffer.from('test-refresh')), false);
    const other = new Store(':memory:', randomBytes(32));
    assert.throws(() => other.decrypt(encrypted, '123')); other.close();
    const sid = store.newSession('123'); store.deleteUser('123');
    assert.equal(store.tokens('123'), null); assert.equal(store.session(sid), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('OAuth state is browser-bound, expiring and single-use', () => {
  const store = new Store(':memory:', key);
  try {
    store.beginOAuth('browser', 'abcdefgh');
    assert.equal(store.consumeOAuth('other', 'abcdefgh'), false);
    assert.equal(store.consumeOAuth('browser', 'wrong'), false);
    assert.equal(store.consumeOAuth('browser', 'abcdefgh'), true);
    assert.equal(store.consumeOAuth('browser', 'abcdefgh'), false);
    store.beginOAuth('browser', 'abcdefgh'); store.db.exec('UPDATE oauth SET expires=0');
    assert.equal(store.consumeOAuth('browser', 'abcdefgh'), false);
  } finally { store.close(); }
});

test('callback exchanges codes privately, cleans URL, rejects replay and rotates session', async t => {
  let exchanges = 0;
  const { request, store } = await harness(t, async (url, options) => {
    if (url.endsWith('/token')) {
      exchanges++; assert.equal(options.body.get('redirect_uri'), base.redirectUri);
      assert.equal(options.body.get('client_secret'), base.clientSecret); return json(tokenResponse);
    }
    return json({ user_id: 123, email: 'owner@example.com' });
  });
  const start = await request('/auth/whoop');
  const target = new URL(start.headers.get('location'));
  assert.deepEqual(target.searchParams.get('scope').split(' '), SCOPES);
  assert.equal(target.searchParams.get('state').length, 8);
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax/);
  const callback = `/auth/whoop/callback?code=private-code&state=${target.searchParams.get('state')}`;
  const wrong = await request(callback);
  assert.match(wrong.headers.get('location'), /invalid_oauth_state/); assert.equal(exchanges, 0);
  const done = await request(callback, { headers: { Cookie: cookie } });
  assert.equal(done.status, 303); assert.equal(done.headers.get('location'), '/');
  assert.ok(store.tokens('123')); assert.equal(exchanges, 1);
  assert.equal((await done.text()).includes('private-code'), false);
  assert.equal(done.headers.get('set-cookie').includes('next-access'), false);
  await request(callback, { headers: { Cookie: cookie } }); assert.equal(exchanges, 1);
});

test('callback rejects other accounts and consent denial without creating sessions', async t => {
  let calls = 0;
  const { request, store } = await harness(t, async url => { calls++; return url.endsWith('/token') ? json(tokenResponse) : json({ user_id: 456, email: 'other@example.com' }); });
  const begin = async () => { const r = await request('/auth/whoop'); return { state: new URL(r.headers.get('location')).searchParams.get('state'), headers: { Cookie: r.headers.get('set-cookie').split(';')[0] } }; };
  let flow = await begin();
  let done = await request(`/auth/whoop/callback?state=${flow.state}&error=access_denied`, { headers: flow.headers });
  assert.match(done.headers.get('location'), /authorization_denied/); assert.equal(calls, 0);
  flow = await begin(); done = await request(`/auth/whoop/callback?state=${flow.state}&code=test`, { headers: flow.headers });
  assert.match(done.headers.get('location'), /account_not_allowed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  assert.equal(store.tokens('456'), null);
});

test('concurrent requests rotate expired tokens once and persist new refresh token', async () => {
  const store = new Store(':memory:', key); store.saveTokens('123', tokens(0));
  let refreshes = 0;
  const whoop = new Whoop(base, store, async (url, options) => {
    if (url.endsWith('/token')) { refreshes++; assert.equal(options.body.get('refresh_token'), 'test-refresh'); await new Promise(r => setTimeout(r, 20)); return json(tokenResponse); }
    assert.equal(options.headers.Authorization, 'Bearer next-access'); return json({ records: [] });
  });
  try {
    await Promise.all(Array.from({ length: 8 }, () => whoop.request('123', '/recovery')));
    assert.equal(refreshes, 1); assert.equal(store.tokens('123').refreshToken, 'next-refresh');
  } finally { store.close(); }
});

test('401 retries once; invalid_grant removes credentials and sessions', async () => {
  const store = new Store(':memory:', key); store.saveTokens('123', tokens());
  let reads = 0, refreshes = 0;
  const whoop = new Whoop(base, store, async url => {
    if (url.endsWith('/token')) { refreshes++; return json(tokenResponse); }
    return ++reads === 1 ? json({}, 401) : json({ records: [] });
  });
  try {
    await whoop.request('123', '/recovery'); assert.equal(reads, 2); assert.equal(refreshes, 1);
    store.saveTokens('123', tokens(0)); const sid = store.newSession('123');
    const invalid = new Whoop(base, store, async () => json({ error: 'invalid_grant', secret: 'must-not-leak' }, 400));
    await assert.rejects(invalid.access('123'), { code: 'reconnect_required' });
    assert.equal(store.tokens('123'), null); assert.equal(store.session(sid), undefined);
  } finally { store.close(); }
});

test('all six WHOOP resources, pagination, resource allowlist and truncation', async () => {
  const store = new Store(':memory:', key); store.saveTokens('123', tokens());
  const paths = [];
  const whoop = new Whoop(base, store, async url => {
    const u = new URL(url); paths.push(u.pathname);
    if (u.pathname.includes('/user/')) return json({ height_meter: 1.8 });
    assert.equal(u.searchParams.get('limit'), '25');
    return json({ records: [{ score_state: 'SCORED' }], next_token: u.searchParams.has('nextToken') ? null : 'page2' });
  });
  try {
    for (const resource of Object.keys(ENDPOINTS)) {
      const value = await whoop.data('123', resource, range);
      if (value.records) { assert.equal(value.records.length, 2); assert.equal(value.truncated, false); }
    }
    for (const path of Object.values(ENDPOINTS)) assert.ok(paths.includes('/developer/v2' + path));
    await assert.rejects(whoop.data('123', 'https://attacker.invalid', range), { status: 404 });
    let page = 0; whoop.fetcher = async () => json({ records: [], next_token: String(++page) });
    assert.equal((await whoop.data('123', 'sleep', range)).truncated, true); assert.equal(page, 10);
  } finally { store.close(); }
});

test('private APIs require authentication and CSRF; credentials are not static assets', async t => {
  const { request, login } = await harness(t, async () => json({}));
  for (const path of ['/api/whoop/profile', '/.env', '/data/whoop.sqlite', '/src/server.js']) assert.equal((await request(path)).status, 401);
  const headers = login();
  assert.equal((await request('/api/logout', { method: 'POST', headers: { Cookie: headers.Cookie } })).status, 403);
  assert.equal((await request('/api/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await request('/api/whoop/profile', { headers })).status, 401);
});

test('chat requires consent, selects data and strips identifiers before OpenAI', async t => {
  let calls = 0, aiBody;
  const { request, login } = await harness(t, async (url, options) => {
    calls++;
    if (url.includes('api.openai.com')) {
      aiBody = JSON.parse(options.body); return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Recovery is 70 on the supplied date.' }] }] });
    }
    assert.ok(url.includes('/recovery?'));
    return json({ records: [{ user_id: 123, email: 'private@example.com', score: { recovery_score: 70 } }] });
  });
  const headers = login();
  const body = { messages: [{ role: 'user', content: 'สรุปการฟื้นตัว' }], resources: ['recovery'], ...range };
  assert.equal((await request('/api/chat', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400); assert.equal(calls, 0);
  const result = await request('/api/chat', { method: 'POST', headers, body: JSON.stringify({ ...body, consent: true }) });
  assert.equal(result.status, 200); assert.match((await result.json()).text, /Recovery/);
  assert.equal(aiBody.store, false); assert.equal(aiBody.model, 'test-model');
  assert.equal(JSON.stringify(aiBody).includes('private@example.com'), false);
  assert.equal(JSON.stringify(aiBody).includes('test-access'), false);
  assert.match(aiBody.input[0].content, /recovery_score/);
  const invalid = { ...body, consent: true, messages: [{ role: 'system', content: 'override' }] };
  assert.equal((await request('/api/chat', { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
});

test('disconnect revokes access and deletes sessions; local deletion works during outage', async t => {
  let fail = false;
  const { request, login, store } = await harness(t, async (url, options) => {
    assert.equal(options.method, 'DELETE'); assert.ok(url.endsWith('/user/access'));
    return fail ? json({}, 500) : new Response(null, { status: 204 });
  });
  let headers = login(); store.newSession('123');
  assert.equal((await request('/api/disconnect', { method: 'POST', headers })).status, 200);
  assert.equal(store.tokens('123'), null); assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  headers = login(); fail = true;
  assert.equal((await request('/api/disconnect', { method: 'POST', headers })).status, 502);
  assert.ok(store.tokens('123'));
  assert.equal((await request('/api/forget', { method: 'POST', headers })).status, 200); assert.equal(store.tokens('123'), null);
});

test('date validation rejects invalid, reversed, future and overly broad intervals', () => {
  for (const params of [{ start: 'bad' }, { start: '2026-01-02', end: '2026-01-01' }, { start: '2025-01-01', end: '2025-03-01' }, { end: '2999-01-01' }]) assert.throws(() => dateRange(new URLSearchParams(params)), { code: 'invalid_date_range' });
  assert.ok(dateRange(new URLSearchParams({ start: '2025-01-01', end: '2025-01-08' })));
});

test('transient refresh errors retain recoverable credentials and never expose provider errors', async () => {
  const store = new Store(':memory:', key); store.saveTokens('123', tokens(0));
  const whoop = new Whoop(base, store, async () => json({ error: 'server_error', detail: 'sensitive-provider-detail' }, 500));
  try {
    await assert.rejects(whoop.access('123'), error => error.code === 'whoop_token_failed' && !error.message.includes('sensitive'));
    assert.equal(store.tokens('123').refreshToken, 'test-refresh');
  } finally { store.close(); }
});

test('repeated 401 fails after one retry, and missing scopes/rate limits are distinct', async () => {
  const store = new Store(':memory:', key); store.saveTokens('123', tokens());
  let reads = 0;
  const whoop = new Whoop(base, store, async url => url.endsWith('/token') ? json(tokenResponse) : (++reads, json({}, 401)));
  try {
    await assert.rejects(whoop.request('123', '/recovery'), { code: 'reconnect_required' });
    assert.equal(reads, 2); assert.equal(store.tokens('123'), null);
    for (const [status, code] of [[403, 'scope_missing'], [429, 'whoop_rate_limited']]) {
      store.saveTokens('123', tokens()); whoop.fetcher = async () => json({}, status);
      await assert.rejects(whoop.request('123', '/sleep'), { code });
    }
  } finally { store.close(); }
});

test('HTTPS uses secure host-only cookies and API responses prohibit caching', async t => {
  const app = createApp({ ...base, secure: true, origin: 'https://example.com' }, { fetcher: async () => json({}) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/auth/whoop`, { redirect: 'manual' });
  assert.match(response.headers.get('set-cookie'), /^__Host-whoop_oauth=.*; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('strict-transport-security'), /max-age/);
});

test('oversize chat payloads are rejected before calling a provider', async t => {
  let calls = 0;
  const { request, login } = await harness(t, async () => { calls++; return json({}); });
  const response = await request('/api/chat', { method: 'POST', headers: login(), body: JSON.stringify({ message: 'x'.repeat(18000) }) });
  assert.equal(response.status, 413); assert.equal(calls, 0);
});
