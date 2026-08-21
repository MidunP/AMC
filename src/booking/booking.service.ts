import type { BookingCapabilities, MovieShow, SeatSelectionResult } from '../types';
import { getLogger } from '../config/logger';

const log = getLogger('booking-service');

/**
 * Booking Capability Detection & Optional Seat Hold
 *
 * IMPORTANT: Payment is NEVER automated. The system stops before payment.
 *
 * Capability detection happens step-by-step:
 * 1. Can we get the seat map? (seatMap)
 * 2. Can we select seats? (seatSelection)
 * 3. Does the flow enter a temporary hold state? (seatHold)
 * 4. Is there a resumable booking URL? (resumableBookingSession)
 * 5. Payment → NEVER_SUPPORTED (hard-coded)
 *
 * If any step fails or requires bypassing security: return BOOKING_NOT_SUPPORTED.
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

/**
 * Attempts to detect whether an actual legitimate seat hold is possible.
 *
 * Currently returns NOT_SUPPORTED because:
 * - The legitimate BMS booking flow requires user authentication.
 * - Phase 10 of the spec requires this to be tested against real shows first.
 * - Automated seat holding will NOT be implemented without validating the full
 *   legitimate flow against a real low-demand show.
 *
 * This function is the extension point for Phase 10.
 */
export async function attemptSeatHold(
    show: MovieShow,
    seatSelection: SeatSelectionResult,
    _watchId: number
): Promise<BookingAttemptResult> {
    log.info(
        { showId: show.showId, seats: seatSelection.seats },
        'Seat hold attempted — checking capabilities'
    );

    // Phase 10: validate legitimate booking flow capability first.
    // Until validated against a real show, this must return not_supported.
    const capabilities: BookingCapabilities = {
        ...DEFAULT_CAPABILITIES,
        seatMap: 'unknown',
        seatSelection: 'unknown',
        seatHold: 'not_supported', // Will be updated when Phase 10 is implemented
        resumableBookingSession: 'not_supported',
        payment: 'never_supported',
    };

    log.warn(
        { showId: show.showId },
        'Automated seat hold is not yet validated — falling back to notification-only flow'
    );

    return {
        supported: false,
        held: false,
        continuationUrl: show.bookingUrl,
        capabilities,
        notes:
            'Seat hold capability not yet validated against legitimate booking flow. See Phase 10 in spec.',
    };
}

export { DEFAULT_CAPABILITIES };
