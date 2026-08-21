import type { Watch } from '../types';
import { getLogger } from '../config/logger';

const log = getLogger('time-window');

export type WindowState =
    | 'idle'           // Before activation_start
    | 'activating'     // Within activation_start to expected_opening_at
    | 'active'         // At or after expected_opening_at, before activation_end
    | 'expired'        // After activation_end
    | 'no_window';     // No booking window configured — always active

export interface WindowStatus {
    state: WindowState;
    msUntilActivation: number | null;
    msUntilOpening: number | null;
    msUntilExpiry: number | null;
    shouldPollAggressively: boolean;
    isBookingWindowOver: boolean;
}

function parseTime(iso: string | null): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

export function getWindowStatus(watch: Watch, now: Date = new Date()): WindowStatus {
    const activationStart = parseTime(watch.activation_start);
    const expectedOpening = parseTime(watch.expected_opening_at);
    const activationEnd = parseTime(watch.activation_end);

    // No booking window configured
    if (!activationStart && !expectedOpening && !activationEnd) {
        return {
            state: 'no_window',
            msUntilActivation: null,
            msUntilOpening: null,
            msUntilExpiry: null,
            shouldPollAggressively: false,
            isBookingWindowOver: false,
        };
    }

    const nowMs = now.getTime();

    // If activation end is in the past — booking window is over
    if (activationEnd && nowMs > activationEnd.getTime()) {
        return {
            state: 'expired',
            msUntilActivation: null,
            msUntilOpening: null,
            msUntilExpiry: 0,
            shouldPollAggressively: false,
            isBookingWindowOver: true,
        };
    }

    // Before activation start
    if (activationStart && nowMs < activationStart.getTime()) {
        return {
            state: 'idle',
            msUntilActivation: activationStart.getTime() - nowMs,
            msUntilOpening: expectedOpening ? expectedOpening.getTime() - nowMs : null,
            msUntilExpiry: activationEnd ? activationEnd.getTime() - nowMs : null,
            shouldPollAggressively: false,
            isBookingWindowOver: false,
        };
    }

    // In the activation window (activation_start → activation_end)
    const msUntilOpening = expectedOpening ? Math.max(0, expectedOpening.getTime() - nowMs) : null;
    const msUntilExpiry = activationEnd ? activationEnd.getTime() - nowMs : null;

    const isPreOpening = expectedOpening ? nowMs < expectedOpening.getTime() : false;

    return {
        state: isPreOpening ? 'activating' : 'active',
        msUntilActivation: 0,
        msUntilOpening,
        msUntilExpiry,
        shouldPollAggressively: true,
        isBookingWindowOver: false,
    };
}

export function shouldCheckNow(watch: Watch, now: Date = new Date()): boolean {
    const ws = getWindowStatus(watch, now);

    if (ws.isBookingWindowOver) {
        log.debug({ watchId: watch.id }, 'Booking window expired — skipping check');
        return false;
    }

    // Always check if no window configured
    if (ws.state === 'no_window') return true;

    // Check during active window
    if (ws.state === 'active' || ws.state === 'activating') return true;

    // Idle — do a low-frequency check to detect if movie was already bookable before window
    if (ws.state === 'idle') return false;

    return false;
}

export function formatWindowStatus(ws: WindowStatus): string {
    switch (ws.state) {
        case 'idle':
            return `⏳ Idle — activates in ${formatMs(ws.msUntilActivation)}`;
        case 'activating':
            return `🔔 BOOKING MODE ACTIVE — opens in ${formatMs(ws.msUntilOpening)}`;
        case 'active':
            return `🚨 BOOKING WINDOW ACTIVE`;
        case 'expired':
            return `⌛ Booking window expired`;
        case 'no_window':
            return `👁️ Monitoring (no booking window configured)`;
    }
}

function formatMs(ms: number | null): string {
    if (ms === null) return 'unknown';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}
