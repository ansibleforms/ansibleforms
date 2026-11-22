// The last object types on the engine (lib/repoObjects) : the ones the app has ONE object of, a map
// under its key in one file of their repository - the chat assistant (chat_assistant:), the System >
// General settings (general:), the Appearance pages (defaults:, logo:, icon:, name:, links:) - and
// the announcements and the disclaimer versions, lists of entries. On the shared fixture :
//   single mode       a pull applies the map (git wins), turning the type on writes the app's
//                     values when no file gives it, an edit in the app rewrites only what changed,
//                     its secret an ${ENV} reference only, what it names waited for
//   general           checked and applied as the settings page's Save : a variable another page or
//                     the deployment owns refused, a secret only as ${ENV}, a restart said
//   mcp               the MCP page's switches the same way (mcp:), applied at once, never a
//                     variable of the settings' ; the seed's mcp section holding them per variable
//   appearance        one key per page, holding what that page saves and nothing else, a page's
//                     save writing its own key only ; the logo's and the icon's images named
//                     relative to their file, read and written as binary, checked as an upload
//   announcements     named, their moments compared in UTC, one made in the app named on its way
//   disclaimer        a changed text a correction, or everyone asked again when the entry says so
//   the seed          the defaults, logo, icon and name sections read through the same descriptors,
//                     the images relative to it
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
  // the words stored as the model stores them (cleaned : trimmed, within their length)
  const { default: actual } = await vi.importActual("../src/models/disclaimer.model.js");
  const rows = () => fx.state.tables.disclaimer_versions;
  const enabledOf = () => fx.state.tables.settings[0]?.disclaimer_version;
  const Disclaimer = {
    versions: async () => rows().map((r) => ({ id: r.version, ...r, enabled: r.version === enabledOf() ? 1 : 0, acceptances: acceptances[r.version] || 0 })),
    version: async (v) => {
      const found = (await Disclaimer.versions()).find((r) => String(r.version) === String(v));
      if (!found) throw new Error(`No disclaimer version ${v}`);
      return found;
    },
    cleanWords: actual.cleanWords,
    createVersion: async (d) => {
      rows().push({ version: Number(d.version), ...actual.words(d), repository: null, repo_file: null });
      return Number(d.version);
    },
    updateVersion: async (v, d) => {
      Object.assign(rows().find((r) => r.version === Number(v)), actual.words(d));
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
const { default: logger } = await import("./__mocks__/logger.js");
const desc = (key) => RepoObjects.descriptorOf(key);
const { fileKeyOf } = await import("../src/lib/repoObjects/types.js");

// a PNG as the sniffing reads it : its signature, then anything
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of the image")]);
const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
// the type each YAML file of these tests holds, by the name the tests give it : any name would do,
// a file is read by its content (its top-level key)
const KEY_OF = {
  "chat-assistant.yaml": "chat_assistant",
  "chat_assistant.yaml": "chat_assistant",
  "general.yaml": "general",
  "mcp.yaml": "mcp",
  "defaults.yaml": "defaults",
  "logo.yaml": "logo",
  "icon.yaml": "icon",
  "name.yaml": "name",
  "links.yaml": "links",
};
// a type's map as text (provider: openai ...), written under its key, and read back so
const wrapped = (key, text) => `${fileKeyOf(key)}:\n${String(text).split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}`;
const unwrapped = (text) => text.split("\n").slice(1).map((l) => l.replace(/^ {2}/, "")).join("\n");
const writeRaw = (repo, file, content) => {
  fs.mkdirSync(path.dirname(path.join(fx.ROOT, repo, file)), { recursive: true });
  const key = KEY_OF[path.basename(file)];
  // a text already under its key (controller_logo:\n  logo: logo.png) written as it is
  const under = typeof content === "string" && new RegExp(`^${fileKeyOf(key)}:[ \\t]*(\\n|$)`, "m").test(content);
  fs.writeFileSync(path.join(fx.ROOT, repo, file), typeof content === "string" && key && !under ? wrapped(key, content) : content);
};
const readRaw = (repo, file) => fs.readFileSync(path.join(fx.ROOT, repo, file));
// a type's map of a file, and its text under its key
const readMapOf = (repo, file) => fx.readMap(repo, file, KEY_OF[path.basename(file)]);
const readFlat = (repo, file) => unwrapped(fx.textOf(repo, file));

beforeEach(() => {
  process.env.CHAT_KEY = "sk-from-env";
  for (const name of ["JOB_RETENTION_DAYS", "GIT_PULL_COMMAND", "ACCESS_TOKEN_ISSUER", "AUDIT_RETENTION_DAYS"]) delete process.env[name];
  delete process.env.DEFAULT_LANGUAGE;
  for (const name of ["ENABLE_MCP", "MCP_READ_ONLY", "MCP_CHAT_FORMS_ONLY", "ENABLE_CHAT"]) delete process.env[name];
  fs.rmSync(MANAGED, { force: true });
  audits.length = 0;
  acceptances = { 1: 5 };
  fx.reset({
    repositories: [
      { id: 1, name: "cfg", use_for_chat_assistant: 1, use_for_general: 1, use_for_defaults: 1, use_for_logo: 1, use_for_icon: 1, use_for_name: 1, use_for_links: 1, use_for_mcp: 1 },
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
describe("a type the app has one of : the chat assistant", () => {
  test("a pull applies its file, its ${ENV} key resolved ; an unchanged file changes nothing", async () => {
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\nmodel: gpt-5\napi_key: ${CHAT_KEY}\n");
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    const row = fx.state.tables.chat_settings[0];
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-5");
    assert.equal(row.api_key, "enc:sk-from-env");
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).unchanged, 1);
  });

  test("a plain key is refused, the app left as it is ; a credential not there yet waits", async () => {
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\napi_key: sk-plain\n");
    const refused = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.match(refused.refused[0].reasons[0], /api_key must be an \$\{ENV\} reference/);
    assert.equal(fx.state.tables.chat_settings[0].provider, "");
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\ncredential: missing-key\n");
    const waiting = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.match(waiting.waiting[0].reasons[0], /waits for the credential 'missing-key'/);
  });

  test("a file that moves the chat to another address : its stored key and credential stay behind, unless it gives them", async () => {
    Object.assign(fx.state.tables.chat_settings[0], { provider: "openai", model: "gpt-5", base_url: "", credential: "chat-key" });
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\nmodel: gpt-5\nbase_url: https://collector.example/v1\n");
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    const row = fx.state.tables.chat_settings[0];
    assert.equal(row.base_url, "https://collector.example/v1");
    assert.equal(row.api_key, "", "the stored key never goes to the address the file chose");
    assert.equal(row.credential, null);
    assert.deepEqual(summary.secretsKept, []);
    assert.match(summary.notes.join("\n"), /stored api key was cleared/);
    assert.match(summary.notes.join("\n"), /credential 'chat-key' was let go/);
    // the same address with its key given : taken
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\nmodel: gpt-5\nbase_url: https://collector.example/v1/\napi_key: ${CHAT_KEY}\n");
    await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.equal(row.api_key, "enc:sk-from-env");
    // another model, the address the same : the key stays
    writeRaw("cfg", "chat-assistant.yaml", "provider: openai\nmodel: gpt-6\nbase_url: https://collector.example/v1\n");
    await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.equal(row.model, "gpt-6");
    assert.equal(row.api_key, "enc:sk-from-env");
  });

  test("no file : turning it on writes the app's values, without the key ; an edit rewrites what changed", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.chat_settings[0], { provider: "openai", model: "gpt-5" });
    const p = await RepoObjects.preview(await desc("chat_assistant"), "cfg");
    assert.deepEqual(p.written, ["Chat assistant"]);
    assert.deepEqual(p.withoutSecret, ["Chat assistant"]);
    const report = await RepoObjects.activate(await desc("chat_assistant"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["Chat assistant"]);
    // no file gives it : written to <key>.yaml at the root
    assert.equal(report.file, "chat_assistant.yaml");
    assert.equal(p.file, "chat_assistant.yaml");
    assert.deepEqual(readMapOf("cfg", "chat_assistant.yaml"), { enable_chat: false, provider: "openai", model: "gpt-5", max_turns: 20, allow_job_status: true });
    // edited in the app : only the model rewritten
    const before = await RepoObjects.snapshot("chat_assistant");
    fx.state.tables.chat_settings[0].model = "gpt-6";
    assert.equal(await RepoObjects.appUpdated("chat_assistant", before), true);
    assert.equal(readMapOf("cfg", "chat_assistant.yaml").model, "gpt-6");
    // and a pull says its key stays the database's
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.deepEqual(summary.secretsKept, ["Chat assistant"]);
  });

  test("a file there when it is turned on : git wins, the app's values not written", async () => {
    writeRaw("cfg", "chat-assistant.yaml", "model: from-git\n");
    const report = await RepoObjects.activate(await desc("chat_assistant"), "cfg", { pull: false });
    assert.deepEqual(report.matched, ["Chat assistant"]);
    assert.deepEqual(report.written, []);
    assert.equal(fx.state.tables.chat_settings[0].model, "from-git");
    assert.equal(readFlat("cfg", "chat-assistant.yaml"), "model: from-git\n");
  });

  test("its file a link that leads outside the repository : never read, never written through", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-"));
    const target = path.join(outside, "server.yaml");
    fs.writeFileSync(target, "model: read-from-the-server\n");
    fx.cloneEmpty("cfg");
    fs.symlinkSync(target, path.join(fx.ROOT, "cfg", "chat-assistant.yaml"));
    await RepoObjects.syncText(await desc("chat_assistant"), "cfg");
    const preview = await RepoObjects.preview(await desc("chat_assistant"), "cfg");
    assert.deepEqual(preview.refused, [{ file: "chat-assistant.yaml", reasons: ["a link that leads outside the repository: never read"] }]);
    assert.deepEqual(preview.written, []);
    assert.equal(fx.state.tables.chat_settings[0].model ?? "", "");
    // an edit in the app : the file outside left as it was
    const before = { ...(await RepoObjects.snapshot("chat_assistant")) };
    fx.state.tables.chat_settings[0].model = "gpt-6";
    await RepoObjects.appUpdated("chat_assistant", before);
    assert.equal(fs.readFileSync(target, "utf8"), "model: read-from-the-server\n");
  });

  test("the config seed's chat : it stays with the seed, never written to git, its file not applied", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.chat_settings[0], { provider: "openai", model: "seeded", managed: 1 });
    const p = await RepoObjects.preview(await desc("chat_assistant"), "cfg");
    assert.deepEqual(p.written, []);
    assert.deepEqual(p.kept, [{ name: "Chat assistant", whole: true, code: "seed", reason: "managed by the config seed" }]);
    const report = await RepoObjects.activate(await desc("chat_assistant"), "cfg", { pull: false });
    assert.deepEqual(report.written, []);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "chat-assistant.yaml")), false, "nothing written");
    // a file in git : not applied, said, never refused
    writeRaw("cfg", "chat-assistant.yaml", "model: from-git\n");
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.state.tables.chat_settings[0].model, "seeded");
    assert.match(RepoObjects.summaryText(await desc("chat_assistant"), summary), /Kept by the config seed, not applied: controller_chat_assistant: of chat-assistant\.yaml/);
    // the app's own write (the seed's apply) never reaches the file
    const before = await RepoObjects.snapshot("chat_assistant");
    fx.state.tables.chat_settings[0].model = "seeded-2";
    assert.equal(await RepoObjects.appUpdated("chat_assistant", before), false);
    assert.equal(readFlat("cfg", "chat-assistant.yaml"), "model: from-git\n");
  });

  test("turned off : read once more, the app keeps its values, the file stays", async () => {
    writeRaw("cfg", "chat-assistant.yaml", "model: last\n");
    const report = await RepoObjects.deactivate(await desc("chat_assistant"), "cfg");
    assert.equal(report.unlinked, 1);
    assert.equal(fx.state.tables.chat_settings[0].model, "last");
    assert.ok(fs.existsSync(path.join(fx.ROOT, "cfg", "chat-assistant.yaml")));
  });
});

