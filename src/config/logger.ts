import pino from 'pino';
import { getEnv } from './env';

let _logger: pino.Logger | null = null;

export function getLogger(name?: string): pino.Logger {
    if (!_logger) {
        const env = getEnv();
        const isDev = env.NODE_ENV === 'development';

        _logger = pino({
            level: env.LOG_LEVEL,
            transport: isDev
                ? {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'SYS:standard',
                        ignore: 'pid,hostname',
                    },
                }
                : undefined,
            base: isDev ? undefined : { service: 'broadway-watcher' },
            redact: {
                paths: [
                    'token',
                    'botToken',
                    'TELEGRAM_BOT_TOKEN',
                    'cookie',
                    'cookies',
                    'session',
                    'password',
                    'otp',
                    'payment',
                    'cardNumber',
                    'cvv',
                    'upi',
                ],
                censor: '[REDACTED]',
            },
        });
    }

    return name ? _logger.child({ name }) : _logger;
}
