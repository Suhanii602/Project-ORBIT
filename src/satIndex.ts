export interface IndexEntry {
  ref: number; // index into the satellite array
  name: string;
  norad: string;
}

export interface SatIndex {
  element: HTMLElement;
  setEntries(entries: IndexEntry[]): void;
  refresh(): void;
}

// A scrolling list that only draws the rows currently visible,
// so 16,000 satellites stay fast.
export function createIndex(opts: {
  height?: string;
  rowHeight?: number;
  onPick: (ref: number) => void;
  isSelected: (ref: number) => boolean;
}): SatIndex {
  const rowH = opts.rowHeight ?? 40;
  let entries: IndexEntry[] = [];

  const root = document.createElement('div');
  root.style.cssText =
    `display:flex;flex-direction:column;gap:6px;height:${opts.height ?? '100%'};min-height:0;`;

  const count = document.createElement('div');
  count.style.cssText = 'font-size:12px;opacity:.75;padding:0 2px;flex:0 0 auto;';

  const scroller = document.createElement('div');
  scroller.style.cssText =
    'position:relative;overflow-y:auto;flex:1;min-height:0;border-radius:8px;';

  const spacer = document.createElement('div');
  spacer.style.cssText = 'position:relative;width:100%;';
  scroller.appendChild(spacer);
  root.append(count, scroller);

  function render() {
    const total = entries.length;
    spacer.style.height = total * rowH + 'px';
    const viewH = scroller.clientHeight || 300;
    const start = Math.max(0, Math.floor(scroller.scrollTop / rowH) - 5);
    const end = Math.min(total, Math.ceil((scroller.scrollTop + viewH) / rowH) + 5);

    spacer.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const e = entries[i];
      const sel = opts.isSelected(e.ref);
      const row = document.createElement('div');
      row.style.cssText =
        `position:absolute;left:0;right:0;top:${i * rowH}px;height:${rowH}px;` +
        'box-sizing:border-box;display:flex;justify-content:space-between;' +
        'align-items:center;gap:8px;padding:0 10px;cursor:pointer;' +
        'border-bottom:1px solid rgba(255,255,255,.06);' +
        (sel ? 'background:rgba(25,195,240,.22);' : '');
      const n = document.createElement('span');
      n.textContent = e.name;
      n.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const id = document.createElement('span');
      id.textContent = e.norad;
      id.style.cssText = 'font-size:12px;opacity:.6;flex:0 0 auto;';
      row.append(n, id);
      row.addEventListener('click', () => opts.onPick(e.ref));
      frag.appendChild(row);
    }
    spacer.appendChild(frag);
    count.textContent = `${total} satellites (A–Z)`;
  }

  scroller.addEventListener('scroll', render);

  return {
    element: root,
    setEntries(e: IndexEntry[]) {
      entries = e;
      scroller.scrollTop = 0;
      render();
    },
    refresh: render,
  };
}