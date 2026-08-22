import type { Watch, CheckResult, MovieShow } from '../types';
import {
    getActiveWatches,
    insertCheckLog,
    updateLastChecked,
    updateBookingState,
    markNotified,
    getRecentConsecutiveBlocks,
    insertBookingAttempt,
} from '../db/repository';
import { checkBroadwayShowtimes } from '../cinema/broadway/broadway.adapter';
import { matchSeats } from '../booking/seatMatcher';
import { attemptSeatHold } from '../booking/booking.service';
import { getWindowStatus, formatWindowStatus } from './timeWindow';
import {
    sendTicketLive,
    sendSeatsHeld,
    sendBlockedWarning,
    sendParserError,
    sendApproachingAlert,
} from '../notify/telegram';
import { getLogger } from '../config/logger';

const log = getLogger('watcher');

// ─── Per-watch cooldown trackers (in-memory) ──────────────────────────────────

/** Last time a "blocked" Telegram alert was sent per watch (30 min cooldown) */
const lastBlockedAlert: Map<number, number> = new Map();
const BLOCKED_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Last time an idle background poll ran per watch.
 * During IDLE state the watcher still checks every 30 min to catch early releases.
 */
const lastIdlePoll: Map<number, number> = new Map();
const IDLE_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Last time a "booking opens soon" alert was sent per watch.
 * Sent once when msUntilOpening drops below 60 minutes.
 */
const lastApproachAlert: Map<number, number> = new Map();
const APPROACH_ALERT_THRESHOLD_MS = 60 * 60 * 1000;  // fire when < 60 min away
const APPROACH_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // max once per 4 hours

// ─── Main cycle ───────────────────────────────────────────────────────────────

export async function runWatchCycle(): Promise<void> {
    const watches = getActiveWatches();
    log.info({ count: watches.length }, 'Starting watch cycle');

    if (watches.length === 0) {
        log.info('No active watches');
        return;
    }

    for (let i = 0; i < watches.length; i++) {
        const watch = watches[i];
        try {
            await processWatch(watch);
        } catch (err) {
            log.error(
                { watchId: watch.id, movie: watch.movie, err },
                'Unhandled error in watch — continuing other watches'
            );
        }

        // Stagger requests between watches (500ms – 2s)
        if (i < watches.length - 1) {
            await sleep(500 + Math.random() * 1500);
        }
    }
}

// ─── Per-watch processor ─────────────────────────────────────────────────────

