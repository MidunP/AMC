import type { AdapterResult, MovieShow } from '../types';

/**
 * Mock adapter for Phase 5 testing.
 * Simulates all possible adapter outcomes without making real HTTP requests.
 */

export type MockScenario =
    | 'not_bookable'
    | 'bookable'
    | 'seats_available'
    | 'seats_unavailable'
    | 'blocked'
    | 'parse_error'
    | 'booking_not_supported'
    | 'booking_held';

const MOCK_SHOW: MovieShow = {
    movie: 'Avengers: Doomsday',
    theatre: 'Broadway Cinemas',
    date: '2026-12-18',
    format: 'EPIQ',
    language: 'English',
    showtime: '6:00 PM',
    showId: 'MOCK-SHOW-001',
    bookingUrl: 'https://in.bookmyshow.com/buytickets/avengers-doomsday-english/BWCO',
    bookable: true,
    availability: 'available',
    seatMapAvailable: true,
};

export function mockCheckShow(scenario: MockScenario = 'not_bookable'): AdapterResult {
    switch (scenario) {
        case 'not_bookable':
            return {
                success: true,
                shows: [],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
            };

        case 'bookable':
            return {
                success: true,
                shows: [{ ...MOCK_SHOW, seatMapAvailable: false }],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
            };

        case 'seats_available':
            return {
                success: true,
                shows: [{ ...MOCK_SHOW, seatMapAvailable: true }],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
            };

        case 'seats_unavailable':
            return {
                success: true,
                shows: [{ ...MOCK_SHOW, seatMapAvailable: true }],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
            };

        case 'blocked':
            return {
                success: false,
                shows: [],
                rawHttpStatus: 429,
                blocked: true,
                parseError: false,
                errorMessage: 'Rate limited by provider',
            };

        case 'parse_error':
            return {
                success: false,
                shows: [],
                rawHttpStatus: 200,
                blocked: false,
                parseError: true,
                errorMessage: 'HTML structure changed — parser failed',
            };

        case 'booking_not_supported':
            return {
                success: true,
                shows: [MOCK_SHOW],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
                errorMessage: 'Booking capability not supported',
            };

        case 'booking_held':
            return {
                success: true,
                shows: [MOCK_SHOW],
                rawHttpStatus: 200,
                blocked: false,
                parseError: false,
            };
    }
}

/** Mock seat map available for seats_available scenario */
export const MOCK_AVAILABLE_SEAT_MAP: Record<string, 'available' | 'unavailable' | 'unknown'> = {
    H12: 'available',
    H13: 'available',
    H11: 'unavailable',
    H14: 'available',
    G12: 'available',
    G13: 'available',
};

/** Mock seat map for seats_unavailable scenario */
export const MOCK_UNAVAILABLE_SEAT_MAP: Record<string, 'available' | 'unavailable' | 'unknown'> = {
    H12: 'unavailable',
    H13: 'unavailable',
    H11: 'unavailable',
    H14: 'unavailable',
    G12: 'unavailable',
    G13: 'unavailable',
};
