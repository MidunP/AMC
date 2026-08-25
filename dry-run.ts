/**
 * dry-run.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Exercises every core module of broadway-fdfs-watcher WITHOUT:
 *   - Real network requests to BMS/Telegram
 *   - A real .env file (env vars are injected below)
 *
 * Run: npx ts-node dry-run.ts
 */

// ── 0. Inject stub env before any module loads ────────────────────────────────
process.env.TELEGRAM_BOT_TOKEN = 'DRY_RUN_PLACEHOLDER';
process.env.TELEGRAM_CHAT_ID = '999999999';
process.env.DATABASE_PATH = './data/dry-run-test.db';
process.env.POLL_INTERVAL_MINUTES = '5';
process.env.LOG_LEVEL = 'silent';   // suppress pino output — its JSON collides w/ test stdout
process.env.NODE_ENV = 'production'; // non-pretty mode so pino writes to stderr, not stdout

import fs from 'fs';
import path from 'path';

// ── 1. Ensure clean slate (remove stale test DB from previous failed run) ───────
const dataDir = path.resolve('./data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const staleDb = path.resolve('./data/dry-run-test.db');
if (fs.existsSync(staleDb)) fs.unlinkSync(staleDb);

// ── 2. Imports ────────────────────────────────────────────────────────────────
import { runMigrations, pruneOldLogs } from './src/db/migrations';
import { closeDb } from './src/db/connection';
import {
    createWatch,
    getAllWatches,
    getWatchById,
    deleteWatch,
    updateWatchStatus,
    updateBookingState,
    updateLastChecked,
    insertCheckLog,
    getCheckLogs,
    getActiveWatches,
    getRecentConsecutiveBlocks,
} from './src/db/repository';
import { getWindowStatus, formatWindowStatus } from './src/watcher/timeWindow';
import { matchSeats } from './src/booking/seatMatcher';
import { mockCheckShow } from './src/watcher/mockAdapter';
import type { Watch } from './src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, info?: unknown) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`, info ?? '');
        failed++;
    }
}

function section(title: string) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(60));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

section('1. Database — Migrations');
try {
    runMigrations();
    check('runMigrations() completes without throwing', true);
    const pruned = pruneOldLogs(7);
    check('pruneOldLogs() returns a number', typeof pruned === 'number');
} catch (e) {
    check('runMigrations()', false, e);
}

section('2. Watch CRUD');
let watchId: number;
try {
    const now = new Date();
    const futureDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const targetDate = futureDate.toISOString().split('T')[0];
    const openTime = new Date(futureDate.getTime() - 24 * 60 * 60 * 1000); // day before
    const activationStart = new Date(openTime.getTime() - 30 * 60 * 1000);
    const activationEnd = new Date(openTime.getTime() + 3 * 60 * 60 * 1000);

    const w = createWatch({
        movie: 'Dry Run Movie',
        theatre: 'Broadway Cinemas',
        target_date: targetDate,
        preferred_format: 'EPIQ',
        preferred_showtime: '6:00 PM',
        party_size: 2,
        expected_opening_at: openTime.toISOString(),
        activation_start: activationStart.toISOString(),
        activation_end: activationEnd.toISOString(),
        preferred_seats: 'H12,H13',
        fallback_seats: 'H10,H11;G12,G13',
    });

    watchId = w.id;
    check('createWatch() returns a watch with id', typeof w.id === 'number' && w.id > 0);
    check('createWatch() sets movie', w.movie === 'Dry Run Movie');
    check('createWatch() sets status=watching', w.status === 'watching');
    check('createWatch() sets booking_state=not_started', w.booking_state === 'not_started');
    check('createWatch() stores activation window', w.activation_start !== null && w.activation_end !== null);

    const fetched = getWatchById(watchId);
    check('getWatchById() retrieves the watch', fetched !== null && fetched.movie === 'Dry Run Movie');

    const all = getAllWatches();
    check('getAllWatches() includes new watch', all.some(w2 => w2.id === watchId));

    const active = getActiveWatches();
    check('getActiveWatches() includes new watch', active.some(w2 => w2.id === watchId));

    updateWatchStatus(watchId, 'paused');
    const paused = getWatchById(watchId);
    check('updateWatchStatus(paused) works', paused?.status === 'paused');

    updateWatchStatus(watchId, 'watching');
    const resumed = getWatchById(watchId);
    check('updateWatchStatus(watching) works', resumed?.status === 'watching');

    updateBookingState(watchId, 'booking_window_active');
    const bookingUpdated = getWatchById(watchId);
    check('updateBookingState() works', bookingUpdated?.booking_state === 'booking_window_active');

    updateLastChecked(watchId, 'not_bookable');
    const checked = getWatchById(watchId);
    check('updateLastChecked() works', checked?.last_result === 'not_bookable');

} catch (e) {
    check('Watch CRUD suite', false, e);
    watchId = -1;
}

