import { ref, watch } from 'vue';

// The designer's file explorer (Forms, Playbooks, Vars files, Inventories) : how wide it opens
// beside the editor, and how far its handle drags it, in percent of the section's width.
export const EXPLORER_WIDTH = { start: 30, min: 15, max: 50 };

/**
 * The explorer's width once its handle moved : the width it started at, less what the handle
 * moved (dragged left, wider), kept between min and max.
 *
 * Args:
 *   startPct (number): the width when the drag started, in percent.
 *   movedPx (number): how far the handle moved, in pixels (to the right is positive).
 *   widthPx (number): the section's width, in pixels.
 *
 * Returns:
 *   number: the new width, in percent.
 */
export function explorerWidthAfterDrag(startPct, movedPx, widthPx) {
  return Math.min(EXPLORER_WIDTH.max, Math.max(EXPLORER_WIDTH.min, startPct - (movedPx / widthPx) * 100));
}

// ─── folded away ──────────────────────────────────────────────────────────────

// remembered in the browser, so every section opens as the last one was left
const FOLDED_KEY = 'af.designer.explorerFolded';
function readFolded() {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The explorer folded away (its > in its header) : the editor takes the width, a < brings it back. */
export const explorerFolded = ref(readFolded());
watch(explorerFolded, (folded) => {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
  } catch {
    // a browser that keeps nothing : folded until the page reloads
  }
});

/**
 * The columns of an editor with its explorer : the editor, the handle and the explorer at its
 * width ; folded, only the explorer's < remains.
 *
 * Args:
 *   pct (number): the explorer's width, in percent.
 *
 * Returns:
 *   string: the grid's template columns.
 */
export function explorerColumns(pct) {
  return explorerFolded.value ? '1fr 0.5rem 2.25rem' : `1fr 1rem ${pct}%`;
}

// ─── the file a section opens on ──────────────────────────────────────────────

/**
 * The first file the explorer lists, as it lists them : at each level the folders first, then
 * the files, each by name - so a section opens on a file rather than on nothing.
 *
 * Args:
 *   paths (string[]): the files' paths ('a/b.yaml').
 *   accept (function): which files may open (optional ; all by default).
 *
 * Returns:
 *   string|null: its path, or null when there is none.
 */
export function firstExplorerFile(paths, accept = () => true) {
  const before = (a, b) => {
    const pa = a.split('/');
    const pb = b.split('/');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const aFolder = i < pa.length - 1;
      const bFolder = i < pb.length - 1;
      // a folder before a file at the same level
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      const byName = pa[i].localeCompare(pb[i]);
      if (byName) return byName;
    }
    return pa.length - pb.length;
  };
  return [...(paths || [])].filter(accept).sort(before)[0] ?? null;
}

/**
 * Opens a section on the first item its explorer lists, the one way every Designer section does
 * it (the files, the forms, the RTE images) : nothing when an item is open already, else the first
 * item by firstExplorerFile, opened through the section's own open - which fills every tab (its
 * YAML, its Visual, its Preview), whichever one shows.
 *
 * Args:
 *   opts (object): {
 *     isOpen (function): whether an item is open already,
 *     paths (string[]): the items' paths as the explorer lists them,
 *     accept (function): which ones may open (optional),
 *     open (function): (path) => opens one (may be async),
 *   }.
 *
 * Returns:
 *   Promise<string|null>: the path opened, or null.
 */
export async function openFirstExplorerItem({ isOpen, paths, accept, open }) {
  if (isOpen()) return null;
  const first = firstExplorerFile(paths, accept);
  if (first) await open(first);
  return first;
}
