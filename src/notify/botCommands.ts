import axios from 'axios';
import { getEnv } from '../config/env';
import { getLogger } from '../config/logger';
import {
    getAllWatches,
    createWatch,
    deleteWatch,
    updateWatchStatus,
    getWatchById,
} from '../db/repository';
import { getWindowStatus, formatWindowStatus } from '../watcher/timeWindow';
import { checkBroadwayShowtimes } from '../cinema/broadway/broadway.adapter';

const log = getLogger('telegram-bot-commands');

let lastUpdateId = 0;
let isPolling = false;

/**
 * Start long-polling Telegram for user commands.
 * Runs inside worker.ts so you can manage your watcher 24/7 directly from your phone!
 */
export function startTelegramBotListener(): void {
    if (isPolling) return;
    isPolling = true;
    log.info('🤖 Telegram remote control listener started');
    pollLoop();
}

async function pollLoop(): Promise<void> {
    const env = getEnv();
    const token = env.TELEGRAM_BOT_TOKEN;
    const allowedChatId = String(env.TELEGRAM_CHAT_ID);
    const url = `https://api.telegram.org/bot${token}/getUpdates`;

    while (isPolling) {
        try {
            const res = await axios.get(url, {
                params: {
                    offset: lastUpdateId + 1,
                    timeout: 20, // 20s long-polling
                },
                timeout: 25_000,
            });

            const updates = res.data?.result ?? [];

            for (const update of updates) {
                lastUpdateId = update.update_id;

                const msg = update.message;
                if (!msg || !msg.text) continue;

                // Security check: only respond to YOUR Telegram chat ID
                const incomingChatId = String(msg.chat.id);
                if (incomingChatId !== allowedChatId) {
                    log.warn({ incomingChatId }, 'Ignored message from unauthorized chat ID');
                    continue;
                }

                await handleCommand(msg.text.trim(), token, incomingChatId);
            }
        } catch (err) {
            // Log & pause briefly on network error before retrying
            log.debug({ err: (err as Error).message }, 'Telegram poll loop error — retrying');
            await sleep(5000);
        }
    }
}

async function handleCommand(text: string, token: string, chatId: string): Promise<void> {
    log.info({ text }, 'Received Telegram remote command');

    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();
    const argsStr = parts.slice(1).join(' ').trim();

    switch (cmd) {
        case '/start':
        case '/help':
            await replyHelp(token, chatId);
            break;

        case '/list':
            await replyList(token, chatId);
            break;

        case '/status':
            await replyStatus(token, chatId);
            break;

        case '/add':
            await handleAddCommand(argsStr, token, chatId);
            break;

        case '/remove':
        case '/delete':
            await handleRemoveCommand(argsStr, token, chatId);
            break;

        case '/pause':
            await handlePauseCommand(argsStr, token, chatId);
            break;

        case '/resume':
            await handleResumeCommand(argsStr, token, chatId);
            break;

        case '/check':
            await handleCheckCommand(argsStr, token, chatId);
            break;

        default:
            if (text.startsWith('/')) {
                await sendReply(token, chatId, `❓ Unknown command: <code>${cmd}</code>\nSend /help to see available commands.`);
            }
            break;
    }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function replyHelp(token: string, chatId: string): Promise<void> {
    const text =
        `🎬 <b>Broadway FDFS Watcher — Remote Control</b>\n\n` +
        `Commands you can send from your phone:\n\n` +
        `📋 <code>/list</code> — View all active watches & status\n` +
        `🟢 <code>/status</code> — System uptime & status summary\n` +
        `➕ <code>/add Movie, YYYY-MM-DD, Format, Seats, OpenTime</code>\n` +
        `   <i>Example:</i> <code>/add Pushpa 3, 2026-12-25, EPIQ, H12,H13, 2026-12-20 18:00</code>\n` +
        `❌ <code>/remove &lt;id&gt;</code> — Delete a watch\n` +
        `⏸️ <code>/pause &lt;id&gt;</code> — Pause a watch\n` +
        `▶️ <code>/resume &lt;id&gt;</code> — Resume a watch\n` +
        `🔍 <code>/check &lt;id&gt;</code> — Force instant showtime check\n\n` +
        `🟢 System is running 24/7 in the cloud.`;

    await sendReply(token, chatId, text);
}

async function replyList(token: string, chatId: string): Promise<void> {
    const watches = getAllWatches();

    if (watches.length === 0) {
        await sendReply(token, chatId, '📋 No watches configured.\n\nAdd one with: <code>/add Movie, Date, Format, Seats, OpenTime</code>');
        return;
    }

    let text = `📋 <b>ACTIVE WATCHES (${watches.length})</b>\n\n`;

    const now = new Date();
    for (const w of watches) {
        const ws = getWindowStatus(w, now);
        const statusIcon = w.status === 'watching' ? '👁️' : w.status === 'paused' ? '⏸️' : '✅';
        const openTime = w.expected_opening_at
            ? new Date(w.expected_opening_at).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short'
            })
            : 'Not set';

        text += `${statusIcon} <b>ID ${w.id}: ${w.movie}</b>\n`;
        text += `   Date: ${w.target_date} | Format: ${w.preferred_format ?? 'Any'}\n`;
        text += `   Seats: <code>${w.preferred_seats ?? 'None'}</code>\n`;
        text += `   Status: <b>${w.status.toUpperCase()}</b> (${ws.state})\n`;
        text += `   Opens: ${openTime}\n\n`;
    }

    await sendReply(token, chatId, text);
}

