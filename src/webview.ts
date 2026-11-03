import { RichEditor } from './rich-editor';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import type { State } from './extension';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): { mode?: string; uri?: string } | undefined };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let state: State | undefined;
let active = -1, pending = false, broken = false, selection = '';
let mode: 'edit' | 'diff' = vscode.getState()?.mode === 'edit' ? 'edit' : 'diff';
let editor: RichEditor | undefined;
let baseText = '', baseRevision = '', localDraft = false, conflict = false;
let editInvalid = false;
let commit: { id: string; text: string; target: 'edit' | 'diff' } | undefined;
const changes = () => [...document.querySelectorAll<HTMLElement>('[data-hunk]')];
const button = (id: string) => $<HTMLButtonElement>(id);

function feedback(text?: string, error = false) {
  $('feedback').textContent = text || ''; $('feedback').hidden = !text;
  $('feedback').classList.toggle('error', error);
}
function controls() {
  const count = state?.count ?? 0;
  $('counter').textContent = count ? `${Math.max(1, active + 1)} / ${count} 件` : '変更なし';
  button('previous').disabled = button('next').disabled = !count || pending || broken;
  button('reviewed').disabled = !count || pending || broken || localDraft;
  button('save').disabled = pending || broken || conflict || editInvalid;
  button('mode-edit').disabled = button('mode-diff').disabled = pending || !state;
  $('save').hidden = !localDraft && !state?.dirty;
  $('save-state').textContent = conflict ? '● 競合・下書きを保持' : localDraft ? '● 編集中' : state?.dirty ? '● 未保存' : '保存済み';
  $('save-state').classList.toggle('dirty', localDraft || !!state?.dirty);
  document.querySelectorAll<HTMLButtonElement>('[data-revert]').forEach(b => { b.disabled = pending || broken; });
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#formatting button, #formatting select').forEach(b => { b.disabled = pending || broken; });
  editor?.enable(!pending && !broken);
  $('conflict').hidden = !conflict;
  $('document').hidden = mode !== 'diff';
  $('editor').hidden = $('formatting').hidden = mode !== 'edit';
  $('review-actions').hidden = $('legend').hidden = mode !== 'diff';
  if (mode === 'diff') $('link-form').hidden = true;
  $('empty').hidden = mode !== 'diff' || !!count;
  button('mode-edit').setAttribute('aria-selected', String(mode === 'edit'));
  button('mode-diff').setAttribute('aria-selected', String(mode === 'diff'));
  vscode.setState({ uri: state?.uri, mode });
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
    broken = true; pending = false; commit = undefined;
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
  $('baseline').textContent = `確認した状態（${time}） → 現在`;
  $('document').classList.remove('stale');
  if (contentChanged) {
    const y = window.scrollY;
    $('document').innerHTML = state.html || '<p class="blank-document">空のMarkdownファイルです。</p>';
    const index = changes().findIndex(b => b.dataset.hunk === selection);
    move(index >= 0 ? index : Math.min(Math.max(active, 0), changes().length - 1), false);
    window.scrollTo(0, y);
  }
  if (!first || !localDraft) feedback(state.notice);
  controls();
});

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
  const button = (event.target as Element).closest<HTMLElement>('[data-revert]');
  if (button) action('revert', button.dataset.revert);
  else { const block = (event.target as Element).closest<HTMLElement>('[data-hunk]'); if (block) move(changes().indexOf(block), false); }
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
vscode.postMessage({ type: 'ready' });
