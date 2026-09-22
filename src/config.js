import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  };
  const url = new URL(required('APP_URL'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APP_URL must be an origin without a path, credentials, query, or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('APP_URL requires HTTPS except on localhost');
  }
  const keyText = required('TOKEN_ENCRYPTION_KEY');
  const key = Buffer.from(keyText, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyText) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  const ownerEmail = required('WHOOP_ALLOWED_EMAIL').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('WHOOP_ALLOWED_EMAIL must be your WHOOP account email');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    origin: url.origin, secure: url.protocol === 'https:', port, key, ownerEmail,
    redirectUri: `${url.origin}/auth/whoop/callback`,
    clientId: required('WHOOP_CLIENT_ID'), clientSecret: required('WHOOP_CLIENT_SECRET'),
    databasePath: resolve(env.DATABASE_PATH || './data/whoop.sqlite'),
    openaiKey: env.OPENAI_API_KEY?.trim(), model: env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
  };
}
