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

## Deploying (Docker) — full runbook

MirNin only monitors while it is running, so put it on an always-on host.

```bash
# 1. On any small VPS (1 vCPU / 1 GB is plenty) with Docker installed:
git clone <your-fork> mirnin && cd mirnin

# 2. Pick a strong admin password and (optionally) a Globalping token:
echo "ADMIN_PASSWORD=$(openssl rand -hex 12)" >  .env
echo "GLOBALPING_TOKEN="                        >> .env   # paste later in Settings too

# 3. Launch (persists data in a Docker volume, restarts on reboot/crash):
docker compose up -d --build

# 4. Put it behind HTTPS. Easiest: a reverse proxy that terminates TLS —
#    Caddy needs just two lines:
#        monitor.example.com {
#            reverse_proxy localhost:4000
#        }
#    (or use your existing nginx/Traefik). Never expose :4000 directly on the
#    internet without TLS — the login password would travel in clear text.

# 5. Watch the watcher: point a free external uptime service (UptimeRobot,
#    Better Uptime, a second tiny box) at:
#        https://monitor.example.com/api/healthz
#    If MirNin's own host dies, nothing else will tell you.
```

Then open the dashboard, sign in, and in **Settings** paste your Globalping
token and alert webhook. Add your first URLs and check types.

Bare-metal alternative (no Docker): `ADMIN_PASSWORD=... node server.js` behind
the same reverse proxy; use a process manager (systemd/pm2) to keep it up.

## Public surfaces

- **`/status.html`** — a public, plain-language status page (no login) for
  customer service or external users: one line per service with a plain summary.
- **`/report.html`** — a print-optimized executive report (uses your login);
  open it and “Save as PDF” from the browser. Linked from the Statistics tab.
- **`/metrics`** — Prometheus exposition (no login) so your engineers can scrape
  MirNin into an existing Grafana/Prometheus stack (`mirnin_check_up`,
  `mirnin_check_latency_ms`, `mirnin_uptime_ratio_24h`, `mirnin_probes_down`).
- **`/api/healthz`** — liveness for an external watchdog.

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
| 🔗 Broken-link crawl | crawls internal pages, checks every link | health % + broken table (source page + anchor) |

The redirect/SSL/domain/blocklist checks use only Node's standard library. The
filter bar (type · status · country) reshapes the dashboard to answer questions
directly; every detail view has a "Show technical detail" expander.

## Roadmap

- Complex flows: scripted browser journeys (login → search → checkout) via
  Playwright, shown as just another tile per location
- Alerting (email/Slack/Telegram) when a tile leaves Operational
- Self-hosted mini-probes on specific ISPs (office/home devices phoning home)
  for guaranteed provider coverage
