import cron from 'node-cron';
import { getEnv } from './config/env';
import { getLogger } from './config/logger';
import { runMigrations, pruneOldLogs } from './db/migrations';
import { getActiveWatches } from './db/repository';
import { runWatchCycle } from './watcher/watcherWorker';
import { sendStartupMessage, sendProcessError } from './notify/telegram';

const log = getLogger('worker');

async function bootstrap(): Promise<void> {
    log.info('🎬 Broadway FDFS Watcher starting...');

    // 1. Validate environment
    const env = getEnv();
    log.info({ pollInterval: env.POLL_INTERVAL_MINUTES, logLevel: env.LOG_LEVEL }, 'Environment validated');

    // 2. Initialize database & run migrations
    runMigrations();

    // 3. Prune old check_logs (older than 7 days)
    pruneOldLogs(7);

    // 4. Load active watches
    const watches = getActiveWatches();
    log.info({ count: watches.length }, 'Active watches loaded');

    // 5. Count booking-aware watches
    const bookingAware = watches.filter((w) => w.expected_opening_at !== null).length;

    // 6. Send startup Telegram message
    await sendStartupMessage({
        watchCount: watches.length,
        pollIntervalMinutes: env.POLL_INTERVAL_MINUTES,
        bookingAwareCount: bookingAware,
    });

    // 7. Build cron expression from POLL_INTERVAL_MINUTES
    const intervalMinutes = env.POLL_INTERVAL_MINUTES;
    const cronExpr = buildCronExpression(intervalMinutes);
    log.info({ cronExpr, intervalMinutes }, 'Scheduler configured');

    // 8. Run once immediately on startup
    log.info('Running initial check cycle...');
    await runWatchCycle();

    // 9. Schedule recurring checks
    cron.schedule(cronExpr, async () => {
        log.info('⏰ Scheduled check cycle starting');
        try {
            await runWatchCycle();
        } catch (err) {
            log.error({ err }, 'Watch cycle failed');
        }
    });

    log.info(`✅ Watcher running. Checking every ${intervalMinutes} minute(s). Press Ctrl+C to stop.`);
}

function buildCronExpression(intervalMinutes: number): string {
    // For common intervals, use division syntax
    if (intervalMinutes === 1) return '* * * * *';
    if (intervalMinutes <= 30 && 60 % intervalMinutes === 0) {
        return `*/${intervalMinutes} * * * *`;
    }
    // Default to every N minutes starting at minute 0
    return `*/${intervalMinutes} * * * *`;
}

// ─── Process error handling ────────────────────────────────────────────────────

process.on('uncaughtException', async (err) => {
    log.fatal({ err }, 'Uncaught exception — attempting Telegram alert');
    try {
        await sendProcessError(err);
    } catch {
        // Best effort
    }
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    log.fatal({ reason }, 'Unhandled rejection — attempting Telegram alert');
    try {
        await sendProcessError(reason instanceof Error ? reason : new Error(String(reason)));
    } catch {
        // Best effort
    }
    process.exit(1);
});

process.on('SIGINT', () => {
    log.info('SIGINT received — shutting down cleanly');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log.info('SIGTERM received — shutting down cleanly');
    process.exit(0);
});

bootstrap().catch((err) => {
    log.fatal({ err }, 'Bootstrap failed');
    process.exit(1);
});
