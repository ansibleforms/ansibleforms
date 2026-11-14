// The config seed's mail keys of before 7.6 (mail_server ... mail_from under settings:) : the
// settings row has no mail columns any more (#1328), so a seed written before keeps working by
// declaring a mail channel, and its smtp credential when there is a login, instead. Deprecated :
// a warning in the log, once per process.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the database : every query answers [] but the settings row and the reserved names
let reservedChannels = [];
let reservedCredentials = [];
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      if (/^SELECT \* FROM AnsibleForms\.`settings`/.test(sql)) return [{ url: "https://af.example.com", managed: 1 }];
      if (/^SELECT name FROM AnsibleForms\.`notification_channels` WHERE COALESCE\(managed, 0\) = 0 AND type <> 'mail'/.test(sql)) return reservedChannels.map((name) => ({ name }));
      if (/^SELECT name FROM AnsibleForms\.`credentials` WHERE COALESCE\(managed, 0\) = 0 AND COALESCE\(credential_type, ''\) <> 'smtp'/.test(sql)) return reservedCredentials.map((name) => ({ name }));
      return [];
    },
  },
}));

const { foldMailSettingsIntoChannel, seedHasMailSettings, validateSeed } = await import("../src/lib/seed-schema.js");
const appConfig = (await import("./__mocks__/app.config.js")).default;
const logger = (await import("../src/lib/logger.js")).default;
const { applyConfigSeed, listSections, _resetSeedState } = await import("../src/lib/seed.js");

const MAIL = { mail_server: "smtp.example.com", mail_port: 587, mail_secure: true, mail_username: "mailer", mail_password: "pw", mail_from: "af@example.com" };

// ---------------------------------------------------------------------------------------
// the fold, on its own
// ---------------------------------------------------------------------------------------

describe("the mail keys of the settings become a mail channel", () => {
  test("no mail key : the document is left as it is", () => {
    const doc = { settings: { url: "https://x" } };
    expect(seedHasMailSettings(doc)).toBe(false);
    expect(foldMailSettingsIntoChannel(doc)).toEqual({ doc, folded: false, channel: null, credential: null });
  });

  test("with a login : the channel 'default' naming the smtp credential 'mail-login', which holds the server and login", () => {
    const { doc, folded, channel, credential } = foldMailSettingsIntoChannel({ settings: { ...MAIL, url: "https://x" } });
    expect(folded).toBe(true);
    expect([channel, credential]).toEqual(["default", "mail-login"]);
    expect(doc.settings).toEqual({ url: "https://x" });
    expect(doc.credentials.items).toEqual([
      { name: "mail-login", description: "The mail server of the config seed's settings", credential_type: "smtp", host: "smtp.example.com", user: "mailer", port: 587, secure: true, password: "pw" },
    ]);
    expect(doc.notification_channels.items).toEqual([
      { name: "default", description: "From the config seed's mail settings", type: "mail", from_address: "af@example.com", credential: "mail-login" },
    ]);
    // never is_active : the first mail channel is the active one, one made by hand stays it
    expect(doc.notification_channels.items[0].is_active).toBeUndefined();
  });

  test("a relay (no user) : a channel with its own server and no credential", () => {
    const { doc, credential } = foldMailSettingsIntoChannel({ settings: { ...MAIL, mail_username: "", mail_password: "", url: "" } });
    expect(credential).toBe(null);
    expect(doc.credentials.items).toEqual([]);
    expect(doc.notification_channels.items[0]).toMatchObject({ name: "default", type: "mail", server: "smtp.example.com", port: 587, secure: true });
    expect(doc.notification_channels.items[0].credential).toBeUndefined();
  });

  test("no mail server : the keys leave, nothing is declared", () => {
    const { doc, folded, channel } = foldMailSettingsIntoChannel({ settings: { ...MAIL, mail_server: "", url: "" } });
    expect([folded, channel]).toEqual([true, null]);
    expect(doc).toEqual({ settings: { url: "" } });
  });

  test("names the seed declares, or reserved ones, are not taken", () => {
    const { channel, credential, doc } = foldMailSettingsIntoChannel(
      {
        settings: { ...MAIL, url: "" },
        notification_channels: { items: [{ name: "default", type: "slack", webhook_url: "https://hooks.example.com/x" }] },
        credentials: { items: [{ name: "mail-login", user: "u" }] },
      },
      { channels: ["default-2"], credentials: ["mail-login-2"] },
    );
    expect([channel, credential]).toEqual(["default-3", "mail-login-3"]);
    expect(doc.notification_channels.items.map((c) => c.name)).toEqual(["default", "default-3"]);
  });

  test("a seed of before 7.6 validates, with or without its mail keys, and url is still required", () => {
    expect(validateSeed({ settings: { ...MAIL, url: "https://x" } })).toBe(true);
    expect(validateSeed({ settings: { url: "https://x" } })).toBe(true);
    // its channel named like one the seed declares : a free name, no duplicate
    expect(validateSeed({ settings: { ...MAIL, url: "" }, notification_channels: { items: [{ name: "default", type: "mail", server: "x" }] } })).toBe(true);
    expect(() => validateSeed({ settings: { ...MAIL } })).toThrow(/required property 'url'/);
  });
});

