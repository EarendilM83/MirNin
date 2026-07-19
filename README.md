# MirNin Monitor

A self-hosted monitoring tool that answers one question at a glance:
**is our platform reachable right now, from the countries our users are in?**

Admins register URLs to watch, pick the countries to check from and how often.
The dashboard shows every country as a live tile — like participants in a video
call — with latency history, uptime, and a pinnable detail view.

## Quick start

Requires Node.js 18.17+ (no other dependencies).

```bash
npm start          # or: node server.js
# open http://localhost:4000
```

Click **+ Add URL**, enter the URL, pick countries and an interval — checks
start immediately and stream to the dashboard live.

## How checks work

Each target (URL) is checked on its own schedule from every location you
selected. A location is a **country plus an optional provider (ISP)** — add
"Georgia · Magti" and "Georgia · Silknet" side by side to catch provider-level
blocks. Every check records latency with a **phase breakdown**
(DNS → connect → TLS → first byte → download), response size, redirect chain,
the CDN edge that served it, and days until the SSL certificate expires.
Results are classified as:

| Status | Meaning |
|---|---|
| Operational | Responded 2xx/3xx within the degraded threshold |
| Degraded | Responded, but slowly or with a 4xx (possible geo-block) |
| Down | Timeout, connection failure, 5xx, or expected content missing |
| No data | The check itself could not run (probe network unreachable) |

Optional per-target **content assertion**: if the response doesn't contain the
expected text, the check counts as Down even with a 200 status — this is what
catches ISP block pages pretending to be your site.

### Divergence detection & diagnostics

When providers inside one country disagree (Magti failing while Silknet
passes), tiles get an explicit "suspected ISP-level block" badge instead of a
muddy average. On every transition to Down, the monitor automatically runs
ping + DNS diagnostics from that same location and attaches the verdict to the
incident.

### History & incidents

Raw checks are kept ~48 h; hourly rollups (status counts, p50/p95) are kept
90 days. That powers the focus view's 1 h → 30 d range selector, 24 h/7 d/30 d
uptime, a week-at-a-glance status heatmap, and the per-target incident
timeline (start, duration, location, error, diagnosis).

“No data” is deliberately distinct from “Down” — *we couldn't look* is not the
same as *the site is broken*.

### Probe locations

- **Country probes** use the free [Globalping](https://globalping.io) probe
  network (real machines in each country). Unauthenticated use is rate-limited;
  set `GLOBALPING_TOKEN` for higher limits. Keep intervals modest
  (≥ 1–5 min) when checking many countries.
- **This server** (`LOCAL`) checks the URL directly from wherever the monitor
  is hosted — works with private/internal URLs the probe network can't reach.
- **Simulated mode** (Probes selector in the header) generates synthetic
  results so you can explore the UI without network access.

### Alerts

Settings → paste a webhook URL (a Slack incoming webhook works as-is; the
payload is `{"text": "…"}` JSON). You get a 🔴 message when a location fails
N consecutive checks — including the auto-diagnosis verdict — and a 🟢 message
on recovery with the outage duration. "Send test alert" verifies the wiring.

### Authentication

Set `ADMIN_PASSWORD` to require a login. Sessions are HMAC-signed cookies
(7-day expiry); the signing secret is generated once under `data/`. Without
the variable the dashboard stays open (fine on localhost) and shows an
"Unprotected" notice. Always set it before exposing the monitor to a network.

## Deploying (Docker)

```bash
ADMIN_PASSWORD=change-me docker compose up -d --build
# or: docker build -t mirnin-monitor . && docker run -d -p 4000:4000 \
#     -e ADMIN_PASSWORD=change-me -v monitor-data:/app/data mirnin-monitor
```

Works on any $5 VPS or container host. `GET /api/healthz` is unauthenticated
and made for an external watchdog (UptimeRobot or similar) — a monitor nobody
watches when *it* dies is a blind spot, so point something at it.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `./data` | Where config + results are persisted (JSON) |
| `ADMIN_PASSWORD` | – | Enables login protection (recommended) |
| `GLOBALPING_TOKEN` | – | Globalping API token for higher rate limits (can also be set in Settings) |

Targets and settings live in `data/config.json`; recent results are flushed to
`data/results.json` every 30 s and kept for ~25 h (the 24 h uptime window).

## API

| Method & path | Purpose |
|---|---|
| `GET /api/healthz` | Liveness for external watchdogs (no auth) |
| `POST /api/login` / `POST /api/logout` | Session management when `ADMIN_PASSWORD` is set |
| `POST /api/alerts/test` | Send a test message to the configured webhook |
| `GET /api/state` | Full snapshot: targets, recent history, uptimes, incidents |
| `GET /api/events` | Server-sent events stream of live results |
| `GET /api/history?target=&loc=` | 48 h raw + 30 d hourly rollups for one tile |
| `GET /api/probes/:CC` | Providers with live Globalping probes in a country |
| `POST /api/targets` | Add a target `{name, url, intervalSeconds, locations: [{country, isp?}], degradedMs?, expectText?}` |
| `PUT /api/targets/:id` | Edit a target (partial body allowed, incl. `{enabled}`) |
| `DELETE /api/targets/:id` | Remove a target and its history |
| `POST /api/targets/:id/check` | Run a check immediately |
| `PUT /api/settings` | `{provider: "auto" | "simulated"}` |

## Check types

Beyond reachability, a target can be one of several check types (chosen in the
"What to check" selector), all sharing the same scheduling, incidents, alerts,
and statistics:

| Type | What it watches | Visualization |
|---|---|---|
| 🌍 Reachability | URL up from countries/ISPs | tiles + latency |
| ↪ Redirect / link | full redirect chain ends where expected, tracking params survive | journey strip |
| 🔒 SSL certificate | days to expiry, chain validity, hostname match | runway bar |
| 📅 Domain expiry | registration expiry, registrar, nameservers (RDAP) | runway bar |
| 🛡 DNS blocklist | reputation/content blocklist hits | shield + list |

The redirect/SSL/domain/blocklist checks use only Node's standard library. The
filter bar (type · status · country) reshapes the dashboard to answer questions
directly; every detail view has a "Show technical detail" expander.

## Roadmap

- Complex flows: scripted browser journeys (login → search → checkout) via
  Playwright, shown as just another tile per location
- Alerting (email/Slack/Telegram) when a tile leaves Operational
- Self-hosted mini-probes on specific ISPs (office/home devices phoning home)
  for guaranteed provider coverage