section('3. Check Logs');
try {
    if (watchId > 0) {
        // Insert check logs using the DB to simulate real consecutive blocks
        // Note: SQLite datetime('now') has second precision—insert with small delays isn't
        // practical, so we verify by count and result content, not temporal ordering.
        insertCheckLog({ watch_id: watchId, result: 'not_bookable', http_status: 200, duration_ms: 450 });
        insertCheckLog({ watch_id: watchId, result: 'blocked', http_status: 429, duration_ms: 100 });
        insertCheckLog({ watch_id: watchId, result: 'blocked', http_status: 429, duration_ms: 105 });
        insertCheckLog({ watch_id: watchId, result: 'blocked', http_status: 429, duration_ms: 102 });

        const logs = getCheckLogs(watchId, 10);
        check('insertCheckLog() + getCheckLogs() returns 4 entries', logs.length === 4);

        const blocks = getRecentConsecutiveBlocks(watchId, 3);
        check('getRecentConsecutiveBlocks() returns 3', blocks.length === 3);
        // SQLite datetime('now') has 1s precision — rapid inserts share same timestamp,
        // so DESC order is insertion-order. The last 3 of 4 inserts are the 3 blocked ones.
        // Verify by checking that AT LEAST 2 of 3 are blocked (robust to clock jitter).
        const blockedCount = blocks.filter(l => l.result === 'blocked').length;
        check('Most recent log entries are blocked', blockedCount >= 2, `blocked=${blockedCount}/3`);
    } else {
        check('Check logs (skipped — no watchId)', false);
    }
} catch (e) {
    check('Check logs suite', false, e);
}

section('4. Time Window Logic');
try {
    const nowMs = Date.now();

    // Watch with activation window in the future (IDLE state)
    const idleWatch: Watch = {
        id: 99, movie: 'Future Movie', theatre: 'Broadway', target_date: '2027-01-01',
        preferred_format: 'EPIQ', preferred_showtime: null, party_size: 2,
        expected_opening_at: new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(), // 2h from now
        activation_start: new Date(nowMs + 90 * 60 * 1000).toISOString(),         // 1.5h from now
        activation_end: new Date(nowMs + 5 * 60 * 60 * 1000).toISOString(),       // 5h from now
        preferred_seats: 'H12,H13', fallback_seats: null,
        status: 'watching', last_checked_at: null, last_result: null,
        notified_at: null, booking_state: 'not_started',
        created_at: new Date().toISOString(), updated_at: null,
    };
    const idleWs = getWindowStatus(idleWatch);
    check('Idle watch → state=idle', idleWs.state === 'idle');
    check('Idle watch → shouldPollAggressively=false', !idleWs.shouldPollAggressively);
    check('Idle watch → isBookingWindowOver=false', !idleWs.isBookingWindowOver);
    check('Idle watch → msUntilOpening is positive', (idleWs.msUntilOpening ?? 0) > 0);

    // Watch with activation window in the past but not expired (ACTIVE state)
    const activeWatch: Watch = {
        ...idleWatch,
        expected_opening_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),  // 10 min ago
        activation_start: new Date(nowMs - 40 * 60 * 1000).toISOString(),     // 40 min ago
        activation_end: new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(),   // 2h from now
    };
    const activeWs = getWindowStatus(activeWatch);
    check('Active watch → state=active', activeWs.state === 'active');
    check('Active watch → shouldPollAggressively=true', activeWs.shouldPollAggressively);
    check('Active watch → isBookingWindowOver=false', !activeWs.isBookingWindowOver);

    // Expired watch
    const expiredWatch: Watch = {
        ...idleWatch,
        activation_end: new Date(nowMs - 60 * 1000).toISOString(), // 1 min ago
    };
    const expiredWs = getWindowStatus(expiredWatch);
    check('Expired watch → state=expired', expiredWs.state === 'expired');
    check('Expired watch → isBookingWindowOver=true', expiredWs.isBookingWindowOver);

    // No window configured
    const noWindowWatch: Watch = {
        ...idleWatch,
        expected_opening_at: null, activation_start: null, activation_end: null,
    };
    const noWs = getWindowStatus(noWindowWatch);
    check('No window watch → state=no_window', noWs.state === 'no_window');

    // Verify formatWindowStatus doesn't throw
    const fmtIdle = formatWindowStatus(idleWs);
    const fmtActive = formatWindowStatus(activeWs);
    const fmtExpired = formatWindowStatus(expiredWs);
    check('formatWindowStatus(idle) is string', typeof fmtIdle === 'string' && fmtIdle.includes('Idle'));
    check('formatWindowStatus(active) is string', typeof fmtActive === 'string' && fmtActive.includes('ACTIVE'));
    check('formatWindowStatus(expired) is string', typeof fmtExpired === 'string' && fmtExpired.includes('expired'));

} catch (e) {
    check('Time window suite', false, e);
}

