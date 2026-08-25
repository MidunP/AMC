import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const envSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
    TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),
    DATABASE_PATH: z.string().default('./data/tickets.db'),
    POLL_INTERVAL_MINUTES: z
        .string()
        .default('5')
        .transform(Number)
        .refine((n) => n >= 3, {
            message: 'POLL_INTERVAL_MINUTES must be at least 3 to respect rate limits',
        }),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
    if (_env) return _env;

    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`❌ Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`);
    }

    _env = result.data;
    return _env;
}

export function getDatabasePath(): string {
    const env = getEnv();
    return path.resolve(env.DATABASE_PATH);
}
