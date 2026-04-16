import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import FirecrawlApp from '@mendable/firecrawl-js';
import { saveJob, updateJob, getAllJobs, getJobById, deleteJob } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;

const firecrawl = new FirecrawlApp({
  apiKey: 'local',
  apiUrl: process.env.FIRECRAWL_URL || 'http://localhost:3002',
});

app.use(cors());
app.use(express.json());

// ── POST /api/scrape ────────────────────────────────────

app.post('/api/scrape', async (req, res) => {
  const { url, mode = 'scrape', pdfMode = 'auto' } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url обязателен и должен начинаться с http' });
  }

  try {
    let markdown = '';
    let metadata = null;

    if (mode === 'scrape') {
      const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
      markdown = result.markdown ?? '';
      metadata = result.metadata ?? null;

    } else if (mode === 'crawl') {
      const result = await firecrawl.crawlUrl(url, {
        limit: 10,
        scrapeOptions: { formats: ['markdown'] },
      });
      const pages = result.data ?? [];
      markdown = pages.map((p) => p.markdown ?? '').join('\n\n---\n\n');
      metadata = { pagesCount: pages.length };

    } else if (mode === 'parse') {
      const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
      const docFormats = ['xlsx', 'xls', 'docx', 'doc', 'odt', 'rtf'];

      if (ext === 'pdf') {
        const result = await firecrawl.scrapeUrl(url, {
          parsers: [{ type: 'pdf', mode: pdfMode }],
        });
        markdown = result.markdown ?? '';
        metadata = result.metadata ?? null;
      } else if (docFormats.includes(ext)) {
        const result = await firecrawl.scrapeUrl(url, { formats: ['markdown'] });
        markdown = result.markdown ?? '';
        metadata = result.metadata ?? null;
      } else {
        return res.status(400).json({ error: 'Неподдерживаемый формат файла' });
      }

    } else {
      return res.status(400).json({ error: 'mode должен быть scrape, crawl или parse' });
    }

    const job = saveJob({
      url,
      type: mode,
      status: 'success',
      result_markdown: markdown,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
    });

    res.json({
      id: job.id,
      markdown,
      metadata: { url, type: mode, createdAt: job.created_at },
    });
  } catch (err) {
    const message = err.message || 'Firecrawl error';

    saveJob({
      url,
      type: mode,
      status: 'error',
      result_markdown: message,
      metadata_json: null,
    });

    res.status(500).json({ error: message });
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

// ── Запуск ──────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
