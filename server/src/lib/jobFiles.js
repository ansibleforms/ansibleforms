/******************************************************************/
/*                                                                */
/*  The files a job runs from, packed for a socket-mode RTE that  */
/*  has none of its own (RTE_FILES=transfer) : the playbooks      */
/*  folder and the inventories, each a tar.gz named by a hash of  */
/*  its content (the files' paths, sizes, times and modes). The   */
/*  RTE keeps what it got and asks only for a hash it has not     */
/*  seen : an unchanged folder is never sent twice.               */
/*                                                                */
/******************************************************************/
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import * as tar from "tar";
import logger from "./logger.js";
import config from "../../config/app.config.js";

// where the app keeps the bundles it made
const BUNDLE_DIR = path.join(os.tmpdir(), "ansibleforms-bundles");
// what never goes : git's own folder, the job logs and the extravars files of running jobs
const SKIP_DIRS = new Set([".git", ".joblogs", "node_modules", "__pycache__"]);
const SKIP_FILE = /^(he_)?extravars_\d+\.json$/;
// a folder bigger than this is refused : mount it on the RTE instead (RTE_FILES=local) ;
// RTE_FILES_MAX_MB, read by app.config.js (512 when unset or not a positive number) and read
// again on each job, so a new value saved on Settings > Environment applies at once
const maxBytes = () => (config.rteFilesMaxMb > 0 ? config.rteFilesMaxMb : 512) * 1024 * 1024;
// a bundle not used for this long is removed from BUNDLE_DIR (a folder that changes makes a
// new one each time, so they would pile up otherwise) ; looked for at most once an hour
export const BUNDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

// hash -> { file, sha256, size, root } : the bundles made by this process
const made = new Map();
// hash -> Promise : the bundles being packed now, so two jobs of the same folder pack it once
const packing = new Map();
// when BUNDLE_DIR was last pruned (0 : not yet in this process)
let lastPrune = 0;

/**
 * Whether a path lies in a folder (or is the folder itself), both real paths.
 *
 * Args:
 *   full (string): the real path.
 *   root (string): the folder's real path.
 *
 * Returns:
 *   boolean: true when it is inside.
 */
function inside(full, root) {
  return full === root || full.startsWith(root + path.sep);
}

/**
 * The files of a folder, as a sorted manifest : what the hash is made of.
 *
 * A symbolic link is followed only when what it points to is in the folder too : a link to a
 * file or a folder outside it (a committed link to the app's own .env, to /etc) is left out,
 * so the RTE never receives a file of the app's server.
 *
 * Args:
 *   root (string): the folder.
 *
 * Returns:
 *   { entries: string[], lines: string[], bytes: number }: the relative paths, the manifest
 *     lines, the total size.
 */
function manifest(root) {
  const entries = [];
  const lines = [];
  let bytes = 0;
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { entries, lines, bytes };
  }
  // parents : the real folders above this one, so a link back to one of them (a loop) is not
  // walked again ; a link to a sibling folder is, its files sent under both names
  const walk = (dir, rel, parents = new Set()) => {
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (!inside(realDir, realRoot) || parents.has(realDir)) return;
    const above = new Set(parents).add(realDir);
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        walk(full, relPath, above);
      } else if (d.isFile() || d.isSymbolicLink()) {
        if (SKIP_FILE.test(d.name)) continue;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (d.isSymbolicLink()) {
          // where the link really leads : outside the folder, it is not sent
          let target;
          try {
            target = fs.realpathSync(full);
          } catch {
            continue;
          }
          if (!inside(target, realRoot)) {
            logger.warning(`Not sending ${relPath} of ${root} to the runner: it is a link to ${target}, outside the folder`);
            continue;
          }
          // a link to a folder of the folder : walked like the folder itself
          if (st.isDirectory()) {
            if (SKIP_DIRS.has(d.name)) continue;
            walk(full, relPath, above);
            continue;
          }
        }
        if (!st.isFile()) continue;
        bytes += st.size;
        entries.push(relPath);
        lines.push(`${relPath}\t${st.size}\t${Math.floor(st.mtimeMs)}\t${(st.mode & 0o777).toString(8)}`);
      }
    }
  };
  walk(root, "");
  return { entries, lines, bytes };
}

/**
 * Removes the bundles nobody used for maxAgeMs (their time is set again each time one is
 * used), and the part files a stopped process left behind. A bundle being packed now is kept.
 *
 * Args:
 *   maxAgeMs (number): how long a bundle may go unused.
 *   now (number): the time to measure from (Date.now() by default).
 *
 * Returns:
 *   number: the files removed.
 */
