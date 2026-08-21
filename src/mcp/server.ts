import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

import { runMigrations } from '../db/migrations';
import {
    createWatch,
    getAllWatches,
    getWatchById,
    deleteWatch,
    updateWatchStatus,
    updateBookingState,
    getCheckLogs,
    insertCheckLog,
    updateLastChecked,
} from '../db/repository';
import { checkBroadwayShowtimes } from '../cinema/broadway/broadway.adapter';
import { getWindowStatus, formatWindowStatus } from '../watcher/timeWindow';

runMigrations();

const server = new McpServer({
    name: 'broadway-fdfs-watcher',
    version: '1.0.0',
});

// ─── add_watch ─────────────────────────────────────────────────────────────────

server.tool(
    'add_watch',
    'Create a new movie monitoring request',
    {
        movie: z.string().describe('Movie name'),
        theatre: z.string().optional().describe('Theatre name (default: Broadway Cinemas)'),
        target_date: z.string().describe('Target date (YYYY-MM-DD)'),
        preferred_format: z.string().optional().describe('Preferred format (EPIQ, 3D, 2D)'),
        expected_opening_time: z.string().optional().describe('Expected booking opening time (ISO 8601)'),
        activation_start: z.string().optional().describe('Activation window start (ISO 8601)'),
        activation_end: z.string().optional().describe('Activation window end (ISO 8601)'),
        preferred_showtime: z.string().optional().describe('Preferred showtime (e.g. "6:00 PM")'),
        party_size: z.number().int().min(1).optional().describe('Number of seats needed'),
        preferred_seats: z.string().optional().describe('Preferred seats, comma-separated (e.g. "H12,H13")'),
        fallback_seats: z.string().optional().describe('Fallback seat groups, semicolon-separated'),
    },
    async (args) => {
        const watch = createWatch({
            movie: args.movie,
            theatre: args.theatre ?? 'Broadway Cinemas',
            target_date: args.target_date,
            preferred_format: args.preferred_format ?? null,
            preferred_showtime: args.preferred_showtime ?? null,
            party_size: args.party_size ?? 1,
            expected_opening_at: args.expected_opening_time ?? null,
            activation_start: args.activation_start ?? null,
            activation_end: args.activation_end ?? null,
            preferred_seats: args.preferred_seats ?? null,
            fallback_seats: args.fallback_seats ?? null,
        });

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    watch: {
                        id: watch.id,
                        movie: watch.movie,
                        theatre: watch.theatre,
                        target_date: watch.target_date,
                        preferred_format: watch.preferred_format,
                        expected_opening_at: watch.expected_opening_at,
                        preferred_seats: watch.preferred_seats,
                        status: watch.status,
                    },
                }, null, 2),
            }],
        };
    }
);

// ─── list_watches ──────────────────────────────────────────────────────────────

server.tool('list_watches', 'Return all configured watches', {}, async () => {
    const watches = getAllWatches();
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                count: watches.length,
                watches: watches.map((w) => ({
                    id: w.id,
                    movie: w.movie,
                    theatre: w.theatre,
                    target_date: w.target_date,
                    preferred_format: w.preferred_format,
                    status: w.status,
                    booking_state: w.booking_state,
                    last_checked_at: w.last_checked_at,
                    last_result: w.last_result,
                    notified_at: w.notified_at,
                })),
            }, null, 2),
        }],
    };
});

// ─── get_watch ─────────────────────────────────────────────────────────────────

server.tool(
    'get_watch',
    'Return detailed information about a watch',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const watch = getWatchById(id);
        if (!watch) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Watch ${id} not found` }) }] };
        }

        const ws = getWindowStatus(watch);
        const logs = getCheckLogs(id, 10);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    watch,
                    window: { state: ws.state, formatted: formatWindowStatus(ws) },
                    recentLogs: logs,
                }, null, 2),
            }],
        };
    }
);

// ─── pause_watch ───────────────────────────────────────────────────────────────

server.tool(
    'pause_watch',
    'Pause monitoring for a watch',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const watch = getWatchById(id);
        if (!watch) return { content: [{ type: 'text', text: JSON.stringify({ error: `Watch ${id} not found` }) }] };
        updateWatchStatus(id, 'paused');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, status: 'paused' }) }] };
    }
);

// ─── resume_watch ──────────────────────────────────────────────────────────────

server.tool(
    'resume_watch',
    'Resume monitoring for a watch',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const watch = getWatchById(id);
        if (!watch) return { content: [{ type: 'text', text: JSON.stringify({ error: `Watch ${id} not found` }) }] };
        updateWatchStatus(id, 'watching');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, status: 'watching' }) }] };
    }
);

// ─── remove_watch ──────────────────────────────────────────────────────────────

server.tool(
    'remove_watch',
    'Delete a monitoring request',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const deleted = deleteWatch(id);
        return { content: [{ type: 'text', text: JSON.stringify({ success: deleted, id }) }] };
    }
);

// ─── check_status ─────────────────────────────────────────────────────────────

server.tool(
    'check_status',
    'Return current status, last check, seat status, and booking state',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const watch = getWatchById(id);
        if (!watch) return { content: [{ type: 'text', text: JSON.stringify({ error: `Watch ${id} not found` }) }] };

        const ws = getWindowStatus(watch);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    id: watch.id,
                    movie: watch.movie,
                    status: watch.status,
                    booking_state: watch.booking_state,
                    last_checked_at: watch.last_checked_at,
                    last_result: watch.last_result,
                    notified_at: watch.notified_at,
                    window: { state: ws.state, formatted: formatWindowStatus(ws) },
                }, null, 2),
            }],
        };
    }
);

// ─── check_now ─────────────────────────────────────────────────────────────────

server.tool(
    'check_now',
    'Manually execute a check for a watch. Respects minimum poll interval.',
    { id: z.number().int().describe('Watch ID') },
    async ({ id }) => {
        const watch = getWatchById(id);
        if (!watch) return { content: [{ type: 'text', text: JSON.stringify({ error: `Watch ${id} not found` }) }] };

        const start = Date.now();
        const result = await checkBroadwayShowtimes(watch);
        const duration = Date.now() - start;

        const checkResult = result.blocked ? 'blocked' : result.parseError ? 'parse_error' : result.shows.length > 0 ? 'bookable' : 'not_bookable';

        insertCheckLog({ watch_id: id, result: checkResult, http_status: result.rawHttpStatus, duration_ms: duration });
        updateLastChecked(id, checkResult);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    result: checkResult,
                    shows: result.shows,
                    blocked: result.blocked,
                    parseError: result.parseError,
                    httpStatus: result.rawHttpStatus,
                    durationMs: duration,
                }, null, 2),
            }],
        };
    }
);

// ─── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    process.stderr.write('Broadway FDFS MCP Server running on stdio\n');
}).catch((err) => {
    process.stderr.write(`MCP Server failed to start: ${err.message}\n`);
    process.exit(1);
});
