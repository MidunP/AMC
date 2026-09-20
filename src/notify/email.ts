import nodemailer, { Transporter } from 'nodemailer';
import type { TicketLivePayload, SeatsHeldPayload } from '../types';
import { getEnv } from '../config/env';
import { getLogger } from '../config/logger';

const log = getLogger('email');

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
    const env = getEnv();

    // Check if email features are enabled & SMTP user/pass exist
    if (env.EMAIL_ENABLED === false) {
        log.debug('Email notification is explicitly disabled in config');
        return null;
    }

    if (!env.SMTP_USER || !env.SMTP_PASS) {
        log.debug('SMTP credentials (SMTP_USER / SMTP_PASS) not configured — email sending skipped');
        return null;
    }

    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
            auth: {
                user: env.SMTP_USER,
                pass: env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false,
            },
        });
    }

    return transporter;
}

export interface EmailOptions {
    to?: string;
    subject: string;
    html: string;
    text?: string;
}

/**
 * Core helper for sending HTML email.
 * Safe execution: logs error on failure but never throws.
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
    const env = getEnv();
    const mailer = getTransporter();

    const recipient = options.to || env.EMAIL_TO;
    if (!recipient) {
        log.debug('No recipient specified and EMAIL_TO is empty — skipping email');
        return false;
    }

    if (!mailer) {
        log.debug({ recipient, subject: options.subject }, 'Mailer not initialized — email notification bypassed');
        return false;
    }

    const from = env.EMAIL_FROM || env.SMTP_USER || 'Broadway Watcher <no-reply@broadway-watcher.com>';

    try {
        const info = await mailer.sendMail({
            from,
            to: recipient,
            subject: options.subject,
            html: options.html,
            text: options.text,
        });

        log.info({ messageId: info.messageId, recipient }, '📧 Email notification sent successfully');
        return true;
    } catch (err) {
        log.error({ err: (err as Error).message, recipient }, '❌ Email sending failed — watcher continues');
        return false;
    }
}

/**
 * Send a test email to verify SMTP configuration
 */
export async function sendTestEmail(targetEmail?: string): Promise<boolean> {
    const env = getEnv();
    const recipient = targetEmail || env.EMAIL_TO;

    if (!recipient) {
        log.warn('Cannot send test email: EMAIL_TO is not set in configuration');
        return false;
    }

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 20px; }
        .card { max-width: 550px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; border: 1px solid #334155; padding: 28px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        .badge { display: inline-block; background-color: #10b981; color: #022c22; font-weight: bold; padding: 4px 12px; border-radius: 9999px; font-size: 12px; text-transform: uppercase; }
        h2 { color: #ffffff; margin-top: 12px; }
        p { color: #94a3b8; font-size: 15px; line-height: 1.6; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #334155; color: #64748b; font-size: 12px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">System Check</span>
        <h2>🎬 Broadway FDFS Watcher — Email Verified!</h2>
        <p>This is a test notification confirming that your email setup is active and fully functional.</p>
        <p>When tickets go live or seats are reserved for your watched shows, instant alerts will land right here in your inbox.</p>
        <div class="footer">
          Broadway FDFS Ticket Watcher Engine &bull; Automated Personal Alert System
        </div>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        to: recipient,
        subject: '✅ Broadway FDFS Watcher — Test Email Verification',
        html,
        text: 'Broadway FDFS Watcher: Test email received successfully!',
    });
}

/**
 * Send TICKETS LIVE email alert
 */
