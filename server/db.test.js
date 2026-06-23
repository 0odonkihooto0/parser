import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Use an isolated in-memory database for the test run. DB_PATH must be set
// before db.js is imported, so the module is pulled in dynamically.
let db, saveJob, updateJob, getAllJobs, getJobById, deleteJob;

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  const mod = await import('./db.js');
  db = mod.default;
  ({ saveJob, updateJob, getAllJobs, getJobById, deleteJob } = mod);
});

beforeEach(() => {
  db.exec('DELETE FROM jobs');
});

describe('saveJob', () => {
  it('inserts a job and returns it with an id and defaults', () => {
    const job = saveJob({ url: 'https://example.com', type: 'scrape' });
    expect(job.id).toBeTypeOf('number');
    expect(job.url).toBe('https://example.com');
    expect(job.type).toBe('scrape');
    expect(job.status).toBe('pending');
    expect(job.result_markdown).toBeNull();
    expect(job.created_at).toBeTruthy();
  });

  it('persists provided markdown and metadata', () => {
    const job = saveJob({
      url: 'https://example.com',
      type: 'parse',
      status: 'success',
      result_markdown: '# Hello',
      metadata_json: JSON.stringify({ fileType: 'pdf' }),
    });
    const fetched = getJobById(job.id);
    expect(fetched.result_markdown).toBe('# Hello');
    expect(JSON.parse(fetched.metadata_json)).toEqual({ fileType: 'pdf' });
  });
});

describe('getJobById', () => {
  it('returns the matching row', () => {
    const saved = saveJob({ url: 'https://a.test', type: 'scrape', result_markdown: 'body' });
    const fetched = getJobById(saved.id);
    expect(fetched).toMatchObject({ id: saved.id, url: 'https://a.test', result_markdown: 'body' });
  });

  it('returns undefined for a missing id', () => {
    expect(getJobById(999999)).toBeUndefined();
  });
});

describe('getAllJobs', () => {
  it('returns all jobs without the result_markdown column', () => {
    saveJob({ url: 'https://a.test', type: 'scrape', result_markdown: 'A'.repeat(100) });
    saveJob({ url: 'https://b.test', type: 'crawl', result_markdown: 'B'.repeat(100) });

    const jobs = getAllJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.url).sort()).toEqual(['https://a.test', 'https://b.test']);
    for (const job of jobs) {
      expect(job).not.toHaveProperty('result_markdown');
      expect(job).toHaveProperty('metadata_json');
    }
  });

  it('returns an empty array when there are no jobs', () => {
    expect(getAllJobs()).toEqual([]);
  });
});

describe('updateJob', () => {
  it('updates status, markdown and metadata', () => {
    const saved = saveJob({ url: 'https://a.test', type: 'scrape' });
    const updated = updateJob(saved.id, {
      status: 'success',
      result_markdown: 'done',
      metadata_json: JSON.stringify({ durationMs: 5 }),
    });
    expect(updated.status).toBe('success');
    expect(updated.result_markdown).toBe('done');
    expect(JSON.parse(updated.metadata_json)).toEqual({ durationMs: 5 });
  });
});

describe('deleteJob', () => {
  it('removes an existing job and reports success', () => {
    const saved = saveJob({ url: 'https://a.test', type: 'scrape' });
    expect(deleteJob(saved.id)).toBe(true);
    expect(getJobById(saved.id)).toBeUndefined();
  });

  it('returns false when nothing was deleted', () => {
    expect(deleteJob(999999)).toBe(false);
  });
});
