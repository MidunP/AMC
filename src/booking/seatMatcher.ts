import type { SeatSelectionResult, SeatStatus } from '../types';
import { getLogger } from '../config/logger';

const log = getLogger('seat-matcher');

/**
 * Seat Preference Engine
 *
 * Checks preferred seats first, then fallback pairs in order.
 * Never selects random seats unless explicitly configured.
 */

export interface SeatMatcherInput {
    /** Available seats from the seat map, keyed by seat label e.g. "H12" */
    availableSeats: Record<string, SeatStatus>;
    /** Comma-separated preferred seats, e.g. "H12,H13" */
    preferredSeats: string | null;
    /** Semicolon-separated fallback seat groups, e.g. "H11,H12;G12,G13" */
    fallbackSeats: string | null;
    partySize: number;
}

function parseSeatsString(raw: string | null): string[][] {
    if (!raw || !raw.trim()) return [];
    return raw
        .split(';')
        .map((group) => group.split(',').map((s) => s.trim()).filter(Boolean))
        .filter((g) => g.length > 0);
}

function checkSeatGroup(seats: string[], available: Record<string, SeatStatus>): boolean {
    return seats.every((seat) => {
        const status = available[seat];
        return status === 'available';
    });
}

export function matchSeats(input: SeatMatcherInput): SeatSelectionResult {
    const { availableSeats, preferredSeats, fallbackSeats, partySize } = input;

    const preferredGroups = parseSeatsString(preferredSeats);
    const fallbackGroups = parseSeatsString(fallbackSeats);

    const seatStatuses: Record<string, SeatStatus> = {};

    // Collect status of all configured seats
    for (const group of [...preferredGroups, ...fallbackGroups]) {
        for (const seat of group) {
            seatStatuses[seat] = availableSeats[seat] ?? 'unknown';
        }
    }

    // 1. Check preferred seats
    for (const group of preferredGroups) {
        if (group.length >= partySize || group.length === partySize) {
            if (checkSeatGroup(group, availableSeats)) {
                log.info({ seats: group }, 'Preferred seats available');
                return {
                    found: true,
                    seats: group,
                    source: 'preferred',
                    seatStatuses,
                };
            }
        }
    }

    // 2. Check fallback pairs in order
    for (let i = 0; i < fallbackGroups.length; i++) {
        const group = fallbackGroups[i];
        if (group.length >= partySize || group.length === partySize) {
            if (checkSeatGroup(group, availableSeats)) {
                log.info({ seats: group, fallbackIndex: i }, 'Fallback seats available');
                return {
                    found: true,
                    seats: group,
                    source: 'fallback',
                    fallbackIndex: i,
                    seatStatuses,
                };
            }
        }
    }

    log.info({ preferredGroups, fallbackGroups }, 'No suitable seats found');
    return {
        found: false,
        seats: [],
        source: 'none',
        seatStatuses,
    };
}

/**
 * Mock seat map for development/testing - simulates a seat availability map.
 * Replace with real seat map data from the adapter when available.
 */
export function createMockSeatMap(
    availableSeats: string[],
    unavailableSeats: string[] = []
): Record<string, SeatStatus> {
    const map: Record<string, SeatStatus> = {};
    for (const s of availableSeats) map[s] = 'available';
    for (const s of unavailableSeats) map[s] = 'unavailable';
    return map;
}