describe("the chat assistant's switch (ENABLE_CHAT), enable_chat in its map as the page saves it", () => {
  const configController = async () => (await import("../src/controllers/v2/config.controller.js")).default;
  // the page's Save of its switch : the environment settings' route, as the page calls it
  const saveSwitch = async (body) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await (await configController()).saveEnv({ body, user: { user: { username: "root", options: { showSettings: true } } }, ip: "::1" }, res);
    return res;
  };

  test("turned on : the switch handed over first in the map ; a pull applies it at once, checked as the page's Save", async () => {
    fs.writeFileSync(MANAGED, "ENABLE_CHAT='1'\n");
    process.env.ENABLE_CHAT = "1";
    fx.cloneEmpty("cfg");
    await RepoObjects.activate(await desc("chat_assistant"), "cfg", { pull: false });
    assert.equal(readFlat("cfg", "chat_assistant.yaml").split("\n")[0], "enable_chat: true");
    // switched off in git : saved as the page saves it, the chat off without a restart
    const { default: appConfig } = await import("./__mocks__/app.config.js");
    appConfig.enableChat = true;
    writeRaw("cfg", "chat_assistant.yaml", "enable_chat: false\nmodel: gpt-5\n");
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(appConfig.enableChat, false);
    assert.equal(fx.state.tables.chat_settings[0].model, "gpt-5");
    assert.match(fs.readFileSync(MANAGED, "utf8"), /ENABLE_CHAT='0'/);
    assert.deepEqual(audits[0].detail, { changed: ["ENABLE_CHAT"], restartRequired: [] });
    assert.doesNotMatch(RepoObjects.summaryText(await desc("chat_assistant"), summary), /restart/);
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).unchanged, 1);
    // the switch alone : applied, the settings row left as it is
    writeRaw("cfg", "chat_assistant.yaml", "enable_chat: true\n");
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).updated, 1);
    assert.equal(appConfig.enableChat, true);
    assert.equal(fx.state.tables.chat_settings[0].model, "gpt-5");
    // not a yes or no : refused, nothing applied
    writeRaw("cfg", "chat_assistant.yaml", "enable_chat: maybe\nmodel: other\n");
    const refused = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.equal(refused.refused.length, 1, JSON.stringify(refused));
    assert.equal(fx.state.tables.chat_settings[0].model, "gpt-5");
    appConfig.enableChat = false;
  });

  test("a save of the page's switch writes it back into the chat assistant's map, never into general's", async () => {
    fx.cloneEmpty("cfg");
    for (const key of ["chat_assistant", "general"]) await RepoObjects.activate(await desc(key), "cfg", { pull: false });
    const general = readRaw("cfg", "general.yaml").toString();
    writeRaw("cfg", "chat_assistant.yaml", "# the team's chat\nenable_chat: false\nmodel: gpt-5\n");
    await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    const res = await saveSwitch({ ENABLE_CHAT: "1" });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(readFlat("cfg", "chat_assistant.yaml"), "# the team's chat\nenable_chat: true\nmodel: gpt-5\n");
    assert.equal(readRaw("cfg", "general.yaml").toString(), general, "the switch is the Chat assistant page's, not General's");
    // and General's map never holds it
    writeRaw("cfg", "general.yaml", "enable_chat: true\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    assert.match(summary.refused[0].reasons.join(" "), /enable_chat is not one Settings > System > General changes/);
  });

  test("set in the real environment : never written, a file giving it refused as General's, one without it applied", async () => {
    process.env.ENABLE_CHAT = "1";
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.chat_settings[0], { provider: "openai", model: "gpt-5" });
    await RepoObjects.activate(await desc("chat_assistant"), "cfg", { pull: false });
    assert.equal(readMapOf("cfg", "chat_assistant.yaml").enable_chat, undefined, "the deployment's value is not the repository's");
    writeRaw("cfg", "chat_assistant.yaml", "enable_chat: false\nmodel: gpt-6\n");
    const summary = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
    assert.deepEqual(summary.refused[0]?.reasons, ["ENABLE_CHAT is set in the environment and cannot be changed from here"]);
    assert.equal(fx.state.tables.chat_settings[0].model, "gpt-5", "refused whole");
    assert.equal(process.env.ENABLE_CHAT, "1");
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
    writeRaw("cfg", "chat_assistant.yaml", "model: gpt-6\n");
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).updated, 1);
    assert.equal(fx.state.tables.chat_settings[0].model, "gpt-6");
    // an edit in the app : the switch still never written
    const before = await RepoObjects.snapshot("chat_assistant");
    fx.state.tables.chat_settings[0].model = "gpt-7";
    await RepoObjects.appUpdated("chat_assistant", before);
    assert.equal(readFlat("cfg", "chat_assistant.yaml"), "model: gpt-7\n");
  });

  test("the config seed's chat section stays as it is : no switch in it, the file's schema has one", async () => {
    const { seedSchema, chatFileItem } = await import("../src/lib/seed-schema.js");
    assert.equal(seedSchema.properties.chat_assistant.properties.enable_chat, undefined);
    assert.ok(!seedSchema.properties.chat_assistant.required.includes("enable_chat"));
    assert.equal(Object.keys(chatFileItem.properties)[0], "enable_chat");
    assert.equal(chatFileItem.required, undefined);
  });
});

