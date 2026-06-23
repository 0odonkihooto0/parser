import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import net from 'net';
import dns from 'dns/promises';
import multer from 'multer';
import FirecrawlApp from '@mendable/firecrawl-js';
import { saveJob, getAllJobs, getJobById, deleteJob } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

const GENERIC_ERROR = 'Не удалось обработать запрос. Попробуйте позже.';

const firecrawlOpts = { apiKey: process.env.FIRECRAWL_API_KEY || 'local' };
if (process.env.FIRECRAWL_URL) firecrawlOpts.apiUrl = process.env.FIRECRAWL_URL;
const firecrawl = new FirecrawlApp(firecrawlOpts);

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const uploadsDir = join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir);

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

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    // Never trust the client-supplied name for the on-disk path: use a random
    // id and keep only a sanitized extension to avoid path traversal.
    filename: (req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Middleware ──────────────────────────────────────────

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [APP_URL, 'http://localhost:5173', `http://localhost:${PORT}`];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже.' },
});
app.use('/api', apiLimiter);

// ── POST /api/scrape ────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { url, mode = 'scrape' } = req.body;

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

    if (mode === 'scrape') {
      const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'], timeout: 180000 });
      markdown = result.markdown ?? '';
      rawMeta = result.metadata ?? null;

    } else if (mode === 'crawl') {
      const result = await firecrawl.crawlUrl(url, {
        limit: 10,
        scrapeOptions: { formats: ['markdown'], timeout: 180000 },
      });
      const pages = result.data ?? [];
      markdown = pages.map((p) => p.markdown ?? '').join('\n\n---\n\n');
      rawMeta = { pagesCount: pages.length };

    } else if (mode === 'parse') {
      const docFormats = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];

      if (!docFormats.includes(ext)) {
        return res.status(400).json({ error: 'Неподдерживаемый формат файла' });
      }

      const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'], timeout: 180000 });
      markdown = result.markdown ?? '';
      rawMeta = result.metadata ?? null;
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
  const allowed = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];

  if (!allowed.includes(ext)) {
    await unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: `Неподдерживаемый формат: .${ext}. Допустимо: ${allowed.join(', ')}` });
  }

  const fileUrl = `${APP_URL}/uploads/${req.file.filename}`;
  const startTime = Date.now();

  try {
    const result = await firecrawl.scrapeUrl(fileUrl, { formats: ['markdown'], timeout: 180000 });
    const markdown = result.markdown ?? '';
    const rawMeta = result.metadata ?? null;

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
  } finally {
    await unlink(req.file.path).catch(() => {});
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

// ── Запуск ──────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export { app };
