import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.js';
import { Store, random } from './store.js';
import { Whoop, SCOPES, ENDPOINTS, AppError, dateRange } from './whoop.js';
import { answer } from './chat.js';

const root = new URL('../', import.meta.url);
const files = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/privacy': ['index.html', 'text/html'], '/privacy.css': ['privacy.css', 'text/css'] };
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(pair => pair.length === 2));
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'json_required');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new AppError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'invalid_json'); }
}

export function createApp(config, { store = new Store(config.databasePath, config.key), fetcher = fetch } = {}) {
  const whoop = new Whoop(config, store, fetcher);
  const sessionName = config.secure ? '__Host-whoop_session' : 'whoop_session';
  const bindingName = config.secure ? '__Host-whoop_oauth' : 'whoop_oauth';
  const rates = new Map(), busy = new Set();
  function limit(key, max, window = 60000) {
    const now = Date.now();
    for (const [id, row] of rates) if (row.until <= now) rates.delete(id);
    const row = rates.get(key) || { count: 0, until: now + window };
    rates.set(key, row);
    if (++row.count > max) throw new AppError(429, 'rate_limited');
  }
  const cookie = (name, value, age) => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const redirect = path => { res.writeHead(303, { Location: path }); res.end(); };
    let path = '';
    try {
      if (!req.url || req.url.length > 8192) throw new AppError(414, 'url_too_long');
      const url = new URL(req.url, config.origin); path = url.pathname;
      const jar = cookies(req);
      if (req.method === 'GET' && Object.hasOwn(files, path)) {
        const [file, type] = files[path];
        const content = await readFile(new URL(file, root));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      if (req.method === 'GET' && path === '/healthz') return send(200, { ok: true });
      if (req.method === 'GET' && path === '/callback.html') return redirect('/?error=old_callback');
      if (req.method === 'GET' && path === '/auth/whoop') {
        limit('oauth-start', 30, 600000);
        const binding = random();
        // WHOOP documents an eight-character state; browser binding adds 256 bits.
        const state = randomBytes(6).toString('base64url');
        store.beginOAuth(binding, state);
        res.setHeader('Set-Cookie', cookie(bindingName, binding, 600));
        const target = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state });
        return redirect(target.href);
      }
      if (req.method === 'GET' && path === '/auth/whoop/callback') {
        limit('oauth-callback', 60, 600000);
        res.setHeader('Set-Cookie', cookie(bindingName, '', 0));
        if (!store.consumeOAuth(jar[bindingName], url.searchParams.get('state'))) throw new AppError(400, 'invalid_oauth_state');
        if (url.searchParams.has('error')) return redirect('/?error=authorization_denied');
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) throw new AppError(400, 'invalid_oauth_code');
        // Serialize account authorization with refresh/revoke once identity is known.
        const tokens = await whoop.exchange(code);
        const profile = await whoop.raw(ENDPOINTS.profile, tokens.accessToken);
        if (typeof profile.email !== 'string' || profile.email.trim().toLowerCase() !== config.ownerEmail || !Number.isSafeInteger(profile.user_id)) throw new AppError(403, 'account_not_allowed');
        const userId = String(profile.user_id);
        await whoop.locked(userId, () => store.saveTokens(userId, tokens));
        store.logout(jar[sessionName]);
        const sid = store.newSession(userId);
        res.setHeader('Set-Cookie', [cookie(bindingName, '', 0), cookie(sessionName, sid, 7 * 86400)]);
        return redirect('/');
      }
      const session = store.session(jar[sessionName]);
      if (req.method === 'GET' && path === '/api/session') return send(200, { authenticated: Boolean(session), csrf: session?.csrf, chatAvailable: Boolean(config.openaiKey) });
      if (!session) throw new AppError(401, 'sign_in_required');
      limit(`api:${session.user_id}`, 120);
      if (req.method === 'POST') {
        if (req.headers.origin !== config.origin || !equal(req.headers['x-csrf-token'], session.csrf)) throw new AppError(403, 'csrf_failed');
      }
      if (req.method === 'POST' && path === '/api/logout') {
        store.logout(jar[sessionName]);
        res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/disconnect') {
        await whoop.disconnect(session.user_id);
        res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/forget') {
        await whoop.locked(session.user_id, () => store.deleteUser(session.user_id));
        res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
        return send(200, { ok: true, revokeInWhoop: true });
      }
      if (req.method === 'GET' && path.startsWith('/api/whoop/')) {
        const resource = path.slice('/api/whoop/'.length);
        const range = dateRange(url.searchParams);
        return send(200, { resource, range, data: await whoop.data(session.user_id, resource, range) });
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const body = await jsonBody(req);
        if (!body || body.consent !== true) throw new AppError(400, 'consent_required');
        const { messages, resources } = body;
        if (!Array.isArray(messages) || !messages.length || messages.length > 12 || messages.at(-1)?.role !== 'user' || messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000)) throw new AppError(400, 'invalid_messages');
        if (!Array.isArray(resources) || !resources.length || resources.length > 5 || new Set(resources).size !== resources.length || resources.some(r => !['recovery', 'cycles', 'sleep', 'workouts', 'body'].includes(r))) throw new AppError(400, 'invalid_resources');
        if (!config.openaiKey) throw new AppError(503, 'chat_not_configured');
        const range = dateRange(new URLSearchParams({ start: body.start || '', end: body.end || '' }));
        limit(`chat:${session.user_id}`, 10);
        limit(`daily-chat:${session.user_id}`, 100, 86400000);
        if (busy.has(session.user_id)) throw new AppError(429, 'chat_busy');
        busy.add(session.user_id);
        try {
          const snapshot = { range, fetchedAt: new Date().toISOString(), resources: {} };
          for (const resource of resources) {
            try { snapshot.resources[resource] = await whoop.data(session.user_id, resource, range); }
            catch (error) {
              if (![403, 404].includes(error.status)) throw error;
              snapshot.resources[resource] = { unavailable: error.code };
            }
          }
          const result = await answer(config, snapshot, messages.map(({ role, content }) => ({ role, content })), fetcher);
          return send(200, { ...result, sources: resources, range, fetchedAt: snapshot.fetchedAt });
        } finally { busy.delete(session.user_id); }
      }
      throw new AppError(404, 'not_found');
    } catch (error) {
      // Never log URLs, OAuth codes, upstream response bodies, prompts, or credentials.
      const status = error instanceof AppError ? error.status : 500;
      const code = error instanceof AppError ? error.code : 'internal_error';
      if (path === '/auth/whoop/callback') return redirect(`/?error=${encodeURIComponent(code)}`);
      if (status === 429) res.setHeader('Retry-After', '60');
      send(status, { error: code });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  const cleanup = setInterval(() => store.cleanup(), 600000).unref();
  server.on('close', () => clearInterval(cleanup));
  return { server, store, whoop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const config = readConfig();
    const { server, store } = createApp(config);
    server.listen(config.port, '0.0.0.0', () => console.log(`WHOOP app listening on port ${config.port}`));
    const stop = () => { server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