// ─── the settings ──────────────────────────────────────────────────────────────
describe("the System > General settings, by their environment names", () => {
  test("a pull applies them as the page's Save : written, applied, audited", async () => {
    writeRaw("cfg", "general.yaml", "job_retention_days: 30\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.match(fs.readFileSync(MANAGED, "utf8"), /JOB_RETENTION_DAYS='30'/);
    assert.equal(audits[0].action, "settings.env.update");
    assert.deepEqual(audits[0].detail.changed, ["JOB_RETENTION_DAYS"]);
    assert.equal((await RepoObjects.syncRepository(await desc("general"), "cfg")).unchanged, 1);
  });

  test("only what the page changes : another page's, an unknown one, a bad value, a plain secret refused", async () => {
    writeRaw("cfg", "general.yaml", "base_url: /af/\nnot_a_setting: 1\njob_retention_days: lots\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    const why = summary.refused[0].reasons.join(" ");
    assert.match(why, /base_url is not one Settings > System > General changes/);
    assert.match(why, /not_a_setting is not a known environment variable/);
    assert.match(why, /job_retention_days/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
    writeRaw("cfg", "general.yaml", "db_password: plain\n");
    assert.match((await RepoObjects.syncRepository(await desc("general"), "cfg")).refused[0].reasons[0], /db_password must be an \$\{ENV\} reference/);
  });

  test("keys in lower case : one in upper case refused, naming the key to write, nothing applied", async () => {
    writeRaw("cfg", "general.yaml", "JOB_RETENTION_DAYS: 30\nlog_level: info\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    assert.match(summary.refused[0].reasons.join(" "), /keys are in lower case: job_retention_days, not JOB_RETENTION_DAYS/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
  });

  test("never what runs, connects or loads code : refused with why, and a save from the page never writes it", async () => {
    const { REPOSITORY_REFUSED, repositoryRefusal, saveEnvValues } = await import("../src/lib/envSave.js");
    for (const name of ["GIT_PULL_COMMAND", "MYSQLDUMP_COMMAND", "DB_HOST", "LOG_PATH", "CONTENT_SECURITY_POLICY", "USE_YTT", "REST_ALLOWED_HOSTS", "TRUST_PROXY", "HTTPS_KEY"]) {
      assert.ok(repositoryRefusal(name), name);
    }
    assert.equal(repositoryRefusal("JOB_RETENTION_DAYS"), null);
    assert.ok(REPOSITORY_REFUSED.length);
    writeRaw("cfg", "general.yaml", "git_pull_command: sh -c 'curl x|sh'; git pull\ndb_host: elsewhere\njob_retention_days: 30\n");
    const summary = await RepoObjects.syncRepository(await desc("general"), "cfg");
    const why = summary.refused[0].reasons.join(" ");
    assert.match(why, /git_pull_command is not one a repository may set: it is a command the server runs/);
    assert.match(why, /db_host is not one a repository may set: it says which database the app connects to/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
    // the page still saves it, and the file never gets it
    writeRaw("cfg", "general.yaml", "job_retention_days: 30\n");
    await RepoObjects.syncRepository(await desc("general"), "cfg");
    const before = await RepoObjects.snapshot("general");
    await saveEnvValues({ GIT_PULL_COMMAND: "git pull --ff-only", JOB_RETENTION_DAYS: "31" }, { user: "root" });
    await RepoObjects.appUpdated("general", before);
    assert.equal(readFlat("cfg", "general.yaml"), "job_retention_days: 31\n");
  });

  test("a save from the page rewrites the file, its secrets never", async () => {
    writeRaw("cfg", "general.yaml", "# ops\njob_retention_days: 30\n");
    await RepoObjects.syncRepository(await desc("general"), "cfg");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const before = await RepoObjects.snapshot("general");
    await saveEnvValues({ JOB_RETENTION_DAYS: "45" }, { user: "root" });
    await RepoObjects.appUpdated("general", before);
    assert.equal(readFlat("cfg", "general.yaml"), "# ops\njob_retention_days: 45\n");
  });

  test("each value in its variable's type, a new one below the leading comment ; both forms read", async () => {
    writeRaw("cfg", "general.yaml", "# ops settings\n# kept by the platform team\njob_retention_days: \"30\"\n");
    const first = await RepoObjects.syncRepository(await desc("general"), "cfg");
    assert.equal(first.updated, 1, JSON.stringify(first));
    assert.equal(process.env.JOB_RETENTION_DAYS, "30");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const before = await RepoObjects.snapshot("general");
    // a number, and a text that looks like one (ACCESS_TOKEN_ISSUER is a text, whatever it reads)
    await saveEnvValues({ AUDIT_RETENTION_DAYS: "200", ACCESS_TOKEN_ISSUER: "1" }, { user: "root" });
    await RepoObjects.appUpdated("general", before);
    assert.equal(
      readFlat("cfg", "general.yaml"),
      "# ops settings\n# kept by the platform team\naccess_token_issuer: \"1\"\naudit_retention_days: 200\njob_retention_days: \"30\"\n",
    );
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await desc("general"), "cfg")).unchanged, 1);
  });

  test("a variable the real environment sets is never written : the next pull still applies the file", async () => {
    // saved on the page earlier, then the deployment set it in docker-compose : the environment wins
    fs.writeFileSync(MANAGED, "JOB_RETENTION_DAYS='30'\nAUDIT_RETENTION_DAYS='90'\n");
    process.env.JOB_RETENTION_DAYS = "60";
    process.env.AUDIT_RETENTION_DAYS = "90";
    const general = await desc("general");
    fx.cloneEmpty("cfg");
    await RepoObjects.activate(general, "cfg", { pull: false });
    const text = readFlat("cfg", "general.yaml");
    assert.equal(text, "audit_retention_days: 90\n");
    // the platform team changes the other setting in git : applied, not refused
    writeRaw("cfg", "general.yaml", text.replace("audit_retention_days: 90", "audit_retention_days: 120"));
    const summary = await RepoObjects.syncRepository(general, "cfg");
    assert.equal(summary.refused.length, 0, JSON.stringify(summary.refused));
    assert.equal(summary.updated, 1);
    assert.equal(process.env.AUDIT_RETENTION_DAYS, "120");
  });
});

// ─── the MCP settings ──────────────────────────────────────────────────────────
describe("the MCP settings, in their mcp.yaml", () => {
  test("turned on : every switch written with its value ; a pull applies ENABLE_MCP at once ; an edit rewrites it ; turned off", async () => {
    fx.cloneEmpty("cfg");
    const report = await RepoObjects.activate(await desc("mcp"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["MCP"]);
    assert.deepEqual(readMapOf("cfg", "mcp.yaml"), { enable_mcp: false, mcp_chat_forms_only: false, mcp_read_only: false });
    // a pull : saved as the page saves it, the server switched on without a restart
    const { default: appConfig } = await import("./__mocks__/app.config.js");
    writeRaw("cfg", "mcp.yaml", "enable_mcp: 1\nmcp_read_only: 0\n");
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
    assert.equal(readMapOf("cfg", "mcp.yaml").mcp_read_only, true);
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
    writeRaw("cfg", "general.yaml", "enable_mcp: 1\n");
    assert.match((await RepoObjects.syncRepository(await desc("general"), "cfg")).refused[0].reasons[0], /enable_mcp is not one Settings > System > General changes/);
    writeRaw("cfg", "mcp.yaml", "job_retention_days: 30\nmcp_read_only: 1\n");
    const why = (await RepoObjects.syncRepository(await desc("mcp"), "cfg")).refused[0].reasons.join(" ");
    assert.match(why, /job_retention_days is not one Settings > Connections > MCP changes/);
    assert.equal(fs.existsSync(MANAGED), false, "nothing written");
  });

  test("the seed's own write : applied with ALLOW_ENV_EDIT=0, a variable set in the environment said, never stopping the start", async () => {
    const { default: appConfig } = await import("./__mocks__/app.config.js");
    const warnings = vi.spyOn(logger, "warning");
    appConfig.allowEnvEdit = false;
    process.env.MCP_CHAT_FORMS_ONLY = "1";
    try {
      const done = await RepoObjects.applyDeclared(await desc("mcp"), { mcp_read_only: true, mcp_chat_forms_only: false });
      assert.deepEqual(done.updated, ["mcp"]);
      assert.match(fs.readFileSync(MANAGED, "utf8"), /MCP_READ_ONLY='1'/);
      assert.doesNotMatch(fs.readFileSync(MANAGED, "utf8"), /MCP_CHAT_FORMS_ONLY/);
      assert.equal(process.env.MCP_CHAT_FORMS_ONLY, "1", "the environment's value kept");
      assert.ok(warnings.mock.calls.some(([m]) => /config seed declares MCP_CHAT_FORMS_ONLY, which is set in the environment/.test(m)));
      // the page itself still writes nothing
      const { saveEnvValues } = await import("../src/lib/envSave.js");
      await assert.rejects(saveEnvValues({ MCP_READ_ONLY: "0" }, {}), { status: 403 });
    } finally {
      appConfig.allowEnvEdit = true;
      warnings.mockRestore();
    }
  });

  test("the seed's mcp section holds its switches : refused in the app, kept out of the repository's file", async () => {
    const { setSeedManagedFields, seedManagedFields } = await import("../src/lib/seedManaged.js");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const { validateSeed } = await import("../src/lib/seed-schema.js");
    assert.equal(validateSeed({ mcp: { enable_mcp: true, mcp_read_only: 1 } }), true);
    assert.throws(() => validateSeed({ mcp: { job_retention_days: 30 } }), /validation failed/);
    assert.throws(() => validateSeed({ mcp: { MCP_READ_ONLY: true } }), /validation failed/, "its keys in lower case");
    await setSeedManagedFields(["MCP_READ_ONLY"]);
    assert.deepEqual(await seedManagedFields(), ["MCP_READ_ONLY"]);
    await assert.rejects(saveEnvValues({ MCP_READ_ONLY: "1" }, {}), { status: 403, message: /MCP_READ_ONLY/ });
    // turned on : listed as staying in the app, never written to the file
    fx.cloneEmpty("cfg");
    assert.deepEqual((await RepoObjects.preview(await desc("mcp"), "cfg")).kept.map((k) => k.name), ["mcp_read_only"]);
    await RepoObjects.activate(await desc("mcp"), "cfg", { pull: false });
    assert.deepEqual(readMapOf("cfg", "mcp.yaml"), { enable_mcp: false, mcp_chat_forms_only: false });
    // a file declaring it : not applied, said ; the others applied
    writeRaw("cfg", "mcp.yaml", "mcp_read_only: 1\nmcp_chat_forms_only: 1\n");
    const summary = await RepoObjects.syncRepository(await desc("mcp"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(process.env.MCP_READ_ONLY, undefined);
    assert.equal(process.env.MCP_CHAT_FORMS_ONLY, "1");
    assert.match(RepoObjects.summaryText(await desc("mcp"), summary), /Kept by the config seed, not applied: mcp_read_only/);
    // the seed's own section applies it
    const done = await RepoObjects.applyDeclared(await desc("mcp"), { mcp_read_only: true }, {});
    assert.deepEqual(done.updated, ["mcp"]);
    assert.equal(process.env.MCP_READ_ONLY, "1");
    // released when the seed stops declaring it
    assert.deepEqual(await setSeedManagedFields([]), ["MCP_READ_ONLY"]);
    await saveEnvValues({ MCP_READ_ONLY: "0" }, {});
  });
});

// ─── the Appearance pages : one file each ─────────────────────────────────────
// the fields each Settings > Appearance page saves (client/src/pages/admin/defaults.vue : the
// settings row's lookOf and DEFAULT_LANGUAGE ; logo.vue and favicon.vue : their image ; name.vue :
// nameOf), as its file holds them : the forms view by default_forms_view, as its siblings
const PAGE_FIELDS = {
  defaults: ["default_theme", "default_theme_color", "default_forms_view", "default_timezone", "default_date_format", "default_language"],
  logo: ["logo"],
  icon: ["icon"],
  name: ["app_name"],
  links: ["header_links", "show_designer"],
};

describe("each Appearance page in its own file, holding what that page saves and nothing else", () => {
  test("its file's schema, the seed's section and the fields the seed holds are its page's fields", async () => {
    const { APPEARANCE_SECTIONS } = await import("../src/lib/seed-schema.js");
    const { APPEARANCE_FIELDS, sectionOfField, seedKeyOf } = await import("../src/lib/seedManaged.js");
    // the settings row's field of a key (the forms view's : forms_view, the seed holding it so)
    const fieldOf = (k) => (k === "default_forms_view" ? "forms_view" : k);
    for (const [key, fields] of Object.entries(PAGE_FIELDS)) {
      const d = await desc(key);
      assert.equal(d.single, true);
      assert.deepEqual([...d.keyOrder].sort(), [...fields].sort(), key);
      assert.deepEqual(Object.keys(APPEARANCE_SECTIONS[key].properties).sort(), [...fields].sort(), key);
      for (const field of fields) {
        assert.equal(sectionOfField(fieldOf(field)), key, field);
        assert.equal(seedKeyOf(fieldOf(field)), field, field);
      }
    }
    assert.deepEqual([...APPEARANCE_FIELDS].sort(), Object.values(PAGE_FIELDS).flat().map(fieldOf).sort());
  });

  test("turned on : each file written with its page's values only", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.settings[0], {
      app_name: "Mine",
      default_theme: "dark",
      default_theme_color: "#198754",
      forms_view: "list",
      default_timezone: "Europe/Brussels",
      default_date_format: "DD/MM/YYYY",
      logo: dataUrl(PNG),
      favicon: dataUrl(PNG),
    });
    // the language as its page saves it (the managed environment file)
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    await saveEnvValues({ DEFAULT_LANGUAGE: "fr" }, { user: "root" });
    for (const key of ["defaults", "logo", "icon", "name"]) await RepoObjects.activate(await desc(key), "cfg", { pull: false });
    assert.deepEqual(readMapOf("cfg", "defaults.yaml"), {
      default_theme: "dark",
      default_theme_color: "#198754",
      default_forms_view: "list",
      default_timezone: "Europe/Brussels",
      default_date_format: "DD/MM/YYYY",
      default_language: "fr",
    });
    assert.deepEqual(readMapOf("cfg", "logo.yaml"), { logo: "logo.png" });
    assert.deepEqual(readMapOf("cfg", "icon.yaml"), { icon: "icon.png" });
    assert.deepEqual(readMapOf("cfg", "name.yaml"), { app_name: "Mine" });
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), PNG), 0);
    assert.equal(Buffer.compare(readRaw("cfg", "icon.png"), PNG), 0);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "branding.yaml")), false);
  });

  test("a file declaring another page's field is refused, never applied", async () => {
    for (const [file, key, field] of [
      ["name.yaml", "name", "default_theme: dark"],
      ["defaults.yaml", "defaults", "app_name: Other"],
      ["logo.yaml", "logo", "icon: icon.png"],
      ["icon.yaml", "icon", "logo: logo.png"],
    ]) {
      writeRaw("cfg", file, `${field}\n`);
      const summary = await RepoObjects.syncRepository(await desc(key), "cfg");
      assert.equal(summary.refused.length, 1, `${file}: ${JSON.stringify(summary)}`);
    }
    assert.equal(fx.state.tables.settings[0].app_name, "Old name");
    assert.equal(fx.state.tables.settings[0].default_theme, "system");
  });

  test("a pull applies each file : the name, the defaults, the logo read as binary, checked as an upload", async () => {
    writeRaw("cfg", "name.yaml", "app_name: ACME\n");
    writeRaw("cfg", "defaults.yaml", "default_theme: dark\n");
    writeRaw("cfg", "logo.yaml", "logo: logo.png\n");
    writeRaw("cfg", "logo.png", PNG);
    for (const key of ["name", "defaults", "logo"]) {
      const summary = await RepoObjects.syncRepository(await desc(key), "cfg");
      assert.equal(summary.updated, 1, `${key}: ${JSON.stringify(summary)}`);
    }
    const row = fx.state.tables.settings[0];
    assert.equal(row.app_name, "ACME");
    assert.equal(row.default_theme, "dark");
    assert.equal(row.logo, dataUrl(PNG));
    CrudModel.flushAllLocal();
    for (const key of ["name", "defaults", "logo"]) assert.equal((await RepoObjects.syncRepository(await desc(key), "cfg")).unchanged, 1, key);
  });
});

