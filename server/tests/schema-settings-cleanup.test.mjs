// The settings table cleanup of 7.6 (#1328) : forms_yaml renamed config_yaml (the file it holds is
// config.yaml), and the six mail columns dropped (the mail goes through the mail channels). Both
// run at every start and after every restore of an older dump, so both must keep the data, run
// on whatever state an older release, a failed run or a restored backup left, and do nothing the
// second time. The database is a small model of the settings table and the two tables the mail
// moves into : every statement the patches send is answered from it.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ---------------------------------------------------------------------------------------
// The database : the settings row and its columns, the channels and the credentials
// ---------------------------------------------------------------------------------------

let db;
// every statement, in order, marked when it ran inside a transaction
const statements = [];
let transactions = 0;

/**
 * A fresh model of the database.
 *
 * Args:
 *   columns (string[]): the settings table's columns.
 *   row (object): the settings row, null for none.
 *   channels (object[]): the notification channels.
 *   credentials (object[]): the credentials.
 */
function setDb({ columns, row = {}, channels = [], credentials = [] }) {
  db = { columns: new Set(columns), row, channels, credentials, nextId: 100 };
}

/**
 * Answers one statement from the model ; anything it does not model answers [] (a table or a
 * column of another patch, present, with no row).
 *
 * Args:
 *   sql (string): the statement.
 *   args (Array): its parameters.
 *
 * Returns:
 *   Array|object: the rows, or an ok packet.
 */
