import { getDb } from './connection';
import { getLogger } from '../config/logger';

const log = getLogger('migrations');

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
    {
        version: 1,
        name: 'initial_schema',
        sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS watches (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        movie              TEXT    NOT NULL,
        theatre            TEXT    NOT NULL DEFAULT 'Broadway Cinemas',
        target_date        TEXT    NOT NULL,
        preferred_format   TEXT,
        preferred_showtime TEXT,
        party_size         INTEGER NOT NULL DEFAULT 1,
        expected_opening_at TEXT,
        activation_start   TEXT,
        activation_end     TEXT,
        preferred_seats    TEXT,
        fallback_seats     TEXT,
        status             TEXT    NOT NULL DEFAULT 'watching',
        last_checked_at    TEXT,
        last_result        TEXT,
        notified_at        TEXT,
        booking_state      TEXT    DEFAULT 'not_started',
        created_at         TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TEXT
      );

      CREATE TABLE IF NOT EXISTS check_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id    INTEGER NOT NULL,
        checked_at  TEXT    NOT NULL,
        result      TEXT    NOT NULL,
        http_status INTEGER,
        notes       TEXT,
        duration_ms INTEGER,
        FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS booking_attempts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id         INTEGER NOT NULL,
        attempted_at     TEXT    NOT NULL,
        show_identifier  TEXT,
        seat_selection   TEXT,
        result           TEXT,
        booking_url      TEXT,
        hold_detected    INTEGER DEFAULT 0,
        notes            TEXT,
        FOREIGN KEY(watch_id) REFERENCES watches(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_watches_status       ON watches(status);
      CREATE INDEX IF NOT EXISTS idx_watches_target_date  ON watches(target_date);
      CREATE INDEX IF NOT EXISTS idx_check_logs_watch_id  ON check_logs(watch_id);
      CREATE INDEX IF NOT EXISTS idx_check_logs_checked_at ON check_logs(checked_at);
    `,
    },
];

export function runMigrations(): void {
    const db = getDb();

    // Ensure version table exists
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

    const getCurrentVersion = db.prepare('SELECT MAX(version) as v FROM schema_version');
    const row = getCurrentVersion.get() as { v: number | null };
    const currentVersion = row.v ?? 0;

    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

    if (pending.length === 0) {
        log.info({ currentVersion }, 'Database schema is up to date');
        return;
    }

    for (const migration of pending) {
        log.info({ version: migration.version, name: migration.name }, 'Running migration');
        const run = db.transaction(() => {
            db.exec(migration.sql);
            db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version);
        });
        run();
        log.info({ version: migration.version }, 'Migration complete');
    }
}

export function pruneOldLogs(daysToKeep = 7): number {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString();

    const result = db.prepare('DELETE FROM check_logs WHERE checked_at < ?').run(cutoffStr);
    log.info({ deleted: result.changes, cutoff: cutoffStr }, 'Pruned old check logs');
    return result.changes;
}