async function processWatch(watch: Watch): Promise<void> {
    const now = new Date();
    const ws = getWindowStatus(watch, now);

    log.info(
        { watchId: watch.id, movie: watch.movie, windowState: ws.state },
        `Processing watch — ${formatWindowStatus(ws)}`
    );

    // ── Window completely over ─────────────────────────────────────────────────
    if (ws.isBookingWindowOver) {
        log.info({ watchId: watch.id }, 'Booking window expired — watch will be retired');
        return;
    }

    // ── IDLE STATE — low-frequency background scan ────────────────────────────
    //
    // Even during idle we poll every 30 min because sometimes BMS opens tickets
    // hours before the announced time. We also send a "heads-up" alert when the
    // booking time is less than 60 minutes away.
    if (ws.state === 'idle') {

        // Pre-opening alert: send once when < 60 min to opening
        if (ws.msUntilOpening !== null && ws.msUntilOpening < APPROACH_ALERT_THRESHOLD_MS) {
            const lastAlert = lastApproachAlert.get(watch.id) ?? 0;
            if (Date.now() - lastAlert > APPROACH_ALERT_COOLDOWN_MS) {
                const minutes = Math.ceil(ws.msUntilOpening / 60000);
                await sendApproachingAlert({
                    movie: watch.movie,
                    minutesUntilOpening: minutes,
                    expectedOpeningAt: watch.expected_opening_at!,
                });
                lastApproachAlert.set(watch.id, Date.now());
                log.info({ watchId: watch.id, minutes }, 'Approaching opening alert sent');
            }
        }

        // Throttle idle background checks to once every 30 min
        const lastIdle = lastIdlePoll.get(watch.id) ?? 0;
        if (Date.now() - lastIdle < IDLE_POLL_INTERVAL_MS) {
            log.debug({ watchId: watch.id }, 'Idle — last poll was recent, skipping this cycle');
            return;
        }

        log.info({ watchId: watch.id }, 'Idle — running background check (30-min interval)');
        lastIdlePoll.set(watch.id, Date.now());
        // Fall through → do the actual HTTP check below
    }

    // ── ACTIVE / ACTIVATING / NO_WINDOW — aggressive polling ─────────────────
    // shouldCheckNow returns false for idle (we already handled that above).
    if (ws.state !== 'idle' && ws.state !== 'no_window') {
        // activating / active — check aggressively (every poll-interval cycle)
        if (!ws.shouldPollAggressively) {
            log.debug({ watchId: watch.id, windowState: ws.state }, 'Outside check window — skipping');
            return;
        }
    }

    // ── Do the actual BookMyShow check ────────────────────────────────────────

    const start = Date.now();
    const result = await checkBroadwayShowtimes(watch);
    const duration = Date.now() - start;

    // ── Handle blocking ───────────────────────────────────────────────────────

    if (result.blocked) {
        log.warn({ watchId: watch.id, httpStatus: result.rawHttpStatus }, 'Request blocked');

        insertCheckLog({
            watch_id: watch.id,
            result: 'blocked',
            http_status: result.rawHttpStatus,
            notes: result.errorMessage,
            duration_ms: duration,
        });
        updateLastChecked(watch.id, 'blocked');
        updateBookingState(watch.id, 'blocked');

        const recent = getRecentConsecutiveBlocks(watch.id, 3);
        const allBlocked = recent.length >= 3 && recent.every((l) => l.result === 'blocked');
        if (allBlocked) {
            const lastAlert = lastBlockedAlert.get(watch.id) ?? 0;
            if (Date.now() - lastAlert > BLOCKED_ALERT_COOLDOWN_MS) {
                await sendBlockedWarning({ movie: watch.movie, watchId: watch.id });
                lastBlockedAlert.set(watch.id, Date.now());
            }
        }
        return;
    }

    // ── Handle parse errors ───────────────────────────────────────────────────

    if (result.parseError) {
        log.error({ watchId: watch.id }, 'Parse error — cannot determine availability');

        insertCheckLog({
            watch_id: watch.id,
            result: 'parse_error',
            http_status: result.rawHttpStatus,
            notes: result.errorMessage,
            duration_ms: duration,
        });
        updateLastChecked(watch.id, 'parse_error');

        await sendParserError({ movie: watch.movie, watchId: watch.id });
        return;
    }

    // ── Not bookable yet ──────────────────────────────────────────────────────

    if (!result.success || result.shows.length === 0) {
        log.info({ watchId: watch.id, windowState: ws.state }, 'No bookable shows found — still watching');
        insertCheckLog({
            watch_id: watch.id,
            result: 'not_bookable',
            http_status: result.rawHttpStatus,
            duration_ms: duration,
        });
        updateLastChecked(watch.id, 'not_bookable');

        // Only update booking_state to active if we're in the booking window
        if (ws.state === 'activating' || ws.state === 'active') {
            updateBookingState(watch.id, 'booking_window_active');
        }
        return;
    }

    // ── 🎉 SHOW IS BOOKABLE! ──────────────────────────────────────────────────

    const show = result.shows[0];
    log.info({ watchId: watch.id, bookingUrl: show.bookingUrl }, '🎬 Show is BOOKABLE!');

    insertCheckLog({
        watch_id: watch.id,
        result: 'bookable',
        http_status: result.rawHttpStatus,
        notes: `Found: ${show.movie} @ ${show.theatre} ${show.showtime}`,
        duration_ms: duration,
    });
    updateLastChecked(watch.id, 'bookable');
    updateBookingState(watch.id, 'bookable');

    // ── Seat matching ─────────────────────────────────────────────────────────

    const seatMatch = matchSeats({
        availableSeats: {}, // Phase 10 seat map feeds into this when available
        preferredSeats: watch.preferred_seats,
        fallbackSeats: watch.fallback_seats,
        partySize: watch.party_size,
    });

    updateBookingState(watch.id, 'seat_check');

    // ── Optional: Phase 10 capability check + seat hold ──────────────────────

    const holdResult = await attemptSeatHold(show, seatMatch, watch.id, watch.fallback_seats);

    insertBookingAttempt({
        watch_id: watch.id,
        attempted_at: new Date().toISOString(),
        show_identifier: show.showId,
        seat_selection: seatMatch.seats.join(','),
        result: holdResult.held ? 'booking_held' : 'booking_not_supported',
        booking_url: holdResult.continuationUrl,
        hold_detected: holdResult.held ? 1 : 0,
        notes: holdResult.notes,
    });

    if (holdResult.held && holdResult.continuationUrl) {
        updateBookingState(watch.id, 'booking_held');
        insertCheckLog({ watch_id: watch.id, result: 'booking_held', duration_ms: duration });

        await sendSeatsHeld({
            movie: watch.movie,
            theatre: watch.theatre,
            format: watch.preferred_format ?? 'Standard',
            showtime: show.showtime,
            seats: seatMatch.seats,
            continuationUrl: holdResult.continuationUrl,
        });

        updateBookingState(watch.id, 'user_payment_required');
    } else {
        // Notification-only flow — send TICKETS LIVE alert
        updateBookingState(watch.id, 'notification_sent');
        insertCheckLog({ watch_id: watch.id, result: 'booking_not_supported', duration_ms: duration });

        const preferredSeats = watch.preferred_seats
            ? watch.preferred_seats.split(',').map((s) => s.trim())
            : [];

        await sendTicketLive({
            movie: watch.movie,
            theatre: watch.theatre,
            date: watch.target_date,
            format: watch.preferred_format ?? 'Standard',
            showtime: show.showtime,
            preferredSeats,
            seatStatus: seatMatch.seatStatuses,
            bookingUrl: show.bookingUrl ?? 'https://in.bookmyshow.com',
        });

        updateBookingState(watch.id, 'user_takeover');
    }

    markNotified(watch.id);
    log.info({ watchId: watch.id }, '✅ Notification sent — user takes over');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
