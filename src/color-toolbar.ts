import type { EditorView } from 'prosemirror-view';
import type { Node } from 'prosemirror-model';
import type { Selection } from 'prosemirror-state';
import { colorLabels, colorPresets, normalizeColor, selectionColor, setSelectionColor, type ColorKind } from './text-colors';
import { icon } from './icons';

export function colorToolbar(): string {
  return `<div id="color-controls" class="color-controls">
    <button id="text-color" data-color-control aria-label="文字色" title="文字を選択して色を変更" aria-haspopup="dialog" aria-expanded="false" aria-controls="color-palette"><span class="text-color-icon" aria-hidden="true">A</span></button>
    <button id="text-highlight" data-color-control aria-label="マーカー" title="文字を選択してマーカーを付ける" aria-haspopup="dialog" aria-expanded="false" aria-controls="color-palette">${icon('highlight')}</button>
    <div id="color-palette" class="color-palette" role="dialog" aria-labelledby="color-title" hidden>
      <div class="color-heading"><strong id="color-title">文字色</strong><button type="button" data-color-control id="color-close" aria-label="色のパレットを閉じる">${icon('close')}</button></div>
      <div id="color-swatches" class="color-swatches" role="group" aria-label="おすすめの色"></div>
      <form id="color-custom" class="color-custom"><input id="color-picker" type="color" aria-label="カスタム色を選ぶ"><input id="color-hex" aria-label="カラーコード" placeholder="#RRGGBB" maxlength="7" pattern="#[0-9a-fA-F]{6}" required autocomplete="off" spellcheck="false"><button data-color-control type="submit">適用</button></form>
      <p id="color-error" role="alert" hidden>色は #RRGGBB 形式で指定してください。</p>
      <div id="color-sample" class="color-sample" aria-label="色のプレビュー"><span></span></div>
      <button type="button" data-color-control id="color-clear" class="color-clear">色を解除</button>
      <p class="color-help">選択した文字に適用 · HTMLタグで保存</p>
    </div>
  </div>`;
}

export class ColorPalette {
  private root = document.getElementById('color-controls');
  private kind: ColorKind = 'textColor';
  private openedDoc?: Node;
  private openedSelection?: Selection;
  private readonly ids: Record<ColorKind, string> = { textColor: 'text-color', highlight: 'text-highlight' };
  constructor(private view: EditorView, private enabled: () => boolean) {
    if (!this.root) return;
    for (const kind of ['textColor', 'highlight'] as const) {
      const trigger = this.element<HTMLButtonElement>(this.ids[kind]);
      trigger.addEventListener('mousedown', event => event.preventDefault());
      trigger.addEventListener('click', () => this.openedDoc && this.kind === kind ? this.close(true) : this.open(kind));
    }
    this.element('color-close').addEventListener('click', () => this.close(true));
    this.element('color-clear').addEventListener('click', () => this.apply(null));
    this.element('color-picker').addEventListener('input', () => {
      this.element<HTMLInputElement>('color-hex').value = this.element<HTMLInputElement>('color-picker').value;
      this.preview();
    });
    this.element('color-hex').addEventListener('input', () => this.preview());
    this.element('color-custom').addEventListener('submit', event => {
      event.preventDefault();
      const color = normalizeColor(this.element<HTMLInputElement>('color-hex').value);
      if (color) this.apply(color); else this.element('color-error').hidden = false;
    });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); }
    });
    this.root.addEventListener('focusout', event => {
      if (event.relatedTarget && !this.root?.contains(event.relatedTarget as globalThis.Node)) this.close();
    });
    document.addEventListener('pointerdown', event => { if (!this.root?.contains(event.target as globalThis.Node)) this.close(); });
    this.update();
  }
  private element<T extends HTMLElement = HTMLElement>(id: string): T { return this.root!.querySelector<T>('#' + id)!; }
  private open(kind: ColorKind): void {
    if (!this.enabled() || this.view.composing || !setSelectionColor(kind, null)(this.view.state)) return;
    this.kind = kind; this.openedDoc = this.view.state.doc; this.openedSelection = this.view.state.selection;
    this.element('color-title').textContent = colorLabels[kind];
    this.element('color-clear').textContent = kind === 'textColor' ? '文字色を解除' : 'マーカーを解除';
    const selected = selectionColor(this.view.state, kind);
    const swatches = this.element('color-swatches'); swatches.replaceChildren();
    for (const [name, value] of colorPresets[kind]) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.colorControl = ''; button.className = 'color-swatch'; button.style.setProperty('--swatch', value);
      button.title = `${name} ${value}`; button.setAttribute('aria-label', `${colorLabels[kind]}：${name}`);
      button.setAttribute('aria-pressed', String(value === selected));
      button.innerHTML = icon('check');
      button.addEventListener('click', () => this.apply(value)); swatches.append(button);
    }
    this.element<HTMLInputElement>('color-hex').value = selected || colorPresets[kind][0][1];
    const { from, to } = this.view.state.selection;
    this.element('color-sample').querySelector('span')!.textContent = this.view.state.doc.textBetween(from, to, ' ').slice(0, 50);
    this.preview(); this.element('color-palette').hidden = false; this.update();
    (swatches.querySelector<HTMLButtonElement>('[aria-pressed="true"]') || swatches.querySelector<HTMLButtonElement>('button'))?.focus();
  }
  private preview(): void {
    const value = normalizeColor(this.element<HTMLInputElement>('color-hex').value);
    this.element('color-error').hidden = !!value;
    if (!value) return;
    this.element<HTMLInputElement>('color-picker').value = value;
    const span = this.element('color-sample').querySelector('span')!;
    span.style.color = this.kind === 'textColor' ? value : selectionColor(this.view.state, 'textColor') || '#202124';
    span.style.backgroundColor = this.kind === 'highlight' ? value : selectionColor(this.view.state, 'highlight') || '';
  }
  private apply(value: string | null): void {
    if (!this.enabled() || this.view.composing || this.view.state.doc !== this.openedDoc || !this.view.state.selection.eq(this.openedSelection!)) { this.close(); return; }
    this.close();
    setSelectionColor(this.kind, value)(this.view.state, this.view.dispatch);
    this.view.focus();
  }
  close(focus = false): void {
    if (!this.root) return;
    this.openedDoc = undefined; this.openedSelection = undefined;
    this.element('color-palette').hidden = true;
    for (const id of Object.values(this.ids)) this.element(id).setAttribute('aria-expanded', 'false');
    if (focus) this.element(this.ids[this.kind]).focus();
  }
  update(): void {
    if (!this.root) return;
    if (this.openedDoc && (!this.enabled() || this.view.state.doc !== this.openedDoc || !this.view.state.selection.eq(this.openedSelection!))) this.close();
    for (const kind of ['textColor', 'highlight'] as const) {
      const trigger = this.element<HTMLButtonElement>(this.ids[kind]);
      trigger.disabled = !this.enabled() || !setSelectionColor(kind, null)(this.view.state);
      trigger.style.setProperty('--selected-color', selectionColor(this.view.state, kind) || 'currentColor');
      trigger.setAttribute('aria-expanded', String(!!this.openedDoc && this.kind === kind));
    }
  }
}
