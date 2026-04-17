import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import multer from 'multer';
import FirecrawlApp from '@mendable/firecrawl-js';
import { saveJob, updateJob, getAllJobs, getJobById, deleteJob } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

const firecrawlOpts = { apiKey: process.env.FIRECRAWL_API_KEY || 'local' };
if (process.env.FIRECRAWL_URL) firecrawlOpts.apiUrl = process.env.FIRECRAWL_URL;
const firecrawl = new FirecrawlApp(firecrawlOpts);

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const uploadsDir = join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// ── POST /api/scrape ────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { url, mode = 'scrape', pdfMode = 'auto' } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url обязателен и должен начинаться с http' });
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
        scrapeOptions: { formats: ['markdown'] },
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

    } else {
      return res.status(400).json({ error: 'mode должен быть scrape, crawl или parse' });
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
    const message = err.message || 'Firecrawl error';
    const durationMs = Date.now() - startTime;

    saveJob({
      url,
      type: mode,
      status: 'error',
      result_markdown: message,
      metadata_json: JSON.stringify({ fileType: ext || null, durationMs }),
    });

    res.status(500).json({ error: message });
  }
});

// ── POST /api/upload ────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  const { pdfMode = 'auto' } = req.body;
  const ext = req.file.originalname.split('.').pop()?.toLowerCase();
  const allowed = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];

  if (!allowed.includes(ext)) {
    unlinkSync(req.file.path);
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
    const message = err.message || 'Firecrawl error';
    const durationMs = Date.now() - startTime;

    saveJob({
      url: `file://${req.file.originalname}`,
      type: 'parse',
      status: 'error',
      result_markdown: message,
      metadata_json: JSON.stringify({ fileType: ext, durationMs, originalName: req.file.originalname }),
    });

    res.status(500).json({ error: message });
  } finally {
    try { unlinkSync(req.file.path); } catch {}
  }
});

// ── GET /api/jobs ───────────────────────────────────────

app.get('/api/jobs', (req, res) => {
  const jobs = getAllJobs().map(({ result_markdown, ...rest }) => rest);
  res.json(jobs);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
