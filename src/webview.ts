import { renderDiagrams, refreshDiagramThemes } from './diagrams';
import { enhanceTables } from './table-review';
import { RichEditor } from './rich-editor';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import type { State } from './extension';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): { mode?: string; uri?: string; changesOnly?: boolean } | undefined };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let state: State | undefined;
let disposeTables = () => {};
let changesOnly = vscode.getState()?.changesOnly ?? false;
let active = -1, pending = false, broken = false, selection = '';
let resumeAction: 'review' | 'revert' | undefined;
let mode: 'edit' | 'diff' = vscode.getState()?.mode === 'edit' ? 'edit' : 'diff';
let editor: RichEditor | undefined;
let baseText = '', baseRevision = '', localDraft = false, conflict = false;
let editInvalid = false;
let commit: { id: string; text: string; target: 'edit' | 'diff' } | undefined;
const changes = () => [...document.querySelectorAll<HTMLElement>('[data-hunk]')];
const button = (id: string) => $<HTMLButtonElement>(id);

function feedback(text?: string, error = false) {
  $('feedback-text').textContent = text || (state?.undoId ? '直前の確認を取り消せます。' : ''); $('feedback').hidden = !text && !state?.undoId;
  button('undo-review').hidden = !state?.undoId || !!state?.comparison || error;
  $('feedback').classList.toggle('error', error);
}
function controls() {
  const count = state?.count ?? 0;
  $('counter').textContent = state?.comparison ? `比較差分 ${count}件` : count ? `未確認 ${count}件` : '✓ 確認完了';
  $('counter').classList.toggle('complete', count === 0);
  $('position').textContent = count ? `${Math.max(1, active + 1)} / ${count}` : '';
  $('change-navigation').hidden = !count;
  button('previous').disabled = button('next').disabled = !count || pending || broken;
  button('reviewed').disabled = !count || pending || broken || localDraft || !!state?.comparison;
  button('save').disabled = pending || broken || conflict || editInvalid;
  button('mode-edit').disabled = button('mode-diff').disabled = pending || !state;
  $('save').hidden = !localDraft && !state?.dirty;
  $('save-state').textContent = conflict ? '● 競合・下書きを保持' : localDraft ? '● 編集中' : state?.dirty ? '● 未保存' : '保存済み';
  $('save-state').classList.toggle('dirty', localDraft || !!state?.dirty);
  document.querySelectorAll<HTMLButtonElement>('[data-revert], [data-review]').forEach(b => { b.disabled = pending || broken || localDraft || (!!b.dataset.review && !!state?.comparison); });
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#formatting button, #formatting select').forEach(b => { b.disabled = pending || broken; });
  editor?.enable(!pending && !broken);
  $('conflict').hidden = !conflict;
  $('document').hidden = mode !== 'diff';
  $('editor').hidden = $('formatting').hidden = mode !== 'edit';
  $('review-actions').hidden = $('legend').hidden = mode !== 'diff';
  if (mode === 'diff') $('link-form').hidden = true;
  $('empty').hidden = mode !== 'diff' || !!count;
  $('empty').querySelector('strong')!.textContent = state?.comparison ? 'スナップショットとの差分はありません' : '未確認の変更はありません';
  button('mode-edit').setAttribute('aria-selected', String(mode === 'edit'));
  button('mode-diff').setAttribute('aria-selected', String(mode === 'diff'));
  button('undo-review').disabled = pending || broken || localDraft;
  button('snapshot').disabled = pending || broken || localDraft;
  button('snapshots').disabled = pending || broken || localDraft;
  button('changes-only').setAttribute('aria-pressed', String(changesOnly));
  $('document').classList.toggle('changes-only', changesOnly);
  vscode.setState({ uri: state?.uri, mode, changesOnly });
}
function move(index: number, scroll = true) {
  const blocks = changes();
  if (!blocks.length) { active = -1; controls(); return; }
  active = (index + blocks.length) % blocks.length;
  blocks.forEach((b, i) => b.classList.toggle('active', i === active));
  selection = blocks[active].dataset.hunk!;
  if (scroll) { blocks[active].scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); blocks[active].focus({ preventScroll: true }); }
  controls();
}
function changed() {
  if (!editor || !state) return;
  try {
    const text = editor.text;
    localDraft = text !== baseText;
    editInvalid = new TextEncoder().encode(text).length > 512 * 1024;
    if (editInvalid) { feedback('512KBを超えるため下書きを保存できません。元に戻すか、内容を短くしてください。', true); controls(); return; }
    // Persist each editing transaction outside the webview, including IME drafts.
    vscode.postMessage({ type: 'draft', text, baseText });
    if (!localDraft && !conflict) vscode.postMessage({ type: 'discardDraft' });
    controls();
  } catch (error) { editInvalid = true; localDraft = true; feedback(String(error), true); controls(); }
}
function loadEditor(text: string) {
  if (editor) editor.load(text);
  else editor = new RichEditor($('editor'), text, changed);
}
function setMode(next: 'edit' | 'diff') {
  if (!state || pending) return;
  if (editInvalid) { feedback('編集内容を修正してから切り替えてください。', true); return; }
  if (editor?.composing) { feedback('入力を確定してから切り替えてください。'); return; }
  if (next === 'diff' && localDraft) {
    if (conflict) { feedback('外部の変更と競合しています。下書きを退避するか、最新の内容を読み込んでください。', true); return; }
    applyDraft(false, next); return;
  }
  try {
    if (next === 'edit' && !editor) loadEditor(state.markdown);
    mode = next; controls(); window.scrollTo(0, 0);
  } catch (error) { feedback(String(error), true); }
}
function applyDraft(save: boolean, target: 'edit' | 'diff' = mode) {
  if (!state || !editor || pending || conflict || broken || editInvalid) return;
  if (editor.composing) { feedback('入力を確定してから保存してください。'); return; }
  commit = { id: crypto.randomUUID(), text: editor.text, target };
  pending = true; controls();
  vscode.postMessage({ type: 'edit', id: commit.id, text: commit.text, revision: baseRevision, save });
}
function action(type: string, id?: string) {
  if (!state || pending || broken) return;
  pending = true; controls(); vscode.postMessage({ type, id, revision: state.revision });
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'error') {
    document.querySelectorAll<HTMLDialogElement>('.table-dialog[open]').forEach(dialog => dialog.close());
    broken = true; pending = false; commit = undefined; resumeAction = undefined;
    feedback(msg.message, true); $('document').classList.add('stale'); controls(); return;
  }
  if (msg.type !== 'update') return;
  const next: State = msg.state;
  const first = !state;
  const contentChanged = next.revision !== state?.revision;
  state = next; broken = false;
  try {
    if (first) {
      const draft = next.draft;
      baseText = draft?.baseText ?? next.markdown; baseRevision = next.revision;
      if (draft && draft.text !== next.markdown && draft.text !== draft.baseText) {
        loadEditor(draft.text); localDraft = true; conflict = baseText !== next.markdown; mode = 'edit';
        feedback('前回の編集中の内容を復元しました。');
      } else { baseText = next.markdown; if (mode === 'edit') loadEditor(next.markdown); }
    } else if (commit && next.editResult?.id === commit.id) {
      pending = false;
      if (next.editResult.accepted) {
        localDraft = false; conflict = false; mode = commit.target;
        baseText = next.markdown; baseRevision = next.revision;
        // Keep selection and local Undo history for our own acknowledged edit.
        if (editor?.text !== next.markdown) loadEditor(next.markdown);
      } else { conflict = next.markdown !== baseText; if (!conflict) baseRevision = next.revision; }
      commit = undefined;
    } else if (!commit) {
      pending = false;
      if (localDraft || editor?.composing) {
        conflict = next.markdown !== baseText;
        if (!conflict) baseRevision = next.revision;
      } else {
        if (editor && next.markdown !== baseText) loadEditor(next.markdown);
        baseText = next.markdown; baseRevision = next.revision; conflict = false;
      }
    }
  } catch (error) { feedback(String(error), true); mode = 'diff'; }
  $('filename').textContent = state.name;
  const time = new Date(state.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('baseline').textContent = state.comparison ? `スナップショット ${new Date(state.comparison).toLocaleString('ja-JP')} → 現在` : '確認済みの内容 → 現在';
  $('baseline').title = `最終確認: ${time}`;
  $('document').classList.remove('stale');
  if (contentChanged) {
    const y = window.scrollY;
    disposeTables();
    $('document').innerHTML = state.html || '<p class="blank-document">空のMarkdownファイルです。</p>';
    $('document').querySelectorAll<HTMLDetailsElement>('.unchanged').forEach(d => { d.open = !changesOnly; });
    renderDiagrams($('document'));
    disposeTables = enhanceTables($('document'));
    $('document').querySelectorAll<HTMLImageElement>('.markdown-image').forEach(img => img.addEventListener('error', () => { img.hidden = true; (img.nextElementSibling as HTMLElement).hidden = false; }));
    const index = changes().findIndex(b => b.dataset.hunk === selection);
    move(index >= 0 ? index : Math.min(Math.max(active, 0), changes().length - 1), false);
    window.scrollTo(0, y);
  }
  if (!first || !localDraft) feedback(state.notice);
  controls();
  // Keep keyboard review flowing after the focused buttons disappear.
  if (resumeAction && !pending) {
    const block = changes()[active];
    const target = block?.querySelector<HTMLButtonElement>(`[data-${resumeAction}]`) ?? $('empty');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    resumeAction = undefined;
  }
});

