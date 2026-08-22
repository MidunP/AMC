#!/usr/bin/env ts-node
import { Command } from 'commander';
import dotenv from 'dotenv';
dotenv.config();

import { runMigrations } from '../db/migrations';
import {
    createWatch,
    getAllWatches,
    getWatchById,
    deleteWatch,
    updateWatchStatus,
    getCheckLogs,
} from '../db/repository';
import { sendTestMessage } from '../notify/telegram';
import { checkBroadwayShowtimes, probeVenueApi } from '../cinema/broadway/broadway.adapter';
import { insertCheckLog, updateLastChecked } from '../db/repository';
import { attemptSeatHold } from '../booking/booking.service';
import { setupBmsSession, hasSession, SESSION_FILE } from '../booking/browserSession';

const program = new Command();

program
    .name('broadway-watcher')
    .description('Broadway FDFS Ticket Watcher CLI')
    .version('1.0.0');

// ─── add ───────────────────────────────────────────────────────────────────────


program
    .command('add')
    .description('Add a new movie watch')
    .requiredOption('--movie <name>', 'Movie name')
    .option('--theatre <name>', 'Theatre name', 'Broadway Cinemas')
    .requiredOption('--date <date>', 'Target date (YYYY-MM-DD)')
    .option('--format <format>', 'Preferred format (EPIQ, 3D, 2D, etc.)')
    .option('--showtime <time>', 'Preferred showtime (e.g. "6:00 PM")')
    .option('--party-size <n>', 'Number of seats needed', '1')
    .option('--open <datetime>', 'Expected booking opening time — ISO 8601 or "YYYY-MM-DD HH:MM" in IST')
    .option('--active-from <datetime>', 'Override: activation window start (default: 30 min before --open)')
    .option('--active-until <datetime>', 'Override: activation window end (default: 3 hr after --open)')
    .option('--seats <seats>', 'Preferred seats, comma-separated (e.g. "H12,H13")')
    .option('--fallback <seats>', 'Fallback seat groups, semicolon-separated (e.g. "H11,H12;G12,G13")')
    .action((opts) => {
        runMigrations();

        // ── Auto-compute booking window from --open ───────────────────────────
        // If the user only provides --open (the common case), automatically
        // set --active-from (30 min early) and --active-until (3 hours after).
        // This is the "set and forget" mode: add the watch days ahead, forget it.

        let activationStart: string | null = opts.activeFrom ?? null;
        let activationEnd: string | null = opts.activeUntil ?? null;
        let windowAutoComputed = false;

        if (opts.open) {
            // Parse IST shorthand: "2026-12-25 10:00" → ISO with +05:30
            let openStr = opts.open as string;
            if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(openStr)) {
                openStr = `${openStr}:00+05:30`;
            }

            const openTime = new Date(openStr);

            if (!isNaN(openTime.getTime())) {
                if (!activationStart) {
                    const from = new Date(openTime.getTime() - 30 * 60 * 1000);
                    activationStart = from.toISOString();
                    windowAutoComputed = true;
                }
                if (!activationEnd) {
                    const until = new Date(openTime.getTime() + 3 * 60 * 60 * 1000);
                    activationEnd = until.toISOString();
                }
            } else {
                console.error('\n⚠️  Could not parse --open time. Use ISO 8601 or "YYYY-MM-DD HH:MM" format.\n');
            }
        }

        const watch = createWatch({
            movie: opts.movie,
            theatre: opts.theatre,
            target_date: opts.date,
            preferred_format: opts.format ?? null,
            preferred_showtime: opts.showtime ?? null,
            party_size: parseInt(opts.partySize, 10),
            expected_opening_at: opts.open ? new Date(
                /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(opts.open)
                    ? `${opts.open}:00+05:30`
                    : opts.open
            ).toISOString() : null,
            activation_start: activationStart,
            activation_end: activationEnd,
            preferred_seats: opts.seats ?? null,
            fallback_seats: opts.fallback ?? null,
        });

        // ── Pretty confirmation ───────────────────────────────────────────────
        const openAt = watch.expected_opening_at
            ? new Date(watch.expected_opening_at).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
            })
            : null;
        const msUntilOpen = watch.expected_opening_at
            ? new Date(watch.expected_opening_at).getTime() - Date.now()
            : null;
        const countdownStr = msUntilOpen !== null && msUntilOpen > 0
            ? formatCountdownCli(msUntilOpen)
            : null;

        console.log('');
        console.log('✅ Watch added! The watcher will monitor this automatically.');
        console.log('─'.repeat(60));
        console.log(`   ID:         ${watch.id}`);
        console.log(`   Movie:      ${watch.movie}`);
        console.log(`   Date:       ${watch.target_date}`);
        console.log(`   Format:     ${watch.preferred_format ?? 'Any'}`);
        console.log(`   Theatre:    ${watch.theatre}`);
        console.log(`   Seats:      ${watch.preferred_seats ?? 'Not configured'}`);
        console.log(`   Fallback:   ${watch.fallback_seats ?? 'Not configured'}`);

        if (openAt) {
            console.log('');
            console.log(`   ⏰ Booking opens: ${openAt} IST${countdownStr ? ` (in ${countdownStr})` : ''}`);
        }
        if (windowAutoComputed && activationStart && activationEnd) {
            const fromStr = new Date(activationStart).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', timeStyle: 'short'
            });
            const untilStr = new Date(activationEnd).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', timeStyle: 'short'
            });
            console.log(`   🔔 Active window: ${fromStr} → ${untilStr} IST (auto-computed)`);
            console.log('');
            console.log('   💡 The watcher will:');
            console.log('      • Background-check every 30 min anytime (catches early releases)');
            console.log(`      • Send you a "get ready" alert ~1 hour before ${openAt}`);
            console.log('      • Switch to aggressive polling from', fromStr, 'onward');
            console.log('      • Send TICKETS LIVE the moment booking opens');
        }
        console.log('─'.repeat(60));
        console.log('');
        console.log('   Run: npm run worker  (to start the background watcher)');
        console.log('');
    });

