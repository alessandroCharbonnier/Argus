import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.ARGUS_DEMO_DB ?? path.join(process.cwd(), 'demo.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL
  );
`);

// The environment marker's `db` field is computed from the LIVE sqlite
// connection (file path + a token stored inside the DB), never a config label.
function ensureRunToken(): string {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('run_token') as
    { v: string } | undefined;
  if (row) return row.v;
  const token = Math.random().toString(36).slice(2, 12);
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('run_token', token);
  return token;
}

const runToken = ensureRunToken();

function dbIdentity(): string {
  return createHash('sha1').update(`${DB_PATH}:${runToken}`).digest('hex').slice(0, 12);
}

function isSeeded(): boolean {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('seeded') as
    { v: string } | undefined;
  return row?.v === '1';
}

function reseed(): void {
  db.prepare('DELETE FROM accounts').run();
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('seeded', '1');
}

interface Account {
  id: number;
  name: string;
  email: string;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({ env: 'staging', db: dbIdentity(), seeded: isSeeded() });
});

app.post('/api/e2e/reset', (_req, res) => {
  reseed();
  res.json({ reset: true });
});

app.get('/api/version', (_req, res) => {
  res.type('text/plain').send('demo-v1');
});

app.get('/', (_req, res) => {
  const accounts = db
    .prepare('SELECT id, name, email FROM accounts ORDER BY id')
    .all() as unknown as Account[];
  const items = accounts.map((a) => `<li><a href="/accounts/${a.id}">${a.name}</a></li>`).join('');
  res.send(`<!doctype html><html><body>
    <h1>Argus demo</h1>
    <form method="post" action="/accounts">
      <label>Name <input name="name" required></label>
      <button type="submit" data-testid="create-account">Create account</button>
    </form>
    <ul>${items}</ul>
  </body></html>`);
});

app.post('/accounts', (req, res) => {
  const name = String(req.body?.name ?? 'Anonymous');
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.test`;
  try {
    const info = db.prepare('INSERT INTO accounts (name, email) VALUES (?, ?)').run(name, email);
    res.redirect(`/accounts/${String(info.lastInsertRowid)}`);
  } catch {
    res.status(409).send('duplicate');
  }
});

app.get('/accounts/:id', (req, res) => {
  const account = db
    .prepare('SELECT id, name, email FROM accounts WHERE id = ?')
    .get(req.params.id) as unknown as Account | undefined;
  if (!account) return res.status(404).send('not found');
  res.send(`<!doctype html><html><body>
    <h1>${account.name}</h1>
    <p>${account.email}</p>
    <form method="post" action="/accounts/${account.id}/delete">
      <button type="submit" data-testid="delete-account">Delete</button>
    </form>
    <a href="/">Home</a>
  </body></html>`);
});

app.post('/accounts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`argus demo on http://localhost:${PORT} (db ${DB_PATH})`);
});
