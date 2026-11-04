import { EditorState, Command, TextSelection, NodeSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { tableEditing, deleteTable, goToNextCell } from 'prosemirror-tables';
import { autoNumbering, numberingRules, restoreNumbering, type NumberingRule } from './table-numbering';
import { QuickTableView, quickTableSelection } from './quick-table-view';
import { alignTableColumns, quickTableCommand } from './rich-table';
import { inlineReviewPlugin, inlineReviewKey, inlineChanges, reviewDecorations, InlineChange } from './inline-review';
import { headingSections, insideSection, sectionDecorations } from './section-folding';
import type { Hunk } from './core';
import { mediaNodeViews } from './rich-media';
import { gapCursor } from 'prosemirror-gapcursor';
import { ColorPalette } from './color-toolbar';
import { parseRichMarkdown, serializeRichMarkdown, richSchema as schema, makeTable, RichDocument } from './rich-markdown';
import { searchPlugin, searchKey, findText, Match } from './search';
import { closeHistory } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';

export class RichEditor {
  readonly view: EditorView;
  private model: RichDocument;
  private enabled = true;
  private plan: InlineChange[] = [];
  private expanded = new Set<number>();
  private filtered = false;
  private collapsed = new Set<string>();
  private images = new Map<string, string>();
  private diagramBefore = new Map<string, string>();
  private colors?: ColorPalette;
  private compositionLock = false;
  private comparisons = new Map<string, string>();
  private compositionTimer?: ReturnType<typeof setTimeout>;
  private decorationPending = false;
  private textCache?: { doc: PMNode; text: string };
  private sectionCache?: { doc: PMNode; sections: ReturnType<typeof headingSections> };
  private numberingCache?: { doc: PMNode; rules: NumberingRule[] };
  constructor(element: HTMLElement, source: string, private onChange: () => void, private onFoldChange: () => void = () => {}) {
    this.model = parseRichMarkdown(source);
    const rules = inputRules({ rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, m => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, m => ({ order: +m[1] })),
      wrappingInputRule(/^>\s$/, schema.nodes.blockquote),
    ] });
    const plugins = [searchPlugin, inlineReviewPlugin, quickTableSelection, autoNumbering, history(), rules, keymap({
      'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
      'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em),
      'Mod-`': toggleMark(schema.marks.code),
      'Enter': (state, dispatch, view) => {
        const { $from } = state.selection;
        let task = false;
        for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === schema.nodes.list_item) { task = $from.node(depth).attrs.checked !== null; break; }
        return splitListItem(schema.nodes.list_item, { checked: task ? false : null })(state, dispatch, view);
      },
      'Shift-Enter': (state, dispatch) => { if (state.selection.$from.parent.type === schema.nodes.code_block) { if (dispatch) dispatch(state.tr.insertText('\n')); return true; } if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView()); return true; },
      'Mod-Enter': exitCode,
      'Tab': chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
      'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
    }), keymap(baseKeymap), gapCursor(), tableEditing()];
    this.view = new EditorView(element, {
      state: EditorState.create({ doc: this.model.doc, schema, plugins }),
      attributes: { 'aria-label': 'Markdownを直接編集', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      editable: () => this.enabled,
      nodeViews: { table: (node, view, getPos) => new QuickTableView(node, view, getPos), ...mediaNodeViews(() => this.images, () => this.diagramBefore) },
      dispatchTransaction: transaction => {
        const result = this.view.state.applyTransaction(transaction);
        this.view.updateState(result.state);
        const docChanged = result.transactions.some(tr => tr.docChanged);
        if (docChanged) { this.plan = []; this.expanded.clear(); }
        // Keyboard navigation into hidden content reveals it before continuing to edit.
        let revealed = false;
        if (transaction.selectionSet) for (const section of this.sections) {
          if (this.collapsed.has(section.key) && insideSection(section, result.state.selection.head, result.state.doc.content.size)) {
            this.collapsed.delete(section.key); revealed = true;
          }
        }
        if (docChanged || revealed) this.decorate();
        if (docChanged) this.onChange();
        if (revealed) this.onFoldChange();
        this.updateToolbar();
      },
      handleClickOn: (view, _pos, node, nodePos) => {
        if (node.type !== schema.nodes.image) return false;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos))); return true;
      },
      handleDOMEvents: { change: (view, event) => {
        const input = event.target as HTMLInputElement;
        if (!input.matches('input[data-task]') || !this.enabled) return false;
        const item = input.closest('li')!;
        const position = view.posAtDOM(item.querySelector('div')!, 0), resolved = view.state.doc.resolve(position);
        for (let depth = resolved.depth; depth > 0; depth--) if (resolved.node(depth).type === schema.nodes.list_item) {
          view.dispatch(view.state.tr.setNodeMarkup(resolved.before(depth), undefined, { ...resolved.node(depth).attrs, checked: input.checked })); return true;
        }
        return false;
      }, click: (_view, event) => {
        if ((event.target as Element).closest('a')) { event.preventDefault(); return true; } return false;
      } },
    });
    document.querySelectorAll<HTMLElement>('[data-format]').forEach(button => {
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', () => this.command(button.dataset.format!));
    });
    document.querySelector<HTMLSelectElement>('#block-type')!.addEventListener('change', e => this.command((e.target as HTMLSelectElement).value));
    document.querySelector<HTMLSelectElement>('#table-action')!.addEventListener('change', e => {
      this.command((e.target as HTMLSelectElement).value); (e.target as HTMLSelectElement).value = '';
    });
    this.colors = new ColorPalette(this.view, () => this.enabled && !this.composing);
    this.view.dom.addEventListener('compositionstart', () => {
      clearTimeout(this.compositionTimer); this.compositionLock = true; this.colors?.close(); this.colors?.update();
    }, true);
    this.view.dom.addEventListener('compositionend', () => {
      clearTimeout(this.compositionTimer);
      // ProseMirror flushes the final DOM mutation after compositionend. Keep
      // widgets, source synchronization and host updates paused until it settles.
      this.compositionTimer = setTimeout(() => {
        this.compositionLock = false;
        if (this.decorationPending) this.decorate();
        this.updateToolbar();
        this.view.dom.dispatchEvent(new Event('composition-settled', { bubbles: true }));
      }, 30);
    });
    this.decorate(); this.updateToolbar();
  }
  get text(): string {
    const doc = this.view.state.doc;
    if (this.textCache?.doc !== doc) this.textCache = { doc, text: serializeRichMarkdown(this.model, doc) };
    return this.textCache.text;
  }
  get numbering(): NumberingRule[] {
    const doc = this.view.state.doc;
    if (this.numberingCache?.doc !== doc) this.numberingCache = { doc, rules: numberingRules(doc) };
    return this.numberingCache.rules;
  }
  private get sections() {
    const doc = this.view.state.doc;
    if (this.sectionCache?.doc !== doc) this.sectionCache = { doc, sections: headingSections(doc) };
    return this.sectionCache.sections;
  }
  get folds(): string[] { return [...this.collapsed]; }
  get sectionCount(): number { return this.sections.length; }
  fold(keys: string[]): void { this.collapsed = new Set(keys); this.parkSelection(); this.decorate(); }
  foldAll(collapse: boolean): void {
    this.collapsed = new Set(collapse ? this.sections.map(s => s.key) : []);
    this.parkSelection(); this.decorate(); this.onFoldChange();
  }
  revealChange(id: string): void {
    const change = this.plan.find(p => p.hunk.id === id); if (!change) return;
    for (const section of this.sections) if (insideSection(section, change.position, this.view.state.doc.content.size)) this.collapsed.delete(section.key);
    this.decorate(); this.onFoldChange();
  }
  private toggleFold(key: string): void {
    if (this.composing) return;
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.parkSelection(); this.decorate(); this.onFoldChange();
    // The clicked widget is replaced; retain keyboard focus on its replacement.
    const section = this.sections.find(s => s.key === key);
    if (section) (this.view.nodeDOM(section.from) as HTMLElement | null)?.querySelector<HTMLButtonElement>('.section-toggle')?.focus({ preventScroll: true });
  }
  private parkSelection(): void {
    const { doc, selection } = this.view.state;
    const owner = this.sections.find(s => this.collapsed.has(s.key) && (insideSection(s, selection.from, doc.content.size) || insideSection(s, selection.to, doc.content.size)));
    if (owner) this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(doc, owner.body - 1)).setMeta('addToHistory', false));
  }
  get selectedChange(): string | undefined {
    const { from, to } = this.view.state.selection;
    return this.plan.find(change => change.blocks.some(block => from < block.to && to >= block.from))?.hunk.id;
  }
  get composing(): boolean { return this.compositionLock || this.view.composing; }
  load(source: string, rules = this.numbering): void {
    this.closeColors();
    this.textCache = undefined;
    this.model = parseRichMarkdown(source);
    this.plan = []; this.expanded.clear();
    this.view.updateState(EditorState.create({ doc: restoreNumbering(this.model.doc, rules), plugins: this.view.state.plugins }));
    this.decorate(); this.updateToolbar();
  }
  review(source: string, hunks: Hunk[], html: string): void {
    this.plan = inlineChanges(source, this.view.state.doc, hunks);
    const rendered = new DOMParser().parseFromString(html, 'text/html');
    this.comparisons = new Map([...rendered.querySelectorAll<HTMLElement>('[data-hunk]')].map(block => [block.dataset.hunk!, block.querySelector('.change-content')?.innerHTML ?? '']));
    this.images = new Map();
    // Match source paths using rendered safe image order, including duplicate alt labels.
    const sourceImages: { src: string; alt: string }[] = [];
    this.view.state.doc.descendants(node => { if (node.type === schema.nodes.image) sourceImages.push(node.attrs as { src: string; alt: string }); });
    const approved = [...rendered.querySelectorAll<HTMLImageElement>('.markdown-image')];
    for (const item of sourceImages) {
      const match = approved.find(img => img.getAttribute('data-source') === item.src);
      if (match) this.images.set(item.src, match.getAttribute('src')!);
    }
    this.diagramBefore = new Map([...rendered.querySelectorAll<HTMLElement>('.diagram-review')].map(block => [block.dataset.after ?? '', block.dataset.before ?? '']));
    this.decorate();
    this.view.dom.dispatchEvent(new Event('media-refresh'));
  }
  filter(value: boolean): void { this.filtered = value; this.expanded.clear(); this.decorate(); }
  private decorate(): void {
    if (this.composing) { this.decorationPending = true; return; }
    this.decorationPending = false;
    const doc = this.view.state.doc, sections = this.sections;
    const hidden = (pos: number) => sections.some(s => this.collapsed.has(s.key) && insideSection(s, pos, doc.content.size));
    const review = reviewDecorations(doc, this.plan, this.filtered, this.expanded, pos => { this.expanded.add(pos); this.decorate(); }, hidden, new Set(sections.map(s => s.from)), this.comparisons);
    const decorations = DecorationSet.create(doc, [...review.find(), ...sectionDecorations(doc, sections, this.collapsed, this.plan, key => this.toggleFold(key))]);
    this.view.dispatch(this.view.state.tr.setMeta(inlineReviewKey, decorations).setMeta('addToHistory', false));
  }
  get outline() {
    return headingSections(this.view.state.doc, true).map(section => ({ ...section, count: this.plan.filter(change => change.position >= section.from && change.position < section.end).length }));
  }
  get documentIdentity() { return this.view.state.doc; }
  find(query: string, sensitive: boolean, onlyChanges: boolean) {
    return findText(this.view.state.doc, query, sensitive, onlyChanges ? this.plan.flatMap(change => change.blocks) : undefined);
  }
  highlightSearch(matches: Match[], active: number): void {
    if (this.composing) return;
    const decorations = DecorationSet.create(this.view.state.doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === active ? 'search-hit search-current' : 'search-hit' })));
    this.view.dispatch(this.view.state.tr.setMeta(searchKey, decorations).setMeta('addToHistory', false));
  }
  revealPosition(position: number, selectTo?: number): void {
    if (this.composing) return;
    const doc = this.view.state.doc;
    for (const section of this.sections) if (insideSection(section, position, doc.content.size) || section.from === position) this.collapsed.delete(section.key);
    doc.forEach((node, pos) => { if (position >= pos && position <= pos + node.nodeSize) this.expanded.add(pos); });
    this.decorate();
    if (selectTo !== undefined) this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(doc, position, selectTo)).setMeta('addToHistory', false).scrollIntoView());
    else (this.view.nodeDOM(position) as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    this.onFoldChange();
  }
  replaceMatches(matches: Match[], replacement: string): boolean {
    if (!this.enabled || this.composing || !matches.length || replacement.length > 10000 || replacement.includes('\n') || replacement.includes('\r')) return false;
    let tr = closeHistory(this.view.state.tr);
    for (const match of [...matches].sort((a, b) => b.from - a.from)) {
      if (replacement) tr.replaceWith(match.from, match.to, schema.text(replacement, this.view.state.doc.resolve(match.from).marks()));
      else tr.delete(match.from, match.to);
    }
    const candidate = serializeRichMarkdown(this.model, tr.doc);
    if (new TextEncoder().encode(candidate).length > 512 * 1024) throw new Error('置換後の文書が512KBを超えます。');
    this.view.dispatch(tr); this.view.dispatch(closeHistory(this.view.state.tr)); return true;
  }
  bookmark(): { key: string; offset: number } | undefined {
    const headings = this.outline.map(s => ({ key: s.key, element: this.view.nodeDOM(s.from) as HTMLElement | null })).filter(s => s.element && s.element.getClientRects().length);
    const heading = headings.filter(s => s.element!.getBoundingClientRect().top <= 180).at(-1) ?? headings[0];
    return heading ? { key: heading.key, offset: heading.element!.getBoundingClientRect().top } : undefined;
  }
  restoreBookmark(anchor: { key: string; offset: number }): boolean {
    const section = this.outline.find(s => s.key === anchor.key), element = section && this.view.nodeDOM(section.from) as HTMLElement | undefined;
    if (!element || !element.getClientRects().length) return false;
    window.scrollBy(0, element.getBoundingClientRect().top - anchor.offset); return true;
  }
  closeColors(): void { this.colors?.close(); }
  enable(value: boolean): void { if (this.enabled !== value) { this.enabled = value; this.view.setProps({ editable: () => this.enabled }); this.view.dom.dispatchEvent(new Event('table-tools-update')); } this.colors?.update(); }
  command(name: string): void {
    if (!this.enabled || this.composing) return;
    const id = this.view.state.selection.$from.parent.attrs.sourceId;
    const commands: Record<string, Command> = {
      bold: toggleMark(schema.marks.strong), italic: toggleMark(schema.marks.em), inlineCode: toggleMark(schema.marks.code),
      bullet: wrapInList(schema.nodes.bullet_list, { tight: true }), number: wrapInList(schema.nodes.ordered_list, { tight: true }),
      paragraph: setBlockType(schema.nodes.paragraph, { sourceId: id }),
      h1: setBlockType(schema.nodes.heading, { level: 1, sourceId: id }),
      h2: setBlockType(schema.nodes.heading, { level: 2, sourceId: id }),
      h3: setBlockType(schema.nodes.heading, { level: 3, sourceId: id }),
      h4: setBlockType(schema.nodes.heading, { level: 4, sourceId: id }), h5: setBlockType(schema.nodes.heading, { level: 5, sourceId: id }), h6: setBlockType(schema.nodes.heading, { level: 6, sourceId: id }),
      strike: toggleMark(schema.marks.strike), quote: chainCommands(wrapIn(schema.nodes.blockquote), lift),
      code: setBlockType(schema.nodes.code_block, { sourceId: id }),
      addRow: quickTableCommand('addRow'), addRowBefore: quickTableCommand('addRowBefore'), addColumn: quickTableCommand('addColumn'), addColumnBefore: quickTableCommand('addColumnBefore'),
      alignLeft: alignTableColumns('left'), alignCenter: alignTableColumns('center'), alignRight: alignTableColumns('right'), deleteRow: quickTableCommand('deleteRow'), deleteColumn: quickTableCommand('deleteColumn'), deleteTable,
      undo, redo,
    };
    if (name === 'table') {
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(makeTable()).scrollIntoView());
    } else if (name === 'task') {
      let found = false;
      const markTask = () => {
        const { $from } = this.view.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === schema.nodes.list_item) {
          this.view.dispatch(this.view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...$from.node(depth).attrs, checked: false })); found = true; break;
        }
      };
      markTask(); if (!found) { wrapInList(schema.nodes.bullet_list, { tight: true })(this.view.state, this.view.dispatch); markTask(); }
    } else if (name === 'rule') {
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView());
    } else if (name === 'mermaid') {
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(schema.nodes.code_block.create({ params: 'mermaid' }, schema.text('flowchart LR\nA[開始] --> B[完了]'))).scrollIntoView());
    } else if (name === 'image') {
      document.querySelector<HTMLFormElement>('#image-form')!.hidden = false;
      const selected = this.view.state.selection instanceof NodeSelection ? this.view.state.selection.node : undefined;
      document.querySelector<HTMLInputElement>('#image-src')!.value = selected?.type === schema.nodes.image ? selected.attrs.src : '';
      document.querySelector<HTMLInputElement>('#image-alt')!.value = selected?.type === schema.nodes.image ? selected.attrs.alt : '';
      document.querySelector<HTMLInputElement>('#image-src')!.focus();
    } else if (name === 'link') {
      const form = document.querySelector<HTMLFormElement>('#link-form')!;
      form.hidden = false;
      const field = document.querySelector<HTMLInputElement>('#link-url')!;
      field.value = this.view.state.selection.$from.marks().find(m => m.type === schema.marks.link)?.attrs.href ?? '';
      field.focus();
    } else commands[name]?.(this.view.state, this.view.dispatch, this.view);
    if (!['link', 'image'].includes(name)) this.view.focus();
    this.updateToolbar();
  }
  image(src: string, alt: string): boolean {
    if (!this.enabled || this.composing || !src || /[\r\n\0]/.test(src) || /^(?:javascript|command|data):/i.test(src)) return false;
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(schema.nodes.image.create({ src, alt })).scrollIntoView()); this.view.focus(); return true;
  }
  link(url: string): boolean {
    if (!this.enabled || this.composing) return false;
    if (url && !/^(https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(url)) return false;
    let { from, to, empty } = this.view.state.selection;
    const existing = this.view.state.selection.$from.marks().find(mark => mark.type === schema.marks.link);
    if (empty && existing) {
      const parent = this.view.state.selection.$from.parent, start = this.view.state.selection.$from.start();
      let rangeStart = -1, rangeEnd = -1;
      parent.forEach((node, offset) => {
        if (existing.isInSet(node.marks)) {
          if (rangeEnd !== start + offset) rangeStart = start + offset;
          rangeEnd = start + offset + node.nodeSize;
          if (rangeStart <= from && rangeEnd >= to) { from = rangeStart; to = rangeEnd; empty = false; }
        }
      });
    }
    const transaction = this.view.state.tr;
    if (!url) transaction.removeMark(from, to, schema.marks.link);
    else if (empty) {
      transaction.insertText(url, from).addMark(from, from + url.length, schema.marks.link.create({ href: url }));
      transaction.setSelection(TextSelection.create(transaction.doc, from + url.length));
    } else transaction.addMark(from, to, schema.marks.link.create({ href: url }));
    this.view.dispatch(transaction); this.view.focus(); return true;
  }
  private updateToolbar(): void {
    this.colors?.update();
    this.view.dom.dispatchEvent(new Event('table-tools-update'));
    const { state } = this.view;
    for (const [name, mark] of [['bold', 'strong'], ['italic', 'em'], ['inlineCode', 'code']]) {
      const active = state.selection.empty ? schema.marks[mark].isInSet(state.storedMarks || state.selection.$from.marks()) : state.doc.rangeHasMark(state.selection.from, state.selection.to, schema.marks[mark]);
      document.querySelector(`[data-format="${name}"]`)?.setAttribute('aria-pressed', String(!!active));
    }
    this.view.dom.dispatchEvent(new Event('editor-selection-change', { bubbles: true }));
    const parent = state.selection.$from.parent;
    const select = document.querySelector<HTMLSelectElement>('#block-type');
    if (select) select.value = parent.type === schema.nodes.heading ? `h${parent.attrs.level}` : parent.type === schema.nodes.code_block ? 'code' : 'paragraph';
  }
}