// ─── the forms view : default_forms_view in a file, forms_view in the app ──────────
describe("the Defaults page's forms view, named default_forms_view in a file as its siblings", () => {
  test("a pull reads default_forms_view into the settings row's forms_view ; forms_view is a key the map does not have", async () => {
    writeRaw("cfg", "defaults.yaml", "default_forms_view: list\n");
    const summary = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(fx.state.tables.settings[0].forms_view, "list");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await desc("defaults"), "cfg")).unchanged, 1);
    // the row's name in a file : refused as any key the map does not have, named as written
    writeRaw("cfg", "defaults.yaml", "forms_view: tiles\n");
    const refused = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
    assert.equal(refused.refused.length, 1, JSON.stringify(refused));
    assert.match(refused.refused[0].reasons.join("; "), /forms_view/);
    assert.doesNotMatch(refused.refused[0].reasons.join("; "), /default_forms_view/);
    assert.equal(fx.state.tables.settings[0].forms_view, "list");
  });

  test("an app edit writes default_forms_view back, the file's other keys and comments as they are", async () => {
    fx.cloneEmpty("cfg");
    writeRaw("cfg", "defaults.yaml", "default_theme: dark # the house style\ndefault_forms_view: tiles\n");
    await RepoObjects.activate(await desc("defaults"), "cfg", { pull: false });
    CrudModel.flushAllLocal();
    const before = await RepoObjects.snapshot("defaults");
    fx.state.tables.settings[0].forms_view = "list";
    assert.equal(await RepoObjects.appUpdated("defaults", before), true);
    assert.equal(readFlat("cfg", "defaults.yaml"), "default_theme: dark # the house style\ndefault_forms_view: list\n");
  });

  test("the seed's defaults section : default_forms_view applied and held as the forms_view field, said by its key", async () => {
    const { validateSeed } = await import("../src/lib/seed-schema.js");
    const { seedFieldsOf, setSeedManagedFields, seedManagedFields } = await import("../src/lib/seedManaged.js");
    const { saveSettingsFields } = await import("../src/lib/appearance.js");
    assert.equal(validateSeed({ defaults: { default_forms_view: "list" } }), true);
    assert.throws(() => validateSeed({ defaults: { forms_view: "list" } }), /validation failed/);
    // applied as the seed applies it, held by the row's name (the page's seeded('forms_view'))
    assert.deepEqual((await RepoObjects.applyDeclared(await desc("defaults"), { default_forms_view: "list" }, { fromSeed: true })).updated, ["defaults"]);
    assert.equal(fx.state.tables.settings[0].forms_view, "list");
    assert.deepEqual(seedFieldsOf({ defaults: { default_theme: "dark", default_forms_view: "list" }, mcp: { mcp_read_only: true } }), ["default_theme", "forms_view", "MCP_READ_ONLY"]);
    await setSeedManagedFields(seedFieldsOf({ defaults: { default_forms_view: "list" } }));
    assert.deepEqual(await seedManagedFields(), ["forms_view"]);
    await assert.rejects(saveSettingsFields({ forms_view: "tiles" }), { status: 403, message: /read only here: forms_view/ });
    // a Defaults repository : kept in the app and out of its file, a file declaring it not applied,
    // each said by the key the file has
    fx.cloneEmpty("cfg");
    const p = await RepoObjects.preview(await desc("defaults"), "cfg");
    assert.deepEqual(p.kept, [{ name: "default_forms_view", code: "seed", reason: "managed by the config seed" }]);
    await RepoObjects.activate(await desc("defaults"), "cfg", { pull: false });
    assert.equal(readMapOf("cfg", "defaults.yaml").default_forms_view, undefined);
    assert.equal(readMapOf("cfg", "defaults.yaml").forms_view, undefined);
    writeRaw("cfg", "defaults.yaml", "default_forms_view: tiles\n");
    const summary = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.state.tables.settings[0].forms_view, "list");
    assert.match(RepoObjects.summaryText(await desc("defaults"), summary), /Kept by the config seed, not applied: default_forms_view/);
    assert.deepEqual(await setSeedManagedFields([]), ["forms_view"]);
  });
});

