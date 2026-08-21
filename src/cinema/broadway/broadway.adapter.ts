import axios, { AxiosError } from 'axios';
import type { Watch, AdapterResult, MovieShow } from '../../types';
import { parseShowListings } from './parser';
import { getLogger } from '../../config/logger';

const log = getLogger('broadway-adapter');

/**
 * Broadway Cinemas / BookMyShow Adapter
 *
 * All BookMyShow-specific URL patterns and parsing logic lives here.
 * Nothing in this file attempts to bypass rate limits, CAPTCHA,
 * authentication, or any anti-bot mechanism.
 *
 * If the provider blocks the request: log it, return blocked=true, stop.
 */

const BMS_BASE = 'https://in.bookmyshow.com';

// Broadway Cinemas Coimbatore venue code on BookMyShow
// This must be validated against the real site.
const BROADWAY_VENUE_CODES = ['BWCO', 'broadway-coimbatore'];

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9,ta;q=0.8',
};

function buildShowtimesUrl(watch: Watch): string {
    // BookMyShow movie listings URL pattern:
    // https://in.bookmyshow.com/buytickets/{movie-slug}/{city}-{venue}
    //
    // This URL pattern MUST be validated against real Broadway/BMS pages.
    // The actual structure depends on the movie slug and venue codes.
    const dateStr = watch.target_date.replace(/-/g, '');
    const city = 'coimbatore';

    // Fallback: search by movie name on the city page
    const encodedMovie = encodeURIComponent(watch.movie);
    return `${BMS_BASE}/movies/${city}?q=${encodedMovie}&date=${dateStr}`;
}

function isBlockedResponse(status: number, html: string): boolean {
    if (status === 403 || status === 429) return true;
    const lower = html.toLowerCase();
    return (
        lower.includes('captcha') ||
        lower.includes('bot detected') ||
        lower.includes('access denied') ||
        lower.includes('cf-error') ||
        lower.includes('cloudflare')
    );
}

function filterMatchingShows(shows: MovieShow[], watch: Watch): MovieShow[] {
    return shows.filter((show) => {
        // 1. Movie name match (case-insensitive, partial)
        const movieMatch = show.movie.toLowerCase().includes(watch.movie.toLowerCase()) ||
            watch.movie.toLowerCase().includes(show.movie.toLowerCase().slice(0, 5));

        // 2. Theatre match
        const theatreMatch =
            !watch.theatre ||
            show.theatre.toLowerCase().includes(watch.theatre.toLowerCase().slice(0, 8));

        // 3. Format match
        const formatMatch =
            !watch.preferred_format ||
            !show.format ||
            show.format.toLowerCase().includes(watch.preferred_format.toLowerCase());

        // 4. Must NOT be coming soon
        const notComingSoon = show.availability !== 'coming_soon';

        // 5. Must be actually bookable
        const isBookable = show.bookable && show.bookingUrl !== null;

        // 6. Showtime match (if configured)
        const showtimeMatch =
            !watch.preferred_showtime ||
            !show.showtime ||
            show.showtime.includes(watch.preferred_showtime);

        return movieMatch && theatreMatch && formatMatch && notComingSoon && isBookable && showtimeMatch;
    });
}

export async function checkBroadwayShowtimes(watch: Watch): Promise<AdapterResult> {
    const url = buildShowtimesUrl(watch);
    const start = Date.now();

    log.info({ watchId: watch.id, movie: watch.movie, url }, 'Checking Broadway showtimes');

    try {
        const response = await axios.get<string>(url, {
            headers: DEFAULT_HEADERS,
            timeout: 15_000,
            maxRedirects: 3,
            validateStatus: () => true, // don't throw on 4xx/5xx
        });

        const status = response.status;
        const html = response.data;
        const duration = Date.now() - start;

        log.debug({ watchId: watch.id, status, durationMs: duration }, 'HTTP response received');

        // Check for blocks
        if (isBlockedResponse(status, typeof html === 'string' ? html : '')) {
            log.warn({ watchId: watch.id, status }, 'Request was blocked by provider');
            return {
                success: false,
                shows: [],
                rawHttpStatus: status,
                blocked: true,
                parseError: false,
                errorMessage: `Blocked by provider (HTTP ${status})`,
            };
        }

        if (status >= 500) {
            return {
                success: false,
                shows: [],
                rawHttpStatus: status,
                blocked: false,
                parseError: false,
                errorMessage: `Server error (HTTP ${status})`,
            };
        }

        // Parse the HTML
        const { shows: rawShows, parseWarning } = parseShowListings(typeof html === 'string' ? html : '', {
            targetMovie: watch.movie,
            targetDate: watch.target_date,
            targetFormat: watch.preferred_format ?? undefined,
            targetTheatre: watch.theatre,
        });

        if (parseWarning === 'BLOCKED_PAGE') {
            return {
                success: false,
                shows: [],
                rawHttpStatus: status,
                blocked: true,
                parseError: false,
                errorMessage: 'Blocking page detected in HTML',
            };
        }

        if (parseWarning === 'PARSE_ERROR') {
            return {
                success: false,
                shows: [],
                rawHttpStatus: status,
                blocked: false,
                parseError: true,
                errorMessage: 'HTML parser failed',
            };
        }

        const matchingShows = filterMatchingShows(rawShows, watch);

        log.info(
            { watchId: watch.id, totalShows: rawShows.length, matchingShows: matchingShows.length },
            'Show filtering complete'
        );

        return {
            success: true,
            shows: matchingShows,
            rawHttpStatus: status,
            blocked: false,
            parseError: false,
        };
    } catch (err) {
        const axiosErr = err as AxiosError;
        const duration = Date.now() - start;

        log.error({ watchId: watch.id, err: axiosErr.message, durationMs: duration }, 'Adapter request failed');

        if (axiosErr.response?.status === 403 || axiosErr.response?.status === 429) {
            return {
                success: false,
                shows: [],
                rawHttpStatus: axiosErr.response.status,
                blocked: true,
                parseError: false,
                errorMessage: `Blocked (${axiosErr.response.status})`,
            };
        }

        return {
            success: false,
            shows: [],
            rawHttpStatus: axiosErr.response?.status,
            blocked: false,
            parseError: false,
            errorMessage: axiosErr.message,
        };
    }
}