function formatCountdownCli(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}



// ─── list ──────────────────────────────────────────────────────────────────────

program
    .command('list')
    .description('List all watches')
    .action(() => {
        runMigrations();
        const watches = getAllWatches();

        if (watches.length === 0) {
            console.log('\n📭 No watches configured.\n');
            return;
        }

        console.log(`\n🎬 ${watches.length} watch(es):\n`);
        console.log('─'.repeat(70));

        for (const w of watches) {
            const status = w.status === 'watching' ? '🟢' : w.status === 'paused' ? '⏸️' : '⚪';
            console.log(`${status} [${w.id}] ${w.movie}`);
            console.log(`   Theatre: ${w.theatre} | Date: ${w.target_date} | Format: ${w.preferred_format ?? 'Any'}`);
            console.log(`   Status: ${w.status} | Booking: ${w.booking_state}`);
            console.log(`   Seats: ${w.preferred_seats ?? 'Not set'}`);
            console.log(`   Opens: ${w.expected_opening_at ?? 'Not set'} | Window: ${w.activation_start ?? '-'} → ${w.activation_end ?? '-'}`);
            console.log(`   Last check: ${w.last_checked_at ?? 'Never'} (${w.last_result ?? '-'})`);
            console.log('─'.repeat(70));
        }
        console.log('');
    });

// ─── remove ────────────────────────────────────────────────────────────────────

program
    .command('remove')
    .description('Remove a watch by ID')
    .requiredOption('--id <id>', 'Watch ID')
    .action((opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const watch = getWatchById(id);

        if (!watch) {
            console.error(`\n❌ Watch ID ${id} not found.\n`);
            process.exit(1);
        }

        const deleted = deleteWatch(id);
        if (deleted) {
            console.log(`\n✅ Watch [${id}] "${watch.movie}" removed.\n`);
        }
    });

// ─── pause ─────────────────────────────────────────────────────────────────────

