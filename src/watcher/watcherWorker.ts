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
import { shouldCheckNow, getWindowStatus, formatWindowStatus } from './timeWindow';
import {
    sendTicketLive,
    sendSeatsHeld,
    sendSeatUnavailable,
    sendBlockedWarning,
    sendParserError,
} from '../notify/telegram';
import { getEnv } from '../config/env';
import { getLogger } from '../config/logger';

const log = getLogger('watcher');

/** Track last blocked-alert time per watch to avoid spam */
const lastBlockedAlert: Map<number, number> = new Map();
const BLOCKED_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

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
            log.error({ watchId: watch.id, movie: watch.movie, err }, 'Unhandled error in watch — continuing other watches');
        }

        // Stagger requests between watches (500ms–2s)
        if (i < watches.length - 1) {
            const delay = 500 + Math.random() * 1500;
            await sleep(delay);
        }
    }
}

async function processWatch(watch: Watch): Promise<void> {
    const now = new Date();
    const ws = getWindowStatus(watch, now);

    log.info(
        { watchId: watch.id, movie: watch.movie, windowState: ws.state },
        `Processing watch — ${formatWindowStatus(ws)}`
    );

    // Skip if booking window is completely over
    if (ws.isBookingWindowOver) {
        log.info({ watchId: watch.id }, 'Booking window expired — watch will be retired');
        return;
    }

    // Only poll aggressively during the booking window; otherwise idle
    if (!shouldCheckNow(watch, now)) {
        log.debug({ watchId: watch.id, windowState: ws.state }, 'Outside check window — skipping');
        return;
    }

    const start = Date.now();
    const result = await checkBroadwayShowtimes(watch);
    const duration = Date.now() - start;

    // ─── Handle blocking ──────────────────────────────────────────────────────

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

        // Check for 3 consecutive blocks
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

    // ─── Handle parse errors ──────────────────────────────────────────────────

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

    // ─── Not bookable yet ─────────────────────────────────────────────────────

    if (!result.success || result.shows.length === 0) {
        log.info({ watchId: watch.id }, 'No bookable shows found');
        insertCheckLog({
            watch_id: watch.id,
            result: 'not_bookable',
            http_status: result.rawHttpStatus,
            duration_ms: duration,
        });
        updateLastChecked(watch.id, 'not_bookable');
        updateBookingState(watch.id, 'booking_window_active');
        return;
    }

    // ─── Show is bookable! ────────────────────────────────────────────────────

    const show = result.shows[0];
    log.info({ watchId: watch.id, show: show.bookingUrl }, '🎬 Show is BOOKABLE!');

    insertCheckLog({
        watch_id: watch.id,
        result: 'bookable',
        http_status: result.rawHttpStatus,
        notes: `Found: ${show.movie} @ ${show.theatre} ${show.showtime}`,
        duration_ms: duration,
    });
    updateLastChecked(watch.id, 'bookable');
    updateBookingState(watch.id, 'bookable');

    // ─── Seat matching ────────────────────────────────────────────────────────

    // Note: Real seat map requires Phase 9/10. For now use show-level availability.
    const seatMatch = matchSeats({
        availableSeats: {}, // Will be populated from real seat map in Phase 9/10
        preferredSeats: watch.preferred_seats,
        fallbackSeats: watch.fallback_seats,
        partySize: watch.party_size,
    });

    updateBookingState(watch.id, 'seat_check');

    // ─── Optional: attempt seat hold ─────────────────────────────────────────

    const holdResult = await attemptSeatHold(show, seatMatch, watch.id);

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
        // Seats are actually held — send held notification
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
        // Fallback: notification-only flow
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
            bookingUrl: show.bookingUrl ?? `https://in.bookmyshow.com`,
        });

        updateBookingState(watch.id, 'user_takeover');
    }

    markNotified(watch.id);
    log.info({ watchId: watch.id }, '✅ Notification sent — user takes over');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
