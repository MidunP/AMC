import * as cheerio from 'cheerio';
import type { MovieShow } from '../../types';
import { getLogger } from '../../config/logger';

const log = getLogger('parser');

/**
 * Normalizes raw HTML from a BookMyShow/Broadway listing page into
 * structured MovieShow objects.
 *
 * IMPORTANT: This parser must prefer UNKNOWN over incorrectly claiming BOOKABLE.
 * If any required signal is ambiguous, return availability = 'unknown'.
 */
export function parseShowListings(
    html: string,
    options: {
        targetMovie: string;
        targetDate: string;
        targetFormat?: string;
        targetTheatre?: string;
    }
): { shows: MovieShow[]; parseWarning?: string } {
    const shows: MovieShow[] = [];
    let parseWarning: string | undefined;

    try {
        const $ = cheerio.load(html);

        // BookMyShow show cards - these selectors must be validated against real pages
        // before trusting. The structure may change.
        const showCardSelectors = [
            '[data-venue-name]',
            '.venue-info',
            '.__venue-name',
            '[class*="VenueSeatsDetails"]',
            '[class*="showName"]',
        ];

        let foundCards = 0;

        for (const selector of showCardSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                foundCards += elements.length;
                elements.each((_i, el) => {
                    const show = extractShowFromElement($, el, options);
                    if (show) shows.push(show);
                });
                break; // Use first selector that works
            }
        }

        // Fallback: look for JSON-LD structured data
        if (foundCards === 0) {
            $('script[type="application/ld+json"]').each((_i, el) => {
                try {
                    const json = JSON.parse($(el).text());
                    const extracted = extractFromJsonLd(json, options);
                    if (extracted) shows.push(extracted);
                } catch {
                    // invalid JSON-LD, skip
                }
            });
        }

        if (shows.length === 0) {
            // Check if it's a blocking / CAPTCHA page
            const pageText = $('body').text().toLowerCase();
            if (
                pageText.includes('captcha') ||
                pageText.includes('bot detected') ||
                pageText.includes('access denied') ||
                pageText.includes('blocked')
            ) {
                return { shows: [], parseWarning: 'BLOCKED_PAGE' };
            }

            // Check for "coming soon" signals
            if (
                pageText.includes('coming soon') ||
                pageText.includes('advance booking') ||
                pageText.includes('not yet open')
            ) {
                return { shows: [], parseWarning: 'COMING_SOON' };
            }

            parseWarning = 'NO_SHOWS_FOUND';
        }

        return { shows, parseWarning };
    } catch (err) {
        log.error({ err }, 'Parser threw during HTML parsing');
        return { shows: [], parseWarning: 'PARSE_ERROR' };
    }
}

function extractShowFromElement(
    $: cheerio.CheerioAPI,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    el: any,
    options: {
        targetMovie: string;
        targetDate: string;
        targetFormat?: string;
        targetTheatre?: string;
    }
): MovieShow | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const $el = $(el as any);

        const rawVenueName =
            $el.attr('data-venue-name') ||
            $el.find('[class*="venue"]').first().text().trim() ||
            '';

        const rawShowName =
            $el.attr('data-movie-name') ||
            $el.find('[class*="showName"], [class*="movie-name"]').first().text().trim() ||
            '';

        const rawShowtime =
            $el.attr('data-show-time') ||
            $el.find('[class*="show-time"], [class*="showtime"]').first().text().trim() ||
            '';

        const rawFormat =
            $el.attr('data-format') ||
            $el.find('[class*="format"]').first().text().trim() ||
            '';

        const bookingHref =
            $el.find('a[href*="/buytickets/"], a[href*="/book/"]').first().attr('href') || '';

        // Determine availability
        const isComingSoon =
            $el.find('[class*="coming-soon"], [class*="comingSoon"]').length > 0 ||
            $el.text().toLowerCase().includes('coming soon');

        const hasBookingButton =
            $el.find('[class*="book-btn"], [class*="bookBtn"], a[href*="buytickets"]').length > 0;

        const isSoldOut =
            $el.find('[class*="sold-out"], [class*="soldOut"]').length > 0 ||
            $el.text().toLowerCase().includes('sold out');

        let availability: MovieShow['availability'] = 'unknown';
        let bookable = false;

        if (isComingSoon) {
            availability = 'coming_soon';
        } else if (isSoldOut) {
            availability = 'sold_out';
        } else if (hasBookingButton && bookingHref) {
            availability = 'available';
            bookable = true;
        }

        const show: MovieShow = {
            movie: rawShowName || options.targetMovie,
            theatre: rawVenueName || options.targetTheatre || 'Broadway Cinemas',
            date: options.targetDate,
            format: rawFormat || options.targetFormat || null,
            language: null,
            showtime: rawShowtime,
            showId: $el.attr('data-show-id') || null,
            bookingUrl: bookingHref ? `https://in.bookmyshow.com${bookingHref}` : null,
            bookable,
            availability,
            seatMapAvailable: false,
        };

        return show;
    } catch {
        return null;
    }
}

function extractFromJsonLd(
    json: Record<string, unknown>,
    options: { targetMovie: string; targetDate: string; targetFormat?: string }
): MovieShow | null {
    try {
        if (json['@type'] !== 'Event' && json['@type'] !== 'Movie') return null;

        const name = (json['name'] as string) || '';
        const url = (json['url'] as string) || '';

        return {
            movie: name || options.targetMovie,
            theatre: 'Broadway Cinemas',
            date: options.targetDate,
            format: options.targetFormat || null,
            language: null,
            showtime: '',
            showId: null,
            bookingUrl: url || null,
            bookable: !!url,
            availability: url ? 'available' : 'unknown',
            seatMapAvailable: false,
        };
    } catch {
        return null;
    }
}
