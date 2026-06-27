import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import net from 'net';
import dns from 'dns/promises';
import multer from 'multer';
import { Firecrawl } from '@mendable/firecrawl-js';
import { saveJob, getAllJobs, getJobById, deleteJob } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

const GENERIC_ERROR = 'Не удалось обработать запрос. Попробуйте позже.';

// Document formats Firecrawl can turn into markdown, and the PDF parser modes
// the UI exposes.
const DOC_FORMATS = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];
const PDF_MODES = ['auto', 'fast', 'ocr'];

// Build Firecrawl's `parsers` option from the UI's pdfMode. Only meaningful for
// PDFs; returns undefined otherwise so the request stays clean.
function pdfParsers(ext, pdfMode) {
  if (ext !== 'pdf' || !PDF_MODES.includes(pdfMode)) return undefined;
  return [{ type: 'pdf', mode: pdfMode }];
}

const firecrawl = new Firecrawl({
  apiKey: process.env.FIRECRAWL_API_KEY || 'local',
  timeoutMs: 200000,
  ...(process.env.FIRECRAWL_URL ? { apiUrl: process.env.FIRECRAWL_URL } : {}),
});

// Base URL at which THIS server is reachable *by the Firecrawl instance*. Only
// used for the upload fallback below; for self-hosted Firecrawl set it to a name
// resolvable inside its network (see docker-compose.selfhosted.yml).
const INTERNAL_BASE_URL = process.env.INTERNAL_BASE_URL || `http://localhost:${PORT}`;

// Transient store for uploaded bytes that the fallback serves to Firecrawl. An
// entry lives only for the duration of a single scrape call.
const pendingUploads = new Map();

// ── SSRF protection ─────────────────────────────────────

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;        // this-host, private, loopback
    if (a === 169 && b === 254) return true;                  // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;         // private
    if (a === 192 && b === 168) return true;                  // private
    if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;        // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true;                // link-local
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);                // IPv4-mapped
    return false;
  }
  return false;
}

// Returns an error string if the URL must be rejected, otherwise null.
async function validateScrapeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'url некорректен';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url должен использовать протокол http или https';
  }
  if (process.env.ALLOW_PRIVATE_URLS === 'true') return null;

  const { hostname } = parsed;
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await dns.lookup(hostname, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      return 'не удалось разрешить имя хоста';
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    return 'доступ к внутренним или приватным адресам запрещён';
  }
  return null;
}

// ── Uploads ─────────────────────────────────────────────

// Keep uploads in memory: the bytes are streamed straight to Firecrawl, so
// nothing touches the disk (no temp files, no path-traversal surface).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024 },
});

// Turn an uploaded document into markdown. Prefer Firecrawl's /parse endpoint
// (direct upload — works on cloud and recent self-hosted images). Older
// self-hosted images don't expose /parse and return 404; in that case fall back
// to serving the bytes and scraping that URL, which works whenever Firecrawl can
// reach this server (i.e. self-hosted on a shared network).
async function parseUpload({ buffer, filename, mimetype, ext, pdfMode }) {
  const opts = { formats: ['markdown'], timeout: 180000 };
  const parsers = pdfParsers(ext, pdfMode);
  if (parsers) opts.parsers = parsers;

  try {
    return await firecrawl.parse({ data: buffer, filename, contentType: mimetype }, opts);
  } catch (err) {
    if (err?.status !== 404) throw err;
    const key = `${randomUUID()}.${ext}`;
    pendingUploads.set(key, { buffer, contentType: mimetype || 'application/octet-stream' });
    try {
      return await firecrawl.scrape(`${INTERNAL_BASE_URL}/uploads/${key}`, opts);
    } finally {
      pendingUploads.delete(key);
    }
  }
}

// ── Middleware ──────────────────────────────────────────

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:5173', `http://localhost:${PORT}`];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже.' },
});
app.use('/api', apiLimiter);

// ── Internal: serve a pending upload to Firecrawl (fallback only) ──
// Keys are server-generated UUIDs looked up by exact match, so there is no
// path-traversal surface, and entries exist only while a scrape is in flight.
app.get('/uploads/:file', (req, res) => {
  const entry = pendingUploads.get(req.params.file);
  if (!entry) return res.status(404).end();
  res.setHeader('Content-Type', entry.contentType);
  res.send(entry.buffer);
});

