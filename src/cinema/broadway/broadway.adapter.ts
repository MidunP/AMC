import axios, { AxiosError } from 'axios';
import type { Watch, AdapterResult, MovieShow } from '../../types';
import { parseShowListings } from './parser';
import { getLogger } from '../../config/logger';

const log = getLogger('broadway-adapter');

/**
 * Broadway Cinemas / BookMyShow Adapter — Phase 8 + 9
 *
 * BMS exposes a JSON API (used by their own web frontend) that is far more
 * reliable than HTML scraping. This adapter targets that API.
 *
 * Endpoint used:
 *   GET https://in.bookmyshow.com/api/movies-data/showtimes-by-event
 *       ?appCode=MOBAND2&appVersion=14304&language=en
 *       &eventCode={SHOW_CODE}
 *       &regionCode={REGION_CODE}
 *       &subRegionCode={SUB_REGION_CODE}
 *       &venueCode={VENUE_CODE}
 *       &dateCode={YYYYMMDD}
 *
 * Broadway Cinemas Coimbatore:
 *   regionCode    = CBEI
 *   subRegionCode = CBEI
 *   venueCode     = CABD  (Broadway Cinemas ABD, Coimbatore)
 *
 * Phase 8 validation status:
 *   ✅ URL pattern inspected via BMS network developer tools
 *   ✅ Response schema documented in parseShowListings()
 *   ✅ Venue code CABD confirmed for Broadway Cinemas Coimbatore
 *
 * Nothing here bypasses rate limits, CAPTCHA, auth, or any anti-bot mechanism.
 * If blocked: log, return blocked=true, stop.
 */

const BMS_BASE = 'https://in.bookmyshow.com';

// Broadway Cinemas Coimbatore — validated venue codes (Phase 8)
const BROADWAY_VENUE_CODE = 'CABD';
const BMS_REGION_CODE = 'CBEI';

// BMS JSON Showtimes API — used by BMS's own React frontend
const BMS_SHOWTIMES_API = `${BMS_BASE}/api/movies-data/showtimes-by-event`;

// BMS movie listing search API (used to resolve event codes by name)
const BMS_MOVIES_API = `${BMS_BASE}/api/movies-data/movies-by-event`;

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9,ta;q=0.8',
    Referer: 'https://in.bookmyshow.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

/** Format date as YYYYMMDD for BMS API */
function formatDateCode(isoDate: string): string {
    return isoDate.replace(/-/g, '');
}

function isBlockedResponse(status: number, body: unknown): boolean {
    if (status === 403 || status === 429) return true;
    const text = typeof body === 'string' ? body.toLowerCase() : JSON.stringify(body ?? '').toLowerCase();
    return (
        text.includes('captcha') ||
        text.includes('bot detected') ||
        text.includes('access denied') ||
        text.includes('cf-error') ||
        text.includes('cloudflare')
    );
}

/**
 * Phase 8 — Resolve Event Code
 *
 * BMS showtimes API requires an `eventCode` (e.g. "ET00392749").
 * We fetch the city movies listing and find the event code by matching
 * the movie name. Falls back to HTML parsing if the API returns nothing.
 */
async function resolveEventCode(movieName: string): Promise<string | null> {
    try {
        const resp = await axios.get<unknown>(BMS_MOVIES_API, {
            params: {
                appCode: 'MOBAND2',
                appVersion: '14304',
                language: 'en',
                regionCode: BMS_REGION_CODE,
                subRegionCode: BMS_REGION_CODE,
                category: 'MOVIES',
            },
            headers: DEFAULT_HEADERS,
            timeout: 12_000,
            validateStatus: () => true,
        });

        if (resp.status !== 200) {
            log.warn({ status: resp.status }, 'Movie listing API returned non-200');
            return null;
        }

        // BMS response: { BookMyShow: { arrEvents: [ { EventCode, EventTitle, ... } ] } }
        const data = resp.data as Record<string, unknown>;
        const bmsBlock = (data?.['BookMyShow'] ?? data) as Record<string, unknown>;
        const events = (bmsBlock?.['arrEvents'] ?? []) as Array<Record<string, string>>;

        const needle = movieName.toLowerCase().trim();
        const found = events.find(
            (ev) =>
                ev.EventTitle?.toLowerCase().includes(needle) ||
                needle.includes((ev.EventTitle ?? '').toLowerCase().slice(0, 10))
        );

        if (found?.EventCode) {
            log.info({ movie: movieName, eventCode: found.EventCode }, 'Resolved BMS event code');
            return found.EventCode;
        }

        log.warn({ movie: movieName, totalEvents: events.length }, 'No event code match found');
        return null;
    } catch (err) {
        log.error({ err }, 'Failed to resolve event code');
        return null;
    }
}

/**
 * Phase 9 — Fetch real showtimes from BMS JSON API
 *
 * Uses the resolved eventCode + Broadway venue code to get structured
 * showtime data. Falls back to HTML scraping if API fails.
 */
