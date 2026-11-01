// The shared fixture of the repository-backed objects' tests (lib/repoObjects) : the tables in
// memory, answering the statements the crud models, the engine and its stores run ; the
// repositories' working trees in a folder of their own ; the repository model's git and write
// claim, recorded. A test file mocks the modules with it :
//
//   vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
//   vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
//   vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
//   vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
//   vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";
import { fileKeyOf } from "../../src/lib/repoObjects/types.js";

// ===========================================================================
// THE TABLES
// ===========================================================================

export const state = {
  // table name -> rows
  tables: {},
  nextId: 1,
  // git on the repositories, and the write claims : what the engine asked for, in order
  calls: [],
  pullFails: false,
  // a clone that fails : recorded on the repository, never thrown (Repository.clone), no tree
  cloneFails: false,
  // the statements the database refuses (a busy row, a constraint) : a regular expression
  failing: null,
  // the repositories a pull or a push holds : how many more claims each refuses (Infinity : all)
  busy: {},
  // the columns of a table as information_schema gives them, by table : { name, value, nullable,
  // type (its DATA_TYPE : tinyint, varchar ...) }
  columns: {},
};

/**
 * Empties every table and the records, and the working trees.
 *
 * Args:
 *   tables (object): the rows to start with, by table (repositories, credentials, runners).
 */
export function reset(tables = {}) {
  const empty = ["repositories", "credentials", "runners", "secret_stores", "databases", "notification_channels", "ldap", "oauth2_providers", "chat_settings", "syslog_servers", "labels", "settings", "announcements"];
  state.tables = { ...Object.fromEntries(empty.map((t) => [t, []])), ...structuredClone(tables) };
  state.nextId = 100;
  state.calls.length = 0;
  state.pullFails = false;
  state.cloneFails = false;
  state.failing = null;
  state.columns = {};
  state.busy = {};
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
}

/**
 * The table a statement is about, without its schema and its backticks.
 *
 * Args:
 *   sql (string): the statement.
 *   params (any[]): its values (a ?? table name is the first).
 *
 * Returns:
 *   string: the table.
 */
