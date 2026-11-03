import { foldButton, headingKeys } from './section-folding';

/** Fold rendered comparison blocks without reparenting review actions, tables or diagrams. */
export function detailFolding(root: HTMLElement, initial: string[], onChange: (keys: string[]) => void) {
  const headingSelector = 'h1,h2,h3,h4,h5,h6';
  const headings = [...root.querySelectorAll<HTMLElement>(headingSelector)].filter(h => !h.closest('.before-block, .removed-block, blockquote, li'));
  const headingSet = new Set(headings), keyFor = headingKeys();
  const tokens: HTMLElement[] = [], wrappers: HTMLElement[] = [];
  const visit = (element: HTMLElement) => {
    if (headingSet.has(element) || !headings.some(h => element.contains(h))) { tokens.push(element); return; }
    wrappers.push(element); [...element.children].forEach(child => visit(child as HTMLElement));
  };
  [...root.children].forEach(child => visit(child as HTMLElement));
  const sections = headings.map(heading => {
    const clone = heading.cloneNode(true) as HTMLElement; clone.querySelectorAll('del').forEach(el => el.remove());
    const title = clone.textContent ?? '', level = Number(heading.tagName.slice(1));
    return { heading, title, level, key: keyFor(level, title), start: tokens.indexOf(heading), end: tokens.length };
  });
  sections.forEach((section, i) => { section.end = sections.slice(i + 1).find(s => s.level <= section.level)?.start ?? tokens.length; });
  const foldable = sections.filter(s => s.end > s.start + 1);
  let folded = new Set(initial);
  const contains = (s: typeof sections[number], index: number) => index > s.start && index < s.end;
  function render() {
    root.querySelectorAll('.section-hidden').forEach(el => el.classList.remove('section-hidden'));
    for (const s of sections) s.heading.querySelector('.section-toggle')?.remove();
    const closed = foldable.filter(s => folded.has(s.key));
    tokens.forEach((element, index) => { if (closed.some(s => contains(s, index))) element.classList.add('section-hidden'); });
    for (const s of foldable) {
      const ids = new Set<string>();
      tokens.slice(s.start + 1, s.end).forEach(element => {
        const owner = element.closest<HTMLElement>('[data-hunk]'); if (owner) ids.add(owner.dataset.hunk!);
        element.querySelectorAll<HTMLElement>('[data-hunk]').forEach(e => ids.add(e.dataset.hunk!));
      });
      const button = foldButton(s.title, folded.has(s.key), ids.size, () => {
        if (folded.has(s.key)) folded.delete(s.key); else folded.add(s.key);
        render(); onChange([...folded]); s.heading.querySelector<HTMLButtonElement>('.section-toggle')?.focus({ preventScroll: true });
      });
      s.heading.prepend(button);
    }
    for (const wrapper of [...wrappers].reverse()) {
      const children = [...wrapper.children].filter(el => !(wrapper.matches('.unchanged') && el.tagName === 'SUMMARY'));
      if (children.length && children.every(el => el.classList.contains('section-hidden'))) wrapper.classList.add('section-hidden');
    }
  }
  render();
  return {
    count: foldable.length,
    foldAll(collapse: boolean) { folded = new Set(collapse ? foldable.map(s => s.key) : []); render(); onChange([...folded]); },
    reveal(element: HTMLElement) {
      const indices = tokens.flatMap((token, index) => token === element || element.contains(token) || token.contains(element) ? [index] : []);
      for (const s of sections) if (indices.some(index => contains(s, index))) folded.delete(s.key);
      render(); onChange([...folded]);
      for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    },
  };
}
