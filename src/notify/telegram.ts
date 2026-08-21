import axios from 'axios';
import type { TicketLivePayload, SeatsHeldPayload, SeatStatus } from '../types';
import { getEnv } from '../config/env';
import { getLogger } from '../config/logger';

const log = getLogger('telegram');

function getApiUrl(token: string): string {
    return `https://api.telegram.org/bot${token}`;
}

interface TelegramButton {
    text: string;
    url: string;
}

async function sendTelegramMessage(
    text: string,
    buttons?: TelegramButton[]
): Promise<boolean> {
    const env = getEnv();
    const url = `${getApiUrl(env.TELEGRAM_BOT_TOKEN)}/sendMessage`;

    const body: Record<string, unknown> = {
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    };

    if (buttons && buttons.length > 0) {
        body.reply_markup = {
            inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))],
        };
    }

    try {
        await axios.post(url, body, { timeout: 10_000 });
        log.info('Telegram message sent');
        return true;
    } catch (err) {
        // Log failure but never throw — watcher must continue even if Telegram fails
        log.error({ err: (err as Error).message }, 'Telegram send failed — watcher continues');
        return false;
    }
}

export async function sendMessage(text: string): Promise<boolean> {
    return sendTelegramMessage(text);
}

export async function sendTestMessage(): Promise<boolean> {
    return sendTelegramMessage(
        '✅ <b>Broadway FDFS Watcher</b>\n\nThis is a test message.\nTelegram is configured correctly!'
    );
}

export async function sendStartupMessage(opts: {
    watchCount: number;
    pollIntervalMinutes: number;
    bookingAwareCount: number;
}): Promise<boolean> {
    const text =
        `✅ <b>TICKET WATCHER STARTED</b>\n\n` +
        `👁️ Watching: <b>${opts.watchCount}</b> show(s)\n` +
        `⏱️ Poll interval: <b>${opts.pollIntervalMinutes} minutes</b>\n` +
        `🔔 Booking-aware watches: <b>${opts.bookingAwareCount}</b>\n\n` +
        `System: 🟢 <b>ONLINE</b>`;

    return sendTelegramMessage(text);
}

export async function sendTicketLive(payload: TicketLivePayload): Promise<boolean> {
    const seatLines = formatSeatStatus(payload.preferredSeats, payload.seatStatus);

    const text =
        `🚨 <b>TICKETS LIVE!</b>\n\n` +
        `🎬 <b>${payload.movie}</b>\n` +
        `📍 ${payload.theatre}\n` +
        `📅 ${payload.date}\n` +
        `🖥️ ${payload.format}\n` +
        `🕐 ${payload.showtime}\n\n` +
        `🎟️ Preferred seats:\n${seatLines}\n\n` +
        `⚡ Open the booking link now — seats may sell out fast!`;

    return sendTelegramMessage(text, [
        { text: '🎟️ BOOK NOW', url: payload.bookingUrl },
    ]);
}

export async function sendSeatsHeld(payload: SeatsHeldPayload): Promise<boolean> {
    // IMPORTANT: Only call this if there is reliable evidence of an actual hold.
    const seatsStr = payload.seats.join(' + ');

    const text =
        `🚨 <b>SEATS HELD!</b>\n\n` +
        `🎬 <b>${payload.movie}</b>\n` +
        `📍 ${payload.theatre}\n` +
        `🖥️ ${payload.format}\n` +
        `🕐 ${payload.showtime}\n\n` +
        `🎟️ Seats: <b>${seatsStr}</b>\n\n` +
        `⏳ Temporary booking hold detected.\n` +
        `⚠️ <b>Complete payment before the hold expires.</b>`;

    return sendTelegramMessage(text, [
        { text: '💳 CONTINUE BOOKING', url: payload.continuationUrl },
    ]);
}

export async function sendSeatUnavailable(opts: {
    movie: string;
    showtime: string;
    bookingUrl: string;
}): Promise<boolean> {
    const text =
        `⚠️ <b>PREFERRED SEATS UNAVAILABLE</b>\n\n` +
        `🎬 <b>${opts.movie}</b>\n` +
        `🕐 ${opts.showtime}\n\n` +
        `Preferred and fallback seats are all unavailable.\n` +
        `You may still find other seats manually.`;

    return sendTelegramMessage(text, [
        { text: '🎟️ BOOK NOW', url: opts.bookingUrl },
    ]);
}

export async function sendBlockedWarning(opts: {
    movie: string;
    watchId: number;
}): Promise<boolean> {
    const text =
        `⚠️ <b>WATCHER BLOCKED</b>\n\n` +
        `🎬 <b>${opts.movie}</b>\n\n` +
        `The booking provider has blocked/restricted the watcher for the last 3 checks.\n\n` +
        `🔍 Manual inspection recommended.\n` +
        `Watch ID: <code>${opts.watchId}</code>`;

    return sendTelegramMessage(text);
}

export async function sendParserError(opts: {
    movie: string;
    watchId: number;
}): Promise<boolean> {
    const text =
        `⚠️ <b>WATCHER BROKE</b>\n\n` +
        `🎬 <b>${opts.movie}</b>\n\n` +
        `The booking page changed and availability could not be reliably determined.\n\n` +
        `⚠️ No "TICKETS LIVE" notification will be sent until the parser is fixed.\n` +
        `Watch ID: <code>${opts.watchId}</code>`;

    return sendTelegramMessage(text);
}

export async function sendProcessError(err: Error): Promise<boolean> {
    const text =
        `🔴 <b>WATCHER PROCESS ERROR</b>\n\n` +
        `<code>${err.message.slice(0, 200)}</code>\n\n` +
        `The watcher may have stopped. Please check the logs.`;

    return sendTelegramMessage(text);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatSeatStatus(seats: string[], statuses: Record<string, SeatStatus>): string {
    if (seats.length === 0) return 'No preferred seats configured.';
    return seats
        .map((seat) => {
            const status = statuses[seat];
            const icon = status === 'available' ? '✅' : status === 'unavailable' ? '❌' : '❓';
            return `${icon} ${seat}`;
        })
        .join('\n');
}