async function replyStatus(token: string, chatId: string): Promise<void> {
    const watches = getAllWatches();
    const activeCount = watches.filter((w) => w.status === 'watching').length;

    const text =
        `🟢 <b>WATCHER STATUS REPORT</b>\n\n` +
        `👁️ Total Watches: <b>${watches.length}</b>\n` +
        `⚡ Active Watching: <b>${activeCount}</b>\n` +
        `⏱️ Engine: <b>ONLINE (24/7 Remote)</b>\n` +
        `📍 Venue: <b>Broadway Cinemas Coimbatore</b>\n\n` +
        `All systems operational. Send /list to view active watches.`;

    await sendReply(token, chatId, text);
}

async function handleAddCommand(argsStr: string, token: string, chatId: string): Promise<void> {
    if (!argsStr) {
        await sendReply(
            token,
            chatId,
            `⚠️ <b>Format:</b>\n<code>/add Movie, Date, Format, Seats, OpenTime</code>\n\n` +
            `<b>Example:</b>\n<code>/add Spider-Man, 2026-12-25, EPIQ, H12,H13, 2026-12-20 18:00</code>`
        );
        return;
    }

    const parts = argsStr.split(',').map((p) => p.trim());
    const movie = parts[0];
    const date = parts[1] ?? new Date().toISOString().split('T')[0];
    const format = parts[2] || null;
    const seats = parts[3] || null;
    let rawOpen = parts[4] || null;

    let openIso: string | null = null;
    let activationStart: string | null = null;
    let activationEnd: string | null = null;

    if (rawOpen) {
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rawOpen)) {
            rawOpen = `${rawOpen}:00+05:30`;
        }
        const openDate = new Date(rawOpen);
        if (!isNaN(openDate.getTime())) {
            openIso = openDate.toISOString();
            activationStart = new Date(openDate.getTime() - 30 * 60 * 1000).toISOString();
            activationEnd = new Date(openDate.getTime() + 3 * 60 * 60 * 1000).toISOString();
        }
    }

    const watch = createWatch({
        movie,
        theatre: 'Broadway Cinemas',
        target_date: date,
        preferred_format: format,
        preferred_showtime: null,
        party_size: seats ? seats.split(',').length : 1,
        expected_opening_at: openIso,
        activation_start: activationStart,
        activation_end: activationEnd,
        preferred_seats: seats,
        fallback_seats: null,
    });

    const text =
        `✅ <b>WATCH CREATED VIA TELEGRAM!</b>\n\n` +
        `🆔 ID: <code>${watch.id}</code>\n` +
        `🎬 Movie: <b>${watch.movie}</b>\n` +
        `📅 Date: ${watch.target_date}\n` +
        `🖥️ Format: ${watch.preferred_format ?? 'Any'}\n` +
        `🎟️ Seats: <code>${watch.preferred_seats ?? 'Any'}</code>\n` +
        `⏰ Opens: ${rawOpen ?? 'Not specified'}\n\n` +
        `Watcher will monitor this 24/7 in the cloud!`;

    await sendReply(token, chatId, text);
}

async function handleRemoveCommand(argsStr: string, token: string, chatId: string): Promise<void> {
    const id = parseInt(argsStr, 10);
    if (isNaN(id)) {
        await sendReply(token, chatId, '⚠️ Please specify a watch ID: <code>/remove 1</code>');
        return;
    }

    const ok = deleteWatch(id);
    if (ok) {
        await sendReply(token, chatId, `✅ Watch ID <code>${id}</code> deleted.`);
    } else {
        await sendReply(token, chatId, `❌ Watch ID <code>${id}</code> not found.`);
    }
}

async function handlePauseCommand(argsStr: string, token: string, chatId: string): Promise<void> {
    const id = parseInt(argsStr, 10);
    if (isNaN(id)) {
        await sendReply(token, chatId, '⚠️ Please specify a watch ID: <code>/pause 1</code>');
        return;
    }
    updateWatchStatus(id, 'paused');
    await sendReply(token, chatId, `⏸️ Watch ID <code>${id}</code> paused.`);
}

async function handleResumeCommand(argsStr: string, token: string, chatId: string): Promise<void> {
    const id = parseInt(argsStr, 10);
    if (isNaN(id)) {
        await sendReply(token, chatId, '⚠️ Please specify a watch ID: <code>/resume 1</code>');
        return;
    }
    updateWatchStatus(id, 'watching');
    await sendReply(token, chatId, `▶️ Watch ID <code>${id}</code> resumed.`);
}

async function handleCheckCommand(argsStr: string, token: string, chatId: string): Promise<void> {
    const id = parseInt(argsStr, 10);
    if (isNaN(id)) {
        await sendReply(token, chatId, '⚠️ Please specify a watch ID: <code>/check 1</code>');
        return;
    }

    const watch = getWatchById(id);
    if (!watch) {
        await sendReply(token, chatId, `❌ Watch ID <code>${id}</code> not found.`);
        return;
    }

    await sendReply(token, chatId, `🔍 Running manual check for <b>${watch.movie}</b>...`);

    const result = await checkBroadwayShowtimes(watch);
    if (result.success && result.shows.length > 0) {
        const show = result.shows[0];
        await sendReply(
            token,
            chatId,
            `🎉 <b>SHOW FOUND!</b>\n\n🎬 ${show.movie}\n🕐 ${show.showtime}\n🔗 ${show.bookingUrl}`
        );
    } else {
        await sendReply(token, chatId, `ℹ️ <b>${watch.movie}</b> is not bookable yet.`);
    }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function sendReply(token: string, chatId: string, text: string): Promise<void> {
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        });
    } catch (err) {
        log.error({ err }, 'Failed to send Telegram command reply');
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