// ---------------------------------------------------------------------------------------
// applied : the channel and credential written by their sections, the settings only the url
// ---------------------------------------------------------------------------------------

describe("a seed with mail keys, applied", () => {
  let dir;
  const created = [];
  const originals = new Map();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-seed-mail-"));
    created.length = 0;
    queries.length = 0;
    reservedChannels = [];
    reservedCredentials = [];
    _resetSeedState();
    // the list sections' writes recorded rather than run
    for (const section of listSections) {
      originals.set(section, section.create);
      section.create = async (data) => created.push({ section: section.key, data });
    }
  });

  afterEach(() => {
    for (const [section, create] of originals) section.create = create;
    appConfig.configSeedPath = "";
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Writes the seed file and applies it.
   *
   * Args:
   *   text (string): the seed's yaml.
   *
   * Returns:
   *   Promise<object>: the apply's summary.
   */
  async function apply(text) {
    const seedPath = path.join(dir, "seed.yaml");
    fs.writeFileSync(seedPath, text);
    appConfig.configSeedPath = seedPath;
    return applyConfigSeed();
  }

  const SEED = "version: 1\nsettings:\n  url: https://af.example.com\n  mail_server: smtp.example.com\n  mail_port: 587\n  mail_secure: true\n  mail_username: mailer\n  mail_password: pw\n  mail_from: af@example.com\n";

  test("writes the credential, then the channel naming it ; no mail column is written to the settings", async () => {
    await apply(SEED);
    expect(created.map((c) => `${c.section}:${c.data.name}`)).toEqual(["credentials:mail-login", "notification_channels:default"]);
    expect(created[1].data).toMatchObject({ type: "mail", credential: "mail-login", managed: true });
    const writes = queries.filter((q) => /^UPDATE AnsibleForms\.`settings`/.test(q.sql));
    expect(JSON.stringify(writes)).not.toMatch(/mail_/);
  });

  test("a hand-made Slack channel named 'default' is not adopted : the mail channel is default-2", async () => {
    reservedChannels = ["default"];
    await apply(SEED);
    expect(created.find((c) => c.section === "notification_channels").data.name).toBe("default-2");
  });

  test("says the deprecation once per process, not at every apply", async () => {
    const warning = vi.spyOn(logger, "warning");
    await apply(SEED);
    await apply(SEED + "# changed\n");
    const said = warning.mock.calls.filter(([m]) => /mail_server.*deprecated since 7\.6/.test(String(m)));
    expect(said.length).toBe(1);
    expect(said[0][0]).toMatch(/the mail channel 'default' and its smtp credential 'mail-login'/);
    warning.mockRestore();
  });
});