program
    .command('pause')
    .description('Pause a watch')
    .requiredOption('--id <id>', 'Watch ID')
    .action((opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const watch = getWatchById(id);
        if (!watch) { console.error(`❌ Watch ID ${id} not found.`); process.exit(1); }

        updateWatchStatus(id, 'paused');
        console.log(`\n⏸️ Watch [${id}] "${watch.movie}" paused.\n`);
    });

// ─── resume ────────────────────────────────────────────────────────────────────

program
    .command('resume')
    .description('Resume a paused watch')
    .requiredOption('--id <id>', 'Watch ID')
    .action((opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const watch = getWatchById(id);
        if (!watch) { console.error(`❌ Watch ID ${id} not found.`); process.exit(1); }

        updateWatchStatus(id, 'watching');
        console.log(`\n▶️  Watch [${id}] "${watch.movie}" resumed.\n`);
    });

// ─── logs ──────────────────────────────────────────────────────────────────────

program
    .command('logs')
    .description('Show check logs for a watch')
    .requiredOption('--id <id>', 'Watch ID')
    .option('--limit <n>', 'Number of log entries to show', '20')
    .action((opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const limit = parseInt(opts.limit, 10);
        const watch = getWatchById(id);
        if (!watch) { console.error(`❌ Watch ID ${id} not found.`); process.exit(1); }

        const logs = getCheckLogs(id, limit);
        console.log(`\n📋 Last ${logs.length} check(s) for [${id}] "${watch.movie}":\n`);
        console.log('─'.repeat(70));

        for (const log of logs) {
            const result = log.result === 'bookable' ? '✅ BOOKABLE' :
                log.result === 'not_bookable' ? '⏳ waiting' :
                    log.result === 'blocked' ? '🚫 BLOCKED' :
                        log.result === 'parse_error' ? '💥 PARSE ERROR' :
                            log.result;
            console.log(`${log.checked_at}  ${result}  [HTTP ${log.http_status ?? '-'}]`);
            if (log.notes) console.log(`   ${log.notes}`);
        }
        console.log('─'.repeat(70));
        console.log('');
    });

// ─── check ─────────────────────────────────────────────────────────────────────

program
    .command('check')
    .description('Manually trigger a check for a watch (respects rate limits)')
    .requiredOption('--id <id>', 'Watch ID')
    .action(async (opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const watch = getWatchById(id);
        if (!watch) { console.error(`❌ Watch ID ${id} not found.`); process.exit(1); }

        console.log(`\n🔍 Checking [${id}] "${watch.movie}"...`);
        const start = Date.now();
        const result = await checkBroadwayShowtimes(watch);
        const duration = Date.now() - start;

        if (result.blocked) {
            console.log(`\n🚫 BLOCKED by provider (HTTP ${result.rawHttpStatus})`);
            insertCheckLog({ watch_id: id, result: 'blocked', http_status: result.rawHttpStatus, duration_ms: duration });
        } else if (result.parseError) {
            console.log('\n💥 PARSE ERROR — page structure changed');
            insertCheckLog({ watch_id: id, result: 'parse_error', http_status: result.rawHttpStatus, duration_ms: duration });
        } else if (result.shows.length === 0) {
            console.log('\n⏳ NOT BOOKABLE — no matching shows found');
            insertCheckLog({ watch_id: id, result: 'not_bookable', http_status: result.rawHttpStatus, duration_ms: duration });
        } else {
            const show = result.shows[0];
            console.log('\n✅ BOOKABLE!');
            console.log(`   Show: ${show.movie} @ ${show.theatre}`);
            console.log(`   Time: ${show.showtime} | Format: ${show.format}`);
            console.log(`   URL:  ${show.bookingUrl}`);
            insertCheckLog({ watch_id: id, result: 'bookable', http_status: result.rawHttpStatus, duration_ms: duration, notes: show.bookingUrl ?? '' });
        }

        updateLastChecked(id, result.shows.length > 0 ? 'bookable' : result.blocked ? 'blocked' : 'not_bookable');
        console.log(`\n   Duration: ${duration}ms\n`);
        process.exit(0);
    });

