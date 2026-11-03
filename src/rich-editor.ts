import { EditorState, Command, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { TableView, tableEditing, addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, goToNextCell } from 'prosemirror-tables';
import { alignTableColumns } from './rich-table';
import { inlineReviewPlugin, inlineReviewKey, inlineChanges, reviewDecorations, InlineChange } from './inline-review';
import type { Hunk } from './core';
import { mediaNodeViews } from './rich-media';
import { gapCursor } from 'prosemirror-gapcursor';
import { parseRichMarkdown, serializeRichMarkdown, richSchema as schema, makeTable, RichDocument } from './rich-markdown';

export class RichEditor {
  readonly view: EditorView;
  private model: RichDocument;
  private enabled = true;
  private plan: InlineChange[] = [];
  private expanded = new Set<number>();
  private filtered = false;
  private images = new Map<string, string>();
  private diagramBefore = new Map<string, string>();
  constructor(element: HTMLElement, source: string, private onChange: () => void) {
    this.model = parseRichMarkdown(source);
    const rules = inputRules({ rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, m => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, m => ({ order: +m[1] })),
      wrappingInputRule(/^>\s$/, schema.nodes.blockquote),
    ] });
    const plugins = [inlineReviewPlugin, history(), rules, keymap({
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
      nodeViews: { table: node => new TableView(node, 120), ...mediaNodeViews(() => this.images, () => this.diagramBefore) },
      dispatchTransaction: transaction => {
        this.view.updateState(this.view.state.apply(transaction));
        if (transaction.docChanged) { this.plan = []; this.expanded.clear(); this.onChange(); }
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
    this.updateToolbar();
  }
  get text(): string { return serializeRichMarkdown(this.model, this.view.state.doc); }
  get composing(): boolean { return this.view.composing; }
  load(source: string): void {
    this.model = parseRichMarkdown(source);
    this.plan = []; this.expanded.clear();
    this.view.updateState(EditorState.create({ doc: this.model.doc, plugins: this.view.state.plugins }));
    this.updateToolbar();
  }
  review(source: string, hunks: Hunk[], html: string): void {
    this.plan = inlineChanges(source, this.view.state.doc, hunks);
    const rendered = new DOMParser().parseFromString(html, 'text/html');
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
    const decorations = reviewDecorations(this.view.state.doc, this.plan, this.filtered, this.expanded, pos => { this.expanded.add(pos); this.decorate(); });
    this.view.dispatch(this.view.state.tr.setMeta(inlineReviewKey, decorations).setMeta('addToHistory', false));
  }
  enable(value: boolean): void { if (this.enabled !== value) { this.enabled = value; this.view.setProps({ editable: () => this.enabled }); } }
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
      addRow: addRowAfter, addRowBefore, addColumn: addColumnAfter, addColumnBefore,
      alignLeft: alignTableColumns('left'), alignCenter: alignTableColumns('center'), alignRight: alignTableColumns('right'), deleteRow, deleteColumn, deleteTable,
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
    const { state } = this.view;
    for (const [name, mark] of [['bold', 'strong'], ['italic', 'em'], ['inlineCode', 'code']]) {
      const active = state.selection.empty ? schema.marks[mark].isInSet(state.storedMarks || state.selection.$from.marks()) : state.doc.rangeHasMark(state.selection.from, state.selection.to, schema.marks[mark]);
      document.querySelector(`[data-format="${name}"]`)?.setAttribute('aria-pressed', String(!!active));
    }
    const parent = state.selection.$from.parent;
    const select = document.querySelector<HTMLSelectElement>('#block-type');
    if (select) select.value = parent.type === schema.nodes.heading ? `h${parent.attrs.level}` : parent.type === schema.nodes.code_block ? 'code' : 'paragraph';
  }
}