// ─── a page's save writes its own file ─────────────────────────────────────────
describe("a save from an Appearance page writes its own page's file only", () => {
  const settingsController = async () => (await import("../src/controllers/v2/settings.controller.js")).default;
  const put = async (body) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await (await settingsController()).update({ body, user: { user: { username: "root", options: { showSettings: true } } } }, res);
    return res;
  };

  test("the Defaults page's save : defaults.yaml rewritten, name.yaml and links.yaml left as they are, a removed one not written again", async () => {
    fx.cloneEmpty("cfg");
    for (const key of ["defaults", "name", "links"]) await RepoObjects.activate(await desc(key), "cfg", { pull: false });
    const name = readRaw("cfg", "name.yaml").toString();
    fs.rmSync(path.join(fx.ROOT, "cfg", "links.yaml"));
    const res = await put({ default_theme: "dark", default_theme_color: "#008cba", forms_view: "tiles", default_timezone: "UTC", default_date_format: "YYYY-MM-DD" });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(readMapOf("cfg", "defaults.yaml").default_theme, "dark");
    assert.equal(readRaw("cfg", "name.yaml").toString(), name);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "links.yaml")), false, "the Links page's file is not the Defaults page's to write");
  });

  test("the Name page's save : name.yaml rewritten, defaults.yaml left as it is", async () => {
    fx.cloneEmpty("cfg");
    for (const key of ["defaults", "name"]) await RepoObjects.activate(await desc(key), "cfg", { pull: false });
    fs.rmSync(path.join(fx.ROOT, "cfg", "defaults.yaml"));
    assert.equal((await put({ app_name: "Renamed" })).code, 200);
    assert.deepEqual(readMapOf("cfg", "name.yaml"), { app_name: "Renamed" });
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "defaults.yaml")), false);
  });

  test("a new logo : logo.yaml and its image, never the icon's file", async () => {
    fx.cloneEmpty("cfg");
    for (const key of ["logo", "icon"]) await RepoObjects.activate(await desc(key), "cfg", { pull: false });
    fs.rmSync(path.join(fx.ROOT, "cfg", "icon.yaml"));
    const before = await RepoObjects.snapshots(["logo", "icon"]);
    fx.state.tables.settings[0].logo = dataUrl(PNG);
    await RepoObjects.appUpdatedAll(before);
    assert.deepEqual(readMapOf("cfg", "logo.yaml"), { logo: "logo.png" });
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "icon.yaml")), false);
  });
});

