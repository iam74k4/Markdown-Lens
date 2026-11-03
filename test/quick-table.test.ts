import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { history, undo, closeHistory } from 'prosemirror-history';
import { TableMap } from 'prosemirror-tables';
import { parseRichMarkdown, serializeRichMarkdown } from '../src/rich-markdown';
import { autoNumbering, numberingRules, restoreNumbering } from '../src/table-numbering';
import { quickTableCommand, QuickTableAction } from '../src/rich-table';
const source = '# Keep\r\n\r\n| Name | Value | Note |\r\n| :--- | ---: | :---: |\r\n| Alpha | 10 | **one** |\r\n| Beta | 20 | [two](/two) |\r\n| Gamma | 30 | three |\r\n\r\nUnchanged.\r\n';
function setup(row = 1, col = 0, text = source) {
 const model = parseRichMarkdown(text); let pos = 0;
 model.doc.forEach((node, p) => { if (node.type.name === 'table') pos = p; });
 const table = model.doc.nodeAt(pos)!, map = TableMap.get(table);
 return { model, pos, state: EditorState.create({doc: model.doc, selection: TextSelection.near(model.doc.resolve(pos + 2 + map.map[row * map.width + col])), plugins: [history(), autoNumbering]}) };
}
function run(state: EditorState, action: QuickTableAction, pos?: number) {
 let next = state; assert.equal(quickTableCommand(action, pos)(state, tr => { next = state.applyTransaction(closeHistory(tr)).state; }), true); return next;
}
test('row movement preserves header, rich cells, CRLF, adjacent blocks, and follows the moved row', () => {
 const {model,pos,state} = setup(2,2); const next=run(state,'rowUp');
 const table=next.doc.nodeAt(pos)!;
 assert.equal(table.child(0).textContent,'NameValueNote'); assert.equal(table.child(1).textContent,'Beta20two');
 assert.equal(next.selection.$from.parent.textContent,'two');
 const text=serializeRichMarkdown(model,next.doc); assert.ok(text.indexOf('Beta')<text.indexOf('Alpha'));
 assert.match(text,/\[two\]\(\/two\)/); assert.ok(text.startsWith('# Keep\r\n\r\n')); assert.ok(text.endsWith('Unchanged.\r\n'));
 assert.equal(serializeRichMarkdown(model,run(next,'rowDown').doc),source);
});
test('column movement carries header, alignment and data across every row', () => {
 const {model,pos,state}=setup(2,1); const next=run(state,'columnLeft'),table=next.doc.nodeAt(pos)!;
 assert.equal(table.firstChild!.textContent,'ValueNameNote');
 table.forEach(row=>assert.equal(row.child(0).attrs.align,'right'));
 assert.equal(next.selection.$from.parent.textContent,'20');
 assert.match(serializeRichMarkdown(model,next.doc),/\| ---: \| :--- \| :---: \|/);
 assert.equal(serializeRichMarkdown(model,run(next,'columnRight').doc),source);
});
test('header and edge movements are disabled without any mutation', () => {
 for (const [row,col,action] of [[0,0,'rowDown'],[0,0,'rowUp'],[1,0,'rowUp'],[3,0,'rowDown'],[1,0,'columnLeft'],[1,2,'columnRight']] as const) {
  const {state}=setup(row,col); let dispatched=false;
  assert.equal(quickTableCommand(action)(state,()=>{dispatched=true;}),false);assert.equal(dispatched,false);
 }
});
test('row insertion focuses the new blank cell and inherits column alignment', () => {
 const {state,pos}=setup(1,1); const next=run(state,'addRow'),table=next.doc.nodeAt(pos)!;
 assert.equal(table.childCount,5);assert.equal(table.child(2).textContent,'');assert.equal(next.selection.$from.parent.textContent,'');
 assert.equal(table.child(2).child(1).attrs.align,'right');assert.equal(table.child(3).textContent,'Beta20two');
});
test('column insertion focuses its new cell and keeps original columns intact', () => {
 const {state,pos}=setup(2,0);const next=run(state,'addColumn'),table=next.doc.nodeAt(pos)!;
 assert.equal(TableMap.get(table).width,4);assert.equal(table.child(2).child(1).textContent,'');
 assert.equal(table.child(2).child(2).textContent,'20');assert.equal(next.selection.$from.parent.textContent,'');
 assert.equal(table.child(0).child(1).type.name,'table_header');
});
test('append targets the clicked table even when the caret is outside it', () => {
 const {state,pos}=setup(); const outside=state.apply(state.tr.setSelection(TextSelection.create(state.doc,1)));
 assert.equal(quickTableCommand('rowDown',pos)(outside),false);
 const next=run(outside,'appendRow',pos);assert.equal(next.doc.nodeAt(pos)!.childCount,5);
 const col=run(outside,'appendColumn',pos);assert.equal(TableMap.get(col.doc.nodeAt(pos)!).width,4);
});
test('header-only tables keep valid header and body cell roles when expanded', () => {
 const {state,pos,model}=setup(0,0,'| Header |\n| ---: |\n');
 const col=run(state,'appendColumn',pos);assert.equal(col.doc.nodeAt(pos)!.firstChild!.child(1).type.name,'table_header');
 const row=run(state,'appendRow',pos);assert.equal(row.doc.nodeAt(pos)!.child(1).firstChild!.type.name,'table_cell');
 assert.equal(row.doc.nodeAt(pos)!.child(1).firstChild!.attrs.align,'right');
 assert.equal(parseRichMarkdown(serializeRichMarkdown(model,col.doc)).doc.firstChild!.firstChild!.childCount,2);
});
test('one Undo reverses one quick action without swallowing the prior action', () => {
 const {state,pos}=setup(); const inserted=run(state,'appendRow',pos), moved=run(inserted,'rowUp',pos);
 let undone=moved;assert.equal(undo(moved,tr=>{undone=moved.apply(tr);}),true);assert.ok(undone.doc.eq(inserted.doc));
 let original=undone;undo(undone,tr=>{original=undone.apply(tr);});assert.ok(original.doc.eq(state.doc));
});

