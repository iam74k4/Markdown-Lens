import { navigation } from './navigation';
import type { ReviewView } from './review-view';
import { refreshDiagramThemes } from './diagrams';
import { RichEditor } from './rich-editor';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import type { NumberingRule } from './table-numbering';
import type { State } from './extension';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): { mode?: string; uri?: string; changesOnly?: boolean; numbering?: NumberingRule[]; folds?: string[]; view?: ReviewView } | undefined };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let state: State | undefined;
let restored = false, restoring = false, persistedView = '';
let bookmarkY = -1, bookmarkFolds = '', savedAnchor: ReviewView['anchor'];
let imageUpload: { id: string; text: string; source: boolean; from: number; to: number } | undefined;

let changesOnly = vscode.getState()?.changesOnly ?? false;
let active = -1, pending = false, broken = false, selection = '';
let resumeAction: 'review' | 'revert' | undefined;
let editor: RichEditor | undefined;
let baseText = '', baseRevision = '', localDraft = false, conflict = false;
let editInvalid = false, previewReady = false, sourceOpen = false;
let sourceDraft: string | undefined;
let sourceComposing = false;
let sourcePending = false;
let sourceRenderTimer: ReturnType<typeof setTimeout> | undefined;
let sourceCompositionTimer: ReturnType<typeof setTimeout> | undefined;
type HostMessage = { type: 'imageSaved'; id: string; src?: string; error?: string } | { type: 'update'; state: State } | { type: 'error'; message: string } |
  { type: 'draftPreview'; text: string; baseText?: string; baselineMarkdown?: string; hunks: State['hunks']; html: string; error?: string };
let deferredHostMessage: Extract<HostMessage, { type: 'update' | 'error' }> | undefined;
const composing = () => sourceComposing || !!editor?.composing;
let draftPreview: { text: string; hunks: State['hunks']; html: string } | undefined;
let queuedAction: { type: string; id?: string; row?: number; column?: number } | undefined;
const currentText = () => sourceDraft ?? editor?.text ?? state?.markdown ?? '';
const sourceField = () => $<HTMLTextAreaElement>('source-text');
function syncSource() {
  $('source-pane').hidden = !sourceOpen;
  $('workspace').classList.toggle('with-source', sourceOpen);
  button('toggle-source').setAttribute('aria-pressed', String(sourceOpen));
  const version = $<HTMLSelectElement>('source-version').value;
  sourceField().readOnly = version !== 'current' || pending || broken || !!imageUpload;
  const text = version === 'confirmed' ? state?.confirmedMarkdown ?? '' : version === 'comparison' ? state?.baselineMarkdown ?? '' : currentText();
  if (!sourceComposing && sourceField().value !== text) sourceField().value = text;
  $('source-hint').textContent = version === 'current' ? '本文と同じ下書きを編集します。保存は ⌘ / Ctrl + S' : '読み取り専用です。確認済みの内容と比較元は、確認やスナップショット選択で変わります。';
}
function renderCurrent() {
  if (!state || composing() || sourcePending) return;
  const preview = localDraft ? (draftPreview?.text === currentText() ? draftPreview : undefined) : state;
  if (editor && preview && !editInvalid) editor.review(currentText(), preview.hunks, preview.html);
}

let commit: { id: string; text: string } | undefined;
const changes = () => [...$('editor').querySelectorAll<HTMLElement>('[data-hunk]')];
const button = (id: string) => $<HTMLButtonElement>(id);