function answer(sql, args = []) {
  // the settings' columns : one, or two by name (renameColumn)
  if (/^SHOW COLUMNS FROM \?\?\.\?\? WHERE Field = \?/.test(sql)) {
    const [, table, field] = args;
    if (table !== "settings") return [{ Field: field }];
    return db.columns.has(field) ? [{ Field: field }] : [];
  }
  if (/^SHOW COLUMNS FROM \?\?\.\?\? WHERE Field IN/.test(sql)) {
    const [, , a, b] = args;
    return [a, b].filter((f) => db.columns.has(f)).map((Field) => ({ Field }));
  }
  // the utf8mb4 check : already utf8mb4
  if (/information_schema\.columns/.test(sql)) return [{ 1: 1 }];
  const add = /^ALTER TABLE \?\?\.\?\? ADD COLUMN \?\?/.test(sql);
  if (add) {
    const [, table, field] = args;
    if (table === "settings") {
      db.columns.add(field);
      if (db.row) db.row[field] = null;
    }
    return { affectedRows: 0 };
  }
  if (/^ALTER TABLE \?\?\.\?\? CHANGE COLUMN \?\? \?\?/.test(sql)) {
    const [, table, from, to] = args;
    if (table === "settings") {
      db.columns.delete(from);
      db.columns.add(to);
      if (db.row) {
        db.row[to] = db.row[from];
        delete db.row[from];
      }
    }
    return { affectedRows: 0 };
  }
  if (/^ALTER TABLE \?\?\.\?\? DROP COLUMN \?\?/.test(sql)) {
    const [, table, field] = args;
    if (table === "settings") {
      db.columns.delete(field);
      if (db.row) delete db.row[field];
    }
    return { affectedRows: 0 };
  }
  // the config copied when both columns are there
  if (/^UPDATE AnsibleForms\.`settings` SET config_yaml = forms_yaml/.test(sql)) {
    if (db.row && !db.row.config_yaml && db.row.forms_yaml) db.row.config_yaml = db.row.forms_yaml;
    return { affectedRows: 1 };
  }
  if (/^SELECT \* FROM AnsibleForms\.`settings`/.test(sql)) return db.row ? [{ ...db.row }] : [];
  if (/^UPDATE AnsibleForms\.`settings` SET mail_server = ''/.test(sql)) {
    Object.assign(db.row, { mail_server: "", mail_username: "", mail_password: "" });
    return { affectedRows: 1 };
  }
  // the channels
  if (/COUNT\(\*\) AS n FROM AnsibleForms\.`notification_channels` WHERE type = 'mail' AND is_active = 1 AND enabled = 1/.test(sql)) {
    return [{ n: db.channels.filter((c) => c.type === "mail" && c.is_active && c.enabled).length }];
  }
  if (/COUNT\(\*\) AS n FROM AnsibleForms\.`notification_channels` WHERE type = 'mail'/.test(sql)) {
    return [{ n: db.channels.filter((c) => c.type === "mail").length }];
  }
  if (/^SELECT type FROM AnsibleForms\.`notification_channels` WHERE name = 'default'/.test(sql)) {
    return db.channels.filter((c) => c.name === "default").map((c) => ({ type: c.type }));
  }
  if (/^SELECT 1 FROM AnsibleForms\.`notification_channels` WHERE name = \?/.test(sql)) {
    return db.channels.filter((c) => c.name === args[0]).map(() => ({ 1: 1 }));
  }
  if (/^INSERT INTO AnsibleForms\.`notification_channels`/.test(sql)) {
    const [name, description, server, port, secure, from_address, credential] = args;
    db.channels.push({ id: db.nextId++, name, description, type: "mail", enabled: 1, is_active: 1, server, port, secure, from_address, credential, managed: 0 });
    return { affectedRows: 1 };
  }
  if (/^UPDATE AnsibleForms\.`notification_channels` SET is_active = 0 WHERE type = 'mail' AND name <> \?/.test(sql)) {
    for (const c of db.channels) if (c.type === "mail" && c.name !== args[0]) c.is_active = 0;
    return { affectedRows: 1 };
  }
  if (/^SELECT id, name, server, port, secure, credential FROM AnsibleForms\.`notification_channels`/.test(sql)) {
    return db.channels.filter((c) => c.type === "mail" && !c.managed && c.server && c.credential);
  }
  if (/^UPDATE AnsibleForms\.`notification_channels` SET server = NULL/.test(sql)) {
    const c = db.channels.find((x) => x.id === args[1]);
    Object.assign(c, { server: null, port: null, secure: 0, credential: args[0] });
    return { affectedRows: 1 };
  }
  if (/^SELECT credential FROM AnsibleForms\.`notification_channels` WHERE name = \?/.test(sql)) {
    return db.channels.filter((c) => c.name === args[0]).map((c) => ({ credential: c.credential }));
  }
  if (/^UPDATE AnsibleForms\.`notification_channels` SET managed = 1 WHERE name = \?/.test(sql)) {
    for (const c of db.channels) if (c.name === args[0]) c.managed = 1;
    return { affectedRows: 1 };
  }
  // the credentials
  if (/^SELECT 1 FROM AnsibleForms\.`credentials` WHERE name = \?/.test(sql)) {
    return db.credentials.filter((c) => c.name === args[0]).map(() => ({ 1: 1 }));
  }
  if (/^SELECT \* FROM AnsibleForms\.`credentials` WHERE name = \?/.test(sql)) {
    return db.credentials.filter((c) => c.name === args[0]);
  }
  if (/^INSERT INTO AnsibleForms\.`credentials` \(name, user, password/.test(sql)) {
    const [name, user, password] = args;
    db.credentials.push({ id: db.nextId++, name, user, password, credential_type: "smtp", host: null, managed: 0 });
    return { affectedRows: 1 };
  }
  if (/^INSERT INTO AnsibleForms\.`credentials` \(name, description, is_database, credential_type, host/.test(sql)) {
    const [name, , host, port, secure] = args;
    db.credentials.push({ id: db.nextId++, name, credential_type: "smtp", host, port, secure, managed: 0 });
    return { affectedRows: 1 };
  }
  if (/^UPDATE AnsibleForms\.`credentials` SET host = \?/.test(sql)) {
    const c = db.credentials.find((x) => x.id === args[3]);
    Object.assign(c, { host: args[0], port: args[1], secure: args[2] });
    return { affectedRows: 1 };
  }
  if (/^UPDATE AnsibleForms\.`credentials` SET managed = 1 WHERE name = \?/.test(sql)) {
    for (const c of db.credentials) if (c.name === args[0]) c.managed = 1;
    return { affectedRows: 1 };
  }
  return [];
}

vi.mock("../src/models/db.model.js", () => {
  const run = async (sql, args, tx = false) => {
    statements.push({ sql, args, tx });
    return answer(sql, args);
  };
  return {
    default: {
      do: (sql, args) => run(sql, args),
      transaction: async (fn) => {
        transactions++;
        return fn((sql, args) => run(sql, args, true));
      },
    },
  };
});

const { renameFormsYamlToConfigYaml, dropSettingsMailColumns, patchVersion5, patchVersion7, SCHEMA_MANIFEST } = await import("../src/models/schema.model.js");

// the settings columns of 7.5, and its mail columns
const MAIL = ["mail_server", "mail_port", "mail_secure", "mail_username", "mail_password", "mail_from"];
const COLUMNS_75 = [...MAIL, "encryption_check", "url", "forms_yaml", "logo", "config_source", "managed"];
const CONFIG = "categories: []\nconstants:\n  greeting: hello\n";

beforeEach(() => {
  statements.length = 0;
  transactions = 0;
});

// ---------------------------------------------------------------------------------------
// forms_yaml becomes config_yaml
// ---------------------------------------------------------------------------------------

describe("forms_yaml is renamed config_yaml, its config kept", () => {
  test("a database of 7.5 : renamed in place, with its utf8mb4 type, the config kept", async () => {
    setDb({ columns: COLUMNS_75, row: { forms_yaml: CONFIG } });
    expect(await renameFormsYamlToConfigYaml()).toMatch(/renamed column 'forms_yaml' to 'config_yaml'/);
    const change = statements.find((s) => /CHANGE COLUMN/.test(s.sql));
    expect(change.sql).toMatch(/longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL/);
    expect(db.columns.has("forms_yaml")).toBe(false);
    expect(db.row.config_yaml).toBe(CONFIG);
  });

  test("a second run does nothing", async () => {
    setDb({ columns: ["url", "config_yaml"], row: { config_yaml: CONFIG } });
    expect(await renameFormsYamlToConfigYaml()).toBe(null);
    expect(statements.some((s) => /^(ALTER|UPDATE)/.test(s.sql))).toBe(false);
  });

  test("both columns (an older release re-added forms_yaml) : config_yaml kept, forms_yaml dropped", async () => {
    setDb({ columns: ["url", "config_yaml", "forms_yaml"], row: { config_yaml: CONFIG, forms_yaml: "" } });
    expect(await renameFormsYamlToConfigYaml()).toMatch(/dropped column 'forms_yaml'/);
    expect(db.row.config_yaml).toBe(CONFIG);
    expect(db.columns.has("forms_yaml")).toBe(false);
  });

  test("both columns, config_yaml empty : it takes forms_yaml's config before the drop", async () => {
    setDb({ columns: ["url", "config_yaml", "forms_yaml"], row: { config_yaml: null, forms_yaml: CONFIG } });
    await renameFormsYamlToConfigYaml();
    expect(db.row.config_yaml).toBe(CONFIG);
    const copy = statements.findIndex((s) => /SET config_yaml = forms_yaml/.test(s.sql));
    const drop = statements.findIndex((s) => /DROP COLUMN/.test(s.sql));
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(drop);
  });

  test("the 5 patch renames before it adds : config_yaml is never added empty beside forms_yaml", async () => {
    setDb({ columns: COLUMNS_75, row: { forms_yaml: CONFIG } });
    await patchVersion5([], [], []);
    expect(db.columns.has("config_yaml")).toBe(true);
    expect(db.columns.has("forms_yaml")).toBe(false);
    expect(db.row.config_yaml).toBe(CONFIG);
    expect(statements.some((s) => /ADD COLUMN/.test(s.sql) && s.args?.[2] === "forms_yaml")).toBe(false);
    // and again : nothing renamed, nothing added
    statements.length = 0;
    await patchVersion5([], [], []);
    expect(statements.some((s) => /CHANGE COLUMN|DROP COLUMN/.test(s.sql) || (/ADD COLUMN/.test(s.sql) && s.args?.[1] === "settings"))).toBe(false);
    expect(db.row.config_yaml).toBe(CONFIG);
  });

  test("a database from before 5.0.3 (neither column) gets config_yaml", async () => {
    setDb({ columns: ["url"], row: {} });
    await patchVersion5([], [], []);
    expect(db.columns.has("config_yaml")).toBe(true);
    expect(db.columns.has("forms_yaml")).toBe(false);
  });

  test("the schema manifest expects config_yaml, not forms_yaml", () => {
    const columns = Object.values(SCHEMA_MANIFEST.patches).flatMap((p) => p.columns || []);
    expect(columns).toContain("settings.config_yaml");
    expect(columns).not.toContain("settings.forms_yaml");
    expect(columns.filter((c) => /^settings\.mail_/.test(c))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// the mail columns go, what they held a mail channel first
// ---------------------------------------------------------------------------------------

describe("the settings' mail columns are dropped, their mail settings kept as a mail channel", () => {
  const mailRow = (over) => ({ url: "", mail_server: "smtp.example.com", mail_port: 587, mail_secure: 1, mail_username: "mailer", mail_password: "enc-pw", mail_from: "af@example.com", managed: 0, ...over });

  test("the columns gone already : nothing to do", async () => {
    setDb({ columns: ["url", "config_yaml"], row: { url: "" } });
    expect(await dropSettingsMailColumns()).toBe(null);
    expect(statements.some((s) => /^(ALTER|INSERT|UPDATE)/.test(s.sql))).toBe(false);
  });

  test("no mail server (moved by 7.3 already, or never set) : only the columns go", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow({ mail_server: "", mail_username: "", mail_password: "" }) });
    expect(await dropSettingsMailColumns()).toMatch(/Dropped the mail columns/);
    expect(statements.some((s) => /^INSERT/.test(s.sql))).toBe(false);
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
  });

  test("a mail server and no active mail channel : the active channel 'default', its credential mail-login holding the server and login", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow({ managed: 1 }) });
    expect(await dropSettingsMailColumns()).toMatch(/active mail channel 'default', its login to the credential 'mail-login'/);
    const channel = db.channels.find((c) => c.name === "default");
    expect(channel).toMatchObject({ type: "mail", is_active: 1, enabled: 1, credential: "mail-login", from_address: "af@example.com", server: null });
    const cred = db.credentials.find((c) => c.name === "mail-login");
    // the password as it was stored : the same key encrypts both tables
    expect(cred).toMatchObject({ user: "mailer", password: "enc-pw", host: "smtp.example.com", port: 587, secure: 1, credential_type: "smtp" });
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
  });

  test("the channel and its credential in one transaction, the columns dropped only after it", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow() });
    await dropSettingsMailColumns();
    expect(transactions).toBeGreaterThanOrEqual(1);
    const inserts = statements.filter((s) => /^INSERT/.test(s.sql));
    expect(inserts.every((s) => s.tx)).toBe(true);
    const lastInsert = statements.lastIndexOf(inserts.at(-1));
    const firstDrop = statements.findIndex((s) => /DROP COLUMN/.test(s.sql));
    expect(firstDrop).toBeGreaterThan(lastInsert);
  });

  test("a seeded instance : the channel and its credential are managed, as the settings were", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow({ managed: 1 }) });
    await dropSettingsMailColumns();
    expect(db.channels.find((c) => c.name === "default").managed).toBe(1);
    expect(db.credentials.find((c) => c.name === "mail-login").managed).toBe(1);
  });

  test("an instance made by hand : they are not managed", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow() });
    await dropSettingsMailColumns();
    expect(db.channels.find((c) => c.name === "default").managed).toBe(0);
    expect(statements.some((s) => /SET managed = 1/.test(s.sql))).toBe(false);
  });

  test("a relay (no login) : a channel without a credential, sending through its own server", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow({ mail_username: "", mail_password: "" }) });
    await dropSettingsMailColumns();
    expect(db.channels.find((c) => c.name === "default")).toMatchObject({ credential: null, server: "smtp.example.com", port: 587, secure: 1, is_active: 1 });
    expect(db.credentials).toEqual([]);
  });

  test("a channel of another type named 'default' : never overwritten, the mail channel is default-2", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow(), channels: [{ id: 1, name: "default", type: "slack", enabled: 1, is_active: 0 }] });
    await dropSettingsMailColumns();
    expect(db.channels.find((c) => c.name === "default").type).toBe("slack");
    expect(db.channels.find((c) => c.name === "default-2")).toMatchObject({ type: "mail", is_active: 1 });
  });

  test("a mail channel turned off or not active : the settings were what the mail went through, they become the active one", async () => {
    const off = { id: 1, name: "office", type: "mail", enabled: 0, is_active: 1, credential: "o365" };
    setDb({ columns: [...MAIL, "url"], row: mailRow(), channels: [off] });
    await dropSettingsMailColumns();
    expect(db.channels.find((c) => c.name === "office").is_active).toBe(0);
    expect(db.channels.find((c) => c.name === "default").is_active).toBe(1);
  });

  test("an active mail channel already : it is what the mail went through, nothing is made", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow(), channels: [{ id: 1, name: "office", type: "mail", enabled: 1, is_active: 1 }] });
    await dropSettingsMailColumns();
    expect(statements.some((s) => /^INSERT/.test(s.sql))).toBe(false);
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
  });

  test("a second run does nothing", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow() });
    await dropSettingsMailColumns();
    statements.length = 0;
    expect(await dropSettingsMailColumns()).toBe(null);
    expect(db.channels.length).toBe(1);
  });

  test("a run that stopped after the channel (a drop failed) : the next one makes no second channel", async () => {
    setDb({ columns: [...MAIL, "url"], row: mailRow() });
    await dropSettingsMailColumns();
    // the columns back, as if the drops had not run
    setDb({ columns: [...MAIL, "url"], row: mailRow(), channels: db.channels, credentials: db.credentials });
    await dropSettingsMailColumns();
    expect(db.channels.filter((c) => c.type === "mail").length).toBe(1);
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// in the 7 patch : after the 7.3 copy and move
// ---------------------------------------------------------------------------------------

describe("in the 7 patch", () => {
  test("a database of before 7.3 : the 7.3 copy makes the channel, the drop after it makes no second one", async () => {
    setDb({ columns: [...COLUMNS_75], row: { forms_yaml: CONFIG, ...{ url: "", mail_server: "smtp.example.com", mail_port: 25, mail_secure: 0, mail_username: "mailer", mail_password: "enc-pw", mail_from: "af@example.com", managed: 0 } } });
    const failed = [];
    await patchVersion7([], [], failed);
    expect(db.channels.filter((c) => c.type === "mail").map((c) => c.name)).toEqual(["default"]);
    expect(db.credentials.find((c) => c.name === "mail-login")).toMatchObject({ host: "smtp.example.com", port: 25 });
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
    // the 7.3 copy, then the move to the credential, then the drop
    const copy = statements.findIndex((s) => /^INSERT INTO AnsibleForms\.`notification_channels`/.test(s.sql));
    const drop = statements.findIndex((s) => /DROP COLUMN/.test(s.sql) && s.args?.[2] === "mail_server");
    expect(copy).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(copy);
  });

  test("a seeded instance of 7.5 : the copy leaves it to the seed, the drop moves it, managed", async () => {
    setDb({ columns: [...COLUMNS_75], row: { url: "", mail_server: "smtp.example.com", mail_port: 25, mail_secure: 0, mail_username: "", mail_password: "", mail_from: "af@example.com", managed: 1 } });
    await patchVersion7([], [], []);
    expect(db.channels.find((c) => c.name === "default")).toMatchObject({ type: "mail", is_active: 1, managed: 1, credential: null, server: "smtp.example.com", port: 25 });
    for (const c of MAIL) expect(db.columns.has(c)).toBe(false);
  });
});