// ─── the logo and the icon ─────────────────────────────────────────────────────
describe("the logo and the icon, their images beside their file", () => {
  test("an image that is no image, too large, or outside the repository is refused", async () => {
    writeRaw("cfg", "logo.png", Buffer.from("not an image"));
    writeRaw("cfg", "logo.yaml", "logo: logo.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("logo"), "cfg")).refused[0].reasons[0], /not an image the app takes/);
    writeRaw("cfg", "icon.png", Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
    writeRaw("cfg", "icon.yaml", "icon: icon.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("icon"), "cfg")).refused[0].reasons[0], /larger than 256 KB/);
    writeRaw("cfg", "logo.yaml", "logo: ../elsewhere.png\n");
    assert.match((await RepoObjects.syncRepository(await desc("logo"), "cfg")).refused[0].reasons[0], /not a file of the repository/);
  });

  test("an image linked to a file outside the repository is never read", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-"));
    fs.writeFileSync(path.join(outside, "secret.png"), PNG);
    fx.cloneEmpty("cfg");
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(fx.ROOT, "cfg", "logo.png"));
    writeRaw("cfg", "logo.yaml", "logo: logo.png\n");
    const summary = await RepoObjects.syncRepository(await desc("logo"), "cfg");
    assert.match(summary.refused[0]?.reasons[0] || "", /not a file of the repository/, JSON.stringify(summary));
    assert.equal(fx.state.tables.settings[0].logo, null);
  });

  test("turned on : the app's logo written beside logo.yaml as binary ; a new logo rewrites it", async () => {
    fx.cloneEmpty("cfg");
    Object.assign(fx.state.tables.settings[0], { app_name: "Mine", logo: dataUrl(PNG) });
    await RepoObjects.activate(await desc("logo"), "cfg", { pull: false });
    assert.deepEqual(readMapOf("cfg", "logo.yaml"), { logo: "logo.png" });
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), PNG), 0);
    // a new logo in the app : the image rewritten, the YAML as it was
    const before = await RepoObjects.snapshot("logo");
    const other = Buffer.concat([PNG, Buffer.from("v2")]);
    fx.state.tables.settings[0].logo = dataUrl(other);
    await RepoObjects.appUpdated("logo", before);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), other), 0);
    assert.equal(readMapOf("cfg", "logo.yaml").logo, "logo.png");
  });

  test("a new logo in the app while the file names it elsewhere : written where it names it, an unrelated logo.png untouched", async () => {
    fx.cloneEmpty("cfg");
    writeRaw("cfg", "logo.yaml", "logo: images/logo.png # the team's layout\n");
    fs.mkdirSync(path.join(fx.ROOT, "cfg", "images"), { recursive: true });
    writeRaw("cfg", "images/logo.png", PNG);
    // a logo.png at the root that is not the Logo type's (the README's)
    const readme = Buffer.concat([PNG, Buffer.from("readme")]);
    writeRaw("cfg", "logo.png", readme);
    await RepoObjects.syncRepository(await desc("logo"), "cfg");
    CrudModel.flushAllLocal();
    const before = await RepoObjects.snapshot("logo");
    const other = Buffer.concat([PNG, Buffer.from("v2")]);
    fx.state.tables.settings[0].logo = dataUrl(other);
    assert.equal(await RepoObjects.appUpdated("logo", before), true);
    // the YAML still names its own file, which holds the new logo : a pull of it gives the new one
    assert.equal(readFlat("cfg", "logo.yaml"), "logo: images/logo.png # the team's layout\n");
    assert.equal(Buffer.compare(readRaw("cfg", "images/logo.png"), other), 0);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), readme), 0, "the README's logo untouched");
    // another type : beside it with its extension, the YAML naming it, the old file the logo's gone
    const before2 = await RepoObjects.snapshot("logo");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    fx.state.tables.settings[0].logo = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    await RepoObjects.appUpdated("logo", before2);
    assert.equal(readMapOf("cfg", "logo.yaml").logo, "images/logo.svg");
    assert.equal(Buffer.compare(readRaw("cfg", "images/logo.svg"), svg), 0);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "images", "logo.png")), false);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), readme), 0);
  });

  test("a file of the name an image would be written as, not the Logo type's : refused, never overwritten", async () => {
    fx.cloneEmpty("cfg");
    const readme = Buffer.concat([PNG, Buffer.from("readme")]);
    writeRaw("cfg", "logo.png", readme);
    Object.assign(fx.state.tables.settings[0], { app_name: "Mine", logo: dataUrl(PNG) });
    // turned on : logo.yaml would name the app's logo logo.png
    await assert.rejects(RepoObjects.activate(await desc("logo"), "cfg", { pull: false }), /'logo.png' is in repository 'cfg' already and is not the one logo.yaml names/);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), readme), 0);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "logo.yaml")), false, "nothing written");
    // an edit of a logo.yaml that names no logo : the same
    writeRaw("cfg", "logo.yaml", "# no logo yet\n{}\n");
    const before = await RepoObjects.snapshot("logo");
    fx.state.tables.settings[0].logo = dataUrl(Buffer.concat([PNG, Buffer.from("v3")]));
    assert.equal(await RepoObjects.appUpdated("logo", before), null);
    assert.equal(Buffer.compare(readRaw("cfg", "logo.png"), readme), 0);
    assert.equal(readFlat("cfg", "logo.yaml"), "# no logo yet\n{}\n");
  });

  test("a save that leaves the logo as it is writes nothing : no image beside the YAML, none removed", async () => {
    fx.cloneEmpty("cfg");
    writeRaw("cfg", "logo.yaml", "logo: images/logo.png\n");
    fs.mkdirSync(path.join(fx.ROOT, "cfg", "images"), { recursive: true });
    writeRaw("cfg", "images/logo.png", PNG);
    await RepoObjects.syncRepository(await desc("logo"), "cfg");
    CrudModel.flushAllLocal();
    const before = await RepoObjects.snapshot("logo");
    fx.state.tables.settings[0].app_name = "Renamed";
    assert.equal(await RepoObjects.appUpdated("logo", before), false);
    assert.equal(readFlat("cfg", "logo.yaml"), "logo: images/logo.png\n");
    assert.equal(fs.existsSync(path.join(fx.ROOT, "cfg", "logo.png")), false);
    assert.equal(Buffer.compare(readRaw("cfg", "images/logo.png"), PNG), 0);
  });

  test("the seed's logo, icon and name sections : read the same way, the images relative to the seed file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-seed-"));
    fs.mkdirSync(path.join(dir, "img"));
    fs.writeFileSync(path.join(dir, "img", "logo.png"), PNG);
    fs.writeFileSync(path.join(dir, "img", "icon.png"), PNG);
    assert.deepEqual((await RepoObjects.applyDeclared(await desc("logo"), { logo: "img/logo.png" }, { dir })).updated, ["logo"]);
    assert.deepEqual((await RepoObjects.applyDeclared(await desc("icon"), { icon: "img/icon.png" }, { dir })).updated, ["icon"]);
    assert.deepEqual((await RepoObjects.applyDeclared(await desc("name"), { app_name: "Seeded" }, { dir })).updated, ["name"]);
    assert.equal(fx.state.tables.settings[0].app_name, "Seeded");
    assert.equal(fx.state.tables.settings[0].logo, dataUrl(PNG));
    assert.equal(fx.state.tables.settings[0].favicon, dataUrl(PNG));
  });
});

// ─── the log lines of a type kept in one file ───────────────────────────────────
describe("a file whose values the app keeps otherwise : the next pull changes nothing", () => {
  test("the name with spaces around it, an unknown forms view", async () => {
    writeRaw("cfg", "name.yaml", "app_name: '  ACME  '\n");
    writeRaw("cfg", "defaults.yaml", "default_forms_view: nonsense\n");
    assert.equal((await RepoObjects.syncRepository(await desc("name"), "cfg")).updated, 1);
    assert.deepEqual((await RepoObjects.syncRepository(await desc("defaults"), "cfg")).refused, []);
    assert.equal(fx.state.tables.settings[0].app_name, "ACME");
    for (const key of ["name", "defaults"]) {
      const second = await RepoObjects.syncRepository(await desc(key), "cfg");
      assert.equal(second.updated, 0, JSON.stringify(second));
      assert.equal(second.unchanged, 1);
    }
  });

  test("the chat's number of turns above its limit", async () => {
    writeRaw("cfg", "chat-assistant.yaml", "max_turns: 500\n");
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).updated, 1);
    assert.equal(fx.state.tables.chat_settings[0].max_turns, 200);
    assert.equal((await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg")).unchanged, 1);
  });

  test("an empty list of links, the app without links : nothing to change", async () => {
    writeRaw("cfg", "links.yaml", "header_links: []\n");
    assert.equal((await RepoObjects.syncRepository(await desc("links"), "cfg")).unchanged, 1);
    assert.equal((await RepoObjects.syncRepository(await desc("links"), "cfg")).unchanged, 1);
  });
});

