import type { BrowserContext, Page } from 'playwright';
import type { MovieShow } from '../types';
import { getLogger } from '../config/logger';

const log = getLogger('seat-holder');

// ─── BMS DOM Selectors ────────────────────────────────────────────────────────
//
// BMS renders a React seat map. These selectors cover the known patterns.
// If BMS changes their DOM, update selectors here — nothing else needs changing.
//
const SELECTORS = {
    // Seat map container (wait for this before trying to click seats)
    seatMap: [
        '.seat-layout',
        '[class*="SeatLayout"]',
        '[class*="seat-layout"]',
        '[class*="seat-map"]',
        '[class*="seatlayout"]',
    ].join(', '),

    // Individual available seat (data-seat-label, title, or aria-label carries "H12" etc.)
    seat: (label: string) =>
        [
            `[data-seat-label="${label}"]`,
            `[title="${label}"]`,
            `[aria-label="${label}"]`,
            `[data-id="${label}"]`,
        ].join(', '),

    // Book Tickets / Proceed button
    bookBtn: [
        '[data-qa="book-tickets"]',
        '[data-qa="btn-book-tickets"]',
        'button:has-text("Book Tickets")',
        'button:has-text("Proceed to Pay")',
        'button:has-text("Proceed")',
        'a:has-text("Book Tickets")',
    ].join(', '),

    // Already-selected seat (to deselect before retrying fallback)
    selectedSeat: '[class*="selected"]:not([class*="unavailable"]):not([class*="blocked"])',

    // Availability markers on seat elements
    unavailableClass: ['unavailable', 'blocked', 'sold', 'booked', 'occupied', 'unabl'],
};

const PAGE_TIMEOUT = 30_000;  // 30s for page navigation
const SEAT_TIMEOUT = 12_000;  // 12s to find a seat element
const PAYMENT_TIMEOUT = 25_000;  // 25s to reach payment page

export interface SeatHoldResult {
    held: boolean;
    orderUrl: string | null;
    seatsSelected: string[];
    screenshotPath: string | null;
    error?: string;
}

/**
 * Main entry point — attempts to hold seats in BMS using the provided session.
 *
 * Strategy:
 *  1. Navigate to the show's booking page
 *  2. Wait for the seat map to render
 *  3. Try preferred seats → then each fallback group in order
 *  4. Click "Book Tickets"
 *  5. Wait for the payment/order-summary page (seats now held for ~10 min by BMS)
 *  6. Return the payment URL — send to Telegram so user can tap and pay
 *
 * SAFETY:
 *  - Never clicks any payment button
 *  - Never submits card details
 *  - Stops at the order summary URL
 */
