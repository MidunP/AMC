import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getDatabasePath } from '../config/env';
import { getLogger } from '../config/logger';

const log = getLogger('database');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (_db) return _db;

    const dbPath = getDatabasePath();
    const dir = path.dirname(dbPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL');

    log.info({ dbPath }, 'Database connection established');
    return _db;
}

export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
        log.info('Database connection closed');
    }
}