// ─── test-notify ───────────────────────────────────────────────────────────────

program
    .command('test-notify')
    .description('Send a test Telegram message')
    .action(async () => {
        console.log('\n📤 Sending test Telegram message...');
        const ok = await sendTestMessage();
        if (ok) {
            console.log('✅ Test message sent! Check your Telegram.\n');
        } else {
            console.error('❌ Failed to send test message. Check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.\n');
            process.exit(1);
        }
        process.exit(0);
    });

// ─── probe ─────────────────────────────────────────────────────────────────────
// Phase 8: Inspect raw BMS API response for a movie + date at Broadway Coimbatore

program
    .command('probe')
    .description('[Phase 8] Dump raw BMS API response for venue validation')
    .requiredOption('--movie <name>', 'Movie name to look up')
    .requiredOption('--date <date>', 'Target date (YYYY-MM-DD)')
    .action(async (opts) => {
        const dateCode = opts.date.replace(/-/g, '');
        console.log(`\n🔎 Probing BMS for "${opts.movie}" on ${opts.date} @ Broadway Coimbatore...\n`);
        const result = await probeVenueApi(opts.movie, dateCode);
        console.log(JSON.stringify(result, null, 2));
        console.log('');
        process.exit(0);
    });

// ─── capability ────────────────────────────────────────────────────────────────
// Phase 10: Run booking capability detection on a watch's current best show

program
    .command('capability')
    .description('[Phase 10] Run seat hold capability detection for a watch')
    .requiredOption('--id <id>', 'Watch ID')
    .action(async (opts) => {
        runMigrations();
        const id = parseInt(opts.id, 10);
        const watch = getWatchById(id);
        if (!watch) { console.error(`❌ Watch ID ${id} not found.`); process.exit(1); }

        console.log(`\n🔬 Running capability check for [${id}] "${watch.movie}"...`);
        const checkResult = await checkBroadwayShowtimes(watch);

        if (!checkResult.success || checkResult.shows.length === 0) {
            console.log('\n⚠️  No bookable shows found — cannot run capability detection.');
            console.log(`   Blocked: ${checkResult.blocked}, ParseError: ${checkResult.parseError}`);
            process.exit(0);
        }

        const show = checkResult.shows[0];
        console.log(`\n🎟️  Best show: ${show.movie} @ ${show.showtime} (${show.format}) — ${show.bookingUrl}`);

        const capResult = await attemptSeatHold(show, { found: false, seats: [], source: 'none', seatStatuses: {} }, id);

        console.log('\n📊 Capability Report:');
        console.log(`   Seat Map:         ${capResult.capabilities.seatMap}`);
        console.log(`   Seat Selection:   ${capResult.capabilities.seatSelection}`);
        console.log(`   Seat Hold:        ${capResult.capabilities.seatHold}`);
        console.log(`   Resumable URL:    ${capResult.capabilities.resumableBookingSession}`);
        console.log(`   Payment:          ${capResult.capabilities.payment}`);
        console.log(`\n📝 Notes:\n${capResult.notes}`);
        console.log('');
        process.exit(0);
    });

// ─── session:setup ──────────────────────────────────────────────────────────────────
// One-time: opens a visible browser for the user to log in to BMS.
// The session is saved and reused headlessly for all future seat holds.

program
    .command('session:setup')
    .description('One-time BMS login setup — enables automated seat holding')
    .action(async () => {
        if (hasSession()) {
            console.log(`\n⚠️  A session already exists at: ${SESSION_FILE}`);
            console.log('   Re-running will overwrite it with a fresh login.\n');
        }
        try {
            await setupBmsSession();
            console.log('\n✅ Setup complete! Session saved.');
            console.log('   The seat holder will now use this session automatically.');
            console.log('   Run: npm run worker:prod  to start monitoring.\n');
        } catch (err) {
            console.error('\n❌ Session setup failed:', (err as Error).message);
            process.exit(1);
        }
        process.exit(0);
    });

program.parse();