describe("the default language, an environment setting in defaults.yaml", () => {
  test("set in the real environment : never written to the repository, a file's not applied (said), its other fields applied", async () => {
    process.env.DEFAULT_LANGUAGE = "fr";
    try {
      fx.cloneEmpty("cfg");
      await RepoObjects.activate(await desc("defaults"), "cfg", { pull: false });
      assert.equal(readMapOf("cfg", "defaults.yaml").default_language, undefined, "the deployment's value is not the repository's");
      writeRaw("cfg", "defaults.yaml", "default_theme: dark\ndefault_language: de\n");
      const summary = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
      assert.deepEqual(summary.refused, []);
      assert.equal(fx.state.tables.settings[0].default_theme, "dark");
      assert.equal(process.env.DEFAULT_LANGUAGE, "fr");
      assert.match(RepoObjects.summaryText(await desc("defaults"), summary), /Set in the environment, not applied: DEFAULT_LANGUAGE/);
      assert.equal((await RepoObjects.syncRepository(await desc("defaults"), "cfg")).unchanged, 1);
    } finally {
      delete process.env.DEFAULT_LANGUAGE;
    }
  });

  test("the environment settings not editable (ALLOW_ENV_EDIT=0) : the file refused whole, nothing of it applied", async () => {
    const { default: appConfig } = await import("./__mocks__/app.config.js");
    appConfig.allowEnvEdit = false;
    try {
      writeRaw("cfg", "defaults.yaml", "default_theme: dark\ndefault_language: de\n");
      const summary = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
      assert.equal(summary.refused.length, 1, JSON.stringify(summary));
      assert.equal(fx.state.tables.settings[0].default_theme, "system", "never applied by halves");
    } finally {
      appConfig.allowEnvEdit = true;
    }
  });
});