export async function holdSeatsAutomated(
    context: BrowserContext,
    show: MovieShow,
    preferredSeats: string[],
    fallbackGroups: string[][]
): Promise<SeatHoldResult> {
    const page = await context.newPage();
    log.info({ showId: show.showId, preferredSeats }, 'Starting automated seat hold');

    try {
        if (!show.bookingUrl) {
            return fail('No booking URL on show', page);
        }

        // ── Step 1: Navigate to booking page ──────────────────────────────────
        log.info({ url: show.bookingUrl }, 'Navigating to BMS booking page');
        await page.goto(show.bookingUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        // Check if redirected to login — BMS sometimes redirects anonymously
        if (page.url().includes('/login') || page.url().includes('/signin')) {
            log.warn('Redirected to login — session may have expired. Re-run: npm run session:setup');
            return fail('BMS session expired — re-run: npm run session:setup', page);
        }

        // ── Step 2: Wait for seat map ─────────────────────────────────────────
        log.info('Waiting for seat map to render...');
        try {
            await page.waitForSelector(SELECTORS.seatMap, { timeout: PAGE_TIMEOUT });
        } catch {
            log.warn('Seat map did not render — page may have changed or require a different URL');
            return fail('Seat map not found on page', page);
        }

        // Extra wait for JS to finish rendering all seat states
        await page.waitForTimeout(1500);

        // ── Step 3: Try preferred seats, then fallbacks ───────────────────────
        const allGroups = [preferredSeats, ...fallbackGroups].filter((g) => g.length > 0);
        let seatsSelected: string[] = [];

        for (const group of allGroups) {
            log.info({ group }, 'Trying seat group');
            const ok = await trySelectGroup(page, group);
            if (ok) {
                seatsSelected = group;
                log.info({ seats: group }, '✅ Seat group selected');
                break;
            }
            // Deselect partially-clicked seats before trying next group
            await deselectAll(page);
            await page.waitForTimeout(500);
        }

        if (seatsSelected.length === 0) {
            log.warn('None of the configured seat groups were available');
            return fail('All configured seat groups unavailable', page);
        }

        // ── Step 4: Click "Book Tickets" ──────────────────────────────────────
        log.info('Clicking Book Tickets button');
        try {
            await page.locator(SELECTORS.bookBtn).first().click({ timeout: 10_000 });
        } catch {
            log.warn('Book Tickets button not found or not clickable');
            return fail('Book Tickets button not found', page);
        }

        // ── Step 5: Wait for payment/order page ───────────────────────────────
        log.info('Waiting for payment page navigation...');
        try {
            await page.waitForURL(
                (url) => {
                    const href = url.href;
                    return (
                        href.includes('/payment') ||
                        href.includes('/order-summary') ||
                        href.includes('/booking-summary') ||
                        href.includes('/checkout')
                    );
                },
                { timeout: PAYMENT_TIMEOUT }
            );
        } catch {
            // Sometimes BMS goes to an intermediate page — check current URL
            const current = page.url();
            log.warn({ url: current }, 'Did not navigate to expected payment URL');
            if (current !== show.bookingUrl) {
                // We moved forward — return what we have
                log.info({ url: current }, 'Using current URL as order URL');
                const shot = await takeScreenshot(page, 'order');
                return { held: true, orderUrl: current, seatsSelected, screenshotPath: shot };
            }
            return fail('Did not reach payment page after clicking Book Tickets', page);
        }

        const orderUrl = page.url();
        log.info({ orderUrl, seats: seatsSelected }, '🎉 SEATS HELD — order URL obtained');

        const screenshotPath = await takeScreenshot(page, 'order-summary');
        return { held: true, orderUrl, seatsSelected, screenshotPath };

    } catch (err) {
        log.error({ err }, 'Seat holder threw an unexpected error');
        return fail((err as Error).message, page);
    } finally {
        await page.close().catch(() => { });
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function trySelectGroup(page: Page, seats: string[]): Promise<boolean> {
    for (const label of seats) {
        const locator = page.locator(SELECTORS.seat(label)).first();

        // Check if element exists
        const count = await locator.count();
        if (count === 0) {
            log.debug({ seat: label }, 'Seat element not found in DOM');
            return false;
        }

        // Check availability via class names
        const el = locator.first();
        const className = (await el.getAttribute('class')) ?? '';
        const isUnavailable = SELECTORS.unavailableClass.some((c) => className.toLowerCase().includes(c));
        if (isUnavailable) {
            log.debug({ seat: label, className }, 'Seat marked unavailable');
            return false;
        }

        // Click the seat
        try {
            await el.click({ timeout: SEAT_TIMEOUT });
            await page.waitForTimeout(350); // brief pause between clicks
            log.debug({ seat: label }, 'Seat clicked');
        } catch {
            log.warn({ seat: label }, 'Could not click seat element');
            return false;
        }
    }

    return true;
}

async function deselectAll(page: Page): Promise<void> {
    try {
        const selected = page.locator(SELECTORS.selectedSeat);
        const count = await selected.count();
        for (let i = 0; i < count; i++) {
            await selected.nth(i).click().catch(() => { });
            await page.waitForTimeout(200);
        }
    } catch {
        // Non-critical
    }
}

async function takeScreenshot(page: Page, name: string): Promise<string | null> {
    try {
        const p = `./data/${name}-${Date.now()}.png`;
        await page.screenshot({ path: p, fullPage: false });
        return p;
    } catch {
        return null;
    }
}

async function fail(error: string, page: Page): Promise<SeatHoldResult> {
    await page.close().catch(() => { });
    return { held: false, orderUrl: null, seatsSelected: [], screenshotPath: null, error };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Parse a fallback seats string (e.g. "H10,H11;G12,G13") into groups */
export function parseFallbackGroups(raw: string | null): string[][] {
    if (!raw || !raw.trim()) return [];
    return raw
        .split(';')
        .map((group) => group.split(',').map((s) => s.trim()).filter(Boolean))
        .filter((g) => g.length > 0);
}
