import { useQuery } from '@tanstack/react-query';
import {
  Activity, Archive, Bot, ChevronDown, CircleAlert, Cpu, Database,
  FileArchive, FolderOpen, Gauge, HardDrive, MemoryStick, RefreshCw,
} from 'lucide-react';
import { apiFetch } from '../utils/apiFetch';

type DirectoryUsage = { bytes: number; files: number; available: boolean };
type UsageMetrics = {
  sampledAt: string;
  process: {
    rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number;
    arrayBuffersBytes: number; cpuPercent: number | null; uptimeSeconds: number; pid: number;
  };
  system: {
    totalMemoryBytes: number; freeMemoryBytes: number; usedMemoryBytes: number;
    cpuCores: number; platform: string;
  };
  database: {
    name: string; bytes: number;
    connections: { total: number; idle: number; waiting: number };
    features: Array<{ key: string; label: string; description: string; bytes: number; estimatedRows: number; tables: string[] }>;
    tables: Array<{ table: string; totalBytes: number; dataBytes: number; indexBytes: number; estimatedRows: number; deadRows: number }>;
  };
  files: { uploads: DirectoryUsage; obsidianVault: DirectoryUsage; backups: DirectoryUsage };
  background: { embeddingJobs: Record<string, number> };
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function percent(part: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, (part / total) * 100)) : 0;
}

function MetricCard({ label, value, detail, Icon, tone = 'indigo' }: {
  label: string; value: string; detail: string; Icon: React.ElementType; tone?: 'indigo' | 'emerald' | 'amber' | 'slate';
}) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-600', emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600', slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className={`mb-4 flex h-9 w-9 items-center justify-center rounded-xl ${colors[tone]}`}><Icon size={18} /></div>
      <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{label}</p>
      <p className="mt-1 font-headline text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

function DirectoryCard({ label, usage, Icon }: { label: string; usage: DirectoryUsage; Icon: React.ElementType }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm"><Icon size={17} /></div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-slate-700">{label}</p>
        <p className="mt-0.5 font-mono text-[10px] text-slate-400">
          {usage.available ? `${formatBytes(usage.bytes)} · ${usage.files.toLocaleString()} files` : 'Folder not created yet'}
        </p>
      </div>
    </div>
  );
}