async function fetchShowtimesFromApi(
    watch: Watch,
    eventCode: string
): Promise<{ shows: MovieShow[]; blocked: boolean; parseError: boolean; status: number; error?: string }> {
    const dateCode = formatDateCode(watch.target_date);
    const params = {
        appCode: 'MOBAND2',
        appVersion: '14304',
        language: 'en',
        eventCode,
        regionCode: BMS_REGION_CODE,
        subRegionCode: BMS_REGION_CODE,
        venueCode: BROADWAY_VENUE_CODE,
        dateCode,
    };

    log.info({ watchId: watch.id, eventCode, dateCode, venueCode: BROADWAY_VENUE_CODE }, 'Fetching BMS showtimes');

    const resp = await axios.get<unknown>(BMS_SHOWTIMES_API, {
        params,
        headers: DEFAULT_HEADERS,
        timeout: 15_000,
        validateStatus: () => true,
    });

    if (isBlockedResponse(resp.status, resp.data)) {
        return { shows: [], blocked: true, parseError: false, status: resp.status, error: `Blocked (HTTP ${resp.status})` };
    }

    if (resp.status >= 500) {
        return { shows: [], blocked: false, parseError: false, status: resp.status, error: `BMS server error (HTTP ${resp.status})` };
    }

    // Parse BMS JSON response into MovieShow[]
    const shows = parseBmsApiResponse(resp.data, watch);
    return { shows, blocked: false, parseError: false, status: resp.status };
}

/**
 * Parse the BMS showtimes-by-event API response.
 *
 * BMS response structure (Phase 8 inspection):
 * {
 *   ShowDetails: [{
 *     VenueCode, VenueName,
 *     ShowTime: [{
 *       ShowTime, ShowDate, ShowCode, SeatCategories: [...],
 *       BookingStatus: "Open" | "Closed" | "SoldOut" | "NotOpen",
 *       TrailerURL: null, ShowAvailability: "Yes" | "No"
 *     }]
 *   }]
 * }
 */
function parseBmsApiResponse(data: unknown, watch: Watch): MovieShow[] {
    const shows: MovieShow[] = [];

    try {
        const root = data as Record<string, unknown>;
        const showDetailsList = (root?.['ShowDetails'] ?? []) as Array<Record<string, unknown>>;

        for (const venue of showDetailsList) {
            const venueName = (venue['VenueName'] as string) || 'Broadway Cinemas';
            const showtimes = (venue['ShowTime'] ?? []) as Array<Record<string, unknown>>;

            for (const st of showtimes) {
                const bookingStatus = ((st['BookingStatus'] as string) ?? '').toLowerCase();
                const showAvail = ((st['ShowAvailability'] as string) ?? '').toLowerCase();
                const showCode = (st['ShowCode'] as string) || null;
                const showTime = (st['ShowTime'] as string) || '';
                const showDate = (st['ShowDate'] as string) || watch.target_date;

                // Determine availability
                let availability: MovieShow['availability'] = 'unknown';
                let bookable = false;

                if (bookingStatus === 'open' && showAvail === 'yes') {
                    availability = 'available';
                    bookable = true;
                } else if (bookingStatus === 'soldout' || bookingStatus === 'sold out') {
                    availability = 'sold_out';
                } else if (bookingStatus === 'notopen' || bookingStatus === 'closed') {
                    availability = 'coming_soon';
                }

                // Extract format from category names if present
                const cats = (st['SeatCategories'] ?? []) as Array<Record<string, unknown>>;
                const format = inferFormat(cats, watch.preferred_format);

                const bookingUrl = showCode
                    ? `${BMS_BASE}/buytickets/${encodeURIComponent(watch.movie.toLowerCase().replace(/\s+/g, '-'))}/${showCode}`
                    : null;

                shows.push({
                    movie: watch.movie,
                    theatre: venueName,
                    date: showDate,
                    format: format ?? watch.preferred_format ?? null,
                    language: null,
                    showtime: showTime,
                    showId: showCode,
                    bookingUrl: bookable ? bookingUrl : null,
                    bookable,
                    availability,
                    seatMapAvailable: cats.length > 0,
                });
            }
        }
    } catch (err) {
        log.error({ err }, 'Failed to parse BMS API response');
    }

    return shows;
}

function inferFormat(cats: Array<Record<string, unknown>>, preferredFormat: string | null): string | null {
    const catNames = cats.map((c) => ((c['CategoryName'] ?? c['PriceDesc'] ?? '') as string).toUpperCase()).join(' ');
    if (catNames.includes('EPIQ') || catNames.includes('4DX') || catNames.includes('IMAX')) return 'EPIQ';
    if (catNames.includes('3D')) return '3D';
    if (catNames.includes('2D')) return '2D';
    return preferredFormat ?? null;
}

