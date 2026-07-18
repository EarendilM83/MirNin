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
selected. A check records latency and HTTP status, classified as:

| Status | Meaning |
|---|---|
| Operational | Responded 2xx/3xx within the degraded threshold |
| Degraded | Responded, but slowly or with a 4xx (possible geo-block) |
| Down | Timeout, connection failure, or 5xx |
| No data | The check itself could not run (probe network unreachable) |

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

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `./data` | Where config + results are persisted (JSON) |
| `GLOBALPING_TOKEN` | – | Optional Globalping API token for higher rate limits |

Targets and settings live in `data/config.json`; recent results are flushed to
`data/results.json` every 30 s and kept for ~25 h (the 24 h uptime window).

## API

| Method & path | Purpose |
|---|---|
| `GET /api/state` | Full snapshot: targets, history, uptime |
| `GET /api/events` | Server-sent events stream of live results |
| `POST /api/targets` | Add a target `{name, url, intervalSeconds, countries, degradedMs?}` |
| `PUT /api/targets/:id` | Edit a target (partial body allowed, incl. `{enabled}`) |
| `DELETE /api/targets/:id` | Remove a target and its history |
| `POST /api/targets/:id/check` | Run a check immediately |
| `PUT /api/settings` | `{provider: "auto" | "simulated"}` |

## Roadmap

- Complex flows: scripted browser journeys (login → search → checkout) via
  Playwright, shown as just another tile per country
- Alerting (email/Slack/Telegram) when a tile leaves Operational
- Long-term history storage (SQLite) and SLA reports
