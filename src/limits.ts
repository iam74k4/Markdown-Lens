/** Shared by the extension host and the webview; no Node or DOM dependencies. */
const MIN = 128 * 1024, MAX = 4 * 1024 * 1024;
let maxBytes = 512 * 1024;
export const limits = {
  get maxBytes(): number { return maxBytes; },
  get label(): string { return maxBytes % (1024 * 1024) === 0 ? `${maxBytes / 1024 / 1024}MB` : `${Math.round(maxBytes / 1024)}KB`; },
  /** Blocks scale with the size limit so larger files remain comparable. */
  get maxBlocks(): number { return Math.round(4000 * maxBytes / (512 * 1024)); },
};
export function configureLimits(kilobytes: unknown): void {
  const bytes = typeof kilobytes === 'number' && Number.isFinite(kilobytes) ? Math.round(kilobytes) * 1024 : 512 * 1024;
  maxBytes = Math.min(MAX, Math.max(MIN, bytes));
}
export const byteLength = (text: string) => new TextEncoder().encode(text).length;
