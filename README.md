# WHOOP Personal Insights

Private, single-owner WHOOP dashboard and Thai/English AI chat. The existing GitHub Pages privacy-policy URL remains usable. OAuth now runs on a Node.js backend; **GitHub Pages cannot host the application or receive the new callback**.

## เริ่มใช้งานหลังสร้าง WHOOP Developer App

1. Deploy โปรเจกต์นี้บนเซิร์ฟเวอร์ที่รัน Node.js 24 หรือ Docker ได้ มี HTTPS และพื้นที่เก็บข้อมูลถาวร ดู [DEPLOYMENT.md](DEPLOYMENT.md)
2. ตั้งค่า `APP_URL`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_ALLOWED_EMAIL`, `TOKEN_ENCRYPTION_KEY` ใน environment ของเซิร์ฟเวอร์ ห้ามใส่ Secret ใน GitHub หรือแชต
3. แก้ Redirect URI ใน WHOOP Developer App เป็น `https://YOUR-APP-DOMAIN/auth/whoop/callback` ให้ตรงกับโดเมนจริง แทน URL `callback.html` เดิม
4. เปิดสิทธิ์ `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`, `read:profile`, `read:body_measurement` แอปขอ `offline` เพิ่มตอนเริ่ม OAuth เพื่อรับ refresh token
5. เปิดเว็บ กด **เชื่อมต่อ WHOOP** แล้วอนุญาตด้วยบัญชีที่มีอีเมลตรงกับ `WHOOP_ALLOWED_EMAIL`
6. ตั้ง `OPENAI_API_KEY` เพื่อใช้แชต เลือกช่วงเวลาและประเภทข้อมูล จากนั้นยินยอมส่งข้อมูลให้ OpenAI ก่อนถาม

ไม่ต้องคัดลอก authorization code หรือ token ด้วยตนเอง และไม่ต้องส่ง Client Secret ให้ผู้ช่วย ส่วน AI ใช้ OpenAI API key ของเจ้าของแอป

## Local development

Requires Node.js 24 (uses built-in `node:sqlite`, HTTP, fetch, and crypto); no third-party runtime packages or install step.

```sh
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
# Set the generated key and your settings in .env, then:
node --env-file=.env src/server.js
```

On PowerShell, use `Copy-Item .env.example .env`. Visit `http://localhost:3000`. WHOOP's documented redirect format is HTTPS; for a real OAuth test use your HTTPS staging hostname/tunnel and set both `APP_URL` and the registered callback to that hostname. Don't mix localhost and the HTTPS origin in the browser during sign-in.

```sh
node --test
node --check src/server.js
node --check public/app.js
```

Tests use synthetic credentials and mocked providers. They cover encrypted persistence/restart, OAuth state binding/expiry/replay, owner-only sign-in, token rotation concurrency, 401 retry, invalid grants, all six resources, pagination, CSRF, consent, AI data minimization and disconnection. Real provider acceptance must be checked after deployment with your credentials. No real WHOOP or OpenAI requests are made by the test suite.

## Design

- Backend callback exchanges the code without displaying it; one-time browser-bound state, ten-minute expiry, clean redirect, owner email allowlist, fresh opaque session.
- Seven-day HttpOnly, SameSite=Lax session cookies; Secure and `__Host-` prefix on HTTPS. Session IDs are hashed in SQLite. Mutations require exact Origin and CSRF token.
- AES-256-GCM encrypted access/refresh tokens with random nonce and user-bound authenticated data. SQLite writes token pairs atomically. WHOOP refresh token rotation is serialized per user in one process; 401 triggers at most one refresh/retry.
- Exact API route allowlist, provider timeouts, generic errors, no upstream error-body or URL logging, no credential endpoints, restrictive CSP, text-only chat rendering.
- Data is fetched on demand. No health-record or chat database. Up to 31 days per request, ten pages/250 records per collection, explicit truncation flag; chat asks for a shorter interval if the payload is too large.
- AI uses the Responses API with `store: false`. Only selected resources and bounded chat history are sent. Profile identifiers are removed; text the user types is sent as written. Provider retention policies still apply.
- Chat limits: 10 requests/minute, 100 per rolling 24-hour process window and one in flight. These in-memory budgets reset on restart; set an independent spending limit in your OpenAI project. Private API requests are limited to 120/minute; OAuth starts to 30/10 minutes globally.
- One Node process / one replica with a persistent volume. Do not use cluster workers or scale replicas: refresh coordination and rate limits are process-local. For multiple replicas replace SQLite/session storage and locks with a shared transactional store before scaling.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /auth/whoop` | Begin authorization |
| `GET /auth/whoop/callback` | Server-only code exchange |
| `GET /api/session` | Session status + CSRF value, never WHOOP tokens |
| `GET /api/whoop/{resource}` | `recovery`, `cycles`, `sleep`, `workouts`, `profile`, `body` |
| `POST /api/chat` | Selected WHOOP snapshot + conversation → AI answer |
| `POST /api/logout` | End current session |
| `POST /api/disconnect` | Revoke WHOOP grant and delete local tokens/all sessions |
| `POST /api/forget` | Delete locally during provider outages; revoke in WHOOP manually |
| `GET /privacy` | Privacy policy |
| `GET /healthz` | Liveness without secrets |

Collection queries accept `start` and `end` as ISO timestamps (defaults: last seven days). WHOOP's range semantics apply per resource, including recovery cycle timing. Profile and body measurements are current values, not historical values for the selected interval. The UI offers 7/14/30 days; the API supports explicit intervals up to 31 days. Browser account authentication applies to every data/chat route; there is no client-supplied user ID.

## Official references

- [WHOOP OAuth and rotating refresh tokens](https://developer.whoop.com/docs/developing/oauth/)
- [WHOOP v2 API and scopes](https://developer.whoop.com/api/)
- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [OpenAI data controls and retention](https://developers.openai.com/api/docs/guides/your-data)
