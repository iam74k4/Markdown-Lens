export interface ReviewView { mode: 'edit' | 'diff'; folds: string[]; changesOnly: boolean; sourceOpen: boolean; y: number; active: number; anchor?: { key: string; offset: number } }
export function reviewView(value: unknown): ReviewView | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as ReviewView;
  if (!['edit', 'diff'].includes(v.mode) || !Array.isArray(v.folds) || v.folds.length > 4000 || v.folds.some(k => typeof k !== 'string' || k.length > 100000) || JSON.stringify(v).length > 512 * 1024 || typeof v.changesOnly !== 'boolean' || typeof v.sourceOpen !== 'boolean' || !Number.isFinite(v.y) || v.y < 0 || v.y > 10000000 || !Number.isInteger(v.active) || v.active < -1 || v.active > 4000) return;
  const anchor = v.anchor && typeof v.anchor.key === 'string' && v.anchor.key.length < 100000 && Number.isFinite(v.anchor.offset) && Math.abs(v.anchor.offset) < 10000000 ? v.anchor : undefined;
  // Older saved diff views resume on the unified editable Preview.
  return { mode: 'edit', folds: v.folds, changesOnly: v.changesOnly, sourceOpen: v.sourceOpen, y: v.y, active: v.active, anchor };
}
