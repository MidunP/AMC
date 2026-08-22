import type { BookingCapabilities, MovieShow, SeatSelectionResult } from '../types';
import { loadBmsSession, hasSession } from './browserSession';
import { holdSeatsAutomated, parseFallbackGroups } from './seatHolder';
import { getLogger } from '../config/logger';

const log = getLogger('booking-service');

/**
 * Booking Service — Phase 10 + Browser Automation
 *
 * INVARIANTS (cannot be changed at runtime):
 *   ❌ Payment is NEVER automated
 *   ❌ Credentials are NEVER stored (only BMS session cookies via storageState)
 *   ❌ No anti-bot evasion — uses real user session
 *   ✅ Only goes as far as the BMS order-summary/payment page
 *   ✅ Returns a continuation URL the user taps to complete payment
 *
 * Flow:
 *   1. If session file exists → try real browser-automated seat hold
 *   2. If hold succeeds → return order URL (direct payment link)
 *   3. If anything fails → fall back to notification-only (send booking link)
 *
 * Session setup (one-time): npm run session:setup
 */

export interface BookingAttemptResult {
    supported: boolean;
    held: boolean;
    continuationUrl: string | null;
    capabilities: BookingCapabilities;
    notes: string;
}

const DEFAULT_CAPABILITIES: BookingCapabilities = {
    seatMap: 'unknown',
    seatSelection: 'unknown',
    seatHold: 'unknown',
    resumableBookingSession: 'unknown',
    payment: 'never_supported',
};

export async function attemptSeatHold(
    show: MovieShow,
    seatSelection: SeatSelectionResult,
    _watchId: number,
    fallbackSeatsStr?: string | null
): Promise<BookingAttemptResult> {

    // ── Path A: Real automated seat hold (requires session setup) ─────────────
    if (hasSession() && show.bookingUrl && show.bookable) {

        const seatsToHold = seatSelection.found && seatSelection.seats.length > 0
            ? seatSelection.seats
            : []; // Will try all fallback groups if preferred empty

        const fallbackGroups = parseFallbackGroups(fallbackSeatsStr ?? null);

        log.info(
            { showId: show.showId, seats: seatsToHold, fallbackGroups: fallbackGroups.length },
            '🎭 Attempting real browser-automated seat hold'
        );

        try {
            const session = await loadBmsSession();

            if (session) {
                const holdResult = await holdSeatsAutomated(
                    session.context,
                    show,
                    seatsToHold,
                    fallbackGroups
                );

                // Always close the browser after we're done
                await session.browser.close().catch(() => { });

                if (holdResult.held && holdResult.orderUrl) {
                    // ✅ SUCCESS — seats are held, user just needs to pay
                    const capabilities: BookingCapabilities = {
                        seatMap: 'supported',
                        seatSelection: 'supported',
                        seatHold: 'supported',
                        resumableBookingSession: 'supported',
                        payment: 'never_supported',
                    };

                    const seatStr = holdResult.seatsSelected.join(' + ');
                    log.info({ seats: holdResult.seatsSelected, orderUrl: holdResult.orderUrl }, '✅ Seats held');

                    return {
                        supported: true,
                        held: true,
                        continuationUrl: holdResult.orderUrl,
                        capabilities,
                        notes: [
                            `✅ Seats ${seatStr} are HELD`,
                            `⏳ BMS hold timer: ~10 minutes`,
                            `💳 Open the Telegram link NOW to pay`,
                            `🔒 Payment: user-driven only`,
                            `🔗 Order URL: ${holdResult.orderUrl}`,
                        ].join('\n'),
                    };
                }

                // Hold failed — log the reason and fall through to notification-only
                log.warn(
                    { error: holdResult.error, seats: holdResult.seatsSelected },
                    'Seat hold attempt failed — falling back to notification-only'
                );
            }
        } catch (err) {
            log.error({ err }, 'Browser automation threw — falling back to notification-only');
        }
    } else if (!hasSession()) {
        log.info('No BMS session configured — notification-only mode. Run: npm run session:setup');
    }

    // ── Path B: Notification-only (no session, or hold failed) ───────────────
    // Send the TICKETS LIVE message with a direct booking link.
    // User opens it and manually selects seats + pays.

    log.info({ showId: show.showId }, 'Notification-only mode — returning booking URL');

    const capabilities: BookingCapabilities = {
        seatMap: 'unknown',
        seatSelection: hasSession() ? 'not_supported' : 'unknown',
        seatHold: 'not_supported',
        resumableBookingSession: show.bookingUrl ? 'supported' : 'not_supported',
        payment: 'never_supported',
    };

    return {
        supported: false,
        held: false,
        continuationUrl: show.bookingUrl,
        capabilities,
        notes: hasSession()
            ? 'Seat hold attempted but failed (seats may have been grabbed). Notification sent with booking link.'
            : 'No BMS session — notification-only mode. Run: npm run session:setup to enable auto-hold.',
    };
}

export { DEFAULT_CAPABILITIES };
