export function baseName(p: string | null | undefined): string {
  if (!p) return 'No folder';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayBucket(ms: number): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= start) return 'Today';
  if (ms >= start - 86400000) return 'Yesterday';
  if (ms >= start - 7 * 86400000) return 'Previous 7 days';
  if (ms >= start - 30 * 86400000) return 'Previous 30 days';
  return 'Older';
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function resetLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const diff = at - Date.now();
  if (diff <= 0) return 'Resets soon';
  const min = Math.round(diff / 60000);
  if (min < 60) return `Resets in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Resets in ${h}h ${min % 60}m`;
  return `Resets ${new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

/** One-line description of a tool call. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const s =
    pick('command') ||
    pick('file_path') ||
    pick('path') ||
    pick('pattern') ||
    pick('url') ||
    pick('query') ||
    pick('description') ||
    pick('prompt') ||
    pick('skill');
  if (s) return s.replace(/\s+/g, ' ');
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return first ? first.replace(/\s+/g, ' ') : '';
}
