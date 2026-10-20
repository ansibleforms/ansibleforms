// The last object types on the engine (lib/repoObjects) : the ones kept in ONE file of their
// repository - the chat assistant (chat.yaml), the System > General settings (general.yaml), the
// branding (branding.yaml and its images) - and the announcements and the disclaimer versions, one
// file each. On the shared fixture :
//   single-file mode  a pull applies the file (git wins), turning the type on writes the app's
//                     values when there is no file, an edit in the app rewrites only what changed,
//                     its secret an ${ENV} reference only, what it names waited for
//   general           checked and applied as the settings page's Save : a variable another page or
//                     the deployment owns refused, a secret only as ${ENV}, a restart said
//   mcp               the MCP page's switches the same way (mcp.yaml), applied at once, never a
//                     variable of the settings' ; the seed's mcp section holding them per variable
//   branding          its images beside it, read and written as binary, checked as an upload
//   announcements     named, their moments compared in UTC, one made in the app named on its way
//   disclaimer        a changed text a correction, or everyone asked again when the file says so
//   the seed          the branding section read through the same descriptor, its image relative to it
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
// the settings page's managed file : a file of the test's own
const MANAGED = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-managed-env-")), ".env");
process.env.MANAGED_ENV_PATH = MANAGED;

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
// what a save tells the rest of the app and the audit trail : recorded, nothing else
const audits = [];
vi.mock("../src/models/audit.model.js", () => ({ default: { log: (entry) => audits.push(entry) } }));
vi.mock("../src/routes/v2/app.routes.js", () => ({ forgetAppDefaults: () => {} }));
// the documented variables : the real help.yaml
vi.mock("../src/models/help.model.js", async () => {
  const YAML = (await import("yaml")).default;
  const text = fs.readFileSync(new URL("../help.yaml", import.meta.url), "utf8");
  return { default: { get: async () => YAML.parse(text) } };
});
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {}, onLive: () => {} }));
// the disclaimer's versions and who accepted them, in memory, its link in the fixture's table
let acceptances;
vi.mock("../src/models/disclaimer.model.js", async () => {
  const fx = await import("./fixtures/repoObjects.mjs");
  const rows = () => fx.state.tables.disclaimer_versions;
  const enabledOf = () => fx.state.tables.settings[0]?.disclaimer_version;
  const Disclaimer = {
    versions: async () => rows().map((r) => ({ id: r.version, ...r, enabled: r.version === enabledOf() ? 1 : 0, acceptances: acceptances[r.version] || 0 })),
    version: async (v) => {
      const found = (await Disclaimer.versions()).find((r) => String(r.version) === String(v));
      if (!found) throw new Error(`No disclaimer version ${v}`);
      return found;
    },
    createVersion: async (d) => {
      rows().push({ version: Number(d.version), title: d.title, text: d.text, checkbox_label: d.checkbox_label, repository: null, repo_file: null });
      return Number(d.version);
    },
    updateVersion: async (v, d) => {
      Object.assign(rows().find((r) => r.version === Number(v)), { title: d.title, text: d.text, checkbox_label: d.checkbox_label });
      if (d.askAgain) acceptances[v] = 0;
    },
    enableVersion: async (v, on) => {
      fx.state.tables.settings[0].disclaimer_version = on ? Number(v) : null;
    },
    deleteVersion: async (v) => {
      fx.state.tables.disclaimer_versions = rows().filter((r) => r.version !== Number(v));
    },
  };
  return { default: Disclaimer };
});

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const desc = (key) => RepoObjects.descriptorOf(key);

// a PNG as the sniffing reads it : its signature, then anything
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of the image")]);
const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
const writeRaw = (repo, file, content) => {
  fs.mkdirSync(path.join(fx.ROOT, repo), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, repo, file), content);
};
const readRaw = (repo, file) => fs.readFileSync(path.join(fx.ROOT, repo, file));