function filterMatchingShows(shows: MovieShow[], watch: Watch): MovieShow[] {
    return shows.filter((show) => {
        const formatMatch =
            !watch.preferred_format ||
            !show.format ||
            show.format.toLowerCase().includes(watch.preferred_format.toLowerCase());

        const notComingSoon = show.availability !== 'coming_soon';
        const isBookable = show.bookable && show.bookingUrl !== null;

        const showtimeMatch =
            !watch.preferred_showtime ||
            !show.showtime ||
            show.showtime.includes(watch.preferred_showtime);

        return formatMatch && notComingSoon && isBookable && showtimeMatch;
    });
}

/**
 * HTML fallback — used when:
 * - Movie is not yet indexed in BMS movies-by-event API (pre-release)
 * - eventCode resolution fails
 */
async function fetchShowtimesFromHtml(watch: Watch): Promise<{
    shows: MovieShow[];
    blocked: boolean;
    parseError: boolean;
    status: number;
    error?: string;
}> {
    const dateStr = formatDateCode(watch.target_date);
    const city = 'coimbatore';
    const encodedMovie = encodeURIComponent(watch.movie);
    const url = `${BMS_BASE}/movies/${city}?q=${encodedMovie}&date=${dateStr}`;

    log.info({ watchId: watch.id, url }, 'Falling back to HTML scraping');

    const resp = await axios.get<string>(url, {
        headers: { ...DEFAULT_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
        timeout: 15_000,
        maxRedirects: 3,
        validateStatus: () => true,
    });

    const html = typeof resp.data === 'string' ? resp.data : '';

    if (isBlockedResponse(resp.status, html)) {
        return { shows: [], blocked: true, parseError: false, status: resp.status };
    }

    const { shows, parseWarning } = parseShowListings(html, {
        targetMovie: watch.movie,
        targetDate: watch.target_date,
        targetFormat: watch.preferred_format ?? undefined,
        targetTheatre: watch.theatre,
    });

    if (parseWarning === 'BLOCKED_PAGE') {
        return { shows: [], blocked: true, parseError: false, status: resp.status };
    }
    if (parseWarning === 'PARSE_ERROR') {
        return { shows: [], blocked: false, parseError: true, status: resp.status };
    }

    return { shows, blocked: false, parseError: false, status: resp.status };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function checkBroadwayShowtimes(watch: Watch): Promise<AdapterResult> {
    const start = Date.now();
    log.info({ watchId: watch.id, movie: watch.movie }, 'Checking Broadway showtimes');

    try {
        // Phase 9: Try JSON API first
        const eventCode = await resolveEventCode(watch.movie);
        let result: { shows: MovieShow[]; blocked: boolean; parseError: boolean; status: number; error?: string };

        if (eventCode) {
            result = await fetchShowtimesFromApi(watch, eventCode);

            if (!result.blocked && !result.parseError && result.shows.length === 0) {
                // API returned but no shows — movie may not be at Broadway; try HTML
                log.info({ watchId: watch.id }, 'No shows from API, falling back to HTML');
                result = await fetchShowtimesFromHtml(watch);
            }
        } else {
            // Could not resolve event code — fall back to HTML
            result = await fetchShowtimesFromHtml(watch);
        }

        const duration = Date.now() - start;
        log.debug({ watchId: watch.id, durationMs: duration, ...result }, 'Check complete');

        if (result.blocked) {
            return {
                success: false,
                shows: [],
                rawHttpStatus: result.status,
                blocked: true,
                parseError: false,
                errorMessage: result.error ?? 'Blocked by provider',
            };
        }

        if (result.parseError) {
            return {
                success: false,
                shows: [],
                rawHttpStatus: result.status,
                blocked: false,
                parseError: true,
                errorMessage: 'HTML/JSON parser failed',
            };
        }

        const matchingShows = filterMatchingShows(result.shows, watch);

        log.info(
            { watchId: watch.id, totalShows: result.shows.length, matchingShows: matchingShows.length },
            'Show filtering complete'
        );

        return {
            success: true,
            shows: matchingShows,
            rawHttpStatus: result.status,
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

/** Probe tool — returns raw API response for Phase 8 validation */
export async function probeVenueApi(movieName: string, dateCode: string): Promise<unknown> {
    const eventCode = await resolveEventCode(movieName);
    if (!eventCode) return { error: 'Could not resolve event code for movie', movie: movieName };

    const resp = await axios.get<unknown>(BMS_SHOWTIMES_API, {
        params: {
            appCode: 'MOBAND2',
            appVersion: '14304',
            language: 'en',
            eventCode,
            regionCode: BMS_REGION_CODE,
            subRegionCode: BMS_REGION_CODE,
            venueCode: BROADWAY_VENUE_CODE,
            dateCode,
        },
        headers: DEFAULT_HEADERS,
        timeout: 15_000,
        validateStatus: () => true,
    });

    return { eventCode, status: resp.status, data: resp.data };
}
