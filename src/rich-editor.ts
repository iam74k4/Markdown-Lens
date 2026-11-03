import { EditorState, Command, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { TableView, tableEditing, addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable, goToNextCell } from 'prosemirror-tables';
import { gapCursor } from 'prosemirror-gapcursor';
import { parseRichMarkdown, serializeRichMarkdown, richSchema as schema, makeTable, RichDocument } from './rich-markdown';

export class RichEditor {
  readonly view: EditorView;
  private model: RichDocument;
  private enabled = true;
  constructor(element: HTMLElement, source: string, private onChange: () => void) {
    this.model = parseRichMarkdown(source);
    const rules = inputRules({ rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, m => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, m => ({ order: +m[1] })),
      wrappingInputRule(/^>\s$/, schema.nodes.blockquote),
    ] });
    const plugins = [history(), rules, keymap({
      'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
      'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em),
      'Mod-`': toggleMark(schema.marks.code),
      'Enter': splitListItem(schema.nodes.list_item),
      'Shift-Enter': (state, dispatch) => { if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView()); return true; },
      'Mod-Enter': exitCode,
      'Tab': chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
      'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
    }), keymap(baseKeymap), gapCursor(), tableEditing()];
    this.view = new EditorView(element, {
      state: EditorState.create({ doc: this.model.doc, schema, plugins }),
      attributes: { 'aria-label': 'Markdownを直接編集', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      editable: () => this.enabled,
      nodeViews: { table: node => new TableView(node, 120) },
      dispatchTransaction: transaction => {
        this.view.updateState(this.view.state.apply(transaction));
        if (transaction.docChanged) this.onChange();
        this.updateToolbar();
      },
      handleClickOn: (_view, _pos, node) => node.type === schema.nodes.image,
      handleDOMEvents: { click: (_view, event) => {
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
    this.view.updateState(EditorState.create({ doc: this.model.doc, plugins: this.view.state.plugins }));
    this.updateToolbar();
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
      code: setBlockType(schema.nodes.code_block, { sourceId: id }),
      addRow: addRowAfter, addColumn: addColumnAfter, deleteRow, deleteColumn, deleteTable,
      undo, redo,
    };
    if (name === 'table') {
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(makeTable()).scrollIntoView());
    } else if (name === 'link') {
      const form = document.querySelector<HTMLFormElement>('#link-form')!;
      form.hidden = false;
      const field = document.querySelector<HTMLInputElement>('#link-url')!;
      field.value = this.view.state.selection.$from.marks().find(m => m.type === schema.marks.link)?.attrs.href ?? '';
      field.focus();
    } else commands[name]?.(this.view.state, this.view.dispatch, this.view);
    if (name !== 'link') this.view.focus();
    this.updateToolbar();
  }
  link(url: string): boolean {
    if (!this.enabled || this.composing) return false;
    if (url && !/^(https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(url)) return false;
    const { from, to, empty } = this.view.state.selection;
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
