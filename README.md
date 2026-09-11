# 🎬 Broadway FDFS Ticket Watcher

Automated ticket monitoring & booking assistant for Broadway Cinemas Coimbatore (via BookMyShow).

---

## ✨ Features

- **24/7 Background Monitoring** — Watches BookMyShow JSON API for your target shows
- **Smart Booking Window** — Idle scan every 30 min; switches to aggressive polling 30 min before booking opens
- **Telegram Remote Control** — Add/remove/pause/check watches directly from your phone
- **"TICKETS LIVE" Alerts** — Instant Telegram notification the moment booking opens, with a direct BMS link
- **Auto Seat Hold** *(optional)* — Playwright-based browser automation to lock your preferred seats and send a checkout link
- **Daily Heartbeat** — Morning status ping at 9 AM IST with countdown for each watch
- **"Booking Opens Soon"** — Pre-alert ~1 hour before expected opening time

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
copy .env.example .env
```

Fill in `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=987654321
DATABASE_PATH=./data/tickets.db
POLL_INTERVAL_MINUTES=5
LOG_LEVEL=info
NODE_ENV=production
```

> **How to get your Telegram credentials:**
> 1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **API Token**
> 2. Open [@myidbot](https://t.me/myidbot) → `/start` → copy your **numeric Chat ID**

### 3. Test Telegram

```bash
npm run test:notify
```

### 4. (Optional) Set up BookMyShow session for auto seat hold

```bash
npm run session:setup
```

This opens a browser window — log in to BMS, then press ENTER. Session is saved to `./data/bms-session.json`.

### 5. Add a watch

```bash
npm run watch:add -- \
  --movie "Coolie" \
  --date "2026-08-28" \
  --format "EPIQ" \
  --party-size 2 \
  --seats "H12,H13" \
  --fallback "H10,H11;G12,G13" \
  --open "2026-08-27 18:00"
```

### 6. Start the worker

```bash
# Development (ts-node, with pretty logs):
npm run worker

# Production (compiled, recommended for cloud):
npm run build
npm run worker:prod
```

---

## 📱 Telegram Bot Commands

Send these from your phone while the worker is running:

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/list` | View all active watches & status |
| `/status` | System uptime & summary |
| `/add Movie, YYYY-MM-DD, Format, Seats, OpenTime` | Add a new watch |
| `/remove <id>` | Delete a watch |
| `/pause <id>` | Pause a watch |
| `/resume <id>` | Resume a watch |
| `/check <id>` | Force an instant BMS check |

**Example `/add` from Telegram:**
```
/add Pushpa 3, 2026-12-25, EPIQ, H12 H13, 2026-12-20 18:00
```

---

## 🛠️ CLI Reference

```bash
npm run watch:list                        # List all watches
npm run watch:add -- --movie ...          # Add watch (see above)
npm run watch:remove -- --id 1            # Remove watch #1
npm run watch:pause -- --id 1             # Pause watch #1
npm run watch:resume -- --id 1            # Resume watch #1
npm run watch:check -- --id 1             # Manual check
npm run logs -- --id 1                    # View check logs
npm run watch:probe -- --movie "X" --date "2026-12-25"   # Raw BMS API dump
npm run watch:capability -- --id 1       # Test auto seat hold
npm run test:notify                       # Send test Telegram message
```

---

## 🏗️ Architecture

```
src/
├── worker.ts              # Main entrypoint — cron scheduler + startup
├── watcher/
│   ├── watcherWorker.ts   # Per-watch processing loop
│   ├── timeWindow.ts      # Booking window state machine
│   └── mockAdapter.ts     # Dry-run testing adapter
├── cinema/broadway/
│   ├── broadway.adapter.ts  # BMS JSON API + HTML fallback
│   └── parser.ts            # HTML cheerio parser
├── booking/
│   ├── booking.service.ts   # Seat hold orchestration
│   ├── browserSession.ts    # Playwright session management
│   ├── seatHolder.ts        # Playwright seat selection automation
│   └── seatMatcher.ts       # Preferred/fallback seat logic
├── notify/
│   ├── telegram.ts          # All outbound Telegram notifications
│   └── botCommands.ts       # Inbound Telegram bot command handler
├── db/
│   ├── connection.ts        # SQLite connection (better-sqlite3)
│   ├── migrations.ts        # Schema versioned migrations
│   └── repository.ts        # Watch & log CRUD
├── config/
│   ├── env.ts               # Zod-validated env
│   └── logger.ts            # Pino structured logger
└── cli/cli.ts               # Commander CLI
```

---

## ✅ Safety Rules (Hardcoded)

- ❌ **Payment is NEVER automated** — the bot stops at BMS order summary
- ❌ **No credentials stored** — only BMS session cookies (via Playwright storageState)
- ❌ **No anti-bot evasion** — uses your real browser session, not spoofing
- ✅ The system only captures a checkout URL and sends it to you via Telegram

---

## 🧪 Dry Run

Exercises all core modules without network access:

```bash
npx ts-node dry-run.ts
```
