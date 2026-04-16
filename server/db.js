import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'parser.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('scrape', 'crawl', 'parse')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
    result_markdown TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const insertJob = db.prepare(`
  INSERT INTO jobs (url, type, status) VALUES (@url, @type, @status)
`);

const updateJobStmt = db.prepare(`
  UPDATE jobs SET status = @status, result_markdown = @result_markdown, metadata_json = @metadata_json WHERE id = @id
`);

const selectAllJobs = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC`);

const selectJobById = db.prepare(`SELECT * FROM jobs WHERE id = ?`);

export function saveJob({ url, type }) {
  const result = insertJob.run({ url, type, status: 'pending' });
  return selectJobById.get(result.lastInsertRowid);
}

export function updateJob(id, { status, result_markdown = null, metadata_json = null }) {
  updateJobStmt.run({ id, status, result_markdown, metadata_json });
  return selectJobById.get(id);
}

export function getAllJobs() {
  return selectAllJobs.all();
}

export function getJobById(id) {
  return selectJobById.get(id);
}

export default db;
