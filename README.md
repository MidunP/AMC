# 🎬 Broadway FDFS Watcher

A fully automated, 24/7 ticket availability watcher, seat-holder, and notification assistant for Broadway Cinemas Coimbatore. Built for FDFS (First Day First Show) releases on BookMyShow.

**Safety-first design:** No payment automation. No credential storage. The system holds your preferred seats automatically in your logged-in BookMyShow session, then sends you a direct payment checkout link — you just tap and pay!

---

## ✅ Build Status

- **TypeScript:** 0 errors (`strict` mode)
- **Browser Automation:** Playwright integration complete
- **Phases:** 10 / 10 complete
- **Node.js:** v18+ (tested on v24)

---

## Features

| Feature | Description |
|---------|-------------|
| ⚡ **Auto Seat Hold** | Automatically selects & holds your preferred seats in your BMS session on release |
| 💳 **Tap-to-Pay** | Sends direct payment checkout link to Telegram with BMS 10-minute hold active |
| 🔔 **Notification-first** | Instant Telegram alerts for tickets live, seat holds, or fallback seats |
| 📅 **Set-and-Forget** | Add watches days or weeks ahead — auto-calculates activation windows |
| ⏰ **Smart Windows** | Background 30-min idle checks + aggressive polling near expected release time |
| 🎟️ **Seat Preference Engine** | Preferred seats (e.g. `H12,H13`) → Fallback groups (`H10,H11;G12,G13`) |
| 🔄 **BMS JSON API** | Direct API showtime resolution for Broadway Coimbatore (`CABD`) + HTML fallback |
| 🖥️ **CLI & Tools** | Complete management CLI + `session:setup` login tool |
| 🤖 **MCP Server** | 7-tool MCP server for AI assistant integration |
| 📊 **SQLite Engine** | WAL-mode local database with versioned migrations |

---

## Quick Start

### 1. Install Dependencies

```bash
cd AMC
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
DATABASE_PATH=./data/tickets.db
POLL_INTERVAL_MINUTES=5
LOG_LEVEL=info
NODE_ENV=production
```

> **Getting your Telegram credentials:**
> 1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
> 2. Message [@userinfobot](https://t.me/userinfobot) → copy your chat ID

### 3. Test Telegram

```bash
npm run test:notify
```

### 4. One-Time BMS Login Setup (Enables Auto Seat Hold)

```bash
npm run session:setup
```

- A visible browser will open.
- Log in to your BookMyShow account (via Mobile/OTP/Google).
- Return to your terminal and press `ENTER`.
- Your session state is saved securely to `./data/bms-session.json` (gitignored).

### 5. Probe BMS API (Optional Validation)

```bash
npm run watch:probe -- --movie "Vidaamuyarchi" --date "2026-08-22"
```

### 6. Add Your "Set-and-Forget" Watch

```bash
npm run watch:add -- \
  --movie "Spider-Man: Brand New Day" \
  --date "2026-12-25" \
  --format "EPIQ" \
  --party-size 2 \
  --seats "H12,H13" \
  --fallback "H10,H11;G12,G13" \
  --open "2026-12-20 18:00"
```

> The `--open` option automatically computes activation windows (starts 30 min before, runs 3 hrs after) and enables 30-min idle background scanning.

### 7. Start the Background Watcher

```bash
# Production (compiled)
npm run build
npm run worker:prod

# Or Development (ts-node)
npm run worker
```

---

## All CLI Commands

| Command | Description |
|---------|-------------|
| `npm run session:setup` | **One-time BMS login setup** for automated seat holding |
| `npm run watch:add` | Add a new movie watch |
| `npm run watch:list` | List all configured watches |
| `npm run watch:remove -- --id N` | Delete a watch |
| `npm run watch:pause -- --id N` | Pause a watch |
| `npm run watch:resume -- --id N` | Resume a paused watch |
| `npm run watch:check -- --id N` | Manually trigger a check |
| `npm run watch:probe -- --movie X --date Y` | Phase 8: Dump raw BMS API response |
| `npm run watch:capability -- --id N` | Phase 10: Run capability detection |
| `npm run logs -- --id N` | View check history |
| `npm run test:notify` | Send a test Telegram message |
| `npm run worker` | Start background watcher (ts-node) |
| `npm run worker:prod` | Start background watcher (compiled) |
| `npm run mcp` | Start MCP server (stdio) |
| `npm run build` | Compile TypeScript → dist/ |

---

## How Auto Seat Hold Works

1. **Detection:** As soon as showtimes appear, the watcher detects availability.
2. **Playwright Execution:** If `bms-session.json` exists, Playwright opens a headless browser using your saved session.
3. **Seat Selection:** It selects your preferred seats (`H12,H13`). If occupied, it immediately tries your fallback groups (`H10,H11`, then `G12,G13`).
4. **Hold Trigger:** It clicks "Book Tickets" → BMS reserves the seats on a 10-minute hold timer.
5. **Telegram Checkout Alert:** The watcher captures the checkout/payment URL and sends a Telegram notification with a **💳 CONTINUE BOOKING** button.
6. **User Checkout:** You tap the button on Telegram, BMS opens with your held seats, you pay and get your tickets in BMS and email!

---

## Safety Guarantees

| Risk | Protection |
|------|------------|
| Payment automation | Hard-coded `never_supported` — payment is ALWAYS manual |
| Password storage | Never requested or stored (only session cookies via Playwright) |
| Rate limits | 3-block cooldown alert, safe poll intervals |
| Idle safety | Low-frequency 30-min checks prevent excessive traffic |
| Fallback safety | If seat hold fails, falls back gracefully to direct booking link |

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Scaffold, tsconfig, scripts, .env.example | ✅ |
| 2 | SQLite schema, migrations, repositories | ✅ |
| 3 | Full CLI | ✅ |
| 4 | Telegram all message types | ✅ |
| 5 | Mock watcher (all scenarios) | ✅ |
| 6 | Time-window engine | ✅ |
| 7 | Seat preference matcher | ✅ |
| 8 | BMS JSON API inspection + venue codes | ✅ |
| 9 | Real Broadway adapter (JSON + HTML fallback) | ✅ |
| 10 | Browser-Automated Seat Holding & Payment Link Delivery | ✅ |