beforeEach(() => {
  process.env.CHAT_KEY = "sk-from-env";
  delete process.env.JOB_RETENTION_DAYS;
  delete process.env.DEFAULT_LANGUAGE;
  for (const name of ["ENABLE_MCP", "MCP_READ_ONLY", "MCP_CHAT_FORMS_ONLY"]) delete process.env[name];
  fs.rmSync(MANAGED, { force: true });
  audits.length = 0;
  acceptances = { 1: 5 };
  fx.reset({
    repositories: [
      { id: 1, name: "cfg", use_for_chat: 1, use_for_general: 1, use_for_branding: 1, use_for_links: 1, use_for_mcp: 1 },
      { id: 2, name: "news", use_for_announcements: 1, use_for_disclaimer: 1 },
    ],
    credentials: [{ id: 1, name: "chat-key", credential_type: "api", password: "enc:k" }],
    chat_settings: [{ provider: "", api_key: "enc:old-key", model: "", max_turns: 20, allow_job_status: 1, managed: 0 }],
    settings: [{ id: 1, app_name: "Old name", header_links: null, default_theme: "system", logo: null, favicon: null, disclaimer_version: null }],
    disclaimer_versions: [],
  });
  CrudModel.flushAllLocal();
});

// ─── the single-file mode ──────────────────────────────────────────────────────
describe("a type kept in one file : the chat assistant", () => {
  test("a pull applies its file, its ${ENV} key resolved ; an unchanged file changes nothing", async () => {
    writeRaw("cfg", "chat.yaml", "provider: openai\nmodel: gpt-5\napi_key: ${CHAT_KEY}\n");
    const summary = await RepoObjects.syncRepository(await desc("chat"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    const row = fx.state.tables.chat_settings[0];
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-5");
    assert.equal(row.api_key, "enc:sk-from-env");
    assert.equal((await RepoObjects.syncRepository(await desc("chat"), "cfg")).unchanged, 1);
  });

  test("a plain key is refused, the app left as it is ; a credential not there yet waits", async () => {
    writeRaw("cfg", "chat.yaml", "provider: openai\napi_key: sk-plain\n");
    const refused = await RepoObjects.syncRepository(await desc("chat"), "cfg");
    assert.match(refused.refused[0].reasons[0], /api_key must be an \$\{ENV\} reference/);
    assert.equal(fx.state.tables.chat_settings[0].provider, "");
    writeRaw("cfg", "chat.yaml", "provider: openai\ncredential: missing-key\n");
    const waiting = await RepoObjects.syncRepository(await desc("chat"), "cfg");
    assert.match(waiting.waiting[0].reasons[0], /waits for the credential 'missing-key'/);
  });

  test("no file : turning it on writes the app's values, without the key ; an edit rewrites what changed", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.chat_settings[0], { provider: "openai", model: "gpt-5" });
    const p = await RepoObjects.preview(await desc("chat"), "cfg");
    assert.deepEqual(p.written, ["Chat assistant"]);
    assert.deepEqual(p.withoutSecret, ["Chat assistant"]);
    const report = await RepoObjects.activate(await desc("chat"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["Chat assistant"]);
    assert.deepEqual(fx.readObject("cfg", ".", "chat.yaml"), { provider: "openai", model: "gpt-5", max_turns: 20, allow_job_status: true });
    // edited in the app : only the model rewritten
    const before = await RepoObjects.snapshot("chat");
    fx.state.tables.chat_settings[0].model = "gpt-6";
    assert.equal(await RepoObjects.appUpdated("chat", before), true);
    assert.equal(fx.readObject("cfg", ".", "chat.yaml").model, "gpt-6");
    // and a pull says its key stays the database's
    const summary = await RepoObjects.syncRepository(await desc("chat"), "cfg");
    assert.deepEqual(summary.secretsKept, ["Chat assistant"]);
  });

  test("a file there when it is turned on : git wins, the app's values not written", async () => {
    writeRaw("cfg", "chat.yaml", "model: from-git\n");
    const report = await RepoObjects.activate(await desc("chat"), "cfg", { pull: false });
    assert.deepEqual(report.matched, ["Chat assistant"]);
    assert.deepEqual(report.written, []);
    assert.equal(fx.state.tables.chat_settings[0].model, "from-git");
    assert.equal(fx.readText("cfg", ".", "chat.yaml"), "model: from-git\n");
  });

  test("turned off : read once more, the app keeps its values, the file stays", async () => {
    writeRaw("cfg", "chat.yaml", "model: last\n");
    const report = await RepoObjects.deactivate(await desc("chat"), "cfg");
    assert.equal(report.unlinked, 1);
    assert.equal(fx.state.tables.chat_settings[0].model, "last");
    assert.ok(fs.existsSync(path.join(fx.ROOT, "cfg", "chat.yaml")));
  });
});

// ─── the settings ──────────────────────────────────────────────────────────────
describe("the System > General settings, by their environment names", () => {
  test("a pull applies them as the page's Save : written, applied, audited", async () => {
    writeRaw("cfg", "general.yaml", "JOB_RETENTION_DAYS: 30\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.match(fs.readFileSync(MANAGED, "utf8"), /JOB_RETENTION_DAYS='30'/);
    assert.equal(audits[0].action, "settings.env.update");
    assert.deepEqual(audits[0].detail.changed, ["JOB_RETENTION_DAYS"]);
    assert.equal((await RepoObjects.syncRepository(await desc("general"), "cfg")).unchanged, 1);
  });

  test("only what the page changes : another page's, an unknown one, a bad value, a plain secret refused", async () => {
    writeRaw("cfg", "general.yaml", "BASE_URL: /af/\nNOT_A_SETTING: 1\nJOB_RETENTION_DAYS: lots\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    const why = summary.refused[0].reasons.join(" ");
    assert.match(why, /BASE_URL is not one Settings > System > General changes/);
    assert.match(why, /NOT_A_SETTING is not a known environment variable/);
    assert.match(why, /JOB_RETENTION_DAYS/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
    writeRaw("cfg", "general.yaml", "DB_PASSWORD: plain\n");
    assert.match((await RepoObjects.syncRepository(await desc("general"), "cfg")).refused[0].reasons[0], /DB_PASSWORD must be an \$\{ENV\} reference/);
  });

  test("a save from the page rewrites the file, its secrets never", async () => {
    writeRaw("cfg", "general.yaml", "# ops\nJOB_RETENTION_DAYS: 30\n");
    await RepoObjects.syncRepository(await desc("general"), "cfg");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const before = await RepoObjects.snapshot("general");
    await saveEnvValues({ JOB_RETENTION_DAYS: "45" }, { user: "root" });
    await RepoObjects.appUpdated("general", before);
    assert.equal(fx.readText("cfg", ".", "general.yaml"), "# ops\nJOB_RETENTION_DAYS: \"45\"\n");
  });
});

// ─── the MCP settings ──────────────────────────────────────────────────────────
describe("the MCP settings, in their mcp.yaml", () => {
  test("turned on : every switch written with its value ; a pull applies ENABLE_MCP at once ; an edit rewrites it ; turned off", async () => {
    fx.cloneEmpty("cfg");
    const report = await RepoObjects.activate(await desc("mcp"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["MCP"]);
    assert.deepEqual(fx.readObject("cfg", ".", "mcp.yaml"), { ENABLE_MCP: "0", MCP_CHAT_FORMS_ONLY: "0", MCP_READ_ONLY: "0" });
    // a pull : saved as the page saves it, the server switched on without a restart
    const { default: appConfig } = await import("./__mocks__/app.config.js");
    writeRaw("cfg", "mcp.yaml", "ENABLE_MCP: 1\nMCP_READ_ONLY: 0\n");
    const summary = await RepoObjects.syncRepository(await desc("mcp"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(appConfig.enableMcp, true);
    assert.doesNotMatch(RepoObjects.summaryText(await desc("mcp"), summary), /restart/);
    assert.match(fs.readFileSync(MANAGED, "utf8"), /ENABLE_MCP='1'/);
    assert.deepEqual(audits[0].detail, { changed: ["ENABLE_MCP"], restartRequired: [] });
    assert.equal((await RepoObjects.syncRepository(await desc("mcp"), "cfg")).unchanged, 1);
    // a save from the page rewrites the file
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const before = await RepoObjects.snapshot("mcp");
    await saveEnvValues({ MCP_READ_ONLY: "1" }, { user: "root" });
    await RepoObjects.appUpdated("mcp", before);
    assert.equal(fx.readObject("cfg", ".", "mcp.yaml").MCP_READ_ONLY, "1");
    // turned off : the app keeps its values, the file stays
    assert.equal((await RepoObjects.deactivate(await desc("mcp"), "cfg")).unlinked, 1);
    assert.equal(appConfig.enableMcp, true);
    assert.ok(fs.existsSync(path.join(fx.ROOT, "cfg", "mcp.yaml")));
    appConfig.enableMcp = false;
  });

  test("never one variable for both : the settings refuse the MCP switches, the MCP the settings'", async () => {
    const { envDocs, ownsVariable } = await import("../src/lib/envSave.js");
    const docs = await envDocs();
    const both = [...docs.keys()].filter((name) => ownsVariable("general", name, docs) && ownsVariable("mcp", name, docs));
    assert.deepEqual(both, []);
    assert.deepEqual([...docs.keys()].filter((name) => ownsVariable("mcp", name, docs)).sort(), ["ENABLE_MCP", "MCP_CHAT_FORMS_ONLY", "MCP_READ_ONLY"]);
    writeRaw("cfg", "general.yaml", "ENABLE_MCP: 1\n");
    assert.match((await RepoObjects.syncRepository(await desc("general"), "cfg")).refused[0].reasons[0], /ENABLE_MCP is not one Settings > System > General changes/);
    writeRaw("cfg", "mcp.yaml", "JOB_RETENTION_DAYS: 30\nMCP_READ_ONLY: 1\n");
    const why = (await RepoObjects.syncRepository(await desc("mcp"), "cfg")).refused[0].reasons.join(" ");
    assert.match(why, /JOB_RETENTION_DAYS is not one Settings > Connections > MCP changes/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
  });

  test("the seed's mcp section holds its switches : refused in the app, kept out of the repository's file", async () => {
    const { setSeedManagedBranding, seedManagedBranding } = await import("../src/lib/brandingManaged.js");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const { validateSeed } = await import("../src/lib/seed-schema.js");
    assert.equal(validateSeed({ mcp: { ENABLE_MCP: true, MCP_READ_ONLY: 1 } }), true);
    assert.throws(() => validateSeed({ mcp: { JOB_RETENTION_DAYS: 30 } }), /validation failed/);
    await setSeedManagedBranding(["MCP_READ_ONLY"]);
    assert.deepEqual(await seedManagedBranding(), ["MCP_READ_ONLY"]);
    await assert.rejects(saveEnvValues({ MCP_READ_ONLY: "1" }, {}), { status: 403, message: /MCP_READ_ONLY/ });
    // turned on : listed as staying in the app, never written to the file
    fx.cloneEmpty("cfg");
    assert.deepEqual((await RepoObjects.preview(await desc("mcp"), "cfg")).kept.map((k) => k.name), ["MCP_READ_ONLY"]);
    await RepoObjects.activate(await desc("mcp"), "cfg", { pull: false });
    assert.deepEqual(fx.readObject("cfg", ".", "mcp.yaml"), { ENABLE_MCP: "0", MCP_CHAT_FORMS_ONLY: "0" });
    // a file declaring it : not applied, said ; the others applied
    writeRaw("cfg", "mcp.yaml", "MCP_READ_ONLY: 1\nMCP_CHAT_FORMS_ONLY: 1\n");
    const summary = await RepoObjects.syncRepository(await desc("mcp"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(process.env.MCP_READ_ONLY, undefined);
    assert.equal(process.env.MCP_CHAT_FORMS_ONLY, "1");
    assert.match(RepoObjects.summaryText(await desc("mcp"), summary), /Kept by the config seed, not applied: MCP_READ_ONLY/);
    // the seed's own section applies it
    const done = await RepoObjects.applyDeclared(await desc("mcp"), { MCP_READ_ONLY: true }, {});
    assert.deepEqual(done.updated, ["mcp"]);
    assert.equal(process.env.MCP_READ_ONLY, "1");
    // released when the seed stops declaring it
    assert.deepEqual(await setSeedManagedBranding([]), ["MCP_READ_ONLY"]);
    await saveEnvValues({ MCP_READ_ONLY: "0" }, {});
  });
});

// ─── the branding ──────────────────────────────────────────────────────────────
describe("the branding and its images", () => {
  test("a pull applies its fields and reads its logo as binary, checked as an upload", async () => {
    writeRaw("cfg", "branding.yaml", "app_name: ACME\ndefault_theme: dark\nlogo: logo.png\n");
    writeRaw("cfg", "logo.png", PNG);
    const summary = await RepoObjects.syncRepository(await desc("branding"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    const row = fx.state.tables.settings[0];
    assert.equal(row.app_name, "ACME");
    assert.equal(row.default_theme, "dark");
    assert.equal(row.logo, dataUrl(PNG));
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await desc("branding"), "cfg")).unchanged, 1);
  });

  test("an image that is no image, too large, or outside the repository is refused", async () => {
    writeRaw("cfg", "logo.png", Buffer.from("not an image"));
    writeRaw("cfg", "branding.yaml", "logo: logo.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("branding"), "cfg")).refused[0].reasons[0], /not an image the app takes/);
    writeRaw("cfg", "icon.png", Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
    writeRaw("cfg", "branding.yaml", "icon: icon.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("branding"), "cfg")).refused[0].reasons[0], /larger than 256 KB/);
    writeRaw("cfg", "branding.yaml", "logo: ../elsewhere.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("branding"), "cfg")).refused[0].reasons[0], /not a file beside it/);
  });

  test("turned on : the app's branding written, its logo beside it as binary ; a new logo rewrites it", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.settings[0], { app_name: "Mine", logo: dataUrl(PNG) });
    await RepoObjects.activate(await desc("branding"), "cfg", { pull: false });
    const file = fx.readObject("cfg", ".", "branding.yaml");
    assert.equal(file.app_name, "Mine");
    assert.equal(file.logo, "logo.png");
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), PNG), 0);
    // a new logo in the app : the image rewritten, the YAML as it was
    const before = await RepoObjects.snapshot("branding");
    const other = Buffer.concat([PNG, Buffer.from("v2")]);
    fx.state.tables.settings[0].logo = dataUrl(other);
    await RepoObjects.appUpdated("branding", before);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), other), 0);
    assert.equal(fx.readObject("cfg", ".", "branding.yaml").logo, "logo.png");
  });

  test("the seed's branding section : read the same way, its image relative to the seed file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-seed-"));
    fs.mkdirSync(path.join(dir, "img"));
    fs.writeFileSync(path.join(dir, "img", "logo.png"), PNG);
    const done = await RepoObjects.applyDeclared(await desc("branding"), { app_name: "Seeded", logo: "img/logo.png" }, { dir });
    assert.deepEqual(done.updated, ["branding"]);
    assert.equal(fx.state.tables.settings[0].app_name, "Seeded");
    assert.equal(fx.state.tables.settings[0].logo, dataUrl(PNG));
  });
});

// ─── the header's links ────────────────────────────────────────────────────────
describe("the header's links, in their own links.yaml", () => {
  const LINK = { id: "a", label: "Docs", url: "https://docs.example.com", icon: "book", newTab: true, parent: null };

  test("turned on : written to links.yaml, never to branding.yaml ; a pull applies it ; an edit rewrites it", async () => {
    fx.cloneEmpty("cfg");
    fx.state.tables.settings[0].header_links = JSON.stringify([LINK]);
    const report = await RepoObjects.activate(await desc("links"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["Links"]);
    const file = fx.readObject("cfg", ".", "links.yaml");
    assert.equal(file.header_links[0].label, "Docs");
    assert.equal(file.show_designer, true);
    // the branding holds no link any more
    await RepoObjects.activate(await desc("branding"), "cfg", { pull: false });
    const branding = fx.readObject("cfg", ".", "branding.yaml");
    assert.equal(branding.header_links, undefined);
    assert.equal(branding.show_designer, undefined);
    writeRaw("cfg", "branding.yaml", "header_links: []\n");
    assert.match((await RepoObjects.syncRepository(await desc("branding"), "cfg")).refused[0].reasons[0], /'header_links'/);
    // a pull of links.yaml : the links follow it
    writeRaw("cfg", "links.yaml", "header_links:\n  - { id: b, label: Wiki, url: 'https://wiki' }\n");
    const summary = await RepoObjects.syncRepository(await desc("links"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(JSON.parse(fx.state.tables.settings[0].header_links)[0].label, "Wiki");
    // an edit in the app rewrites the file
    const before = await RepoObjects.snapshot("links");
    fx.state.tables.settings[0].header_links = JSON.stringify([LINK]);
    await RepoObjects.appUpdated("links", before);
    assert.equal(fx.readObject("cfg", ".", "links.yaml").header_links[0].label, "Docs");
    // turned off : the app keeps its links, the file stays
    assert.equal((await RepoObjects.deactivate(await desc("links"), "cfg")).unlinked, 1);
    assert.ok(fs.existsSync(path.join(fx.ROOT, "cfg", "links.yaml")));
  });

  test("the seed's links are its own : refused in the app, kept out of the repository's file", async () => {
    const { setSeedManagedBranding } = await import("../src/lib/brandingManaged.js");
    const { saveSettingsFields } = await import("../src/lib/appearance.js");
    await setSeedManagedBranding(["header_links"]);
    await assert.rejects(saveSettingsFields({ header_links: [LINK] }), { status: 403 });
    writeRaw("cfg", "links.yaml", "header_links: []\n");
    const summary = await RepoObjects.syncRepository(await desc("links"), "cfg");
    assert.match(RepoObjects.summaryText(await desc("links"), summary), /Kept by the config seed, not applied: header_links/);
    assert.deepEqual((await RepoObjects.preview(await desc("links"), "cfg")).kept.map((k) => k.name), ["header_links"]);
    // the seed's own section applies them
    const done = await RepoObjects.applyDeclared(await desc("links"), { header_links: [LINK] }, {});
    assert.deepEqual(done.updated, ["links"]);
    assert.equal(JSON.parse(fx.state.tables.settings[0].header_links)[0].label, "Docs");
  });
});

// ─── the branding the config seed manages ─────────────────────────────────────
describe("the branding fields the config seed declares are its own", () => {
  test("refused through the save helpers ; the others, and one sent back as it is, still saved", async () => {
    const { setSeedManagedBranding } = await import("../src/lib/brandingManaged.js");
    const { saveSettingsFields } = await import("../src/lib/appearance.js");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const { BRAND_IMAGES } = await import("../src/lib/brandImages.js");
    await setSeedManagedBranding(["app_name", "logo", "default_language"]);
    await assert.rejects(saveSettingsFields({ app_name: "Mine" }), { status: 403, message: /Managed by the config seed and read only here: app_name/ });
    await assert.rejects(BRAND_IMAGES.logo.set(dataUrl(PNG)), { status: 403 });
    await assert.rejects(saveEnvValues({ DEFAULT_LANGUAGE: "fr" }, {}), { status: 403 });
    // what the seed does not declare stays editable ; the name sent back as it is passes
    assert.equal(await saveSettingsFields({ default_theme: "dark", app_name: "Old name" }), true);
    assert.equal(fx.state.tables.settings[0].default_theme, "dark");
    await BRAND_IMAGES.icon.set(dataUrl(PNG));
    // the seed's own write passes
    await saveSettingsFields({ app_name: "Seeded" }, { fromSeed: true });
    assert.equal(fx.state.tables.settings[0].app_name, "Seeded");
  });

  test("a field the seed stops declaring is released", async () => {
    const { setSeedManagedBranding, seedManagedBranding } = await import("../src/lib/brandingManaged.js");
    await setSeedManagedBranding(["app_name", "logo"]);
    assert.deepEqual(await setSeedManagedBranding(["app_name"]), ["logo"]);
    assert.deepEqual(await seedManagedBranding(), ["app_name"]);
    const { BRAND_IMAGES } = await import("../src/lib/brandImages.js");
    await BRAND_IMAGES.logo.set(dataUrl(PNG));
  });

  test("with a branding repository : the seed's fields stay the seed's, the repository holds the rest", async () => {
    const { setSeedManagedBranding } = await import("../src/lib/brandingManaged.js");
    await setSeedManagedBranding(["app_name"]);
    Object.assign(fx.state.tables.settings[0], { app_name: "Seeded", default_theme: "light" });
    fx.cloneEmpty("cfg");
    // turned on : the seed's field listed as staying in the app, never written to the file
    const p = await RepoObjects.preview(await desc("branding"), "cfg");
    assert.deepEqual(p.kept, [{ name: "app_name", code: "seed", reason: "managed by the config seed" }]);
    await RepoObjects.activate(await desc("branding"), "cfg", { pull: false });
    assert.equal(fx.readObject("cfg", ".", "branding.yaml").app_name, undefined);
    assert.equal(fx.readObject("cfg", ".", "branding.yaml").default_theme, "light");
    // a file declaring it : not applied, said ; the other fields applied
    writeRaw("cfg", "branding.yaml", "app_name: From git\ndefault_theme: dark\n");
    const summary = await RepoObjects.syncRepository(await desc("branding"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.state.tables.settings[0].app_name, "Seeded");
    assert.equal(fx.state.tables.settings[0].default_theme, "dark");
    assert.match(RepoObjects.summaryText(await desc("branding"), summary), /Kept by the config seed, not applied: app_name/);
  });
});

// ─── the announcements and the disclaimer ──────────────────────────────────────
describe("the announcements", () => {
  test("named, their moments in UTC : made, then unchanged ; one of the app written with a name", async () => {
    fx.writeFile("news", "announcements", "maintenance.yaml", { name: "Maintenance", message: "Down on Sunday", level: "warning", start_at: "2030-01-01T08:00:00Z" });
    const summary = await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.equal(summary.created, 1, JSON.stringify(summary));
    const row = fx.rowNamed("announcements", "Maintenance");
    assert.equal(row.start_at, "2030-01-01 08:00:00");
    assert.equal(row.repository, "news");
    assert.equal((await RepoObjects.syncRepository(await desc("announcements"), "news")).unchanged, 1);
    // one made in the app, no name : written with the start of its message, and keeps it
    fx.state.tables.announcements.push({ id: 7, name: null, message: "New forms are coming", level: "info", enabled: 1 });
    const report = await RepoObjects.activate(await desc("announcements"), "news", { pull: false });
    assert.deepEqual(report.written, ["New forms are coming"]);
    assert.equal(fx.state.tables.announcements.find((r) => r.id === 7).name, "New forms are coming");
  });
});

describe("an announcement already ended in git", () => {
  const ended = { name: "Maintenance", message: "Down on Sunday", end_at: "2020-01-01T10:00:00Z" };

  test("is not imported : no refusal, an information line, the sync goes on", async () => {
    fx.writeFile("news", "announcements", "maintenance.yaml", ended);
    fx.writeFile("news", "announcements", "later.yaml", { name: "Later", message: "Soon", end_at: "2099-01-01T10:00:00Z" });
    const summary = await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.created, 1, "a future end still imports");
    assert.equal(fx.rowNamed("announcements", "Maintenance"), undefined);
    assert.match(RepoObjects.summaryText(await desc("announcements"), summary), /Not imported, already ended: Maintenance \(announcements\/maintenance.yaml\)/);
    // and the question before turning the usage on says how many are skipped
    assert.equal((await RepoObjects.preview(await desc("announcements"), "news")).skipped, 1);
  });

  test("a linked one whose file has since ended is removed from the app, its file left as it is", async () => {
    fx.writeFile("news", "announcements", "maintenance.yaml", { ...ended, end_at: "2099-01-01T10:00:00Z" });
    await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.ok(fx.rowNamed("announcements", "Maintenance"));
    fx.writeFile("news", "announcements", "maintenance.yaml", ended);
    const text = fx.readText("news", "announcements", "maintenance.yaml");
    const summary = await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.equal(summary.deleted, 1);
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.rowNamed("announcements", "Maintenance"), undefined);
    assert.equal(fx.readText("news", "announcements", "maintenance.yaml"), text);
    // and later pulls skip it, never refused
    assert.deepEqual((await RepoObjects.syncRepository(await desc("announcements"), "news")).refused, []);
  });

  test("the app's own clean-up of an ended linked announcement leaves git untouched", async () => {
    fx.writeFile("news", "announcements", "maintenance.yaml", { ...ended, end_at: "2099-01-01T10:00:00Z" });
    await RepoObjects.syncRepository(await desc("announcements"), "news");
    const before = await RepoObjects.rowsOf("announcements");
    const text = fx.readText("news", "announcements", "maintenance.yaml");
    // it ends meanwhile : the app's clean-up removes it on the next read
    fx.rowNamed("announcements", "Maintenance").end_at = "2020-01-01 10:00:00";
    before[0].end_at = "2020-01-01 10:00:00";
    fx.state.calls.length = 0;
    await RepoObjects.appChangedRows("announcements", before);
    assert.equal(fx.rowNamed("announcements", "Maintenance"), undefined);
    assert.equal(fx.readText("news", "announcements", "maintenance.yaml"), text);
    assert.deepEqual(fx.state.calls, [], "no write claim : nothing staged");
  });
});

describe("the disclaimer versions", () => {
  const file = (extra = {}) => ({ version: 1, title: "Terms", text: "Be nice", checkbox_label: "I agree", enabled: true, ...extra });

  test("a version from git is made and put in force ; acceptances never in the file", async () => {
    fx.writeFile("news", "disclaimer", "1.yaml", file());
    const summary = await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(summary.created, 1, JSON.stringify(summary));
    assert.equal(fx.state.tables.settings[0].disclaimer_version, 1);
    assert.equal(fx.state.tables.disclaimer_versions[0].repository, "news");
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).unchanged, 1);
  });

  test("a changed text is a correction ; with ask_again, everyone is asked again", async () => {
    fx.writeFile("news", "disclaimer", "1.yaml", file());
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    acceptances[1] = 5;
    fx.writeFile("news", "disclaimer", "1.yaml", file({ text: "Be very nice" }));
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(fx.state.tables.disclaimer_versions[0].text, "Be very nice");
    assert.equal(acceptances[1], 5, "a correction keeps who accepted it");
    fx.writeFile("news", "disclaimer", "1.yaml", file({ text: "Be kind", ask_again: true }));
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(acceptances[1], 0, "everyone asked again");
    // ask_again with the text unchanged : nothing happens
    acceptances[1] = 2;
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).unchanged, 1);
    assert.equal(acceptances[1], 2);
  });
});