function feedback(text?: string, error = false) {
  $('feedback-text').textContent = text || (state?.undoId ? '直前の確認を取り消せます。' : ''); $('feedback').hidden = !text && !state?.undoId;
  button('undo-review').hidden = !state?.undoId || !!state?.comparison || error;
  $('feedback').classList.toggle('error', error);
}
function controls() {
  const busy = pending || !!imageUpload;
  const count = localDraft && draftPreview ? draftPreview.hunks.length : state?.count ?? 0;
  $('counter').textContent = state?.comparison ? `比較差分 ${count}件` : count ? `未確認 ${count}件` : '✓ 確認完了';
  $('counter').classList.toggle('complete', count === 0);
  $('position').textContent = count ? `${Math.max(1, active + 1)} / ${count}` : '';
  $('change-navigation').hidden = !count;
  button('previous').disabled = button('next').disabled = !count || busy || broken;
  button('reviewed').disabled = !count || busy || broken || conflict || editInvalid || (localDraft && !previewReady) || !!state?.comparison;
  button('save').disabled = busy || broken || conflict || editInvalid;
  button('mode-edit').disabled = button('toggle-source').disabled = busy || !state;
  $('save').hidden = !localDraft && !state?.dirty;
  $('save-state').textContent = conflict ? '● 競合・下書きを保持' : localDraft ? '● 編集中' : state?.dirty ? '● 未保存' : '保存済み';
  $('save-state').classList.toggle('dirty', localDraft || !!state?.dirty);
  document.querySelectorAll<HTMLButtonElement>('[data-revert], [data-review]').forEach(b => { b.disabled = busy || broken || conflict || editInvalid || (localDraft && !previewReady) || (!!b.dataset.review && !!state?.comparison); });
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#formatting button:not([data-color-control]), #formatting select').forEach(b => { b.disabled = busy || broken || sourcePending; });
  document.querySelectorAll<HTMLInputElement>('input[data-task]').forEach(input => { input.disabled = busy || broken; });
  editor?.enable(!busy && !broken && (!sourcePending || sourceComposing) && !(editInvalid && sourceDraft !== undefined));
  $('conflict').hidden = !conflict;
  $('editor').hidden = $('formatting').hidden = !editor || (editInvalid && sourceDraft !== undefined);
  $('review-actions').hidden = $('legend').hidden = false;
  $('empty').hidden = !!count || localDraft;
  $('empty').querySelector('strong')!.textContent = state?.comparison ? 'スナップショットとの差分はありません' : '未確認の変更はありません';
  button('mode-edit').setAttribute('aria-pressed', String(!sourceOpen));
  button('undo-review').disabled = busy || broken || localDraft;
  button('snapshot').disabled = busy || broken || localDraft;
  button('snapshots').disabled = busy || broken || localDraft;
  button('changes-only').setAttribute('aria-pressed', String(changesOnly));
  button('fold-all').disabled = button('unfold-all').disabled = busy || broken || !editor?.sectionCount;
  document.querySelectorAll<HTMLButtonElement>('[data-cell-action]').forEach(b => { b.disabled = busy || broken || conflict || editInvalid || composing() || (localDraft && !previewReady) || (b.dataset.cellAction === 'reviewCell' && !!state?.comparison); });
  syncSource(); persistView(); nav.update();
}
function move(index: number, scroll = true) {
  let blocks = changes();
  if (!blocks.length) { active = -1; controls(); return; }
  active = (index + blocks.length) % blocks.length;
  blocks.forEach((b, i) => b.classList.toggle('active', i === active));
  selection = blocks[active].dataset.hunk!;
  if (scroll) {
    editor?.revealChange(selection);
    blocks = changes(); blocks.forEach((b, i) => b.classList.toggle('active', i === active));
    blocks[active].scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); blocks[active].focus({ preventScroll: true }); }
  controls();
}
function changed() {
  if (!editor || !state) return;
  // A late composition flush from the rich view must not overwrite newer
  // source input entered immediately after moving focus to the source pane.
  if (sourcePending && sourceDraft !== undefined) return;
  try {
    sourceDraft = undefined;
    const text = editor.text;
    previewReady = false;
    localDraft = text !== baseText;
    editInvalid = new TextEncoder().encode(text).length > 512 * 1024;
    if (editInvalid) { feedback('512KBを超えるため下書きを保存できません。元に戻すか、内容を短くしてください。', true); controls(); return; }
    // Persist each editing transaction outside the webview, including IME drafts.
    vscode.postMessage({ type: 'draft', text, baseText, composing: composing() });
    if (!localDraft && !conflict) { vscode.postMessage({ type: 'discardDraft' }); renderCurrent(); }
    controls();
  } catch (error) { editInvalid = true; localDraft = true; feedback(String(error), true); controls(); }
}
function loadEditor(text: string) {
  clearTimeout(sourceRenderTimer); sourcePending = false;
  if (editor) editor.load(text);
  else {
    const saved = vscode.getState();
    editor = new RichEditor($('editor'), text, changed, controls);
    if (saved && saved.uri === state?.uri) {
      if (Array.isArray(saved.numbering)) editor.load(text, saved.numbering);
      if (Array.isArray(saved.folds)) editor.fold(saved.folds.filter(key => typeof key === 'string'));
    }
  }
  editInvalid = false; editor.filter(changesOnly);
}
function showSource(open: boolean) {
  if (!state || pending || imageUpload) return;
  // Opening source must remain possible during the rich editor's deferred IME flush.
  // sourcePending then protects newer source input from the late rich callback.
  if (!open && composing()) { feedback('入力を確定してから切り替えてください。'); return; }
  if (!open && ((sourcePending && !flushSourceDraft()) || editInvalid)) {
    feedback('Markdownの編集内容を修正してからPreviewを開いてください。', true); return;
  }
  sourceOpen = open; if (!open) renderCurrent(); controls();
}
function applyDraft(save: boolean) {
  if (!state || !editor || pending || imageUpload || conflict || broken || editInvalid) return;
  if (composing()) { feedback('入力を確定してから保存してください。'); return; }
  if (sourcePending && !flushSourceDraft()) return;
  commit = { id: crypto.randomUUID(), text: currentText() };
  pending = true; controls();
  vscode.postMessage({ type: 'edit', id: commit.id, text: commit.text, revision: baseRevision, save });
}
function action(type: string, id?: string, row?: number, column?: number) {
  if (!state || pending || imageUpload || broken || conflict || editInvalid) return;
  if (composing()) { feedback('入力を確定してから操作してください。'); return; }
  if (localDraft && ['reviewHunk', 'reviewed', 'revert', 'reviewCell', 'revertCell'].includes(type)) {
    if (!previewReady || editor?.composing || sourceComposing) return;
    queuedAction = { type, id, row, column }; applyDraft(false); return;
  }
  pending = true; controls(); vscode.postMessage({ type, id, row, column, revision: state.revision });
}