function tableOf(sql, params) {
  if (/(FROM|INTO|UPDATE) \?\?/.test(sql)) return String(params[0]).replace(/`/g, "").split(".").pop();
  const m = sql.match(/(?:FROM|INTO|UPDATE)\s+AnsibleForms\.`?(\w+)`?/);
  return m ? m[1] : "";
}

const rowsOf = (table) => (state.tables[table] = state.tables[table] || []);
const copy = (rows) => rows.map((r) => ({ ...r }));
const lower = (s) => String(s ?? "").toLowerCase();

export const db = {
  do: async (sql, params = []) => {
    sql = sql.trim();
    if (state.failing?.test(sql)) throw new Error("Lock wait timeout exceeded");
    const table = tableOf(sql, params);
    const rows = rowsOf(table);
    // a table's columns and their defaults (lib/repoObjects/engine.js columnDefaults)
    if (/FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = 'AnsibleForms' AND TABLE_NAME = \?/.test(sql)) return state.columns[params[0]] || [];
    // a repository's usage : the repositories used for it, and another one used for it
    // (several usages : any of them), and the ones used for it by id (the first one wins)
    let m = sql.match(/^SELECT name FROM AnsibleForms\.`repositories` WHERE (use_for_\w+(?: OR use_for_\w+)*)( AND name <> \?)?/);
    const usedFor = (r, flags) => flags.split(" OR ").some((flag) => Number(r[flag]));
    if (m) return rows.filter((r) => usedFor(r, m[1]) && (!m[2] || r.name !== params[0])).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ name: r.name }));
    m = sql.match(/^SELECT id, name FROM AnsibleForms\.`repositories` WHERE (use_for_\w+) ORDER BY id$/);
    if (m) return rows.filter((r) => usedFor(r, m[1])).sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, name: r.name }));
    if (/^SELECT 1 FROM \?\? WHERE \?\? = \?/.test(sql)) return rows.filter((r) => String(r[params[1]]) === String(params[2])).map(() => ({ 1: 1 }));
    if (/^SELECT managed FROM \?\? WHERE \?\? = \?/.test(sql)) return rows.filter((r) => String(r[params[1]]) === String(params[2])).map((r) => ({ managed: r.managed || 0 }));
    // what uses a credential (Credential.usersOf)
    if (/ AS kind, /.test(sql)) {
      const out = [];
      for (const part of sql.split(" UNION ALL ")) {
        const [, kind, nameCol, from, column] = part.match(/SELECT '([^']+)' AS kind, (\w+) AS name FROM AnsibleForms\.`(\w+)` WHERE (\w+) = \?/);
        for (const r of rowsOf(from)) if (r[column] === params[0]) out.push({ kind, name: nameCol === "NULL" ? null : r[nameCol] });
      }
      return out;
    }
    // the repository link (lib/repoObjects/engine.js linkStore)
    m = sql.match(/^UPDATE \S+ SET repository = \?, repo_file = \? WHERE (\w+) = \?/);
    if (m) {
      const row = rows.find((r) => String(r[m[1]]) === String(params[2]));
      if (row) Object.assign(row, { repository: params[0], repo_file: params[1] });
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^UPDATE \S+ SET repository = NULL, repo_file = NULL WHERE repository = \?/.test(sql)) {
      const hit = rows.filter((r) => r.repository === params[0]);
      hit.forEach((r) => Object.assign(r, { repository: null, repo_file: null }));
      return { affectedRows: hit.length };
    }
    if (/^UPDATE \S+ SET repository = \? WHERE repository = \?/.test(sql)) {
      const hit = rows.filter((r) => r.repository === params[1]);
      hit.forEach((r) => (r.repository = params[0]));
      return { affectedRows: hit.length };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM \S+ WHERE repository = \?/.test(sql)) return [{ n: rows.filter((r) => r.repository === params[0]).length }];
    // the Config usage split into its three keys' (models/schema.model.js splitConfigUsage) : the
    // repositories that had it, the first one given the three flags, the flag cleared on the others
    if (/^SELECT id, name FROM AnsibleForms\.`repositories` WHERE use_for_config = 1 ORDER BY id/.test(sql)) {
      return rows.filter((r) => Number(r.use_for_config) === 1).sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, name: r.name }));
    }
    if (/^UPDATE AnsibleForms\.`repositories` SET use_for_roles = 1, use_for_categories = 1, use_for_constants = 1, use_for_config = 0 WHERE id = \?/.test(sql)) {
      const row = rows.find((r) => r.id === Number(params[0]));
      if (row) Object.assign(row, { use_for_roles: 1, use_for_categories: 1, use_for_constants: 1, use_for_config: 0 });
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^UPDATE AnsibleForms\.`repositories` SET use_for_config = 0 WHERE use_for_config = 1/.test(sql)) {
      const hit = rows.filter((r) => Number(r.use_for_config) === 1);
      hit.forEach((r) => (r.use_for_config = 0));
      return { affectedRows: hit.length };
    }
    // a runner's credential, and its default
    if (/^SELECT credential_type FROM AnsibleForms\.`credentials` WHERE name = \?/.test(sql)) return rowsOf("credentials").filter((r) => r.name === params[0]).map((r) => ({ credential_type: r.credential_type }));
    if (/^SELECT name FROM AnsibleForms\.`runners` WHERE is_default = 1 AND managed = 1/.test(sql)) return [];
    if (/^UPDATE AnsibleForms\.`runners` SET is_default = 0 WHERE id <> \? AND type = \?/.test(sql)) {
      rowsOf("runners").filter((r) => r.id !== Number(params[0]) && r.type === params[1] && !r.managed).forEach((r) => (r.is_default = 0));
      return { affectedRows: 1 };
    }
    // the enabled sign-in provider of a type, and Skip the login page : one each
    if (/^SELECT name FROM AnsibleForms\.`oauth2_providers` WHERE enable = 1 AND managed = 1/.test(sql)) return [];
    m = sql.match(/^UPDATE AnsibleForms\.`oauth2_providers` SET (enable|auto_login) = 0 WHERE (provider = \?|auto_login = 1)/);
    if (m) {
      const hit = rowsOf("oauth2_providers").filter((r) => (m[2] === "provider = ?" ? r.provider === params[0] : Number(r.auto_login) === 1) && !r.managed);
      hit.forEach((r) => (r[m[1]] = 0));
      return { affectedRows: hit.length };
    }
    // a single-row table (the settings, the chat assistant's) : its row, a field of it, a write
    if (/^SELECT (\*|[\w, ]+) FROM \S+ limit 1;?$/i.test(sql)) return copy(rows.slice(0, 1));
    if (/^UPDATE \S+ set \?$/i.test(sql)) {
      const values = Array.isArray(params) ? params[0] : params;
      rows.forEach((r) => Object.assign(r, values));
      return { affectedRows: rows.length };
    }
    m = sql.match(/^UPDATE \S+ SET (\w+) = \?$/);
    if (m) {
      rows.forEach((r) => (r[m[1]] = params[0]));
      return { affectedRows: rows.length };
    }
    if (/^INSERT INTO \S+ \(\?\?\) SELECT \? FROM DUAL WHERE NOT EXISTS/.test(sql)) {
      if (rows.length) return { affectedRows: 0 };
      rows.push(Object.fromEntries(params[0].map((k, i) => [k, params[1][i]])));
      return { affectedRows: 1 };
    }
    // the announcements whose end is past : gone
    if (/^DELETE FROM \S+ WHERE end_at IS NOT NULL AND end_at <= UTC_TIMESTAMP\(\)/.test(sql)) {
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      state.tables[table] = rows.filter((r) => !r.end_at || String(r.end_at) > now);
      return { affectedRows: rows.length - state.tables[table].length };
    }
    // the crud models : a row by its id or name, all of them, a write
    m = sql.match(/^SELECT .+ FROM \S+ WHERE (\w+) ?= ?\?$/);
    if (m) return copy(rows.filter((r) => (m[1] === "name" ? lower(r.name) === lower(params[0]) : String(r[m[1]]) === String(params[0]))));
    if (/^SELECT .+ FROM \S+$/.test(sql)) return copy(rows);
    // the rows of some names (the credentials a database shows the server of : models/database.model.js)
    if (/^SELECT .+ FROM \S+ WHERE name IN \(\?\)$/.test(sql)) return copy(rows.filter((r) => [].concat(params[0]).includes(r.name)));
    // a list by name (the repositories)
    if (/^SELECT .+ FROM \S+ ORDER BY name$/.test(sql)) return copy(rows).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // a list in its order (the LDAP directories, the labels)
    if (/^SELECT .+ FROM \S+ ORDER BY position, (id|name)$/.test(sql)) {
      return copy(rows).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id)));
    }
    // the next place in an ordered list
    if (/^SELECT COALESCE\(MAX\(position\), 0\)/.test(sql)) {
      const max = Math.max(0, ...rows.map((r) => Number(r.position) || 0));
      return [{ p: max, next: max + 1 }];
    }
    // another row of that name (an LDAP directory's)
    if (/^SELECT id FROM \S+ WHERE name = \? AND id <> \?/.test(sql)) return rows.filter((r) => lower(r.name) === lower(params[0]) && r.id !== Number(params[1])).map((r) => ({ id: r.id }));
    // the one active mail channel
    if (/^UPDATE AnsibleForms\.`notification_channels` SET is_active = 0 WHERE id <> \?/.test(sql)) {
      rows.filter((r) => r.id !== Number(params[0]) && r.type === "mail").forEach((r) => (r.is_active = 0));
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO \S+ SET \?/i.test(sql)) {
      // the values : the object itself, as the crud model passes them
      const values = Array.isArray(params) ? params[0] : params;
      if (rows.some((r) => lower(r.name) === lower(values.name))) throw new Error(`Duplicate entry '${values.name}' for key 'name'`);
      const id = state.nextId++;
      rows.push({ id, repository: null, repo_file: null, ...values });
      return { insertId: id, affectedRows: 1 };
    }
    m = sql.match(/^UPDATE \S+ SET \? WHERE (\w+) = \?/i);
    if (m) {
      const row = rows.find((r) => String(r[m[1]]) === String(params[1]));
      if (row) Object.assign(row, params[0]);
      return { affectedRows: row ? 1 : 0 };
    }
    m = sql.match(/^DELETE FROM \S+ WHERE (\w+) = \?/);
    if (m) {
      const before = rows.length;
      state.tables[table] = rows.filter((r) => String(r[m[1]]) !== String(params[0]));
      return { affectedRows: before - state.tables[table].length };
    }
    throw new Error(`unexpected statement: ${sql}`);
  },
  tryDo: async () => [],
};

// ===========================================================================
// THE WORKING TREES, GIT AND THE WRITE CLAIM
// ===========================================================================

// the repositories' working trees
export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-repo-objects-"));

export const repo = {
  folderOf: (name) => path.join(ROOT, name),
  isValidName: (name) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(name || ""),
};

export const repository = {
  pull: async (name) => {
    state.calls.push(`pull:${name}`);
    if (state.pullFails) throw new Error("remote unreachable");
  },
  clone: async (name) => {
    state.calls.push(`clone:${name}`);
    if (state.cloneFails) return;
    fs.mkdirSync(path.join(ROOT, name), { recursive: true });
  },
  claimForWrite: async (name) => {
    if (state.busy[name] > 0) {
      state.busy[name]--;
      state.calls.push(`busy:${name}`);
      throw new Error(`Repository '${name}' is busy (a pull or sync is running), try again`);
    }
    state.calls.push(`claim:${name}`);
    return "success";
  },
  releaseWrite: async (name) => {
    state.calls.push(`release:${name}`);
  },
  // the forms repositories' forms folders, as the model gives them : the forms subfolder when there
  // is one (dedicated), else the root
  getFormsFolders: async () =>
    (state.tables.repositories || [])
      .filter((r) => Number(r.use_for_forms))
      .sort((a, b) => a.id - b.id)
      .map((r) => {
        const root = path.join(ROOT, r.name);
        const sub = path.join(root, "forms");
        return fs.existsSync(sub) ? { name: r.name, path: sub, dedicated: true } : { name: r.name, path: root, dedicated: false };
      }),
};

// a secret as the database keeps it : marked, so a test sees it was encrypted
export const crypto = {
  encrypt: (text) => `enc:${text}`,
  decrypt: (text) => String(text).replace(/^enc:/, ""),
};


// ===========================================================================
// FILES
// ===========================================================================

/**
 * Writes a file of a repository, in a folder of it.
 *
 * Args:
 *   name (string): the repository.
 *   folder (string): the folder, relative to the repository ('' or '.' for its root).
 *   file (string): the file name.
 *   content (object|string): the content (written as YAML) or the file's text.
 */
export function writeFile(name, folder, file, content) {
  const dir = path.join(ROOT, name, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof content === "string" ? content : YAML.stringify(content));
}

// a file's text, its object, whether it is there, and a repository cloned with nothing in it
export const readText = (name, folder, file) => fs.readFileSync(path.join(ROOT, name, folder, file), "utf8");
export const readObject = (name, folder, file) => YAML.parse(readText(name, folder, file));
export const fileExists = (name, folder, file) => fs.existsSync(path.join(ROOT, name, folder, file));
export const removeFile = (name, folder, file) => fs.rmSync(path.join(ROOT, name, folder, file));
export const cloneEmpty = (name) => fs.mkdirSync(path.join(ROOT, name), { recursive: true });
export const listFiles = (name, folder) => fs.readdirSync(path.join(ROOT, name, folder)).sort();

/**
 * Writes a file of a repository holding entries of a type under its file key
 * (controller_credentials: [...]) : the
 * repository's files are read by their content, any name, any folder.
 *
 * Args:
 *   name (string): the repository.
 *   file (string): the file, relative to the repository (credentials.yaml, team/creds.yml).
 *   key (string): the type's key (credentials).
 *   content (object|object[]|string): one entry, the entries, or the file's whole text.
 */
export function writeEntry(name, file, key, content) {
  const abs = path.join(ROOT, name, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = typeof content === "string" ? content : YAML.stringify({ [fileKeyOf(key)]: Array.isArray(content) ? content : [content] });
  fs.writeFileSync(abs, text);
}

/**
 * Writes a file of a repository holding the map of a type the app has one of under its file key
 * (controller_defaults: {...}).
 *
 * Args:
 *   name (string): the repository.
 *   file (string): the file, relative to the repository.
 *   key (string): the type's key (defaults).
 *   content (object|string): the map, or the file's whole text.
 */
export function writeMap(name, file, key, content) {
  const abs = path.join(ROOT, name, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === "string" ? content : YAML.stringify({ [fileKeyOf(key)]: content }));
}

/**
 * The entries of a type a file of a repository holds, or one of them by its name.
 *
 * Args:
 *   name (string): the repository.
 *   file (string): the file, relative to the repository.
 *   key (string): the type's key.
 *   entry (string): the entry's name ; none : all of them.
 *
 * Returns:
 *   object|object[]|undefined: the entry, or the list.
 */
export function readEntry(name, file, key, entry) {
  const list = YAML.parse(fs.readFileSync(path.join(ROOT, name, file), "utf8"))?.[fileKeyOf(key)] || [];
  return entry === undefined ? list : list.find((e) => String(e?.name ?? e?.version) === String(entry));
}

/**
 * The map of a type the app has one of a file of a repository holds.
 *
 * Args:
 *   name (string): the repository.
 *   file (string): the file, relative to the repository.
 *   key (string): the type's key.
 *
 * Returns:
 *   object|undefined: the map.
 */
export const readMap = (name, file, key) => YAML.parse(fs.readFileSync(path.join(ROOT, name, file), "utf8"))?.[fileKeyOf(key)];

// whether a file of a repository is there, and its text (path relative to the repository)
export const exists = (name, file) => fs.existsSync(path.join(ROOT, name, file));
export const textOf = (name, file) => fs.readFileSync(path.join(ROOT, name, file), "utf8");

/**
 * A table's row by its name.
 *
 * Args:
 *   table (string): the table.
 *   name (string): the row's name.
 *
 * Returns:
 *   object|undefined: the row.
 */
export const rowNamed = (table, name) => rowsOf(table).find((r) => r.name === name);
