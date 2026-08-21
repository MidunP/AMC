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
import { checkBroadwayShowtimes } from '../cinema/broadway/broadway.adapter';
import { insertCheckLog, updateLastChecked } from '../db/repository';

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
    .option('--open <datetime>', 'Expected booking opening time (ISO 8601)')
    .option('--active-from <datetime>', 'Activation window start (ISO 8601)')
    .option('--active-until <datetime>', 'Activation window end (ISO 8601)')
    .option('--seats <seats>', 'Preferred seats, comma-separated (e.g. "H12,H13")')
    .option('--fallback <seats>', 'Fallback seat groups, semicolon-separated (e.g. "H11,H12;G12,G13")')
    .action((opts) => {
        runMigrations();

        const watch = createWatch({
            movie: opts.movie,
            theatre: opts.theatre,
            target_date: opts.date,
            preferred_format: opts.format ?? null,
            preferred_showtime: opts.showtime ?? null,
            party_size: parseInt(opts.partySize, 10),
            expected_opening_at: opts.open ?? null,
            activation_start: opts.activeFrom ?? null,
            activation_end: opts.activeUntil ?? null,
            preferred_seats: opts.seats ?? null,
            fallback_seats: opts.fallback ?? null,
        });

        console.log('');
        console.log('✅ Watch added!');
        console.log(`   ID:       ${watch.id}`);
        console.log(`   Movie:    ${watch.movie}`);
        console.log(`   Theatre:  ${watch.theatre}`);
        console.log(`   Date:     ${watch.target_date}`);
        console.log(`   Format:   ${watch.preferred_format ?? 'Any'}`);
        console.log(`   Seats:    ${watch.preferred_seats ?? 'Not configured'}`);
        console.log(`   Opens:    ${watch.expected_opening_at ?? 'Not configured'}`);
        console.log('');
    });

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

program.parse();
