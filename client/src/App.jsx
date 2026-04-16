import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import './App.css';

// ── StatusBadge ─────────────────────────────────────────

function StatusBadge({ status }) {
  const labels = {
    pending: 'Ожидание',
    running: 'Загрузка...',
    success: 'Готово',
    error: 'Ошибка',
    done: 'Готово',
  };
  return <span className={`badge badge-${status}`}>{labels[status] || status}</span>;
}

// ── UrlInput ────────────────────────────────────────────

function UrlInput({ onSubmit, loading }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('scrape');
  const [pdfMode, setPdfMode] = useState('auto');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    onSubmit({ url: url.trim(), mode, pdfMode });
  };

  return (
    <form className="url-input" onSubmit={handleSubmit}>
      <input
        type="url"
        placeholder="https://example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <div className="url-input-controls">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="scrape">Scrape</option>
          <option value="crawl">Crawl</option>
          <option value="parse">Parse</option>
        </select>
        {mode === 'parse' && (
          <select value={pdfMode} onChange={(e) => setPdfMode(e.target.value)}>
            <option value="auto">PDF: auto</option>
            <option value="fast">PDF: fast</option>
            <option value="ocr">PDF: ocr</option>
          </select>
        )}
        <button type="submit" disabled={loading}>
          {loading ? 'Загрузка...' : 'Запустить'}
        </button>
      </div>
    </form>
  );
}

// ── ResultViewer ────────────────────────────────────────

function ResultViewer({ markdown, jobId }) {
  if (!markdown) {
    return <div className="result-viewer empty">Результат появится здесь</div>;
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(markdown);
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `result-${jobId || 'export'}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="result-viewer">
      <div className="result-toolbar">
        <button onClick={handleCopy}>Скопировать</button>
        <button onClick={handleDownload}>Скачать .md</button>
      </div>
      <div className="markdown-body">
        <Markdown>{markdown}</Markdown>
      </div>
    </div>
  );
}

// ── JobHistory ──────────────────────────────────────────

function JobHistory({ jobs, activeId, onSelect, onDelete }) {
  if (jobs.length === 0) {
    return <div className="job-history empty">Нет задач</div>;
  }

  return (
    <ul className="job-history">
      {jobs.map((job) => (
        <li
          key={job.id}
          className={job.id === activeId ? 'active' : ''}
          onClick={() => onSelect(job.id)}
        >
          <div className="job-row">
            <span className="job-url" title={job.url}>{job.url}</span>
            <button
              className="job-delete"
              title="Удалить"
              onClick={(e) => { e.stopPropagation(); onDelete(job.id); }}
            >
              &times;
            </button>
          </div>
          <div className="job-meta">
            <span className="job-type">{job.type}</span>
            <StatusBadge status={job.status} />
            <span className="job-date">{new Date(job.created_at + 'Z').toLocaleString()}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── App ─────────────────────────────────────────────────

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (res.ok) setJobs(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const handleSubmit = async ({ url, mode, pdfMode }) => {
    setLoading(true);
    setError(null);
    setActiveJob(null);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode, pdfMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
      setActiveJob({ id: data.id, markdown: data.markdown, status: 'success' });
      fetchJobs();
    } catch (err) {
      setError(err.message);
      fetchJobs();
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (id) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) return;
      const job = await res.json();
      setActiveJob({ id: job.id, markdown: job.result_markdown, status: job.status });
      setError(job.status === 'error' ? job.result_markdown : null);
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (id) => {
    try {
      await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
      if (activeJob?.id === id) setActiveJob(null);
      fetchJobs();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Parser</h1>
        <UrlInput onSubmit={handleSubmit} loading={loading} />
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <h2>История</h2>
          <JobHistory
            jobs={jobs}
            activeId={activeJob?.id}
            onSelect={handleSelect}
            onDelete={handleDelete}
          />
        </aside>

        <main className="content">
          {loading && <StatusBadge status="running" />}
          {error && <div className="error-msg">{error}</div>}
          <ResultViewer markdown={activeJob?.markdown} jobId={activeJob?.id} />
        </main>
      </div>
    </div>
  );
}