describe("the log names a type kept in one file by its label", () => {
  test("turned on, applied from git, saved from the app : sentences that read as such", async () => {
    const lines = [];
    const spies = ["notice", "info", "warning"].map((level) => vi.spyOn(logger, level).mockImplementation((m) => lines.push(m)));
    try {
      fx.cloneEmpty("cfg");
      await RepoObjects.activate(await desc("mcp"), "cfg", { pull: false });
      writeRaw("cfg", "general.yaml", "job_retention_days: 30\n");
      await RepoObjects.syncRepository(await desc("general"), "cfg");
      fs.rmSync(path.join(fx.ROOT, "cfg", "chat-assistant.yaml"), { force: true });
      const none = await RepoObjects.syncRepository(await desc("chat_assistant"), "cfg");
      const { saveEnvValues } = await import("../src/lib/envSave.js");
      const before = await RepoObjects.snapshot("general");
      await saveEnvValues({ JOB_RETENTION_DAYS: "45" }, { user: "root" });
      await RepoObjects.appUpdated("general", before);
      assert.ok(lines.includes("Repository 'cfg' now holds MCP (written to mcp.yaml, waiting for Push)"), lines.join("\n"));
      assert.ok(lines.includes("Applied controller_general: of cfg/general.yaml: the app follows git for General from now on"), lines.join("\n"));
      assert.ok(lines.includes("Saved General into cfg/general.yaml"), lines.join("\n"));
      assert.deepEqual(none.notes, ["No file of the repository gives controller_chat_assistant: - the app keeps Chat assistant as it is"]);
      assert.ok(!lines.some((l) => /holds the general|The \w+ follow /.test(l)), lines.join("\n"));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ─── the header's links ────────────────────────────────────────────────────────
describe("the header's links, in their own links.yaml", () => {
  const LINK = { id: "a", label: "Docs", url: "https://docs.example.com", icon: "book", newTab: true, parent: null };

  test("turned on : written to links.yaml, never to another page's file ; a pull applies it ; an edit rewrites it", async () => {
    fx.cloneEmpty("cfg");
    fx.state.tables.settings[0].header_links = JSON.stringify([LINK]);
    const report = await RepoObjects.activate(await desc("links"), "cfg", { pull: false });
    assert.deepEqual(report.written, ["Links"]);
    const file = readMapOf("cfg", "links.yaml");
    assert.equal(file.header_links[0].label, "Docs");
    assert.equal(file.show_designer, true);
    // the other Appearance pages' files hold no link
    for (const key of ["defaults", "name"]) {
      await RepoObjects.activate(await desc(key), "cfg", { pull: false });
      const other = fx.readObject("cfg", ".", `${key}.yaml`);
      assert.equal(other.header_links, undefined);
      assert.equal(other.show_designer, undefined);
    }
    writeRaw("cfg", "defaults.yaml", "header_links: []\n");
    assert.match((await RepoObjects.syncRepository(await desc("defaults"), "cfg")).refused[0].reasons[0], /'header_links'/);
    // a pull of links.yaml : the links follow it
    writeRaw("cfg", "links.yaml", "header_links:\n  - { id: b, label: Wiki, url: 'https://wiki' }\n");
    const summary = await RepoObjects.syncRepository(await desc("links"), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(JSON.parse(fx.state.tables.settings[0].header_links)[0].label, "Wiki");
    // an edit in the app rewrites the file
    const before = await RepoObjects.snapshot("links");
    fx.state.tables.settings[0].header_links = JSON.stringify([LINK]);
    await RepoObjects.appUpdated("links", before);
    assert.equal(readMapOf("cfg", "links.yaml").header_links[0].label, "Docs");
    // turned off : the app keeps its links, the file stays
    assert.equal((await RepoObjects.deactivate(await desc("links"), "cfg")).unlinked, 1);
    assert.ok(fs.existsSync(path.join(fx.ROOT, "cfg", "links.yaml")));
  });

  test("the seed's links are its own : refused in the app, kept out of the repository's file", async () => {
    const { setSeedManagedFields } = await import("../src/lib/seedManaged.js");
    const { saveSettingsFields } = await import("../src/lib/appearance.js");
    await setSeedManagedFields(["header_links"]);
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

// ─── the appearance fields the config seed manages ─────────────────────────────
describe("the appearance fields the config seed declares are its own", () => {
  test("refused through the save helpers ; the others, and one sent back as it is, still saved", async () => {
    const { setSeedManagedFields } = await import("../src/lib/seedManaged.js");
    const { saveSettingsFields } = await import("../src/lib/appearance.js");
    const { saveEnvValues } = await import("../src/lib/envSave.js");
    const { BRAND_IMAGES } = await import("../src/lib/brandImages.js");
    await setSeedManagedFields(["app_name", "logo", "default_language"]);
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
    const { setSeedManagedFields, seedManagedFields } = await import("../src/lib/seedManaged.js");
    await setSeedManagedFields(["app_name", "logo"]);
    assert.deepEqual(await setSeedManagedFields(["app_name"]), ["logo"]);
    assert.deepEqual(await seedManagedFields(), ["app_name"]);
    const { BRAND_IMAGES } = await import("../src/lib/brandImages.js");
    await BRAND_IMAGES.logo.set(dataUrl(PNG));
  });

  test("with a Defaults repository : the seed's fields stay the seed's, the repository holds the rest", async () => {
    const { setSeedManagedFields } = await import("../src/lib/seedManaged.js");
    await setSeedManagedFields(["default_theme"]);
    Object.assign(fx.state.tables.settings[0], { default_theme: "light", default_timezone: "UTC" });
    fx.cloneEmpty("cfg");
    // turned on : the seed's field listed as staying in the app, never written to the file
    const p = await RepoObjects.preview(await desc("defaults"), "cfg");
    assert.deepEqual(p.kept, [{ name: "default_theme", code: "seed", reason: "managed by the config seed" }]);
    await RepoObjects.activate(await desc("defaults"), "cfg", { pull: false });
    assert.equal(readMapOf("cfg", "defaults.yaml").default_theme, undefined);
    assert.equal(readMapOf("cfg", "defaults.yaml").default_timezone, "UTC");
    // a file declaring it : not applied, said ; the other fields applied
    writeRaw("cfg", "defaults.yaml", "default_theme: dark\ndefault_timezone: Europe/Brussels\n");
    const summary = await RepoObjects.syncRepository(await desc("defaults"), "cfg");
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.state.tables.settings[0].default_theme, "light");
    assert.equal(fx.state.tables.settings[0].default_timezone, "Europe/Brussels");
    assert.match(RepoObjects.summaryText(await desc("defaults"), summary), /Kept by the config seed, not applied: default_theme/);
  });
});

// ─── the announcements and the disclaimer ──────────────────────────────────────
describe("the announcements", () => {
  test("named, their moments in UTC : made, then unchanged ; one of the app written with a name", async () => {
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", { name: "Maintenance", message: "Down on Sunday", level: "warning", start_at: "2030-01-01T08:00:00Z" });
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

describe("the config seed and a repository naming the same announcement", () => {
  test("the repository's is kept, the seed's not applied, said : no tug of war between a start and a pull", async () => {
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", { name: "Maintenance", message: "From git" });
    await RepoObjects.syncRepository(await desc("announcements"), "news");
    const done = await RepoObjects.applyDeclared(await desc("announcements"), [{ name: "Maintenance", message: "From the seed" }], {});
    assert.deepEqual(done.kept, ["Maintenance"]);
    assert.deepEqual(done.updated, []);
    assert.equal(fx.rowNamed("announcements", "Maintenance").message, "From git");
  });
});

describe("announcements made in the app with the same start", () => {
  test("each written with a name of its own, a suffix ; a pull then takes every one, none refused", async () => {
    fx.cloneEmpty("news");
    const message = "Planned maintenance window: the app will be unavailable";
    fx.state.tables.announcements.push({ id: 7, name: null, message: `${message} on Saturday`, level: "info", enabled: 1 }, { id: 8, name: null, message: `${message} on Sunday`, level: "info", enabled: 1 });
    const report = await RepoObjects.activate(await desc("announcements"), "news", { pull: false });
    const base = message.slice(0, 40).trim();
    assert.deepEqual(report.written, [base, `${base} (2)`]);
    // one made after : the next free suffix
    fx.state.tables.announcements.push({ id: 9, name: null, message: `${message} again`, level: "info", enabled: 1 });
    await RepoObjects.appCreated("announcements", 9);
    assert.equal(fx.state.tables.announcements.find((r) => r.id === 9).name, `${base} (3)`);
    const summary = await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.unchanged, 3);
  });
});

describe("an announcement already ended in git", () => {
  const ended = { name: "Maintenance", message: "Down on Sunday", end_at: "2020-01-01T10:00:00Z" };

  test("is not imported : no refusal, an information line, the sync goes on", async () => {
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", ended);
    fx.writeEntry("news", "announcements/later.yaml", "announcements", { name: "Later", message: "Soon", end_at: "2099-01-01T10:00:00Z" });
    const summary = await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.created, 1, "a future end still imports");
    assert.equal(fx.rowNamed("announcements", "Maintenance"), undefined);
    assert.match(RepoObjects.summaryText(await desc("announcements"), summary), /Not imported, already ended: Maintenance \(announcements\/maintenance.yaml#Maintenance\)/);
    // and the question before turning the usage on says how many are skipped
    assert.equal((await RepoObjects.preview(await desc("announcements"), "news")).skipped, 1);
  });

  test("a linked one whose file has since ended is removed from the app, its file left as it is", async () => {
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", { ...ended, end_at: "2099-01-01T10:00:00Z" });
    await RepoObjects.syncRepository(await desc("announcements"), "news");
    assert.ok(fx.rowNamed("announcements", "Maintenance"));
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", ended);
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
    fx.writeEntry("news", "announcements/maintenance.yaml", "announcements", { ...ended, end_at: "2099-01-01T10:00:00Z" });
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
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", file());
    const summary = await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(summary.created, 1, JSON.stringify(summary));
    assert.equal(fx.state.tables.settings[0].disclaimer_version, 1);
    assert.equal(fx.state.tables.disclaimer_versions[0].repository, "news");
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).unchanged, 1);
  });

  test("a changed text is a correction ; with ask_again, everyone is asked again", async () => {
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", file());
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    acceptances[1] = 5;
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", file({ text: "Be very nice" }));
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(fx.state.tables.disclaimer_versions[0].text, "Be very nice");
    assert.equal(acceptances[1], 5, "a correction keeps who accepted it");
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", file({ text: "Be kind", ask_again: true }));
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(acceptances[1], 0, "everyone asked again");
    // ask_again with the text unchanged : nothing happens
    acceptances[1] = 2;
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).unchanged, 1);
    assert.equal(acceptances[1], 2);
  });

  test("a text ending on a line break (a YAML block) with ask_again : asked again once, never on each pull", async () => {
    const text = "controller_disclaimer:\n  - version: 1\n    title: Terms\n    text: |\n      Line one.\n      Line two.\n    checkbox_label: I agree\n    enabled: true\n    ask_again: true\n";
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", text);
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(fx.state.tables.disclaimer_versions[0].text, "Line one.\nLine two.");
    acceptances[1] = 3;
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).unchanged, 1);
    assert.equal(acceptances[1], 3, "who accepted it is not asked again");
    // the seed's disclaimer section : the same words, nothing to change
    const done = await RepoObjects.applyDeclared(await desc("disclaimer"), [{ version: 1, title: " Terms ", text: "Line one.\nLine two.\n", checkbox_label: "I agree", ask_again: true }]);
    assert.deepEqual(done.updated, []);
    assert.equal(acceptances[1], 3);
  });

  test("a refused entry declares its version : the app's version of that number stays in the app, never a second entry", async () => {
    fx.state.tables.disclaimer_versions.push({ version: 1, title: "Terms", text: "Be nice", checkbox_label: "I agree", repository: null, repo_file: null });
    fx.writeEntry("news", "disclaimer/1.yaml", "disclaimer", file({ title: ["not", "a", "text"] }));
    const preview = await RepoObjects.preview(await desc("disclaimer"), "news");
    assert.deepEqual(preview.clashes, ["1"]);
    assert.deepEqual(preview.written, []);
    const report = await RepoObjects.activate(await desc("disclaimer"), "news", { pull: false });
    assert.equal(report.refused.length, 1);
    assert.deepEqual(report.written, []);
    assert.match(report.kept[0].reason, /^news\/disclaimer\/1\.yaml#1 has its name but is not read in/);
    assert.deepEqual(fx.listFiles("news", "disclaimer"), ["1.yaml"]);
    assert.equal(fx.state.tables.disclaimer_versions[0].repository, null);
  });

  test("an entry whose number changes is refused : never the old version's text rewritten, a new entry makes the new one", async () => {
    fx.writeEntry("news", "disclaimer/terms.yaml", "disclaimer", file());
    await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    acceptances[1] = 5;
    // the admin publishes new terms in the same file, the next number and a new text
    fx.writeEntry("news", "disclaimer/terms.yaml", "disclaimer", file({ version: 2, text: "New terms" }));
    const summary = await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(summary.updated, 0, JSON.stringify(summary));
    assert.match(summary.refused[0].reasons[0], /it renames '1' to '2', but a version keeps its number: add a new entry/);
    assert.deepEqual(fx.state.tables.disclaimer_versions.map((r) => [r.version, r.text]), [[1, "Be nice"]]);
    assert.equal(acceptances[1], 5);
    // the same pull again : still refused, nothing changed
    assert.equal((await RepoObjects.syncRepository(await desc("disclaimer"), "news")).updated, 0);
    // as a new entry, in the same file : made
    fx.writeEntry("news", "disclaimer/terms.yaml", "disclaimer", [file({ enabled: false }), file({ version: 2, text: "New terms" })]);
    const made = await RepoObjects.syncRepository(await desc("disclaimer"), "news");
    assert.equal(made.created, 1, JSON.stringify(made));
    assert.deepEqual(made.refused, []);
  });
});
