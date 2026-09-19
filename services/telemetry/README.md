# ZeroClave Telemetry Worker

An independent, privacy-minimized telemetry service for the ZeroClave DSH
privacy plugin. It runs on Cloudflare Workers, uses D1 for exact daily
deduplication, and does not depend on or modify the ZeroClave Gateway.

This directory contains only the service. It has not been deployed and does
not contain production secrets.

## What it measures

The unit is an active browser profile for one UTC day, not a natural person.
The plugin creates 16 random bytes at the start of each UTC day and uses the
same `daily_id` for that day's events. It must never derive this value from an
account, installation, hardware identifier, or a previous day's value.

The service accepts only these low-cardinality events:

| Event | Required `value` enum | Meaning |
| --- | --- | --- |
| `privacy_active` | none | A non-empty draft was actually inspected |
| `protected_send` | none | A protected send completed |
| `detector_used` | `regex`, `embedded`, `zeroclave` | Detector adoption |

DAU on the dashboard is the exact daily distinct count for
`privacy_active`. Merely opening the plugin or testing a connection does not
count as active use. `protected_send` is shown separately.

The service never accepts arbitrary event names or values. It does not accept
message text, redacted text, entity data, rules, error messages, request IDs,
URLs, account IDs, locale, or device attributes.

## Ingest contract

`POST /v1/events` with `Content-Type: application/json; charset=utf-8`.
The raw request body is limited to 512 bytes. Query parameters and compressed
request bodies are rejected.

```json
{
  "schema_version": 1,
  "product": "zeroclave-dsh-privacy",
  "event": "detector_used",
  "daily_id": "AAAAAAAAAAAAAAAAAAAAAA",
  "plugin_version": "0.1.0-alpha.11",
  "value": "zeroclave"
}
```

`daily_id` is exactly 16 random bytes encoded as unpadded, canonical base64url
(22 characters). `value` is required only for events with an enum in the
table and is forbidden for the two valueless events. Unknown JSON fields are
rejected.

### Request authentication

Only the DSH Host receives the ingest secret. Never include it in the browser
bundle, plugin settings, or an open-source package.

Required headers:

| Header | Format |
| --- | --- |
| `X-ZC-Key-Id` | 1-64 characters: `A-Z a-z 0-9 _ . -` |
| `X-ZC-Timestamp` | Current Unix time in seconds |
| `X-ZC-Nonce` | 16-64 base64url characters, newly random for every attempt |
| `X-ZC-Signature` | 64 lowercase hex characters |

Calculate `body_hash` as lowercase hex SHA-256 of the exact bytes sent. Build
this UTF-8 canonical string, with a final body hash and no trailing newline:

```text
v1
POST
/v1/events
<timestamp>
<nonce>
<body_hash>
```

`X-ZC-Signature` is lowercase hex
`HMAC-SHA256(INGEST_HMAC_SECRET, canonical_string)`.

[`test-vectors/ingest-v1.json`](test-vectors/ingest-v1.json) is the normative
cross-implementation test vector. The Worker and DSH Host must both reproduce
its body hash, canonical string, and signature byte-for-byte before release.
Its secret is test data and must never be used in an environment.

The Worker permits 300 seconds of clock skew. After signature verification it
atomically claims `SHA256(key_id + "\\n" + nonce)` in D1 for 600 seconds.
Reusing a nonce returns HTTP 409. Every retry must use a fresh timestamp,
nonce, and signature. Keep the DSH Host clock synchronized.

Successful requests return HTTP 202 and `{"ok":true}`. Errors are deliberately
small and never echo request content:

| HTTP | Error |
| --- | --- |
| 400 | `invalid_request` |
| 401 | `invalid_auth` |
| 409 | `replay_detected` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` or `unsupported_content_encoding` |
| 422 | `invalid_payload` |
| 503 | `service_not_configured` or `temporarily_unavailable` |

Telemetry failure must be silent to the user and must never block detection,
redaction, or sending. The client should make at most a few bounded attempts
per day, with a new nonce for each attempt.

## Data model and retention

Before insertion, the Worker computes:

```text
daily_id_hash = HMAC-SHA256(
  DAILY_ID_HMAC_SECRET,
  utc_day + "\\n" + daily_id
)
```

Using a different secret from request authentication and including the server
UTC day prevents database rows from being linked across days. The raw
`daily_id` is never inserted. A D1 primary key on
`(day, event, value, daily_id_hash)` provides exact daily deduplication.

The hourly Cron Trigger does three things:

1. Seals aggregate rows once for each completed UTC day. A sentinel prevents
   later hourly jobs from rebuilding a rollup after some raw rows are deleted.
2. Marks nonce hashes expired after ten minutes and deletes them in the first
   hourly cleanup after expiry (online retention is 10-70 minutes).
3. Deletes event rows in the first hourly cleanup after 48 hours from their
   **first** receipt. Online retention is therefore at least 48 hours and less
   than 49 hours; duplicate events cannot extend it.

Daily rollups contain only dimensions and `COUNT(DISTINCT daily_id_hash)` and
may be retained for long-term trend analysis. They contain no identifier,
including a hashed one.

Deletion from the online table is not physical erasure from every Cloudflare
backup. D1 Time Travel is always enabled and can restore database history for
7 days on Workers Free or 30 days on Workers Paid. Privacy notices and data
retention reviews must describe that recoverable-backup window accurately.
Do not configure D1 exports to R2 without a separate retention review.

## Logging and network metadata

`wrangler.jsonc` explicitly disables Workers observability, invocation logs,
Wrangler usage metrics, and deployment dependency instrumentation. The code
emits no `console` output. The Worker does not read or store
`CF-Connecting-IP`, User-Agent, country, referrer, or Access identity in D1.

Cloudflare still processes connection metadata at its network edge, and
Cloudflare Access keeps its own authentication/audit records for admin visits.
Those provider-level records are outside this D1 schema. Do not claim that the
system is anonymous in an absolute network sense.

## Admin access

`/admin`, `/admin/app.js`, and `/admin/api/summary` must be placed behind a
Cloudflare Access self-hosted application. The Worker also validates the
`Cf-Access-Jwt-Assertion` itself using the team JWK endpoint and checks the
RS256 signature, issuer, audience, expiry, and not-before time.

Keep `workers_dev` and preview URLs disabled so an alternate public hostname
cannot bypass the Access application. Protect only
`telemetry.example.com/admin*`; `/v1/events` remains non-interactive and is
authenticated by HMAC. The admin API returns aggregates only.

## Local development

Prerequisites: Node.js 22 or newer and a Cloudflare account.

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply zeroclave_telemetry --local
npm test
npm run check
npm run dev
```

