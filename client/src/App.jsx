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

const PARSE_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];

function getExtension(url) {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    return dot !== -1 ? path.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

function UrlInput({ onSubmit, loading }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('scrape');
  const [pdfMode, setPdfMode] = useState('auto');
  const [autoDetected, setAutoDetected] = useState(false);

  const handleUrlChange = (value) => {
    setUrl(value);
    const ext = getExtension(value);
    if (PARSE_EXTENSIONS.includes(ext)) {
      setMode('parse');
      setAutoDetected(true);
    } else if (autoDetected) {
      setMode('scrape');
      setAutoDetected(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    onSubmit({ url: url.trim(), mode, pdfMode });
  };

  const ext = getExtension(url);
  const isPdf = ext === 'pdf';

  return (
    <form className="url-input" onSubmit={handleSubmit}>
      <input
        type="url"
        placeholder="https://example.com"
        value={url}
        onChange={(e) => handleUrlChange(e.target.value)}
        required
      />
      <div className="url-input-controls">
        <select value={mode} onChange={(e) => { setMode(e.target.value); setAutoDetected(false); }}>
          <option value="scrape">Scrape</option>
          <option value="crawl">Crawl</option>
          <option value="parse">Parse</option>
        </select>
        {mode === 'parse' && isPdf && (
          <select value={pdfMode} onChange={(e) => setPdfMode(e.target.value)}>
            <option value="auto">PDF: auto</option>
            <option value="fast">PDF: fast</option>
            <option value="ocr">PDF: ocr</option>
          </select>
        )}
        {autoDetected && (
          <span className="auto-hint">.{ext} — режим parse</span>
        )}
        <button type="submit" disabled={loading}>
          {loading ? 'Загрузка...' : 'Запустить'}
        </button>
      </div>
    </form>
  );
}

// ── FileUpload ─────────────────────────────────────────

const UPLOAD_EXTENSIONS = ['pdf', 'xlsx', 'xls', 'docx', 'doc'];

function FileUpload({ onResult, loading, setLoading, setError, fetchJobs }) {
  const [dragOver, setDragOver] = useState(false);
  const [pdfMode, setPdfMode] = useState('auto');
  const [fileName, setFileName] = useState('');

  const processFile = async (file) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!UPLOAD_EXTENSIONS.includes(ext)) {
      setError(`Неподдерживаемый формат: .${ext}`);
      return;
    }

    setLoading(true);
    setError(null);
    setFileName(file.name);
    onResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('pdfMode', pdfMode);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
      onResult({ id: data.id, markdown: data.markdown, metadata: data.metadata, status: 'success' });
      fetchJobs();
    } catch (err) {
      setError(err.message);
      fetchJobs();
    } finally {
      setLoading(false);
      setFileName('');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  return (
    <div className="file-upload-section">
      <div
        className={`file-dropzone ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {loading && fileName
          ? <span className="dropzone-text">Парсинг {fileName}...</span>
          : <span className="dropzone-text">Перетащите файл сюда или <label className="file-label">выберите<input type="file" accept=".pdf,.xlsx,.xls,.docx,.doc" onChange={handleFileSelect} hidden /></label></span>
        }
        <span className="dropzone-hint">PDF, XLSX, XLS, DOCX, DOC (до 50 МБ)</span>
      </div>
      <div className="file-upload-controls">
        <select value={pdfMode} onChange={(e) => setPdfMode(e.target.value)}>
          <option value="auto">PDF: auto</option>
          <option value="fast">PDF: fast</option>
          <option value="ocr">PDF: ocr</option>
        </select>
      </div>
    </div>
  );
}

// ── ResultViewer ────────────────────────────────────────

function ResultMeta({ metadata }) {
  if (!metadata) return null;
  const items = [];
  if (metadata.fileType) items.push({ label: 'Тип файла', value: `.${metadata.fileType}` });
  if (metadata.pagesCount != null) items.push({ label: 'Страниц', value: metadata.pagesCount });
  if (metadata.numberOfPages != null) items.push({ label: 'Страниц PDF', value: metadata.numberOfPages });
  if (metadata.durationMs != null) {
    const sec = (metadata.durationMs / 1000).toFixed(1);
    items.push({ label: 'Время', value: `${sec}с` });
  }
  if (items.length === 0) return null;
  return (
    <div className="result-meta">
      {items.map((it) => (
        <span key={it.label} className="meta-chip">
          <span className="meta-label">{it.label}:</span> {it.value}
        </span>
      ))}
    </div>
  );
}

function ResultViewer({ markdown, jobId, metadata }) {
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
        <ResultMeta metadata={metadata} />
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
      setActiveJob({ id: data.id, markdown: data.markdown, metadata: data.metadata, status: 'success' });
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
      const meta = job.metadata_json ? JSON.parse(job.metadata_json) : null;
      setActiveJob({ id: job.id, markdown: job.result_markdown, metadata: meta, status: job.status });
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
        <div className="input-row">
          <UrlInput onSubmit={handleSubmit} loading={loading} />
          <div className="input-divider"><span>или</span></div>
          <FileUpload
            onResult={setActiveJob}
            loading={loading}
            setLoading={setLoading}
            setError={setError}
            fetchJobs={fetchJobs}
          />
        </div>
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
          <ResultViewer markdown={activeJob?.markdown} jobId={activeJob?.id} metadata={activeJob?.metadata} />
        </main>
      </div>
    </div>
  );
}
