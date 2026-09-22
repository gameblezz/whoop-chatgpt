import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const random = () => randomBytes(32).toString('base64url');

export class Store {
  constructor(path, key) {
    this.key = key;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS tokens (user_id TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (binding TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
    this.cleanup();
  }
  encrypt(value, userId) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(userId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  decrypt(value, userId) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(userId));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  saveTokens(userId, tokens) {
    this.db.prepare('INSERT INTO tokens VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted=excluded.encrypted')
      .run(userId, this.encrypt(tokens, userId));
  }
  tokens(userId) {
    const row = this.db.prepare('SELECT encrypted FROM tokens WHERE user_id=?').get(userId);
    return row ? this.decrypt(row.encrypted, userId) : null;
  }
  deleteUser(userId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM tokens WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  newSession(userId) {
    const id = random(), csrf = random();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash(id), userId, csrf, Date.now() + 7 * 86400000);
    return id;
  }
  session(id) {
    return id ? this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(id), Date.now()) : null;
  }
  logout(id) { if (id) this.db.prepare('DELETE FROM sessions WHERE id=?').run(hash(id)); }
  beginOAuth(binding, state) {
    this.cleanup();
    this.db.prepare('INSERT OR REPLACE INTO oauth VALUES (?, ?, ?)').run(hash(binding), hash(state), Date.now() + 600000);
  }
  consumeOAuth(binding, state) {
    if (!binding || !state) return false;
    // Atomic deletion prevents code replay, including concurrent callbacks.
    return Boolean(this.db.prepare('DELETE FROM oauth WHERE binding=? AND state=? AND expires>? RETURNING binding')
      .get(hash(binding), hash(state), Date.now()));
  }
  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM oauth WHERE expires<=?').run(Date.now());
  }
  close() { this.db.close(); }
}
