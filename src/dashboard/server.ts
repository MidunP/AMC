import http from 'http';
import url from 'url';
import { getEnv } from '../config/env';
import { getLogger } from '../config/logger';
import { runMigrations } from '../db/migrations';
import {
  getAllWatches,
  createWatch,
  deleteWatch,
  updateWatchStatus,
  updateWatchSeats,
  getWatchById,
} from '../db/repository';
import { syncPresets, PRESETS_FILE } from '../db/presetLoader';
import { getWindowStatus } from '../watcher/timeWindow';
import { sendTestMessage } from '../notify/telegram';
import { sendTestEmail } from '../notify/email';

const log = getLogger('dashboard');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export function startDashboardServer(): void {
  runMigrations();
  syncPresets();

  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url || '/', true);
    const method = req.method || 'GET';
    const pathname = parsedUrl.pathname || '/';

    // CORS & JSON Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API Endpoint: GET /api/watches
    if (pathname === '/api/watches' && method === 'GET') {
      const watches = getAllWatches();
      const now = new Date();
      const enriched = watches.map((w) => {
        const ws = getWindowStatus(w, now);
        return { ...w, windowStatus: ws };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(enriched));
      return;
    }

    // API Endpoint: POST /api/watches
    if (pathname === '/api/watches' && method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const watch = createWatch({
            movie: data.movie,
            theatre: data.theatre || 'Broadway Cinemas',
            target_date: data.target_date,
            preferred_format: data.preferred_format || null,
            preferred_showtime: data.preferred_showtime || null,
            party_size: parseInt(data.party_size || '1', 10),
            expected_opening_at: data.expected_opening_at || null,
            activation_start: data.activation_start || null,
            activation_end: data.activation_end || null,
            preferred_seats: data.preferred_seats ? data.preferred_seats.trim() : null,
            fallback_seats: data.fallback_seats ? data.fallback_seats.trim() : null,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, watch }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }

    // API Endpoint: POST /api/watches/:id/seats (Update Seats for Existing Watch)
    if (pathname.includes('/seats') && method === 'POST') {
      const parts = pathname.split('/');
      const id = parseInt(parts[3], 10);
      if (!isNaN(id)) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const pref = data.preferred_seats ? data.preferred_seats.trim() : null;
            const fall = data.fallback_seats ? data.fallback_seats.trim() : null;
            updateWatchSeats(id, pref, fall);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        });
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid watch ID' }));
      }
      return;
    }

    // API Endpoint: DELETE /api/watches/:id
    if (pathname.startsWith('/api/watches/') && method === 'DELETE') {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!isNaN(id)) {
        deleteWatch(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid watch ID' }));
      }
      return;
    }

    // API Endpoint: POST /api/watches/:id/toggle
    if (pathname.includes('/toggle') && method === 'POST') {
      const id = parseInt(pathname.split('/')[3], 10);
      const watch = getWatchById(id);
      if (watch) {
        const nextStatus = watch.status === 'watching' ? 'paused' : 'watching';
        updateWatchStatus(id, nextStatus);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, newStatus: nextStatus }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Watch not found' }));
      }
      return;
    }

    // API Endpoint: POST /api/test/telegram
    if (pathname === '/api/test/telegram' && method === 'POST') {
      sendTestMessage().then((ok) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok }));
      });
      return;
    }

    // API Endpoint: POST /api/test/email
    if (pathname === '/api/test/email' && method === 'POST') {
      sendTestEmail().then((ok) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok }));
      });
      return;
    }

    // Serve Minimalist HTML Dashboard Page
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  });

  server.listen(PORT, () => {
    log.info({ port: PORT, url: `http://localhost:${PORT}` }, '🌐 Dashboard Web Server live');
    console.log(`\n🌐 Broadway Watcher Control Panel: http://localhost:${PORT}\n`);
  });
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Broadway Watcher Console</title>
  <style>
    :root {
      --bg: #09090b;
      --panel: #121215;
      --border: #27272a;
      --border-light: #3f3f46;
      --text: #fafafa;
      --muted: #a1a1aa;
      --dim: #71717a;
      --accent: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --btn-bg: #18181b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 32px 24px;
      line-height: 1.4;
      font-size: 13px;
    }

    .shell { max-width: 1080px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 28px;
    }

    .sys-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; color: var(--text); }
    .sys-sub { font-size: 12px; color: var(--dim); margin-top: 2px; }

    .actions-row { display: flex; gap: 8px; }

    button {
      background: var(--btn-bg);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover { background: #27272a; border-color: var(--border-light); }
    button.btn-primary { background: #fafafa; color: #09090b; border-color: #fafafa; }
    button.btn-primary:hover { background: #e4e4e7; }
    button.btn-danger { color: #fca5a5; border-color: rgba(239, 68, 68, 0.4); }
    button.btn-danger:hover { background: rgba(239, 68, 68, 0.15); }

    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--dim); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }

    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .movie-title { font-size: 16px; font-weight: 700; color: #ffffff; }
    .meta-tag { font-size: 11px; color: var(--muted); margin-top: 2px; }

    .status-dot {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .status-active { color: var(--accent); border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08); }
    .status-paused { color: var(--warn); border-color: rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.08); }

    .data-table { width: 100%; margin: 12px 0; border-collapse: collapse; }
    .data-table td { padding: 4px 0; font-size: 12px; }
    .data-table td.label { color: var(--dim); width: 40%; }
    .data-table td.val { color: var(--text); font-weight: 500; }

    .seat-box {
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin: 10px 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: #38bdf8;
    }
    .seat-box.no-seat { color: var(--dim); font-style: italic; }

    .card-actions { display: flex; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }

    /* Dialog Modal */
    .dialog-bg {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
    }
    .dialog {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      width: 100%;
      max-width: 480px;
      padding: 24px;
    }
    .dialog-title { font-size: 15px; font-weight: 700; margin-bottom: 16px; }

    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
    .input {
      width: 100%;
      background: #09090b;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
    }
    .input:focus { border-color: var(--border-light); outline: none; }
    .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

    .hint { font-size: 11px; color: var(--dim); margin-top: 4px; }
    .empty { text-align: center; padding: 48px; border: 1px dashed var(--border); border-radius: 8px; color: var(--dim); }
  </style>
</head>
<body>

  <div class="shell">
    <header>
      <div>
        <div class="sys-title">Broadway Watcher Queue</div>
        <div class="sys-sub">Pre-defined watches &amp; ticket auto-hold engine</div>
      </div>
      <div class="actions-row">
        <button onclick="testTelegram()">Test Telegram</button>
        <button onclick="testEmail()">Test Email</button>
        <button class="btn-primary" onclick="openAddModal()">+ Add Movie</button>
      </div>
    </header>

    <div class="section-head">
      <div class="section-title">Pre-entered Watches (<span id="count">0</span>)</div>
    </div>

    <div class="grid" id="grid"></div>
  </div>

  <!-- Add Movie Modal -->
  <div class="dialog-bg" id="addModal">
    <div class="dialog">
      <div class="dialog-title">Pre-define Upcoming Watch</div>
      <form onsubmit="handleAdd(event)">
        <div class="field">
          <label>Movie Title</label>
          <input type="text" id="add_movie" class="input" placeholder="e.g. Pushpa 3 / Coolie" required>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Screening Date</label>
            <input type="date" id="add_date" class="input" required>
          </div>
          <div class="field">
            <label>Format</label>
            <select id="add_format" class="input">
              <option value="EPIQ">EPIQ</option>
              <option value="3D">3D</option>
              <option value="IMAX">IMAX</option>
              <option value="2D">2D</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Party Size</label>
            <input type="number" id="add_party" class="input" value="2" min="1" max="10" required>
          </div>
          <div class="field">
            <label>Expected Opening (Optional)</label>
            <input type="datetime-local" id="add_open" class="input">
          </div>
        </div>
        <div class="field">
          <label>Preferred Seats <span style="font-weight:400; text-transform:none;">(Optional)</span></label>
          <input type="text" id="add_seats" class="input" placeholder="e.g. F10,F11,F12 (Leave empty for alert mode)">
          <div class="hint">Leave empty if you want instant alerts for ANY seat available</div>
        </div>
        <div class="field">
          <label>Fallback Seat Groups <span style="font-weight:400; text-transform:none;">(Optional)</span></label>
          <input type="text" id="add_fallback" class="input" placeholder="e.g. H10-H12;G10-G12">
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
          <button type="button" onclick="closeAddModal()">Cancel</button>
          <button type="submit" class="btn-primary">Save Watch</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Edit Seats Modal -->
  <div class="dialog-bg" id="editSeatsModal">
    <div class="dialog">
      <div class="dialog-title">Update Seat Preferences</div>
      <input type="hidden" id="edit_id">
      <div class="field">
        <label>Preferred Seats (Optional)</label>
        <input type="text" id="edit_seats" class="input" placeholder="e.g. F10,F11,F12,F13 (Leave blank for alert mode)">
      </div>
      <div class="field">
        <label>Fallback Seat Groups (Optional)</label>
        <input type="text" id="edit_fallback" class="input" placeholder="e.g. H10-H13;G10-G13">
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
        <button type="button" onclick="closeEditSeatsModal()">Cancel</button>
        <button type="button" class="btn-primary" onclick="saveEditSeats()">Update Seats</button>
      </div>
    </div>
  </div>

  <script>
    async function fetchWatches() {
      const res = await fetch('/api/watches');
      const data = await res.json();
      document.getElementById('count').innerText = data.length;

      const grid = document.getElementById('grid');
      if (data.length === 0) {
        grid.innerHTML = '<div class="empty">No watches pre-entered yet. Click "+ Add Movie" to create one.</div>';
        return;
      }

      grid.innerHTML = data.map(w => {
        const hasSeats = Boolean(w.preferred_seats);
        return \`
          <div class="card">
            <div>
              <div class="card-head">
                <div>
                  <div class="movie-title">\${w.movie}</div>
                  <div class="meta-tag">📍 \${w.theatre} &bull; \${w.preferred_format || 'Any Format'}</div>
                </div>
                <span class="status-dot \${w.status === 'watching' ? 'status-active' : 'status-paused'}">\${w.status}</span>
              </div>

              <table class="data-table">
                <tr><td class="label">Date:</td><td class="val">\${w.target_date}</td></tr>
                <tr><td class="label">Party Size:</td><td class="val">\${w.party_size} seat(s)</td></tr>
                <tr><td class="label">State:</td><td class="val">\${w.booking_state}</td></tr>
              </table>

              <div class="seat-box \${hasSeats ? '' : 'no-seat'}">
                \${hasSeats ? '🎯 Seats: ' + w.preferred_seats : '🎟️ Seats: Optional (Alert Mode)'}
              </div>
            </div>

            <div class="card-actions">
              <button onclick="toggleWatch(\${w.id})">\${w.status === 'watching' ? 'Pause' : 'Resume'}</button>
              <button onclick="openEditSeatsModal(\${w.id}, '\${w.preferred_seats || ''}', '\${w.fallback_seats || ''}')">✏️ Edit Seats</button>
              <button class="btn-danger" onclick="deleteWatch(\${w.id})">Remove</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function openAddModal() { document.getElementById('addModal').style.display = 'flex'; }
    function closeAddModal() { document.getElementById('addModal').style.display = 'none'; }

    function openEditSeatsModal(id, preferred, fallback) {
      document.getElementById('edit_id').value = id;
      document.getElementById('edit_seats').value = preferred;
      document.getElementById('edit_fallback').value = fallback;
      document.getElementById('editSeatsModal').style.display = 'flex';
    }
    function closeEditSeatsModal() { document.getElementById('editSeatsModal').style.display = 'none'; }

    async function handleAdd(e) {
      e.preventDefault();
      const body = {
        movie: document.getElementById('add_movie').value,
        target_date: document.getElementById('add_date').value,
        preferred_format: document.getElementById('add_format').value,
        party_size: document.getElementById('add_party').value,
        preferred_seats: document.getElementById('add_seats').value,
        fallback_seats: document.getElementById('add_fallback').value,
        expected_opening_at: document.getElementById('add_open').value ? new Date(document.getElementById('add_open').value).toISOString() : null,
      };

      await fetch('/api/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      closeAddModal();
      fetchWatches();
    }

    async function saveEditSeats() {
      const id = document.getElementById('edit_id').value;
      const preferred_seats = document.getElementById('edit_seats').value;
      const fallback_seats = document.getElementById('edit_fallback').value;

      await fetch(\`/api/watches/\${id}/seats\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_seats, fallback_seats }),
      });

      closeEditSeatsModal();
      fetchWatches();
    }

    async function toggleWatch(id) {
      await fetch(\`/api/watches/\${id}/toggle\`, { method: 'POST' });
      fetchWatches();
    }

    async function deleteWatch(id) {
      if (confirm('Delete this watch?')) {
        await fetch(\`/api/watches/\${id}\`, { method: 'DELETE' });
        fetchWatches();
      }
    }

    async function testTelegram() {
      await fetch('/api/test/telegram', { method: 'POST' });
      alert('Telegram test triggered.');
    }

    async function testEmail() {
      await fetch('/api/test/email', { method: 'POST' });
      alert('Email test triggered.');
    }

    fetchWatches();
  </script>
</body>
</html>`;
}

if (require.main === module) {
  startDashboardServer();
}
