import type { RichEditor } from './rich-editor';
import type { Match } from './search';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function navigation(getEditor: () => RichEditor | undefined, ready: () => boolean, enter: () => boolean, feedback: (text: string, error?: boolean) => void) {
  let matches: Match[] = [], active = 0, truncated = false, timer: ReturnType<typeof setTimeout> | undefined;
  let lastDoc: unknown, lastOutline = '', lastCanReplace = false, refreshing = false;
  const open = () => !$('find-panel').hidden;
  const query = () => $<HTMLInputElement>('find-query').value;
  function layoutOutline() {
    if ($('outline-panel').hidden) return;
    const top = open() ? Math.min(Math.max(80, $('find-panel').getBoundingClientRect().bottom + 8), innerHeight - 180) : 110;
    $('outline-panel').style.top = `${top}px`; $('outline-panel').style.maxHeight = `calc(100vh - ${top + 24}px)`;
  }
  window.addEventListener('resize', layoutOutline);
  window.addEventListener('scroll', layoutOutline, { passive: true });
  function refresh() {
    if (refreshing) return;
    const editor = getEditor(); if (!editor || editor.composing) return;
    refreshing = true;
    try {
      if (open()) {
        ({ matches, truncated } = editor.find(query(), $<HTMLInputElement>('find-case').checked, $<HTMLInputElement>('find-changes').checked));
        active = Math.min(active, Math.max(0, matches.length - 1));
        editor.highlightSearch(matches, active);
        $('find-count').textContent = query() ? `${matches.length ? active + 1 : 0} / ${matches.length}${truncated ? '+' : ''}` : '';
        for (const id of ['find-previous','find-next','replace-one','replace-all']) $<HTMLButtonElement>(id).disabled = !matches.length || !ready() || (id === 'replace-all' && truncated);
      }
      if (!$('outline-panel').hidden) {
        const outline = editor.outline, signature = JSON.stringify(outline.map(s => [s.key,s.count,s.from]));
        if (signature !== lastOutline) {
          lastOutline = signature; const root = $('outline-items'); root.replaceChildren();
          if (!outline.length) root.textContent = '見出しがありません。';
          for (const section of outline) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'outline-item'; button.style.paddingLeft = `${10 + (section.level - 1) * 14}px`;
            const title = document.createElement('span'); title.textContent = section.title || '（空の見出し）'; button.append(title);
            if (section.count) { const badge = document.createElement('span'); badge.className = 'outline-count'; badge.textContent = String(section.count); badge.setAttribute('aria-label', `未確認 ${section.count}件`); button.append(badge); }
            button.addEventListener('click', () => { if (ready() && enter()) { editor.revealPosition(section.from); if (innerWidth < 700) toggleOutline(false); } }); root.append(button);
          }
        }
      }
      layoutOutline();
      lastDoc = editor.documentIdentity; lastCanReplace = ready();
    } finally { refreshing = false; }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 100); }
  function jump(delta: number) {
    refresh(); if (!matches.length || !ready()) return;
    active = (active + delta + matches.length) % matches.length;
    getEditor()!.revealPosition(matches[active].from, matches[active].to); refresh();
  }
  function toggleFind(show: boolean) {
    if (show && !enter()) return;
    $('find-panel').hidden = !show; $('toggle-find').setAttribute('aria-pressed', String(show));
    if (show) { refresh(); $('find-query').focus(); } else { getEditor()?.highlightSearch([], 0); $('toggle-find').focus(); }
  }
  function toggleOutline(show: boolean) {
    $('outline-panel').hidden = !show; $('toggle-outline').setAttribute('aria-pressed', String(show));
    if (show) { lastOutline = ''; refresh(); } else $('toggle-outline').focus();
  }
  $('toggle-find').addEventListener('click', () => toggleFind(!open()));
  $('find-close').addEventListener('click', () => toggleFind(false));
  $('toggle-outline').addEventListener('click', () => toggleOutline($('outline-panel').hidden));
  $('outline-close').addEventListener('click', () => toggleOutline(false));
  for (const id of ['find-query','find-case','find-changes']) $(id).addEventListener('input', () => { active = 0; schedule(); });
  $('find-next').addEventListener('click', () => jump(1)); $('find-previous').addEventListener('click', () => jump(-1));
  for (const [id, all] of [['replace-one',false],['replace-all',true]] as const) $(id).addEventListener('click', () => {
    refresh(); if (!ready() || !matches.length || (all && truncated)) return;
    const selected = all ? matches : [matches[active]];
    try { if (getEditor()!.replaceMatches(selected, $<HTMLInputElement>('replace-text').value)) { feedback(`${selected.length}件を置換しました。Undoで取り消せます。`); refresh(); } }
    catch (error) { feedback(String(error), true); }
  });
  $('find-panel').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toggleFind(false); }
    if (event.key === 'Enter') { event.preventDefault(); jump(event.shiftKey ? -1 : 1); }
  });
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); toggleFind(true); }
  });
  return { update() {
    const editor = getEditor(); if (!editor || refreshing) return;
    if (lastDoc !== editor.documentIdentity || lastCanReplace !== ready() || !$('outline-panel').hidden || $<HTMLInputElement>('find-changes').checked) schedule();
  }, closeFind() { if (open()) toggleFind(false); } };
}