export async function sendTicketLiveEmail(payload: TicketLivePayload): Promise<boolean> {
    const seatLines = payload.preferredSeats.map((seat) => {
        const status = payload.seatStatus[seat];
        const color = status === 'available' ? '#10b981' : status === 'unavailable' ? '#ef4444' : '#f59e0b';
        const label = status === 'available' ? 'Available' : status === 'unavailable' ? 'Unavailable' : 'Unknown';
        return `<li style="margin-bottom: 6px;"><strong style="color: #f8fafc;">${seat}:</strong> <span style="color: ${color}; font-weight: 600;">${label}</span></li>`;
    }).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #090d16; color: #f8fafc; padding: 20px; }
        .container { max-width: 580px; margin: 0 auto; background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #4338ca; padding: 32px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
        .alert-banner { background-color: #dc2626; color: #ffffff; text-align: center; font-weight: 900; font-size: 14px; letter-spacing: 1px; padding: 8px 16px; border-radius: 8px; margin-bottom: 20px; text-transform: uppercase; }
        .movie-title { font-size: 26px; font-weight: 800; color: #ffffff; margin: 0 0 16px 0; text-shadow: 0 2px 4px rgba(0,0,0,0.4); }
        .details-grid { background-color: rgba(30, 41, 59, 0.7); border-radius: 12px; padding: 18px; margin-bottom: 24px; border: 1px solid #334155; }
        .detail-item { font-size: 14px; margin-bottom: 10px; color: #cbd5e1; }
        .detail-item strong { color: #f8fafc; width: 110px; display: inline-block; }
        .btn-container { text-align: center; margin: 30px 0 10px 0; }
        .btn { display: inline-block; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: #ffffff !important; text-decoration: none; font-size: 18px; font-weight: 800; padding: 16px 36px; border-radius: 12px; box-shadow: 0 4px 15px rgba(220, 38, 38, 0.5); letter-spacing: 0.5px; }
        .footer { margin-top: 28px; border-top: 1px solid #334155; padding-top: 16px; font-size: 12px; color: #64748b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="alert-banner">🚨 TICKETS LIVE NOW!</div>
        <h1 class="movie-title">🎬 ${payload.movie}</h1>
        
        <div class="details-grid">
          <div class="detail-item"><strong>📍 Theatre:</strong> ${payload.theatre}</div>
          <div class="detail-item"><strong>📅 Date:</strong> ${payload.date}</div>
          <div class="detail-item"><strong>🖥️ Format:</strong> ${payload.format}</div>
          <div class="detail-item"><strong>🕐 Showtime:</strong> ${payload.showtime}</div>
        </div>

        ${payload.preferredSeats.length > 0 ? `
        <div style="margin-bottom: 24px;">
          <h4 style="color: #cbd5e1; margin-bottom: 10px;">🎟️ Preferred Seats Status:</h4>
          <ul style="list-style: none; padding-left: 0; margin: 0;">${seatLines}</ul>
        </div>
        ` : ''}

        <div class="btn-container">
          <a href="${payload.bookingUrl}" class="btn" target="_blank">🎟️ BOOK NOW ON BOOKMYSHOW</a>
        </div>

        <div class="footer">
          Broadway FDFS Ticket Watcher &bull; High-Priority Real-Time Alert
        </div>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        subject: `🚨 TICKETS LIVE: ${payload.movie} @ ${payload.theatre}`,
        html,
        text: `TICKETS LIVE! Movie: ${payload.movie}, Showtime: ${payload.showtime}. Book now: ${payload.bookingUrl}`,
    });
}

/**
 * Send SEATS HELD email alert
 */
export async function sendSeatsHeldEmail(payload: SeatsHeldPayload): Promise<boolean> {
    const seatsStr = payload.seats.join(', ');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #090d16; color: #f8fafc; padding: 20px; }
        .container { max-width: 580px; margin: 0 auto; background: linear-gradient(135deg, #065f46 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #10b981; padding: 32px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
        .alert-banner { background-color: #10b981; color: #022c22; text-align: center; font-weight: 900; font-size: 14px; letter-spacing: 1px; padding: 8px 16px; border-radius: 8px; margin-bottom: 20px; text-transform: uppercase; }
        .movie-title { font-size: 26px; font-weight: 800; color: #ffffff; margin: 0 0 16px 0; }
        .seats-box { background-color: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; border-radius: 12px; padding: 18px; margin-bottom: 24px; text-align: center; }
        .seats-text { font-size: 22px; font-weight: 800; color: #34d399; margin: 4px 0 0 0; }
        .btn-container { text-align: center; margin: 30px 0 10px 0; }
        .btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff !important; text-decoration: none; font-size: 18px; font-weight: 800; padding: 16px 36px; border-radius: 12px; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); }
        .footer { margin-top: 28px; border-top: 1px solid #334155; padding-top: 16px; font-size: 12px; color: #64748b; text-align: center; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="alert-banner">🔒 SEATS TEMPORARILY LOCKED & HELD</div>
        <h1 class="movie-title">🎬 ${payload.movie}</h1>

        <div class="seats-box">
          <div style="font-size: 13px; color: #a7f3d0; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Reserved Seats</div>
          <div class="seats-text">${seatsStr}</div>
        </div>

        <p style="color: #e2e8f0; font-size: 15px; line-height: 1.6;">
          Your seats have been automatically locked in your BookMyShow session.
          <br><strong style="color: #f8fafc;">BMS Hold Timer: approx 10 minutes.</strong> Complete payment before it expires!
        </p>

        <div class="btn-container">
          <a href="${payload.continuationUrl}" class="btn" target="_blank">💳 COMPLETE PAYMENT NOW</a>
        </div>

        <div class="footer">
          Broadway FDFS Ticket Watcher &bull; Automated Seat Lock System
        </div>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        subject: `⚡ SEATS HELD (${seatsStr}): ${payload.movie}`,
        html,
        text: `Seats ${seatsStr} locked for ${payload.movie}! Pay now: ${payload.continuationUrl}`,
    });
}

/**
 * Send pre-opening alert email (~1 hr before expected opening time)
 */
export async function sendApproachingAlertEmail(opts: {
    movie: string;
    minutesUntilOpening: number;
    expectedOpeningAt: string;
}): Promise<boolean> {
    const timeStr = new Date(opts.expectedOpeningAt).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
    });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 20px; }
        .card { max-width: 550px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; border: 1px solid #f59e0b; padding: 28px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        .badge { display: inline-block; background-color: #f59e0b; color: #451a03; font-weight: bold; padding: 4px 12px; border-radius: 9999px; font-size: 12px; text-transform: uppercase; }
        h2 { color: #ffffff; margin-top: 12px; }
        p { color: #cbd5e1; font-size: 15px; line-height: 1.6; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #334155; color: #64748b; font-size: 12px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">⏰ Booking Opens Soon</span>
        <h2>🎬 ${opts.movie} — Opening Imminent</h2>
        <p>Expected opening time: <strong>${timeStr} IST</strong> (in approx. <strong>${opts.minutesUntilOpening} minutes</strong>).</p>
        <p>The watcher engine has automatically switched to high-frequency scan mode. Stay tuned for the instant notification as soon as tickets open!</p>
        <div class="footer">
          Broadway FDFS Ticket Watcher Engine
        </div>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        subject: `⏰ Booking Opens Soon: ${opts.movie} (in ~${opts.minutesUntilOpening}m)`,
        html,
        text: `Booking for ${opts.movie} expected to open at ${timeStr} IST (~${opts.minutesUntilOpening}m). Watcher is on high alert.`,
    });
}

/**
 * Send daily heartbeat status email
 */
export async function sendDailyHeartbeatEmail(opts: {
    watches: Array<{
        movie: string;
        targetDate: string;
        expectedOpeningAt: string | null;
        msUntilOpening: number | null;
    }>;
}): Promise<boolean> {
    const now = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
    });

    const watchRows = opts.watches.map((w) => {
        const status = w.msUntilOpening !== null
            ? `Opens in <strong>${formatCountdownEmail(w.msUntilOpening)}</strong>`
            : 'Actively monitoring';
        return `
        <tr style="border-bottom: 1px solid #334155;">
          <td style="padding: 12px; color: #ffffff; font-weight: bold;">${w.movie}</td>
          <td style="padding: 12px; color: #cbd5e1;">${w.targetDate}</td>
          <td style="padding: 12px; color: #38bdf8;">${status}</td>
        </tr>
        `;
    }).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 20px; }
        .card { max-width: 600px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; border: 1px solid #334155; padding: 28px; }
        h2 { color: #ffffff; margin-top: 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th { text-align: left; padding: 10px; background-color: #0f172a; color: #94a3b8; font-size: 13px; text-transform: uppercase; }
        .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #334155; color: #64748b; font-size: 12px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>👁️ Daily Watch Status Report</h2>
        <div style="color: #94a3b8; font-size: 13px; margin-bottom: 16px;">${now} IST</div>
        <table>
          <thead>
            <tr>
              <th>Movie</th>
              <th>Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${watchRows}
          </tbody>
        </table>
        <p style="margin-top: 20px; color: #10b981; font-weight: bold; font-size: 14px;">🟢 All watcher services operational 24/7.</p>
        <div class="footer">
          Broadway FDFS Ticket Watcher Engine
        </div>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        subject: `👁️ Daily Watch Status Report — ${opts.watches.length} Active Watch(es)`,
        html,
        text: `Daily Watcher Report (${now} IST): ${opts.watches.length} active watch(es) running.`,
    });
}

/**
 * Send critical process error email
 */
export async function sendProcessErrorEmail(err: Error): Promise<boolean> {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 20px; }
        .card { max-width: 550px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; border: 1px solid #ef4444; padding: 28px; }
        .badge { display: inline-block; background-color: #ef4444; color: #ffffff; font-weight: bold; padding: 4px 12px; border-radius: 9999px; font-size: 12px; text-transform: uppercase; }
        h2 { color: #ffffff; margin-top: 12px; }
        pre { background-color: #090d16; padding: 14px; border-radius: 8px; color: #fca5a5; overflow-x: auto; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">Process Error</span>
        <h2>🔴 Watcher Critical Exception</h2>
        <p style="color: #cbd5e1;">The ticket watcher process encountered an error:</p>
        <pre>${err.message}</pre>
        <p style="color: #94a3b8; font-size: 13px;">Please inspect system logs to verify worker state.</p>
      </div>
    </body>
    </html>
    `;

    return sendEmail({
        subject: `🔴 CRITICAL: Watcher Process Error`,
        html,
        text: `Watcher process error: ${err.message}`,
    });
}

function formatCountdownEmail(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
