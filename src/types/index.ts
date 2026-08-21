// ─── Watch States ──────────────────────────────────────────────────────────────

export type WatchStatus =
    | 'watching'
    | 'paused'
    | 'expired'
    | 'error'
    | 'notified';

export type BookingState =
    | 'not_started'
    | 'booking_window_active'
    | 'bookable'
    | 'seat_check'
    | 'seats_unavailable'
    | 'seats_available'
    | 'booking_attempted'
    | 'booking_held'
    | 'user_payment_required'
    | 'notification_sent'
    | 'user_takeover'
    | 'blocked'
    | 'ready';

// ─── Check Results ─────────────────────────────────────────────────────────────

export type CheckResult =
    | 'bookable'
    | 'not_bookable'
    | 'blocked'
    | 'parse_error'
    | 'seat_available'
    | 'seat_unavailable'
    | 'booking_attempted'
    | 'booking_not_supported'
    | 'booking_failed'
    | 'booking_held';

// ─── Watch Record ──────────────────────────────────────────────────────────────

export interface Watch {
    id: number;
    movie: string;
    theatre: string;
    target_date: string;
    preferred_format: string | null;
    preferred_showtime: string | null;
    party_size: number;
    expected_opening_at: string | null;
    activation_start: string | null;
    activation_end: string | null;
    preferred_seats: string | null;
    fallback_seats: string | null;
    status: WatchStatus;
    last_checked_at: string | null;
    last_result: CheckResult | null;
    notified_at: string | null;
    booking_state: BookingState;
    created_at: string;
    updated_at: string | null;
}

// ─── Check Log ─────────────────────────────────────────────────────────────────

export interface CheckLog {
    id: number;
    watch_id: number;
    checked_at: string;
    result: CheckResult;
    http_status: number | null;
    notes: string | null;
}

// ─── Booking Attempt ───────────────────────────────────────────────────────────

export interface BookingAttempt {
    id: number;
    watch_id: number;
    attempted_at: string;
    show_identifier: string | null;
    seat_selection: string | null;
    result: string | null;
    booking_url: string | null;
    hold_detected: 0 | 1;
    notes: string | null;
}

// ─── Normalized Show ───────────────────────────────────────────────────────────

export interface MovieShow {
    movie: string;
    theatre: string;
    date: string;
    format: string | null;
    language: string | null;
    showtime: string;
    showId: string | null;
    bookingUrl: string | null;
    bookable: boolean;
    availability: 'available' | 'sold_out' | 'coming_soon' | 'unknown';
    seatMapAvailable: boolean;
}

// ─── Seat Matching ─────────────────────────────────────────────────────────────

export type SeatStatus = 'available' | 'unavailable' | 'unknown';

export interface SeatSelectionResult {
    found: boolean;
    seats: string[];
    source: 'preferred' | 'fallback' | 'none';
    fallbackIndex?: number;
    seatStatuses: Record<string, SeatStatus>;
}

// ─── Booking Capabilities ──────────────────────────────────────────────────────

export type Capability = 'supported' | 'not_supported' | 'unknown';

export interface BookingCapabilities {
    seatMap: Capability;
    seatSelection: Capability;
    seatHold: Capability;
    resumableBookingSession: Capability;
    payment: 'never_supported'; // ALWAYS never_supported
}

// ─── Adapter Response ──────────────────────────────────────────────────────────

export interface AdapterResult {
    success: boolean;
    shows: MovieShow[];
    rawHttpStatus?: number;
    blocked: boolean;
    parseError: boolean;
    errorMessage?: string;
}

// ─── Notification Payload ──────────────────────────────────────────────────────

export interface TicketLivePayload {
    movie: string;
    theatre: string;
    date: string;
    format: string;
    showtime: string;
    preferredSeats: string[];
    seatStatus: Record<string, SeatStatus>;
    bookingUrl: string;
}

export interface SeatsHeldPayload {
    movie: string;
    theatre: string;
    format: string;
    showtime: string;
    seats: string[];
    continuationUrl: string;
}
