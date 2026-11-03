// Small, local SVGs: consistent strokes, no icon fonts or network dependencies.
const paths = {
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2"/>',
  undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/>',
  redo: '<path d="m15 5 5 5-5 5M20 10H10a6 6 0 0 0 0 12" transform="translate(0 -2)"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  checkAll: '<path d="m3 12 4 4L17 6m-5 10 3 3 7-9"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
  diff: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 3v18M6 9h3m6 6h3m-1.5-1.5v3"/>',
  link: '<path d="m10 13 4-4m-5 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(0 1)"/>',
  bullet: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  number: '<path d="M10 6h11M10 12h11M10 18h11M3 3h1v6M3 9h3M3 14c0-2 4-2 4 0s-4 2-4 6h4"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5m-3-13-4 20"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h9V3M7 21v-7h10v7"/>',
} as const;

export function icon(name: keyof typeof paths): string {
  return `<svg class="ui-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
