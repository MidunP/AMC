import { getDb } from './connection';
import type {
    Watch,
    WatchStatus,
    BookingState,
    CheckResult,
    CheckLog,
    BookingAttempt,
} from '../types';

// ─── Watch Repository ──────────────────────────────────────────────────────────

export function createWatch(
    data: Omit<Watch, 'id' | 'created_at' | 'updated_at' | 'last_checked_at' | 'last_result' | 'notified_at' | 'status' | 'booking_state'>
): Watch {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO watches
      (movie, theatre, target_date, preferred_format, preferred_showtime,
       party_size, expected_opening_at, activation_start, activation_end,
       preferred_seats, fallback_seats)
    VALUES
      (@movie, @theatre, @target_date, @preferred_format, @preferred_showtime,
       @party_size, @expected_opening_at, @activation_start, @activation_end,
       @preferred_seats, @fallback_seats)
  `);
    const result = stmt.run(data);
    return getWatchById(result.lastInsertRowid as number)!;
}

export function getWatchById(id: number): Watch | null {
    const db = getDb();
    return db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | null;
}

export function getAllWatches(): Watch[] {
    const db = getDb();
    return db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as Watch[];
}

export function getActiveWatches(): Watch[] {
    const db = getDb();
    return db
        .prepare("SELECT * FROM watches WHERE status = 'watching' ORDER BY created_at ASC")
        .all() as Watch[];
}

export function updateWatchStatus(id: number, status: WatchStatus): void {
    const db = getDb();
    db.prepare("UPDATE watches SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function updateBookingState(id: number, state: BookingState): void {
    const db = getDb();
    db.prepare("UPDATE watches SET booking_state = ?, updated_at = datetime('now') WHERE id = ?").run(state, id);
}

export function updateLastChecked(id: number, result: CheckResult): void {
    const db = getDb();
    db.prepare(
        "UPDATE watches SET last_checked_at = datetime('now'), last_result = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(result, id);
}

export function markNotified(id: number): void {
    const db = getDb();
    db.prepare(
        "UPDATE watches SET notified_at = datetime('now'), status = 'notified', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
}

export function deleteWatch(id: number): boolean {
    const db = getDb();
    const result = db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    return result.changes > 0;
}

// ─── Check Log Repository ──────────────────────────────────────────────────────

export function insertCheckLog(data: {
    watch_id: number;
    result: CheckResult;
    http_status?: number;
    notes?: string;
    duration_ms?: number;
}): CheckLog {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO check_logs (watch_id, checked_at, result, http_status, notes, duration_ms)
    VALUES (@watch_id, datetime('now'), @result, @http_status, @notes, @duration_ms)
  `);
    const r = stmt.run({
        watch_id: data.watch_id,
        result: data.result,
        http_status: data.http_status ?? null,
        notes: data.notes ?? null,
        duration_ms: data.duration_ms ?? null,
    });
    return db.prepare('SELECT * FROM check_logs WHERE id = ?').get(r.lastInsertRowid) as CheckLog;
}

export function getCheckLogs(watchId: number, limit = 20): CheckLog[] {
    const db = getDb();
    return db
        .prepare('SELECT * FROM check_logs WHERE watch_id = ? ORDER BY checked_at DESC LIMIT ?')
        .all(watchId, limit) as CheckLog[];
}

export function getRecentConsecutiveBlocks(watchId: number, count = 3): CheckLog[] {
    const db = getDb();
    return db
        .prepare(
            "SELECT * FROM check_logs WHERE watch_id = ? ORDER BY checked_at DESC LIMIT ?"
        )
        .all(watchId, count) as CheckLog[];
}

// ─── Booking Attempt Repository ────────────────────────────────────────────────

export function insertBookingAttempt(data: Omit<BookingAttempt, 'id'>): BookingAttempt {
    const db = getDb();
    const stmt = db.prepare(`
    INSERT INTO booking_attempts
      (watch_id, attempted_at, show_identifier, seat_selection, result, booking_url, hold_detected, notes)
    VALUES
      (@watch_id, @attempted_at, @show_identifier, @seat_selection, @result, @booking_url, @hold_detected, @notes)
  `);
    const r = stmt.run({
        watch_id: data.watch_id,
        attempted_at: data.attempted_at ?? new Date().toISOString(),
        show_identifier: data.show_identifier ?? null,
        seat_selection: data.seat_selection ?? null,
        result: data.result ?? null,
        booking_url: data.booking_url ?? null,
        hold_detected: data.hold_detected ?? 0,
        notes: data.notes ?? null,
    });
    return db.prepare('SELECT * FROM booking_attempts WHERE id = ?').get(r.lastInsertRowid) as BookingAttempt;
}

export function getBookingAttempts(watchId: number): BookingAttempt[] {
    const db = getDb();
    return db
        .prepare('SELECT * FROM booking_attempts WHERE watch_id = ? ORDER BY attempted_at DESC')
        .all(watchId) as BookingAttempt[];
}
