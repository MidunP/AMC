import fs from 'fs';
import path from 'path';
import { createWatch, getAllWatches } from './repository';
import { getLogger } from '../config/logger';

const log = getLogger('preset-loader');

export const PRESETS_FILE = path.resolve('./data/presets.json');

export interface MoviePreset {
    movie: string;
    target_date: string;
    preferred_format?: string;
    preferred_showtime?: string;
    party_size?: number;
    expected_opening_at?: string;
    preferred_seats?: string;
    fallback_seats?: string;
    enabled?: boolean;
}

const DEFAULT_PRESETS_EXAMPLE: MoviePreset[] = [
    {
        movie: 'Coolie',
        target_date: '2026-11-01',
        preferred_format: 'EPIQ',
        party_size: 4,
        preferred_seats: 'F10,F11,F12,F13',
        fallback_seats: 'H10,H11,H12,H13;G10,G11,G12,G13',
        enabled: true,
    },
    {
        movie: 'Avatar 3: Fire and Ash',
        target_date: '2026-12-18',
        preferred_format: '3D',
        party_size: 2,
        preferred_seats: 'H12,H13',
        enabled: false,
    },
];

/**
 * Ensures presets.json exists and auto-imports any new pre-defined movies into the database.
 */
export function syncPresets(): number {
    const dir = path.dirname(PRESETS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(PRESETS_FILE)) {
        fs.writeFileSync(PRESETS_FILE, JSON.stringify(DEFAULT_PRESETS_EXAMPLE, null, 2), 'utf-8');
        log.info({ presetsFile: PRESETS_FILE }, 'Created default data/presets.json template');
    }

    try {
        const content = fs.readFileSync(PRESETS_FILE, 'utf-8');
        const presets: MoviePreset[] = JSON.parse(content);
        const existingWatches = getAllWatches();
        let importedCount = 0;

        for (const preset of presets) {
            if (preset.enabled === false) continue;

            const exists = existingWatches.some(
                (w) =>
                    w.movie.toLowerCase() === preset.movie.toLowerCase() &&
                    w.target_date === preset.target_date
            );

            if (!exists) {
                createWatch({
                    movie: preset.movie,
                    theatre: 'Broadway Cinemas',
                    target_date: preset.target_date,
                    preferred_format: preset.preferred_format ?? null,
                    preferred_showtime: preset.preferred_showtime ?? null,
                    party_size: preset.party_size ?? 1,
                    expected_opening_at: preset.expected_opening_at ?? null,
                    activation_start: null,
                    activation_end: null,
                    preferred_seats: preset.preferred_seats ?? null,
                    fallback_seats: preset.fallback_seats ?? null,
                });
                importedCount++;
                log.info({ movie: preset.movie, date: preset.target_date }, '📥 Auto-imported preset watch into database');
            }
        }

        return importedCount;
    } catch (err) {
        log.error({ err: (err as Error).message }, 'Failed to parse data/presets.json');
        return 0;
    }
}
