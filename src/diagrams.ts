import mermaid from 'mermaid';
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb';
import { flowDifference, FlowGraph, FlowDiff } from './flow-diff';

let sequence = 0;
let queue = Promise.resolve();
const modes = new WeakMap<HTMLElement, string>();
const cache = new Map<string, { id: string; svg: string }>();
function initialize() {
  const dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
    maxTextSize: 30000, maxEdges: 200, suppressErrorRendering: true,
    flowchart: { htmlLabels: false, useMaxWidth: true },
    // Document directives cannot override renderer security or host presentation.
    secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'theme', 'themeCSS', 'flowchart', 'htmlLabels'], htmlLabels: false });
}
function validate(source: string) {
  if (source.length > 30000) throw new Error('図が大きすぎます（30,000文字まで）。');
  if (/%%\s*\{|^\s*---/.test(source)) throw new Error('設定ディレクティブを含む図はソースで確認してください。');
}
async function graph(source: string): Promise<FlowGraph | undefined> {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (!['flowchart', 'flowchart-v2'].includes(diagram.type)) return;
  const db = diagram.db as FlowDB;
  return { direction: db.getDirection() ?? 'TB', nodes: structuredClone([...db.getVertices().values()]), edges: structuredClone([...db.getEdges()]),
    subgraphs: db.getSubGraphs().length, styled: db.getClasses().size > 0 || /\b(?:classDef|class|style|linkStyle|click)\b/.test(source) };
}
async function svg(source: string): Promise<string> {
  const key = document.body.className + '\0' + source;
  const found = cache.get(key); if (found) return found.svg.replaceAll(found.id, `mlDiagram${++sequence}`);
  const id = `mlDiagram${++sequence}`;
  const result = await mermaid.render(id, source);
  // No source-provided links, images, foreign HTML, or callbacks reach the host.
  const doc = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
  doc.querySelectorAll('script, foreignObject, image').forEach(n => n.remove());
  doc.querySelectorAll('a').forEach(n => n.replaceWith(...Array.from(n.childNodes)));
  doc.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
    if (/^on/i.test(a.name) || /^(href|xlink:href)$/i.test(a.name) || (/url\(/i.test(a.value) && !/^url\(["']?#/.test(a.value))) n.removeAttribute(a.name);
  }));
  const cleaned = new XMLSerializer().serializeToString(doc.documentElement);
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(key, { id, svg: cleaned }); return cleaned;
}
function highlight(canvas: HTMLElement, diff: FlowDiff) {
  for (const [alias, status] of Object.entries(diff.nodes)) {
    if (!status) continue;
    canvas.querySelectorAll<SVGGElement>('.node').forEach(n => { if (n.id.includes(`-${alias}-`)) n.classList.add(`diagram-${status}`); });
  }
  const paths = [...canvas.querySelectorAll<SVGPathElement>('path.flowchart-link')];
  paths.forEach((p, i) => { if (diff.edges[i]) p.classList.add(`diagram-${diff.edges[i]}`); });
}
async function draw(block: HTMLElement, mode: string) {
  if (!block.isConnected) return;
  const before = block.dataset.before ?? '', after = block.dataset.after ?? '';
  const canvas = block.querySelector<HTMLElement>('.diagram-canvas')!;
  try {
    validate(before); validate(after); initialize();
    let diff: FlowDiff | undefined;
    if (mode === 'diff' && before && after) {
      const a = await graph(before), b = await graph(after);
      if (a && b) diff = flowDifference(a, b);
    }
    if (!block.isConnected || modes.get(block) !== mode) return;
    if (mode === 'diff' && before && after && !diff) {
      const a = await svg(before), b = await svg(after);
      if (!block.isConnected || modes.get(block) !== mode) return;
      canvas.innerHTML = `<div class="diagram-pair"><div><span class="change-label">変更前</span>${a}</div><div><span class="change-label">変更後</span>${b}</div></div><p class="diagram-note">この図は変更前後で比較します。</p>`;
    } else {
      const rendered = await svg(diff?.source ?? ((mode === 'before' ? before : after) || before));
      if (!block.isConnected || modes.get(block) !== mode) return;
      canvas.innerHTML = rendered;
      if (diff) {
        highlight(canvas, diff);
        const note = document.createElement('p'); note.className = 'diagram-note'; note.textContent = diff.summary;
        canvas.append(note);
      }
    }
    // Preserve Mermaid's label size in narrow editor groups; scroll the diagram itself.
    canvas.querySelectorAll<SVGSVGElement>('svg').forEach(element => {
      const width = element.viewBox.baseVal.width;
      if (width > 0) { element.style.width = `${width}px`; element.style.maxWidth = 'none'; }
    });
    canvas.setAttribute('aria-label', diff ? `Mermaidの差分: ${diff.summary}` : 'Mermaidのプレビュー');
    block.querySelectorAll<HTMLButtonElement>('[data-diagram-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.diagramMode === mode)));
  } catch (error) {
    canvas.textContent = `図を表示できません。Mermaidソースを確認してください。${error instanceof Error && /30,000|設定ディレクティブ/.test(error.message) ? error.message : ''}`;
    block.querySelector<HTMLDetailsElement>('.diagram-source')!.open = true;
  }
}
function schedule(block: HTMLElement, mode: string) {
  modes.set(block, mode);
  queue = queue.then(() => modes.get(block) === mode ? draw(block, mode) : undefined).catch(() => {});
}
export function renderDiagrams(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('.diagram-review').forEach(block => {
    block.querySelectorAll<HTMLButtonElement>('[data-diagram-mode]').forEach(b => b.addEventListener('click', () => schedule(block, b.dataset.diagramMode!)));
    schedule(block, block.dataset.before && block.dataset.after ? 'diff' : 'after');
  });
}

export function refreshDiagramThemes(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('.diagram-review').forEach(block => schedule(block, modes.get(block) ?? 'after'));
}