// ── POST /api/scrape ────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { url, mode = 'scrape', pdfMode = 'auto' } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url обязателен' });
  }

  if (!['scrape', 'crawl', 'parse'].includes(mode)) {
    return res.status(400).json({ error: 'mode должен быть scrape, crawl или parse' });
  }

  const urlError = await validateScrapeUrl(url);
  if (urlError) {
    return res.status(400).json({ error: urlError });
  }

  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  const startTime = Date.now();

  try {
    let markdown = '';
    let rawMeta = null;

    if (mode === 'crawl') {
      const job = await firecrawl.crawl(url, {
        limit: 10,
        scrapeOptions: { formats: ['markdown'], timeout: 180000 },
      });
      const pages = job.data ?? [];
      markdown = pages.map((p) => p.markdown ?? '').join('\n\n---\n\n');
      rawMeta = { pagesCount: pages.length };

    } else {
      // scrape and parse both go through /scrape; Firecrawl auto-detects document
      // URLs (PDF, DOCX, XLSX, …) and converts them to markdown the same way.
      if (mode === 'parse' && !DOC_FORMATS.includes(ext)) {
        return res.status(400).json({ error: 'Неподдерживаемый формат файла' });
      }
      const opts = { formats: ['markdown'], timeout: 180000 };
      const parsers = pdfParsers(ext, pdfMode);
      if (parsers) opts.parsers = parsers;

      const doc = await firecrawl.scrape(url, opts);
      markdown = doc.markdown ?? '';
      rawMeta = doc.metadata ?? null;
    }

    const durationMs = Date.now() - startTime;

    const metadata = {
      ...(rawMeta || {}),
      fileType: ext || null,
      durationMs,
    };

    const job = saveJob({
      url,
      type: mode,
      status: 'success',
      result_markdown: markdown,
      metadata_json: JSON.stringify(metadata),
    });

    res.json({
      id: job.id,
      markdown,
      metadata: { url, type: mode, fileType: ext || null, durationMs, ...rawMeta, createdAt: job.created_at },
    });
  } catch (err) {
    console.error('[scrape] error:', err);
    const durationMs = Date.now() - startTime;

    saveJob({
      url,
      type: mode,
      status: 'error',
      result_markdown: GENERIC_ERROR,
      metadata_json: JSON.stringify({ fileType: ext || null, durationMs }),
    });

    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── POST /api/upload ────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  const ext = req.file.originalname.split('.').pop()?.toLowerCase();

  if (!DOC_FORMATS.includes(ext)) {
    return res.status(400).json({ error: `Неподдерживаемый формат: .${ext}. Допустимо: ${DOC_FORMATS.join(', ')}` });
  }

  const { pdfMode = 'auto' } = req.body;
  const startTime = Date.now();

  try {
    const doc = await parseUpload({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      ext,
      pdfMode,
    });
    const markdown = doc.markdown ?? '';
    const rawMeta = doc.metadata ?? null;

    const durationMs = Date.now() - startTime;
    const metadata = { ...(rawMeta || {}), fileType: ext, durationMs, originalName: req.file.originalname };

    const job = saveJob({
      url: `file://${req.file.originalname}`,
      type: 'parse',
      status: 'success',
      result_markdown: markdown,
      metadata_json: JSON.stringify(metadata),
    });

    res.json({
      id: job.id,
      markdown,
      metadata: { url: req.file.originalname, type: 'parse', fileType: ext, durationMs, ...rawMeta, createdAt: job.created_at },
    });
  } catch (err) {
    console.error('[upload] error:', err);
    const durationMs = Date.now() - startTime;

    saveJob({
      url: `file://${req.file.originalname}`,
      type: 'parse',
      status: 'error',
      result_markdown: GENERIC_ERROR,
      metadata_json: JSON.stringify({ fileType: ext, durationMs, originalName: req.file.originalname }),
    });

    res.status(500).json({ error: GENERIC_ERROR });
  }
});

// ── GET /api/jobs ───────────────────────────────────────

app.get('/api/jobs', (req, res) => {
  res.json(getAllJobs());
});

// ── GET /api/jobs/:id ───────────────────────────────────

app.get('/api/jobs/:id', (req, res) => {
  const job = getJobById(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── DELETE /api/jobs/:id ────────────────────────────────

app.delete('/api/jobs/:id', (req, res) => {
  const deleted = deleteJob(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Job not found' });
  res.json({ success: true });
});

// ── Static files (production) ───────────────────────────

const clientDist = join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(clientDist, 'index.html'));
});

// ── Error handling ──────────────────────────────────────

// Middleware errors (e.g. multer's file-size limit or a malformed JSON body)
// would otherwise be rendered as an HTML page that leaks the stack trace and
// can't be parsed by the client. Convert them all to safe JSON. Must stay last,
// after every route; the four-arg signature is what marks it as an error handler.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res
      .status(tooLarge ? 413 : 400)
      .json({ error: tooLarge ? 'Файл слишком большой' : 'Не удалось загрузить файл' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: GENERIC_ERROR });
});

// ── Запуск ──────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