export function pruneBundles(maxAgeMs = BUNDLE_MAX_AGE_MS, now = Date.now()) {
  lastPrune = now;
  let names;
  try {
    names = fs.readdirSync(BUNDLE_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.tgz(\..+\.part)?$/.exec(name);
    if (!match) continue;
    const hash = match[1];
    // being packed now : its part file is in use, and the bundle is about to be
    if (packing.has(hash)) continue;
    const file = path.join(BUNDLE_DIR, name);
    try {
      if (now - fs.statSync(file).mtimeMs <= maxAgeMs) continue;
      fs.unlinkSync(file);
      removed++;
      if (!match[2]) made.delete(hash);
    } catch {
      // gone already, or not ours to remove : left alone
    }
  }
  if (removed) logger.info(`Removed ${removed} job file bundle(s) unused for ${Math.round(maxAgeMs / 3600000)} hours`);
  return removed;
}

/**
 * Packs a folder's files as the bundle of a hash : into a part file of its own (a random
 * name, so a second process never writes into it), renamed when complete.
 *
 * Args:
 *   root (string): the folder.
 *   entries (string[]): the files, relative to the folder.
 *   file (string): the bundle's file.
 *
 * Returns:
 *   Promise<void>
 */
async function pack(root, entries, file) {
  const part = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`;
  try {
    await tar.c({ gzip: true, file: part, cwd: root, portable: true, follow: true }, entries.length ? entries : ["."]);
    fs.renameSync(part, file);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

/**
 * A folder's bundle : made when its content changed, else the one made before.
 *
 * Args:
 *   root (string): the folder.
 *
 * Returns:
 *   Promise<object|null>: { hash, file, sha256, size }, null when the folder does not exist.
 *
 * Raises:
 *   Error: the folder is bigger than RTE_FILES_MAX_MB.
 */
export async function bundleOf(root) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  // the old bundles, now and then : opportunistically, when one is asked for
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) pruneBundles();
  const { entries, lines, bytes } = manifest(root);
  if (bytes > maxBytes()) {
    throw new Error(`the folder ${root} holds ${Math.round(bytes / 1048576)} MB, more than RTE_FILES_MAX_MB (${maxBytes() / 1048576}): mount it on the runner and set RTE_FILES=local there`);
  }
  const hash = crypto.createHash("sha256").update(`${path.resolve(root)}\n${lines.join("\n")}`).digest("hex");
  const file = path.join(BUNDLE_DIR, `${hash}.tgz`);
  const known = made.get(hash);
  if (known && fs.existsSync(known.file)) {
    touch(known.file);
    return { hash, ...known };
  }
  // the same folder asked for by two jobs at once : the second waits for the first's bundle
  if (!packing.has(hash)) {
    const making = (async () => {
      fs.mkdirSync(BUNDLE_DIR, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(file)) {
        await pack(root, entries, file);
        logger.info(`Packed the job files of ${root} (${entries.length} files, ${Math.round(bytes / 1024)} KB) as ${hash.slice(0, 12)}`);
      } else {
        touch(file);
      }
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const entry = { file, sha256, size: fs.statSync(file).size, root };
      made.set(hash, entry);
      return entry;
    })();
    packing.set(hash, making);
    making.then(
      () => packing.delete(hash),
      () => packing.delete(hash)
    );
  }
  const entry = await packing.get(hash);
  return { hash, ...entry };
}

/**
 * Sets a bundle's time to now : it was used, and is not pruned for another BUNDLE_MAX_AGE_MS.
 *
 * Args:
 *   file (string): the bundle's file.
 */
function touch(file) {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // gone meanwhile : made again on the next ask
  }
}

/**
 * A bundle made by this process, by its hash (an RTE's fetch).
 *
 * Args:
 *   hash (string): the hash.
 *
 * Returns:
 *   object|null: { file, sha256, size, root }.
 */
export function bundleByHash(hash) {
  const entry = made.get(hash);
  if (entry && fs.existsSync(entry.file)) {
    touch(entry.file);
    return entry;
  }
  // made by an earlier start of this node : still on disk, its checksum read again
  const file = path.join(BUNDLE_DIR, `${hash}.tgz`);
  if (/^[a-f0-9]{64}$/.test(String(hash)) && fs.existsSync(file)) {
    const again = { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), size: fs.statSync(file).size, root: null };
    made.set(hash, again);
    touch(file);
    return again;
  }
  return null;
}

/**
 * Reads a bundle in chunks, for the socket.
 *
 * Args:
 *   file (string): the bundle's file.
 *   chunkBytes (number): the size of a chunk.
 *   onChunk (function): (buffer, last) => void : called for each chunk, in order.
 *
 * Returns:
 *   Promise<void>
 */
export async function readChunks(file, chunkBytes, onChunk) {
  const fd = await fs.promises.open(file, "r");
  try {
    const size = (await fd.stat()).size;
    let offset = 0;
    if (size === 0) return onChunk(Buffer.alloc(0), true);
    while (offset < size) {
      const len = Math.min(chunkBytes, size - offset);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      offset += len;
      await onChunk(buf, offset >= size);
    }
  } finally {
    await fd.close();
  }
}

export default { bundleOf, bundleByHash, readChunks, pruneBundles, BUNDLE_DIR, BUNDLE_MAX_AGE_MS };