test('deleting a row keeps header and neighbors, focuses a surviving cell, and can be undone', () => {
 const {state,pos}=setup(2,1);const next=run(state,'deleteRow'),table=next.doc.nodeAt(pos)!;
 assert.equal(table.childCount,3);assert.equal(table.firstChild!.textContent,'NameValueNote');
 assert.equal(table.child(1).textContent,'Alpha10one');assert.equal(table.child(2).textContent,'Gamma30three');
 assert.equal(next.selection.$from.parent.textContent,'30');
 let restored=next;undo(next,tr=>{restored=next.apply(tr);});assert.ok(restored.doc.eq(state.doc));
 assert.equal(quickTableCommand('deleteRow')(setup(0,0).state),false);
});
test('deleting a column removes its header and values together, with native Undo', () => {
 const {state,pos}=setup(2,1);const next=run(state,'deleteColumn'),table=next.doc.nodeAt(pos)!;
 assert.equal(TableMap.get(table).width,2);assert.equal(table.firstChild!.textContent,'NameNote');
 assert.equal(table.child(2).textContent,'Betatwo');assert.equal(next.selection.$from.parent.textContent,'two');
 let restored=next;undo(next,tr=>{restored=next.apply(tr);});assert.ok(restored.doc.eq(state.doc));
});
test('the last column cannot be deleted accidentally through the quick action', () => {
 const {state}=setup(1,0,'# Title\n\n| Header |\n| --- |\n| value |\n\nKeep.\n');
 let called=false;assert.equal(quickTableCommand('deleteColumn')(state,()=>{called=true;}),false);assert.equal(called,false);
});

