import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedCells, applyCell } from '../src/cell-review';
import { buildReview } from '../src/core';
import { parseRichMarkdown } from '../src/rich-markdown';
import { findText } from '../src/search';
import { BaselineStore } from '../src/store';
import { reviewView } from '../src/review-view';
import { decodeImage, savePastedImage } from '../src/pasted-image';
const table = '| No | 金額 | 名前 |\r\n| --- | ---: | --- |\r\n| 1 | 10 | A\\|B |\r\n| 2 | 20 | **C** |\r\n';
test('cell review changes only exact cell bytes, including CRLF and escaped pipes', () => {
  const after = table.replace('10', '100').replace('20', '200');
  const cells = changedCells(table, after)!; assert.equal(cells.length, 2);
  const cell = cells[0]; assert.equal(cell.row,1); assert.equal(cell.column,1);
  assert.equal(applyCell(after, cell.after.start, cell.after.end, cell.after.text, cell.before.text), table.replace('20','200'));
  assert.equal(applyCell(table, cell.before.start, cell.before.end, cell.before.text, cell.after.text),table.replace('10','100'));
  assert.throws(() => applyCell('stale',cell.after.start,cell.after.end,cell.after.text,cell.before.text));
});
test('cell review rejects changed structure, irregular tables and alignment edits', () => {
  assert.equal(changedCells(table,table+'| 3 | 30 | D |\r\n'),undefined);
  assert.equal(changedCells(table,table.replace('---:',':---')),undefined);
  assert.equal(changedCells(table,table.replace('| 1 | 10 | A\\|B |','| 1 | 10 |')),undefined);
  assert.equal(changedCells('paragraph','paragraph2'),undefined);
});
test('cell review includes headers, empty cells and formatting-only changes', () => {
  const before = '| Name | Value |\n| --- | --- |\n| A |  |\n';
  const after = before.replace('Name','Label').replace('| A |  |','| **A** | 0 |');
  assert.deepEqual(changedCells(before,after)?.map(c=>[c.row,c.column]),[[0,0],[1,0],[1,1]]);
  const review=buildReview(before,after); assert.equal(review.hunks[0].cells?.length,3); assert.match(review.html,/data-cell-action="reviewCell"/);
});
test('cell source positions are local to their hunk after other changed paragraphs', () => {
  const before='Old\n\n'+table, after='New\n\n'+table.replace('10','100');
  const h=buildReview(before,after).hunks[1], c=h.cells![0];
  assert.equal(applyCell(after,h.start+c.after.start,h.start+c.after.end,c.after.text,c.before.text),'New\n\n'+table);
});
test('literal search crosses inline marks but not table cells or hard breaks', () => {
  const doc=parseRichMarkdown('日**本**語 日本語\n\n| A | B |\n| --- | --- |\n| 日 | 本語 |\n\n日  \n本語\n').doc;
  assert.equal(findText(doc,'日本語',false).matches.length,2);
  assert.equal(findText(doc,'.*',false).matches.length,0);
});
test('search case, changed ranges, emoji and result bounds remain deterministic', () => {
  const doc=parseRichMarkdown('ABC abc 😀😀\n').doc;
  assert.equal(findText(doc,'abc',false).matches.length,2); assert.equal(findText(doc,'abc',true).matches.length,1);
  assert.equal(findText(doc,'abc',false,[{from:1,to:4}]).matches.length,1);
  assert.equal(findText(doc,'😀',true).matches[0].to-findText(doc,'😀',true).matches[0].from,2);
  assert.equal(findText(doc,'😀',true,undefined,1).truncated,true);
});
test('view state survives a new store instance and is isolated by document',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lens-view-')); try {
 const view={mode:'edit' as const,folds:['heading'],changesOnly:true,sourceOpen:false,y:1200,active:2,anchor:{key:'heading',offset:-30}};
 await new BaselineStore(dir).saveView('one',view);
 assert.deepEqual(await new BaselineStore(dir).loadView('one'),view); assert.equal(await new BaselineStore(dir).loadView('two'),undefined);
 assert.equal(reviewView({...view,y:Infinity}),undefined); assert.equal(reviewView({...view,folds:[2]}),undefined);
 } finally {await rm(dir,{recursive:true,force:true});}
});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=';
test('pasted images are binary checked and reject SVG or malformed base64',()=>{
 assert.equal(decodeImage(png).extension,'png'); assert.throws(()=>decodeImage(Buffer.from('<svg/>').toString('base64')));assert.throws(()=>decodeImage('../x'));
 assert.throws(()=>decodeImage('A'.repeat(14*1024*1024)));
});
test('pasted images save exact bytes without overwriting and reject linked destinations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lens-image-')); try {
 const first=await savePastedImage(join(dir,'doc.md'),[dir],png), second=await savePastedImage(join(dir,'doc.md'),[dir],png);
 assert.notEqual(first,second); assert.deepEqual(await readFile(join(dir,first)),Buffer.from(png,'base64'));
 const child=join(dir,'child');await mkdir(child);await symlink(join(dir,'.markdown-lens-images'),join(child,'.markdown-lens-images'));
 await assert.rejects(savePastedImage(join(child,'doc.md'),[dir],png),/シンボリック/);
 await assert.rejects(savePastedImage(join(dir,'doc.md'),[child],png),/ワークスペース/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('legacy comparison mode restores unified Preview without losing folds or source state',()=>{
 const legacy={mode:'diff',folds:['heading'],changesOnly:true,sourceOpen:true,y:350,active:1};
 assert.deepEqual(reviewView(legacy),{...legacy,mode:'edit',anchor:undefined});
});
