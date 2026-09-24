import { useEffect, useState } from 'react';
import { X, Download, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { DBTaskNoteFile } from '../db/schema';

marked.setOptions({ gfm: true, breaks: true });

// ─── Type detection ────────────────────────────────────────────────────────────

type ViewMode = 'pdf' | 'image' | 'markdown' | 'text' | 'unsupported';

function getViewMode(mimeType: string, name: string): ViewMode {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType === 'text/markdown' || ext === 'md') return 'markdown';
  if (mimeType.startsWith('text/') || ext === 'txt' || ext === 'log') return 'text';
  return 'unsupported';
}

function typeBadge(mode: ViewMode) {
  switch (mode) {
    case 'pdf':      return { label: 'PDF',      cls: 'bg-red-500/20 text-red-400' };
    case 'image':    return { label: 'IMG',       cls: 'bg-[#4648d4]/20 text-[#c0c1ff]' };
    case 'markdown': return { label: 'MARKDOWN',  cls: 'bg-emerald-500/20 text-emerald-400' };
    case 'text':     return { label: 'TEXT',      cls: 'bg-white/10 text-gray-400' };
    default:         return { label: 'FILE',      cls: 'bg-white/10 text-gray-400' };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Text / Markdown fetcher ──────────────────────────────────────────────────

function TextViewer({ src, mode }: { src: string; mode: 'text' | 'markdown' }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setContent(null);
    setError(false);
    fetch(src)
      .then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(text => setContent(text))
      .catch(() => setError(true));
  }, [src]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-red-400">
        <AlertCircle size={32} className="opacity-50" />
        <p className="font-mono text-sm">Failed to load file content.</p>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  if (mode === 'markdown') {
    const rawHtml = marked.parse(content) as string;
    const html = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
    return (
      <div className="absolute inset-0 overflow-auto">
        <div
          className="mx-auto max-w-3xl px-8 py-10 prose-marina"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-auto p-6">
      <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-gray-300">
        {content}
      </pre>
    </div>
  );
}

// ─── FileViewerModal ──────────────────────────────────────────────────────────

/** Pass either a DBTaskNoteFile (uploaded journal attachment) or raw fields */
type Props =
  | { file: DBTaskNoteFile; src?: never; name?: never; mimeType?: never; onClose: () => void }
  | { file?: never; src: string; name: string; mimeType: string; onClose: () => void };

export function FileViewerModal(props: Props) {
  const { onClose } = props;
  const src  = props.file ? (props.file.file_url ?? '') : props.src;
  const name = props.file ? props.file.name : props.name;
  const mime = props.file ? props.file.mime_type : props.mimeType;
  const size = props.file?.size ?? null;
  const mode = getViewMode(mime, name);
  const { label, cls } = typeBadge(mode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="mobile-file-viewer fixed inset-0 z-[60] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${name}`}
    >
      {/* ── Toolbar ── */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#0d0d0d] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider ${cls}`}>
            {label}
          </span>
          <span className="truncate text-sm font-semibold text-white">{name}</span>
          {size != null && (
            <span className="shrink-0 font-mono text-[10px] text-gray-500">{formatBytes(size)}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={src}
            download={name}
            aria-label={`Download ${name}`}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-[10px] text-gray-300 transition-colors hover:border-white/20 hover:text-white"
          >
            <Download size={11} />
            Download
          </a>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
            title="Close (Esc)"
            aria-label="Close file preview"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* ── Viewer area ── */}
      <div className="relative min-h-0 flex-1">

        {mode === 'pdf' && (
          <iframe
            src={src}
            className="absolute inset-0 h-full w-full border-0"
            title={name}
          />
        )}

        {mode === 'image' && (
          <div className="absolute inset-0 flex items-center justify-center overflow-auto p-8">
            <img
              src={src}
              alt={name}
              className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
            />
          </div>
        )}

        {(mode === 'markdown' || mode === 'text') && (
          <TextViewer src={src} mode={mode} />
        )}

        {mode === 'unsupported' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-gray-400">
            <FileText size={48} className="opacity-20" />
            <p className="font-mono text-sm">No preview available for this file type.</p>
            <a
              href={src}
              download={name}
              aria-label={`Download ${name}`}
              className="flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 font-mono text-sm text-white transition-colors hover:bg-white/15"
            >
              <Download size={14} />
              Download {name}
            </a>
          </div>
        )}
      </div>
    </motion.div>
  );
}