test('numbering is opt-in, skips the header, and renumbers after deleting a middle row', () => {
 const {state,model,pos}=setup(1,0,'| No | Name |\n| --- | --- |\n| 7 | A |\n| 9 | B |\n| 20 | C |\n');
 const enabled=run(state,'numberColumn');let table=enabled.doc.nodeAt(pos)!;
 assert.equal(table.child(0).textContent,'NoName');assert.deepEqual([1,2,3].map(r=>table.child(r).firstChild!.textContent),['1','2','3']);
 const map=TableMap.get(table);const selected=enabled.apply(enabled.tr.setSelection(TextSelection.near(enabled.doc.resolve(pos+2+map.map[map.width*2]))));
 const deleted=run(selected,'deleteRow');table=deleted.doc.nodeAt(pos)!;
 assert.equal(table.child(1).textContent,'1A');assert.equal(table.child(2).textContent,'2C');
 assert.ok(!serializeRichMarkdown(model,deleted.doc).includes('numberColumn'));
 let restored=deleted;undo(deleted,tr=>{restored=deleted.applyTransaction(tr).state;});assert.ok(restored.doc.eq(selected.doc));
});
test('numbering follows row and column moves and insertion, not an unrelated ID column', () => {
 const {state,pos}=setup(1,1,'| ID | No | Name |\n| --- | --- | --- |\n| 101 | 1 | A |\n| 205 | 2 | B |\n| 999 | 3 | C |\n');
 const enabled=run(state,'numberColumn');const moved=run(enabled,'rowDown');let table=moved.doc.nodeAt(pos)!;
 assert.equal(table.child(1).textContent,'2051B');assert.equal(table.child(2).textContent,'1012A');
 const movedCol=run(moved,'columnRight');table=movedCol.doc.nodeAt(pos)!;assert.equal(table.attrs.numberColumn,2);
 const inserted=run(movedCol,'addRow');table=inserted.doc.nodeAt(pos)!;
 assert.deepEqual([1,2,3,4].map(r=>table.child(r).child(2).textContent),['1','2','3','4']);
 assert.equal(table.child(1).firstChild!.textContent,'205');assert.equal(table.child(2).firstChild!.textContent,'101');
});
test('numbering shifts with inserted/deleted columns, and turns off if its column is deleted', () => {
 const {state,pos}=setup(1,1,'| ID | No | Name |\n| --- | --- | --- |\n| 101 | 1 | A |\n');
 const enabled=run(state,'numberColumn');const table=enabled.doc.nodeAt(pos)!,map=TableMap.get(table);
 const left=enabled.apply(enabled.tr.setSelection(TextSelection.near(enabled.doc.resolve(pos+2+map.map[map.width]))));
 const inserted=run(left,'addColumn');assert.equal(inserted.doc.nodeAt(pos)!.attrs.numberColumn,2);
 const deleted=run(inserted,'deleteColumn');assert.equal(deleted.doc.nodeAt(pos)!.attrs.numberColumn,1);
 const removedNumbers=run(deleted,'deleteColumn');assert.equal(removedNumbers.doc.nodeAt(pos)!.attrs.numberColumn,null);
 assert.equal(removedNumbers.doc.nodeAt(pos)!.child(1).textContent,'101A');
});
test('turning numbering off preserves values and leaves unrelated formatting untouched', () => {
 const {state,model}=setup(1,0,'| No | Name |\n| :--- | --- |\n| 1 | A |\n| 2 | B |\n');
 const enabled=run(state,'numberColumn');assert.equal(serializeRichMarkdown(model,enabled.doc),model.source);
 const disabled=run(enabled,'numberColumn');assert.ok(disabled.doc.eq(state.doc));
 const deleted=run(disabled,'deleteRow');assert.equal(deleted.doc.firstChild!.child(1).textContent,'2B');
});
test('numbering settings restore only an unambiguous matching table', () => {
 const {state}=setup(1,0,'| No | Name |\n| --- | --- |\n| 1 | A |\n');const enabled=run(state,'numberColumn'),rules=numberingRules(enabled.doc);
 assert.equal(restoreNumbering(state.doc,rules).firstChild!.attrs.numberColumn,0);
 const duplicated=parseRichMarkdown('| No | Name |\n| --- | --- |\n| 1 | A |\n\nText\n\n| No | Name |\n| --- | --- |\n| 1 | B |\n');
 assert.equal(restoreNumbering(duplicated.doc,rules).firstChild!.attrs.numberColumn,null);
});

test('new rows with automatic numbering focus a data cell ready for typing', () => {
 const {state,pos}=setup(1,0,'| No | Name |\n| --- | --- |\n| 1 | Alpha |\n');
 const enabled=run(state,'numberColumn');const added=run(enabled,'addRow');
 assert.equal(added.doc.nodeAt(pos)!.child(2).firstChild!.textContent,'2');
 assert.equal(added.selection.$from.parent.textContent,'');
 const typed=added.applyTransaction(added.tr.insertText('Beta')).state;
 assert.equal(typed.doc.nodeAt(pos)!.child(2).textContent,'2Beta');
});