button('undo-review').addEventListener('click', () => action('undoReview', state?.undoId));
button('snapshot').addEventListener('click', () => action('snapshot'));
button('snapshots').addEventListener('click', () => action('chooseSnapshot'));
button('changes-only').addEventListener('click', () => {
  changesOnly = !changesOnly;
  $('document').querySelectorAll<HTMLDetailsElement>('.unchanged').forEach(d => { d.open = !changesOnly; });
  controls();
});
button('editor-wide').addEventListener('click', () => { const wide = $('editor').classList.toggle('editor-wide'); button('editor-wide').setAttribute('aria-pressed', String(wide)); });
button('mode-edit').addEventListener('click', () => setMode('edit'));
button('mode-diff').addEventListener('click', () => setMode('diff'));
button('previous').addEventListener('click', () => move(active - 1));
button('next').addEventListener('click', () => move(active + 1));
button('reviewed').addEventListener('click', () => action('reviewed'));
button('save').addEventListener('click', () => localDraft ? applyDraft(true) : action('save'));
button('export-draft').addEventListener('click', () => { if (editor) vscode.postMessage({ type: 'exportDraft', text: editor.text }); });
button('discard-draft').addEventListener('click', () => {
  if (!state || pending) return;
  loadEditor(state.markdown); baseText = state.markdown; baseRevision = state.revision;
  localDraft = false; conflict = false; editInvalid = false; vscode.postMessage({ type: 'discardDraft' }); controls();
});
$('document').addEventListener('click', event => {
  const target = event.target as Element;
  const control = target.closest<HTMLButtonElement>('[data-revert], [data-review]');
  const block = target.closest<HTMLElement>('[data-hunk]');
  if (!block || pending || broken || localDraft) return;
  move(changes().indexOf(block), false);
  if (control && !control.disabled) {
    resumeAction = control.dataset.review ? 'review' : 'revert';
    action(resumeAction === 'review' ? 'reviewHunk' : 'revert', control.dataset.review ?? control.dataset.revert);
  }
});
$('link-form').addEventListener('submit', event => {
  event.preventDefault();
  if (editor?.link($<HTMLInputElement>('link-url').value.trim())) $('link-form').hidden = true;
  else feedback('リンクは https://、http://、mailto:、#、/、./、../ で始まるURLを指定してください。', true);
});
button('link-cancel').addEventListener('click', () => { $('link-form').hidden = true; editor?.view.focus(); });
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (localDraft) applyDraft(true); else action('save'); }
  if (mode === 'diff' && event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !broken && !pending) { event.preventDefault(); move(active + (event.key === 'ArrowDown' ? 1 : -1)); }
});
new MutationObserver(() => refreshDiagramThemes($('document'))).observe(document.body, { attributes: true, attributeFilter: ['class'] });
vscode.postMessage({ type: 'ready' });