export function UsageManagerView() {
  const query = useQuery({
    queryKey: ['usage'],
    queryFn: () => apiFetch<UsageMetrics>('/api/usage'),
    refetchInterval: 5_000,
  });
  const data = query.data;

  if (query.isLoading) {
    return <div className="mx-auto max-w-7xl px-5 py-10 text-sm text-slate-400">Measuring Marina usage…</div>;
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">Usage data could not be loaded. {query.error instanceof Error ? query.error.message : ''}</div>
      </div>
    );
  }

  const systemRamPercent = percent(data.system.usedMemoryBytes, data.system.totalMemoryBytes);
  const heapPercent = percent(data.process.heapUsedBytes, data.process.heapTotalBytes);
  const totalFeatureBytes = data.database.features.reduce((sum, item) => sum + item.bytes, 0);
  const jobs = data.background.embeddingJobs;
  const activeJobs = (jobs.processing ?? 0) + (jobs.pending ?? 0) + (jobs.queued ?? 0);
  const completedJobs = (jobs.done ?? 0) + (jobs.completed ?? 0);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-12 sm:px-6">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-indigo-600"><Gauge size={18} /><span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em]">Live system view</span></div>
          <h1 className="font-headline text-3xl font-bold tracking-tight text-slate-950">Usage</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">See what Marina is using now, what is stored, and whether background work is building up.</p>
        </div>
        <button
          type="button" onClick={() => query.refetch()} disabled={query.isFetching}
          className="flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={query.isFetching ? 'animate-spin' : ''} />
          {query.isFetching ? 'Measuring' : 'Refresh'}
        </button>
      </header>

      <section className="mobile-usage-metrics grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Marina server RAM" value={formatBytes(data.process.rssBytes)} detail={`Heap ${formatBytes(data.process.heapUsedBytes)} of ${formatBytes(data.process.heapTotalBytes)} · PID ${data.process.pid}`} Icon={MemoryStick} />
        <MetricCard label="Computer RAM" value={`${systemRamPercent.toFixed(0)}% used`} detail={`${formatBytes(data.system.freeMemoryBytes)} free of ${formatBytes(data.system.totalMemoryBytes)}`} Icon={Cpu} tone={systemRamPercent > 90 ? 'amber' : 'emerald'} />
        <MetricCard label="Database" value={formatBytes(data.database.bytes)} detail={`${data.database.tables.length} tables · ${data.database.connections.total} open connections`} Icon={Database} tone="slate" />
        <MetricCard label="Background work" value={activeJobs ? `${activeJobs} active` : 'Clear'} detail={`${jobs.failed ?? 0} failed · ${completedJobs} completed embedding jobs`} Icon={Bot} tone={activeJobs ? 'amber' : 'emerald'} />
      </section>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1.45fr_0.75fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-headline text-lg font-bold text-slate-900">Storage by feature</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">Database footprint and estimated record counts, grouped by what they power.</p>
            </div>
            <HardDrive size={19} className="shrink-0 text-slate-300" />
          </div>
          <div className="mt-5 space-y-4">
            {data.database.features.map((feature, index) => {
              const width = percent(feature.bytes, totalFeatureBytes);
              return (
                <div key={feature.key}>
                  <div className="mb-1.5 flex items-end justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-700">{feature.label}</p><p className="truncate text-[11px] text-slate-400">{feature.description}</p></div>
                    <div className="shrink-0 text-right"><p className="font-mono text-[11px] font-bold text-slate-700">{formatBytes(feature.bytes)}</p><p className="font-mono text-[9px] text-slate-400">~{feature.estimatedRows.toLocaleString()} records</p></div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${index === 0 ? 'bg-indigo-500' : 'bg-indigo-300'}`} style={{ width: `${Math.max(width, feature.bytes ? 1 : 0)}%` }} /></div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="space-y-3">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2"><FolderOpen size={17} className="text-indigo-500" /><h2 className="font-headline text-base font-bold text-slate-900">File storage</h2></div>
            <div className="space-y-2">
              <DirectoryCard label="Uploaded files" usage={data.files.uploads} Icon={FileArchive} />
              <DirectoryCard label="Obsidian vault" usage={data.files.obsidianVault} Icon={FolderOpen} />
              <DirectoryCard label="Database backups" usage={data.files.backups} Icon={Archive} />
            </div>
          </section>
          <section className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">
            <div className="flex gap-3"><CircleAlert size={17} className="mt-0.5 shrink-0 text-indigo-500" /><div><p className="text-xs font-semibold text-indigo-950">How to read this</p><p className="mt-1 text-[11px] leading-5 text-indigo-800/70">Server RAM is Marina’s whole API process. Per-feature RAM cannot be measured reliably inside Node, so the feature chart shows real storage usage instead of invented numbers. Computer RAM includes every open app.</p></div></div>
          </section>
        </div>
      </div>

      <section className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <details>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 hover:bg-slate-50">
            <div className="flex items-center gap-3"><Database size={18} className="text-slate-400" /><div><h2 className="font-headline text-base font-bold text-slate-900">Database table details</h2><p className="text-[11px] text-slate-400">Advanced breakdown for diagnosing storage growth</p></div></div>
            <ChevronDown size={17} className="text-slate-400" />
          </summary>
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full min-w-[680px] text-left">
              <thead><tr className="bg-slate-50 font-mono text-[9px] uppercase tracking-wider text-slate-400"><th className="px-5 py-3">Table</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Data</th><th className="px-4 py-3">Indexes</th><th className="px-4 py-3">Est. records</th><th className="px-4 py-3">Dead rows</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {data.database.tables.map(table => <tr key={table.table} className="text-xs text-slate-600"><td className="px-5 py-3 font-mono font-semibold text-slate-700">{table.table}</td><td className="px-4 py-3">{formatBytes(table.totalBytes)}</td><td className="px-4 py-3">{formatBytes(table.dataBytes)}</td><td className="px-4 py-3">{formatBytes(table.indexBytes)}</td><td className="px-4 py-3">~{table.estimatedRows.toLocaleString()}</td><td className="px-4 py-3">{table.deadRows.toLocaleString()}</td></tr>)}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[9px] uppercase tracking-wider text-slate-400">
        <span className="flex items-center gap-1.5"><Activity size={12} /> Auto-refreshes every 5 seconds</span>
        <span>CPU {data.process.cpuPercent == null ? 'sampling…' : `${data.process.cpuPercent.toFixed(1)}%`} · Uptime {formatDuration(data.process.uptimeSeconds)} · {new Date(data.sampledAt).toLocaleTimeString()}</span>
      </footer>
    </div>
  );
}