function receiveHostMessage(msg: HostMessage) {
  if (msg.type === 'imageSaved') {
    const upload = imageUpload; if (!upload || upload.id !== msg.id) return;
    imageUpload = undefined; controls();
    if (msg.error || !msg.src) { feedback(msg.error || '画像を保存できませんでした。', true); return; }
    if (currentText() !== upload.text || conflict || broken) { feedback(`画像を ${msg.src} に保存しました。本文が更新されたため挿入は中止しました。`, true); return; }
    if (upload.source) {
      sourceField().setRangeText(`![画像](${msg.src})`, upload.from, upload.to, 'end'); sourceChanged();
    } else editor?.image(msg.src, '画像');
    feedback('画像を保存して挿入しました。文書は保存で反映します。'); return;
  }
  if (composing() && (msg.type === 'update' || msg.type === 'error')) { deferredHostMessage = msg; return; }
  if (msg.type === 'draftPreview') {
    if (!state || msg.text !== currentText()) return;
    if (msg.error) { editInvalid = true; previewReady = false; feedback(msg.error, true); controls(); return; }
    if (msg.baseText !== baseText || msg.baselineMarkdown !== state.baselineMarkdown) return;
    draftPreview = { text: msg.text, hunks: msg.hunks, html: msg.html }; previewReady = true;
    if (!composing()) { renderCurrent(); controls(); }
    return;
  }
  if (msg.type === 'error') {
    document.querySelectorAll<HTMLDialogElement>('.table-dialog[open]').forEach(dialog => dialog.close());
    broken = true; pending = false; commit = undefined; queuedAction = undefined; resumeAction = undefined;
    feedback(msg.message, true); controls(); return;
  }
  if (msg.type !== 'update') return;
  const next: State = msg.state;
  const first = !state;
  const contentChanged = next.revision !== state?.revision;
  state = next; broken = false;
  let loadFailed = false;
  try {
    if (first) {
      const local = vscode.getState();
      const saved = local?.uri === next.uri ? local.view ?? next.view : next.view;
      if (saved) { changesOnly = saved.changesOnly; sourceOpen = saved.sourceOpen; active = saved.active; }
      const draft = next.draft;
      baseText = draft?.baseText ?? next.markdown; baseRevision = next.revision;
      if (draft && draft.text !== next.markdown && draft.text !== draft.baseText) {
        loadEditor(draft.text); localDraft = true; conflict = baseText !== next.markdown;
        feedback('前回の編集中の内容を復元しました。');
      } else { baseText = next.markdown; loadEditor(next.markdown); }
      if (saved) editor?.fold(saved.folds);
    } else if (commit && next.editResult?.id === commit.id) {
      pending = false;
      if (next.editResult.accepted) {
        localDraft = false; conflict = false; sourceDraft = undefined; draftPreview = undefined;
        baseText = next.markdown; baseRevision = next.revision;
        // Keep selection and local Undo history for our own acknowledged edit.
        if (editor?.text !== next.markdown) loadEditor(next.markdown);
      } else { queuedAction = undefined; conflict = next.markdown !== baseText; if (!conflict) baseRevision = next.revision; }
      commit = undefined;
    } else if (!commit) {
      pending = false;
      if (localDraft || editor?.composing) {
        conflict = next.markdown !== baseText;
        if (!conflict) baseRevision = next.revision;
      } else {
        if (editor && next.markdown !== baseText) { sourceDraft = undefined; loadEditor(next.markdown); }
        baseText = next.markdown; baseRevision = next.revision; conflict = false;
      }
    }
  } catch (error) {
    loadFailed = true; sourceDraft = next.draft?.text ?? next.markdown; sourceOpen = true; editInvalid = true;
    $<HTMLSelectElement>('source-version').value = 'current';
    feedback(`本文を表示できません。Markdownで内容を確認・修正してください。${String(error)}`, true);
  }
  $('filename').textContent = state.name;
  const time = new Date(state.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('baseline').textContent = state.comparison ? `スナップショット ${new Date(state.comparison).toLocaleString('ja-JP')} → 現在` : '確認済みの内容 → 現在';
  $('baseline').title = `最終確認: ${time}`;
  if (contentChanged) {
    const y = window.scrollY;
    renderCurrent();
    const index = changes().findIndex(b => b.dataset.hunk === selection);
    move(index >= 0 ? index : Math.min(Math.max(active, 0), changes().length - 1), false);
    window.scrollTo(0, y);
  }
  if (localDraft && !conflict) vscode.postMessage({ type: 'draft', text: currentText(), baseText });
  if (!loadFailed && (!first || !localDraft)) feedback(state.notice);
  controls();
  if (first) {
    const local = vscode.getState(), saved = local?.uri === next.uri ? local.view ?? next.view : next.view;
    restoring = true;
    requestAnimationFrame(() => {
      if (saved) { move(saved.active, false); window.scrollTo(0, saved.y); if (!sourceOpen && saved.anchor) editor?.restoreBookmark(saved.anchor); }
      restoring = false; restored = true; persistView();
    });
  }
  if (queuedAction && !commit && !localDraft && !pending) {
    const nextAction = queuedAction; queuedAction = undefined; action(nextAction.type, nextAction.id, nextAction.row, nextAction.column); return;
  }
  // Keep keyboard review flowing after the focused buttons disappear.
  if (resumeAction && !pending) {
    move(active);
    const block = changes()[active];
    const target = block?.querySelector<HTMLButtonElement>(`[data-${resumeAction}]`) ?? $('empty');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    resumeAction = undefined;
  }
}
window.addEventListener('message', event => receiveHostMessage(event.data));
function compositionSettled() {
  if (composing()) return;
  // The final input event has now reached the editor model. Reconcile the
  // latest host update against that draft, including a cancelled composition.
  const deferred = deferredHostMessage; deferredHostMessage = undefined;
  if (deferred) receiveHostMessage(deferred);
  if (localDraft) vscode.postMessage({ type: 'draft', text: currentText(), baseText });
  renderCurrent(); controls();
}

button('undo-review').addEventListener('click', () => action('undoReview', state?.undoId));
button('snapshot').addEventListener('click', () => action('snapshot'));
button('snapshots').addEventListener('click', () => action('chooseSnapshot'));
button('changes-only').addEventListener('click', () => {
  changesOnly = !changesOnly; editor?.filter(changesOnly);
  controls();
});
for (const [id, collapse] of [['fold-all', true], ['unfold-all', false]] as const) button(id).addEventListener('click', () => {
  if (editor?.composing) return;
  editor?.foldAll(collapse);
});
button('editor-wide').addEventListener('click', () => { const wide = $('editor').classList.toggle('editor-wide'); button('editor-wide').setAttribute('aria-pressed', String(wide)); });
button('mode-edit').addEventListener('click', () => showSource(false));
button('previous').addEventListener('click', () => move(active - 1));
button('next').addEventListener('click', () => move(active + 1));
button('reviewed').addEventListener('click', () => action('reviewed'));
button('save').addEventListener('click', () => localDraft ? applyDraft(true) : action('save'));
button('export-draft').addEventListener('click', () => { if (editor) vscode.postMessage({ type: 'exportDraft', text: currentText() }); });
button('discard-draft').addEventListener('click', () => {
  if (!state || pending) return;
  sourceDraft = undefined; draftPreview = undefined; loadEditor(state.markdown); baseText = state.markdown; baseRevision = state.revision;
  localDraft = false; conflict = false; editInvalid = false; vscode.postMessage({ type: 'discardDraft' }); renderCurrent(); controls();
});
$('workspace').addEventListener('click', event => {
  const target = event.target as Element;
  const cell = target.closest<HTMLButtonElement>('[data-cell-action]');
  if (cell) {
    if (!cell.disabled) action(cell.dataset.cellAction!, cell.dataset.cellHunk, Number(cell.dataset.row), Number(cell.dataset.column));
    return;
  }
  const control = target.closest<HTMLButtonElement>('[data-revert], [data-review]');
  const block = target.closest<HTMLElement>('[data-hunk]');
  if (!block || pending || broken || conflict || editInvalid || (localDraft && !previewReady)) return;
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
  if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !broken && !pending) { event.preventDefault(); move(active + (event.key === 'ArrowDown' ? 1 : -1)); }
});
new MutationObserver(() => refreshDiagramThemes($('workspace'))).observe(document.body, { attributes: true, attributeFilter: ['class'] });
button('toggle-source').addEventListener('click', () => showSource(!sourceOpen));
button('close-source').addEventListener('click', () => { showSource(false); if (!sourceOpen) button('toggle-source').focus(); });
$<HTMLSelectElement>('source-version').addEventListener('change', syncSource);
function flushSourceDraft(): boolean {
  clearTimeout(sourceRenderTimer);
  if (sourceComposing) return false;
  try {
    if (sourcePending && sourceDraft !== undefined) loadEditor(sourceDraft);
    return true;
  } catch (error) {
    sourcePending = false; editInvalid = true; feedback(String(error), true); controls(); return false;
  }
}
function sourceChanged(settled = false) {
  if (!state || sourceField().readOnly) return;
  if (!settled && sourceDraft === sourceField().value) return;
  sourceDraft = sourceField().value; localDraft = sourceDraft !== baseText; previewReady = false;
  try {
    editInvalid = new TextEncoder().encode(sourceDraft).length > 512 * 1024;
    if (editInvalid) throw new Error('512KBを超えるため下書きを保存できません。');
    vscode.postMessage({ type: 'draft', text: sourceDraft, baseText, composing: sourceComposing });
    clearTimeout(sourceRenderTimer);
    sourcePending = true;
    if (!sourceComposing) sourceRenderTimer = setTimeout(() => { if (flushSourceDraft()) { renderCurrent(); controls(); } }, 75);
    controls();
  } catch (error) { editInvalid = true; feedback(String(error), true); controls(); }
}
sourceField().addEventListener('input', () => {
  // Capture immediately so a click on Save never races the visual refresh.
  sourceChanged();
});
sourceField().addEventListener('compositionstart', () => { clearTimeout(sourceCompositionTimer); sourceComposing = true; });
sourceField().addEventListener('compositionend', () => {
  clearTimeout(sourceCompositionTimer);
  sourceCompositionTimer = setTimeout(() => { sourceComposing = false; sourceChanged(true); compositionSettled(); }, 30);
});
$('editor').addEventListener('composition-settled', () => { if (sourceDraft === undefined) changed(); compositionSettled(); });
$('image-form').addEventListener('submit', event => {
  event.preventDefault();
  if (editor?.image($<HTMLInputElement>('image-src').value.trim(), $<HTMLInputElement>('image-alt').value)) $('image-form').hidden = true;
  else feedback('画像のパスを入力してください。ローカル画像をプレビューできます。', true);
});
button('image-cancel').addEventListener('click', () => { $('image-form').hidden = true; editor?.view.focus(); });
const nav = navigation(() => editor, () => !!state && !pending && !imageUpload && !broken && !conflict && !editInvalid && !sourcePending && !composing(), () => {
  if (!state || pending || imageUpload || composing()) return false;
  if (sourcePending && !flushSourceDraft()) return false;
  if (editInvalid) return false; sourceOpen = false; controls(); return true;
}, feedback);
function persistView() {
  if (!state || !editor || !restored || restoring) return;
  const y = Math.max(0, window.scrollY), foldKey = JSON.stringify([sourceOpen, editor.folds]);
  if (y !== bookmarkY || foldKey !== bookmarkFolds) { bookmarkY = y; bookmarkFolds = foldKey; savedAnchor = !sourceOpen ? editor.bookmark() : undefined; }
  const view: ReviewView = { mode: 'edit', folds: editor.folds, changesOnly, sourceOpen, y, active, anchor: !sourceOpen ? savedAnchor : undefined };
  vscode.setState({ uri: state.uri, changesOnly, numbering: editor.numbering, folds: editor.folds, view });
  const key = JSON.stringify(view); if (key === persistedView) return;
  persistedView = key; vscode.postMessage({ type: 'view', view });
}
let viewFrame = 0;
window.addEventListener('scroll', () => { if (!viewFrame) viewFrame = requestAnimationFrame(() => { viewFrame = 0; persistView(); }); }, { passive: true });
window.addEventListener('pagehide', persistView);
document.addEventListener('paste', async event => {
  const target = event.target as HTMLElement;
  if (!target.closest('.ProseMirror, #source-text')) return;
  const file = [...event.clipboardData?.items ?? []].find(item => item.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(item.type))?.getAsFile();
  if (!file) return;
  event.preventDefault(); event.stopPropagation();
  if (!state || pending || imageUpload || broken || conflict || composing() || editInvalid || (target.id === 'source-text' && sourceField().readOnly)) return;
  if (file.size > 10 * 1024 * 1024) { feedback('画像は10MB以下で貼り付けてください。', true); return; }
  imageUpload = { id: crypto.randomUUID(), text: currentText(), source: target.id === 'source-text', from: sourceField().selectionStart, to: sourceField().selectionEnd };
  controls(); feedback('画像を保存しています…');
  try {
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('画像を読み込めませんでした。')); reader.readAsDataURL(file); });
    vscode.postMessage({ type: 'pasteImage', id: imageUpload!.id, data });
  } catch (error) { imageUpload = undefined; controls(); feedback(String(error), true); }
}, true);
vscode.postMessage({ type: 'ready' });