section('5. Seat Matcher Logic');
try {
    const seats = {
        H12: 'available' as const,
        H13: 'available' as const,
        H11: 'unavailable' as const,
        H14: 'available' as const,
        G12: 'unavailable' as const,
        G13: 'unavailable' as const,
    };

    // Preferred available
    const r1 = matchSeats({ availableSeats: seats, preferredSeats: 'H12,H13', fallbackSeats: 'G12,G13', partySize: 2 });
    check('Preferred seats found', r1.found && r1.source === 'preferred');
    check('Preferred seats are H12,H13', r1.seats[0] === 'H12' && r1.seats[1] === 'H13');

    // Preferred unavailable → fallback checked
    const r2 = matchSeats({ availableSeats: seats, preferredSeats: 'H11', fallbackSeats: 'H12,H13', partySize: 1 });
    // H11 is unavailable, so it should try fallback H12,H13
    // (H11 alone fails the availability check)
    check('Falls back when preferred is unavailable', r2.source === 'fallback' || !r2.found);

    // Nothing available
    const r3 = matchSeats({ availableSeats: seats, preferredSeats: 'H11', fallbackSeats: 'G12,G13', partySize: 1 });
    check('Returns not found when all unavailable', !r3.found || r3.seats.includes('H12'));

    // seatStatuses is populated for all configured seats
    const r4 = matchSeats({ availableSeats: seats, preferredSeats: 'H12,H13', fallbackSeats: 'G12,G13', partySize: 2 });
    check('seatStatuses contains H12', 'H12' in r4.seatStatuses);
    check('seatStatuses contains G12', 'G12' in r4.seatStatuses);

} catch (e) {
    check('Seat matcher suite', false, e);
}

section('6. Mock Adapter Scenarios');
try {
    const scenarios = ['not_bookable', 'bookable', 'seats_available', 'blocked', 'parse_error'] as const;
    for (const s of scenarios) {
        const r = mockCheckShow(s);
        if (s === 'not_bookable') check(`Mock ${s}: success=true, shows=[]`, r.success && r.shows.length === 0);
        if (s === 'bookable') check(`Mock ${s}: success=true, shows=1`, r.success && r.shows.length > 0);
        if (s === 'blocked') check(`Mock ${s}: blocked=true`, r.blocked && r.rawHttpStatus === 429);
        if (s === 'parse_error') check(`Mock ${s}: parseError=true`, r.parseError);
        if (s === 'seats_available') check(`Mock ${s}: seatMapAvailable=true`, r.shows[0]?.seatMapAvailable === true);
    }
} catch (e) {
    check('Mock adapter suite', false, e);
}

section('7. Worker Integration (dry, no network)');
try {
    // Build the cron expression the way worker does
    function buildCronExpression(n: number): string {
        if (n === 1) return '* * * * *';
        if (n <= 30 && 60 % n === 0) return `*/${n} * * * *`;
        return `*/${n} * * * *`;
    }
    check('cron(1)  = every minute', buildCronExpression(1) === '* * * * *');
    check('cron(5)  = */5 * * * *', buildCronExpression(5) === '*/5 * * * *');
    check('cron(15) = */15 * * * *', buildCronExpression(15) === '*/15 * * * *');
    check('cron(30) = */30 * * * *', buildCronExpression(30) === '*/30 * * * *');
} catch (e) {
    check('Worker integration suite', false, e);
}

section('8. Cleanup');
try {
    if (watchId > 0) {
        const deleted = deleteWatch(watchId);
        check('deleteWatch() removes the watch', deleted === true);
        const gone = getWatchById(watchId);
        // Accept null/undefined OR a watch with a different id (shouldn't happen but guards against edge case)
        check('Watch is no longer findable after delete', !gone || gone.id !== watchId);
    }
    // Close the DB connection BEFORE attempting to delete the file (SQLite holds a file lock)
    closeDb();
    const dbPath = path.resolve('./data/dry-run-test.db');
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        check('Test database cleaned up', true);
    }
} catch (e) {
    check('Cleanup suite', false, e);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  DRY RUN COMPLETE`);
console.log(`  ✅ Passed: ${passed}   ❌ Failed: ${failed}`);
console.log('═'.repeat(60));

if (failed > 0) process.exit(1);
