// The mail_* settings of before 7.6 (the mail goes through the mail channels of Connections >
// Notifications since then) : a client of 7.5 that still sends them to PUT /api/v2/settings is
// neither refused for them nor told to "provide all required fields". They are ignored with a
// deprecation warning logged once, a body of only them answers a 400 that says where the mail
// settings went, and a user limited to a settings section is not refused for them.
// POST /api/v2/settings/mailcheck with the masked password (the stored settings of before)
// tests the active mail channel, or says to add one.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ------------------------------------------------------------------
// the settings row, the mail channels, and what was written or sent
// ------------------------------------------------------------------
const updates = [];
const sent = [];
let activeChannel = null;
vi.mock("../src/models/settings.model.js", () => {
  /**
   * The settings record, as the real constructor keeps it : only the fields it knows.
   *
   * Args:
   *   body (object): the fields sent.
   */
  function Settings(body) {
    for (const key of ["url", "app_name", "default_theme", "default_language"]) {
      if (body[key] !== undefined) this[key] = body[key];
    }
  }
  Settings.find = async () => ({ url: "https://af.example.com" });
  Settings.update = async (record) => { updates.push({ ...record }); };
  Settings.maildo = async (config, to) => { sent.push({ config, to }); return "id-channel"; };
  Settings.mailcheck = async (config, to) => { sent.push({ config, to }); return "id-typed"; };
  return { default: Settings };
});
vi.mock("../src/models/notificationChannel.model.js", () => ({
  default: {
    findActive: async () => activeChannel,
    toMailConfig: async (channel) => ({ mail_server: `${channel.name}.smtp.example.com`, mail_port: 587, mail_secure: 1, mail_username: "svc", mail_password: "Channel-Secret", mail_from: "af@example.com" }),
  },
}));
vi.mock("../src/routes/v2/app.routes.js", () => ({ forgetAppDefaults: () => {} }));
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {} }));

const { default: controller } = await import("../src/controllers/v2/settings.controller.js");

/**
 * Calls a controller handler and waits for its answer.
 *
 * Args:
 *   handler (function): the controller handler.
 *   options (object): the signed-in user's role options.
 *   body (object): the request body.
 *
 * Returns:
 *   Promise<{status: number, data: object}>: the answer.
 */
function call(handler, options, body = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, data: d }); return this; },
    };
    handler({ body, params: {}, query: {}, headers: {}, user: { user: { username: "bob", options } } }, res);
  });
}

const allSettings = { showSettings: true };
const appearanceOnly = { showAppearanceSettings: true };
const oldMail = { mail_server: "smtp.corp", mail_port: 587, mail_secure: 0, mail_username: "svc", mail_password: "**********", mail_from: "af@corp" };

beforeEach(() => {
  updates.length = 0;
  sent.length = 0;
  activeChannel = null;
});

// ─── PUT /api/v2/settings ─────────────────────────────────────────────────────

describe("PUT /api/v2/settings with the mail_* fields of before 7.6", () => {
  test("only mail_* fields : a 400 that says the mail settings moved, nothing written", async () => {
    const r = await call(controller.update, allSettings, { ...oldMail });
    expect(r.status).toBe(400);
    expect(r.data.details).toMatch(/moved to Connections > Notifications/);
    expect(r.data.details).toContain("mail_server");
    expect(r.data.details).not.toMatch(/required fields/);
    expect(updates).toEqual([]);
  });

  test("with other fields : saved, the mail_* fields left out", async () => {
    const r = await call(controller.update, allSettings, { ...oldMail, url: "https://new.example.com", default_theme: "dark" });
    expect(r.status).toBe(200);
    expect(updates).toEqual([{ url: "https://new.example.com", default_theme: "dark" }]);
  });

  test("a user limited to the appearance section is not refused for them", async () => {
    const r = await call(controller.update, appearanceOnly, { ...oldMail, app_name: "Forms" });
    expect(r.status).toBe(200);
    expect(updates).toEqual([{ app_name: "Forms" }]);
  });

  test("nor for a body of only them : the same 400 as everyone, not a 403", async () => {
    const r = await call(controller.update, appearanceOnly, { mail_from: "af@corp" });
    expect(r.status).toBe(400);
    expect(r.data.details).toMatch(/moved to Connections > Notifications/);
  });

  test("a field outside the section is still refused, the mail_* fields not named in the answer", async () => {
    const r = await call(controller.update, appearanceOnly, { ...oldMail, url: "https://evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.data.details).toContain("url");
    expect(r.data.details).not.toContain("mail_");
    expect(updates).toEqual([]);
  });

  test("an empty body and unknown fields answer as before", async () => {
    expect((await call(controller.update, allSettings, {})).status).toBe(400);
    const r = await call(controller.update, allSettings, { nothing_known: 1 });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/required fields/);
  });
});

// ─── the deprecation warning ──────────────────────────────────────────────────

describe("the deprecation warning", () => {
  test("logged once, not at every save", async () => {
    vi.resetModules();
    const fresh = (await import("../src/controllers/v2/settings.controller.js")).default;
    const freshLogger = (await import("../src/lib/logger.js")).default;
    const warned = vi.spyOn(freshLogger, "warning").mockImplementation(() => {});
    await call(fresh.update, allSettings, { ...oldMail, url: "https://a.example.com" });
    await call(fresh.update, allSettings, { ...oldMail });
    await call(fresh.update, allSettings, { url: "https://b.example.com" });
    const mailWarnings = warned.mock.calls.filter(([m]) => /mail_\* fields .* deprecated since 7\.6/.test(String(m)));
    expect(mailWarnings).toHaveLength(1);
    warned.mockRestore();
  });
});

// ─── POST /api/v2/settings/mailcheck ──────────────────────────────────────────

describe("POST /api/v2/settings/mailcheck", () => {
  test("the masked password : the test goes through the active mail channel, never the server sent", async () => {
    activeChannel = { id: 1, name: "default", type: "mail", is_active: 1, enabled: 1 };
    const r = await call(controller.mailcheck, allSettings, { ...oldMail, mail_server: "evil.example.com", to: "a@b.c" });
    expect(r.status).toBe(200);
    expect(r.data.message).toMatch(/through the mail channel default/);
    expect(sent).toHaveLength(1);
    expect(sent[0].config.mail_server).toBe("default.smtp.example.com");
    expect(sent[0].to).toBe("a@b.c");
  });

  test("no server at all : the active mail channel too", async () => {
    activeChannel = { id: 2, name: "m365", type: "mail", is_active: 1, enabled: 1 };
    const r = await call(controller.mailcheck, allSettings, { to: "a@b.c" });
    expect(r.status).toBe(200);
    expect(sent[0].config.mail_server).toBe("m365.smtp.example.com");
  });

  test("no active mail channel : a 400 that says to add one and use its Test button, nothing sent", async () => {
    const r = await call(controller.mailcheck, allSettings, { ...oldMail, to: "a@b.c" });
    expect(r.status).toBe(400);
    expect(r.data.details).toMatch(/no active mail channel: add one under Connections > Notifications.*Test button/);
    expect(sent).toEqual([]);
  });

  test("a typed password tests the server sent, as before", async () => {
    activeChannel = { id: 1, name: "default", type: "mail", is_active: 1, enabled: 1 };
    const r = await call(controller.mailcheck, allSettings, { ...oldMail, mail_password: "typed", to: "a@b.c" });
    expect(r.status).toBe(200);
    expect(sent[0].config).toMatchObject({ mail_server: "smtp.corp", mail_password: "typed" });
  });
});
