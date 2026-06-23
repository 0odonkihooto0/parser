import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getExtension } from './utils.js';
import { StatusBadge } from './App.jsx';

describe('getExtension', () => {
  it('extracts a simple file extension', () => {
    expect(getExtension('https://example.com/file.pdf')).toBe('pdf');
  });

  it('lowercases the extension', () => {
    expect(getExtension('https://example.com/REPORT.PDF')).toBe('pdf');
  });

  it('ignores query strings and fragments', () => {
    expect(getExtension('https://example.com/doc.docx?v=2#section')).toBe('docx');
  });

  it('uses the last dot in the path', () => {
    expect(getExtension('https://example.com/archive.tar.gz')).toBe('gz');
  });

  it('returns empty string when there is no extension', () => {
    expect(getExtension('https://example.com/page')).toBe('');
  });

  it('ignores dots in the domain when path has no extension', () => {
    expect(getExtension('https://sub.example.com/path')).toBe('');
  });

  it('returns empty string for an invalid URL', () => {
    expect(getExtension('not a url')).toBe('');
  });

  it('returns empty string for an empty string', () => {
    expect(getExtension('')).toBe('');
  });
});

describe('StatusBadge', () => {
  it('renders the Russian label for a known status', () => {
    render(<StatusBadge status="success" />);
    expect(screen.getByText('Готово')).toBeInTheDocument();
  });

  it('maps running status to a loading label', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText('Загрузка...')).toBeInTheDocument();
  });

  it('falls back to the raw status when unknown', () => {
    render(<StatusBadge status="weird" />);
    expect(screen.getByText('weird')).toBeInTheDocument();
  });

  it('applies a status-specific class', () => {
    const { container } = render(<StatusBadge status="error" />);
    expect(container.querySelector('.badge-error')).toBeInTheDocument();
    expect(screen.getByText('Ошибка')).toBeInTheDocument();
  });
});
