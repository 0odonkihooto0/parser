import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// Isolated in-memory DB; allow nothing special so SSRF rules stay active.
let app;

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  delete process.env.ALLOW_PRIVATE_URLS;
  // Tiny upload cap so the "file too large" path is cheap to exercise.
  process.env.MAX_UPLOAD_BYTES = '1024';
  ({ app } = await import('./index.js'));
});

describe('POST /api/scrape — validation', () => {
  it('rejects a request with no url', async () => {
    const res = await request(app).post('/api/scrape').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects a non-string url', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 12345 });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed url', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'not-a-valid-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('url некорректен');
  });

  it('rejects a non-http(s) protocol', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'ftp://example.com/file' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown mode', async () => {
    const res = await request(app)
      .post('/api/scrape')
      .send({ url: 'https://example.com', mode: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('blocks loopback addresses (SSRF protection)', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'http://127.0.0.1/admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/приватным|внутренним/);
  });

  it('blocks private network addresses (SSRF protection)', async () => {
    const res = await request(app).post('/api/scrape').send({ url: 'http://192.168.0.1/' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/upload — validation', () => {
  it('returns 400 when no file is attached', async () => {
    const res = await request(app).post('/api/upload');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Файл не загружен');
  });

  it('rejects an unsupported file extension', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('plain text content'), 'malicious.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Неподдерживаемый формат/);
  });

  it('rejects an oversized file with JSON and no stack trace', async () => {
    const oversized = Buffer.alloc(2048, 0x61); // exceeds the 1 KB test cap
    const res = await request(app)
      .post('/api/upload')
      .attach('file', oversized, 'big.pdf');
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('Файл слишком большой');
    expect(res.text).not.toMatch(/MulterError|\.js:/); // no leaked internals
  });
});

describe('GET /api/jobs', () => {
  it('returns an array', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
