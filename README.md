# 🎬 Broadway FDFS Ticket Watcher

A cloud-hosted personal movie ticket monitoring system for **Broadway Cinemas, Coimbatore**.

Designed for high-demand **FDFS (First Day First Show)** releases — monitors BookMyShow for when booking opens, checks your preferred seats, and sends an instant Telegram notification.

---

## Architecture

```
MCP Server ──► SQLite ──► Active Watches
                              │
                         Watch Worker (runs 24/7 in cloud)
                              │
                    Broadway/BMS Adapter (read-only)
                              │
              ┌───────────────┴──────────────┐
           Not Live                          Live
                                             │
                                      Find Show
                                             │
                                      Check Seats
                                             │
                                  Optional: Seat Hold
                                             │
                                        Telegram
                                             │
                                       USER → Payment
```

**Core** (always available): Monitoring → Seat Matching → Telegram  
**Optional**: Seat Hold (only if legitimate booking flow supports it)  
**Never**: Payment automation, CAPTCHA bypass, anti-bot evasion

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure Telegram

#### Create a Bot

1. Open Telegram, search for **BotFather**
2. Send `/newbot`
3. Choose a bot name (e.g. `Broadway Watcher`)
4. Choose a username ending in `bot` (e.g. `broadway_fdfs_bot`)
5. Copy the **token** provided

#### Get Your Chat ID

1. Open your new bot in Telegram
2. Send any message (e.g. "hi")
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find `"chat": {"id": XXXXXXXX}` — that number is your `TELEGRAM_CHAT_ID`

### 3. Create `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_CHAT_ID=987654321
DATABASE_PATH=./data/tickets.db
POLL_INTERVAL_MINUTES=5
LOG_LEVEL=info
NODE_ENV=production
```

> ⚠️ Never commit `.env` — it's in `.gitignore`

### 4. Test Telegram

```bash
npm run test:notify
```

### 5. Build

```bash
npm run build
```

---

## CLI Commands

### Add a Watch

```bash
npm run watch:add -- \
  --movie "Avengers: Doomsday" \
  --theatre "Broadway" \
  --date "2026-12-18" \
  --format "EPIQ" \
  --open "2026-12-17T18:00:00+05:30" \
  --active-from "2026-12-17T17:50:00+05:30" \
  --active-until "2026-12-17T18:30:00+05:30" \
  --seats "H12,H13" \
  --fallback "H11,H12;H13,H14;G12,G13" \
  --party-size 2
```

### List Watches

```bash
npm run watch:list
```

### View Logs

```bash
npm run logs -- --id 1 --limit 20
```

### Pause / Resume / Remove

```bash
npm run watch:pause   -- --id 1
npm run watch:resume  -- --id 1
npm run watch:remove  -- --id 1
```

### Manual Check (for testing)

```bash
npm run watch:check -- --id 1
```

---

## Background Worker

Runs continuously and polls all active watches on the configured interval:

```bash
npm run worker
```

Or in production (compiled):

```bash
npm run build && npm run worker:prod
```

---

## MCP Server

For AI assistant integration (Claude, etc.):

```bash
npm run mcp
```

Configure in your MCP client with:

```json
{
  "mcpServers": {
    "broadway-watcher": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/path/to/broadway-fdfs-watcher"
    }
  }
}
```

---

## Telegram Notifications

### When tickets go live:

```
🚨 TICKETS LIVE!

🎬 Avengers: Doomsday
📍 Broadway Cinemas
📅 2026-12-18
🖥️ EPIQ
🕐 6:00 PM

🎟️ Preferred seats:
✅ H12
✅ H13

⚡ Open the booking link now — seats may sell out fast!

[🎟️ BOOK NOW]
```

### When seats are held (if supported):

```
🚨 SEATS HELD!

🎬 Avengers: Doomsday
📍 Broadway Cinemas
🖥️ EPIQ
🕐 6:00 PM

🎟️ Seats: H12 + H13

⏳ Temporary booking hold detected.
⚠️ Complete payment before the hold expires.

[💳 CONTINUE BOOKING]
```

---

## Booking Window

Configure the activation window to avoid unnecessary polling:

| Time    | What happens                              |
|---------|-------------------------------------------|
| Before 17:50 | System is idle (low-frequency or no checks) |
| 17:50   | **BOOKING MODE ACTIVATED** — system becomes ready |
| 18:00   | Expected booking opens — aggressive checks begin |
| Show found | Process → seat check → Telegram |
| 18:30   | Booking window expires |

---

## Polling Rules

- Minimum `POLL_INTERVAL_MINUTES`: **3** (hard enforced — will reject lower values)
- Default: **5 minutes**
- Multiple watches are **staggered** (500ms–2s between each)
- On blocking (403/429/CAPTCHA): log, wait for next cycle, **never bypass**
- After 3 consecutive blocks: Telegram alert (with 30-minute cooldown)

---

## Safety Guarantees

| Feature | Status |
|---------|--------|
| Payment automation | ❌ NEVER |
| OTP automation | ❌ NEVER |
| CAPTCHA bypass | ❌ NEVER |
| Anti-bot evasion | ❌ NEVER |
| Proxy rotation | ❌ NEVER |
| TLS fingerprint spoofing | ❌ NEVER |
| Multiple accounts | ❌ NEVER |
| Credential storage | ❌ NEVER |
| Seat hold (if legitimately supported) | ✅ Optional |
| Monitoring + Telegram | ✅ Always |

---

## Cloud Deployment

Host on any Node.js platform with **persistent storage**:

- **Fly.io** (with persistent volume for SQLite)
- **Railway** (with volume mount)
- **DigitalOcean App Platform** (with persistent disk)
- **VPS** (any — `pm2` or `systemd` recommended)

> ⚠️ Do NOT use ephemeral filesystems (Vercel, Netlify serverless) — SQLite requires persistent storage.

### Example with PM2

```bash
npm install -g pm2
npm run build
pm2 start dist/worker.js --name broadway-watcher
pm2 save
pm2 startup
```

---

## Build Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Scaffold & build system | ✅ |
| 2 | Database schema & repositories | ✅ |
| 3 | CLI commands | ✅ |
| 4 | Telegram notifications | ✅ |
| 5 | Mock watcher (all scenarios) | ✅ |
| 6 | Time-window engine | ✅ |
| 7 | Seat preference engine | ✅ |
| 8 | Real Broadway/BMS page inspection | 🔲 |
| 9 | Real Broadway adapter (test on low-demand show) | 🔲 |
| 10 | Optional booking capability test | 🔲 |

---

## Test Movie Strategy

> ⚠️ **Do NOT use a major FDFS for initial testing.**

Test with a **low-demand local Tamil movie** first to verify:

1. Ticket opening detection
2. Timing accuracy
3. Format matching
4. Seat map parsing (if available)
5. Preferred seat matching
6. Telegram latency
7. Booking-state detection

Only after successful testing should the system be used for a high-demand FDFS.

---

## License

Personal use. Not affiliated with Broadway Cinemas or BookMyShow.