Test the scheduled handler locally:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`.dev.vars` is ignored by Git. Use distinct non-production secrets locally.

## Cloudflare deployment

No deployment is performed by this repository setup. A production operator
should complete these steps:

1. Create a D1 database with
   `npx wrangler d1 create zeroclave_telemetry` and add the returned
   `database_id` to the `DB` binding in `wrangler.jsonc`. Do not share the
   landing-page database.
2. Generate two independent secrets with at least 32 random bytes. Set
   `INGEST_HMAC_SECRET` and `DAILY_ID_HMAC_SECRET` using
   `wrangler secret put`.
3. Set `INGEST_KEY_ID` the same way. Optionally set
   `INGEST_PREVIOUS_KEY_ID` and `INGEST_PREVIOUS_HMAC_SECRET` only during a
   bounded key rotation.
4. Create a Cloudflare Access self-hosted application for `/admin*`. Set
   `CF_ACCESS_TEAM_DOMAIN` to `https://<team>.cloudflareaccess.com` and
   `CF_ACCESS_AUD` to that application's audience tag.
5. Apply migrations with
   `npx wrangler d1 migrations apply zeroclave_telemetry --remote`.
6. Add a custom-domain route before deploy, for example:

   ```json
   "routes": [{ "pattern": "telemetry.example.com", "custom_domain": true }]
   ```

7. Deploy with `npx wrangler deploy`, verify `/healthz`, verify an invalid
   signature is rejected, submit a valid signed event, exercise the scheduled
   handler, and confirm `/admin` is intercepted by Access when signed out.
8. Confirm in the Cloudflare dashboard that invocation logs remain disabled,
   `workers.dev` is off, preview URLs are off, and no D1 export exists.

For key rotation, configure the new current key and the old previous key,
deploy the Worker, update all official DSH Hosts, then remove the previous key
after more than the five-minute timestamp window plus retry allowance.

## Product requirements

- Telemetry is opt-in and disabled by default.
- Global Privacy Control forces it off.
- The UI explains the metric as daily active browser profiles, not users.
- Third-party/self-hosted DSH installations have telemetry off unless an
  administrator deliberately provisions a Host-side key.
- The browser never calls this service directly and never receives an ingest
  key. The DSH Host rebuilds the payload from a field whitelist and does not
  forward Cookie, Authorization, User-Agent, Referer, IP forwarding headers,
  or arbitrary client headers.
- Metrics are for product trends only. A holder of the shared Host key can
  fabricate events, so this data is unsuitable for billing, security policy,
  financial disclosure, or abuse decisions.

## Mainland China caveat

Standard Cloudflare Workers do not provide a hard availability or latency
guarantee from mainland China. Treat this telemetry as best-effort and never
make product behavior depend on delivery. Before public rollout, measure
success from the actual mainland DSH host for at least 72 hours. If delivery
completeness is a requirement, deploy the same narrow contract on a mainland
provider after a separate privacy and compliance review.

## Release gates

- Unit tests and TypeScript checks pass.
- D1 migration is tested both locally and on staging.
- A real DSH Host produces signatures matching the canonical contract.
- UTC midnight rotation and clock-skew behavior are tested.
- Duplicate requests do not increase daily counts.
- Raw rows disappear from the online table at the first hourly cleanup after
  48 hours from first receipt; Time Travel remains documented as recoverable
  backup.
- Turning consent off produces zero network requests.
- No source, bundle, configuration file, or log contains an ingest secret.
- `/admin*` cannot be reached through a Workers preview or `workers.dev`
  hostname and rejects a forged Access header.

## Cloudflare references

- [Workers Logs and invocation-log controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 limits, including Time Travel duration](https://developers.cloudflare.com/d1/platform/limits/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare China Network](https://developers.cloudflare.com/china-network/)
