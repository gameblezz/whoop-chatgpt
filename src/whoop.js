export const SCOPES = ['offline', 'read:recovery', 'read:cycles', 'read:sleep', 'read:workout', 'read:profile', 'read:body_measurement'];
export const ENDPOINTS = Object.freeze({ recovery: '/recovery', cycles: '/cycle', sleep: '/activity/sleep', workouts: '/activity/workout', profile: '/user/profile/basic', body: '/user/measurement/body' });
const API = 'https://api.prod.whoop.com/developer/v2';
const TOKEN = 'https://api.prod.whoop.com/oauth/oauth2/token';

export class AppError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export class Whoop {
  constructor(config, store, fetcher = fetch) { this.config = config; this.store = store; this.fetcher = fetcher; this.locks = new Map(); }
  async locked(userId, work) {
    const previous = this.locks.get(userId) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    this.locks.set(userId, result);
    try { return await result; } finally { if (this.locks.get(userId) === result) this.locks.delete(userId); }
  }
  async tokenRequest(fields) {
    let response;
    try {
      response = await this.fetcher(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...fields, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
        signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch { throw new AppError(502, 'whoop_unavailable'); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.error === 'invalid_grant') throw new AppError(401, 'reconnect_required');
      throw new AppError(response.status === 429 ? 429 : 502, 'whoop_token_failed');
    }
    const body = await response.json();
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new AppError(502, 'invalid_token_response');
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
  }
  exchange(code) { return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri }); }
  async raw(path, token, method = 'GET') {
    let response;
    try { response = await this.fetcher(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new AppError(502, 'whoop_unavailable'); }
    if (!response.ok) throw new AppError([401, 403, 404, 429].includes(response.status) ? response.status : 502,
      ({401: 'reconnect_required', 403: 'scope_missing', 404: 'data_not_found', 429: 'whoop_rate_limited'})[response.status] || 'whoop_unavailable');
    return response.status === 204 ? null : response.json();
  }
  async access(userId, failedToken) {
    return this.locked(userId, async () => {
      const tokens = this.store.tokens(userId);
      if (!tokens) throw new AppError(401, 'reconnect_required');
      if (tokens.expiresAt > Date.now() + 60000 && (!failedToken || failedToken !== tokens.accessToken)) return tokens.accessToken;
      try {
        const updated = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: 'offline' });
        this.store.saveTokens(userId, updated);
        return updated.accessToken;
      } catch (error) {
        if (error.code === 'reconnect_required') this.store.deleteUser(userId);
        throw error;
      }
    });
  }
  async request(userId, path) {
    const token = await this.access(userId);
    try { return await this.raw(path, token); }
    catch (error) {
      if (error.status !== 401) throw error;
      const refreshed = await this.access(userId, token);
      try { return await this.raw(path, refreshed); }
      catch (retryError) {
        if (retryError.status === 401) await this.locked(userId, () => this.store.deleteUser(userId));
        throw retryError;
      }
    }
  }
  async data(userId, resource, range) {
    if (!Object.hasOwn(ENDPOINTS, resource)) throw new AppError(404, 'unknown_resource');
    if (resource === 'profile' || resource === 'body') return this.request(userId, ENDPOINTS[resource]);
    const records = [], seen = new Set();
    let next;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ start: range.start, end: range.end, limit: '25' });
      if (next) query.set('nextToken', next);
      const data = await this.request(userId, `${ENDPOINTS[resource]}?${query}`);
      if (!Array.isArray(data.records)) throw new AppError(502, 'invalid_whoop_response');
      records.push(...data.records);
      next = data.next_token;
      if (!next) return { records, truncated: false };
      if (typeof next !== 'string' || seen.has(next)) throw new AppError(502, 'invalid_whoop_pagination');
      seen.add(next);
    }
    return { records, truncated: true };
  }
  async disconnect(userId) {
    // Acquire a usable token before taking the same per-user lock used for rotation.
    await this.access(userId);
    await this.locked(userId, async () => {
      const tokens = this.store.tokens(userId);
      if (!tokens) return;
      try { await this.raw('/user/access', tokens.accessToken, 'DELETE'); }
      catch (error) { if (error.status !== 401) throw error; }
      this.store.deleteUser(userId);
    });
  }
}

export function dateRange(params) {
  const endText = params.get('end'), startText = params.get('start');
  const end = endText ? Date.parse(endText) : Date.now();
  const start = startText ? Date.parse(startText) : end - 7 * 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86400000 || end > Date.now() + 60000) {
    throw new AppError(400, 'invalid_date_range');
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
