import { chromium, Browser, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getLogger } from '../config/logger';

const log = getLogger('browser-session');

export const SESSION_FILE = path.resolve('./data/bms-session.json');

/**
 * Load a previously saved BMS session.
 * Returns null if no session file exists yet — run `npm run session:setup` first.
 */
export async function loadBmsSession(): Promise<{ browser: Browser; context: BrowserContext } | null> {
    if (!fs.existsSync(SESSION_FILE)) {
        log.warn({ sessionFile: SESSION_FILE }, 'No BMS session file found — run: npm run session:setup');
        return null;
    }

    try {
        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext({
            storageState: SESSION_FILE,
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            locale: 'en-IN',
            timezoneId: 'Asia/Kolkata',
        });
        log.info({ sessionFile: SESSION_FILE }, 'BMS session loaded');
        return { browser, context };
    } catch (err) {
        log.error({ err }, 'Failed to load BMS session');
        return null;
    }
}

/**
 * One-time interactive setup: opens a visible browser window, lets the user
 * log in to BookMyShow, then saves the session to disk.
 *
 * Run with: npm run session:setup
 *
 * The saved file (data/bms-session.json) contains only cookies & localStorage.
 * It does NOT contain your password — BMS never puts passwords in session state.
 */
export async function setupBmsSession(): Promise<void> {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    console.log('\n🔐 BMS Session Setup');
    console.log('────────────────────────────────────────────────────');
    console.log('A browser window will open. Please:');
    console.log('  1. Log in to your BookMyShow account (Google, Phone, etc.)');
    console.log('  2. Make sure you can see your profile / name in the top-right');
    console.log('  3. Come back here and press ENTER');
    console.log('────────────────────────────────────────────────────\n');

    const browser = await chromium.launch({
        headless: false, // visible window so user can log in
        args: ['--start-maximized'],
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: null, // use the window size
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
    });

    const page = await context.newPage();
    await page.goto('https://in.bookmyshow.com', { waitUntil: 'domcontentloaded' });

    // Wait for the user to log in
    await promptEnter('✋ Press ENTER once you are logged in to BookMyShow...');

    // Verify login by checking for a profile indicator
    const isLoggedIn = await page
        .locator('[class*="UserName"], [class*="user-name"], [data-qa="user-name"], [class*="profile-name"]')
        .first()
        .isVisible()
        .catch(() => false);

    if (!isLoggedIn) {
        console.log('\n⚠️  Could not detect login — saving session anyway.');
        console.log('   If the seat holder fails, re-run: npm run session:setup\n');
    } else {
        console.log('\n✅ Login detected!\n');
    }

    // Save session state (cookies + localStorage)
    await context.storageState({ path: SESSION_FILE });
    await browser.close();

    console.log(`✅ Session saved to: ${SESSION_FILE}`);
    console.log('   Your session is valid for as long as BMS keeps you logged in.');
    console.log('   Re-run this command if the seat holder reports "not logged in".\n');
}

/**
 * Check if valid session exists on disk.
 */
export function hasSession(): boolean {
    return fs.existsSync(SESSION_FILE);
}

function promptEnter(message: string): Promise<void> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message + ' ', () => {
            rl.close();
            resolve();
        });
    });
}
