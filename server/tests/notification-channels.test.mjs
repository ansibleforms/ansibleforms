// Notification channels (Connections > Notifications) : what each type sends (lib/notifiers), how a
// channel is checked by its type (models/notificationChannel), the mail servers of a release
// candidate moved in (schema.model), and a form's channels - in its schema and when a job ends
// or asks for approval.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the queries ; each answers what the test queues (else [])
const queries = [];
let answers = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, args) => {
      queries.push({ sql, args });
      const next = answers.find((a) => a.match.test(sql));
      return next ? next.rows : [];
    },
  },
}));

// the rows of the crud models by name, and the channels
let rows = {};
let channels = [];
vi.mock("../src/models/crud.model.js", () => ({
  default: class {
    static changed() {}
    static isSecretMask(v) {
      return typeof v === "string" && /^\*{8,}$/.test(v);
    }
    static async findByName(modelName, name) {
      if (modelName === "notificationchannel") return channels.find((c) => c.name === name) || null;
      return rows[name] ? { ...rows[name] } : null;
    }
    static async findById(modelName, id) {
      return channels.find((c) => String(c.id) === String(id)) || null;
    }
    static async findAll() {
      return channels;
    }
    static async create() {
      return 7;
    }
    static async update(modelName, data) {
      return data;
    }
    static async delete() {
      return true;
    }
  },
}));

// a credential resolved for use : user and password, by its exact-name regex
let resolved = {};
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    resolveCredential: async (regex) => resolved[regex] || null,
    // the exact name, escaped into an anchored pattern, as the model does
    resolveByName(name) {
      return this.resolveCredential("^" + String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
    },
  },
}));

// what axios was asked ; a failure when the test sets one (an error, or (config) => error)
const requests = [];
let axiosFails = null;
vi.mock("axios", () => ({
  default: async (config) => {
    requests.push(config);
    const err = typeof axiosFails === "function" ? axiosFails(config) : axiosFails;
    if (err) throw err;
    return { status: 200, data: "ok" };
  },
}));

const NotificationChannel = (await import("../src/models/notificationChannel.model.js")).default;
const { renderPayload, DEFAULT_PAYLOAD } = await import("../src/models/notificationChannel.model.js");
const notifiers = await import("../src/lib/notifiers.js");
const { default: Settings } = await import("../src/models/settings.model.js");

beforeEach(() => {
  queries.length = 0;
  answers = [];
  rows = {};
  channels = [];
  resolved = {};
  requests.length = 0;
  axiosFails = null;
});

const message = {
  title: "AnsibleForms 'Deploy' (12) - Success",
  text: "Job 12 of the form 'Deploy' ended: Success.",
  status: "success",
  event: "status",
  job: { id: 12, form: "Deploy", user: "bob" },
  link: "https://af.example.com/jobs/12",
  buttonLabel: "Open the job",
};

describe("a webhook's payload template", () => {
  test("a whole-string placeholder becomes the value as JSON, quotes and newlines escaped", () => {
    const body = renderPayload('{ "text": "{{text}}", "id": "{{jobId}}" }', { text: 'say "hi"\nnow', jobId: 12 });
    expect(JSON.parse(body)).toEqual({ text: 'say "hi"\nnow', id: "12" });
  });

  test("a placeholder inside a longer string is escaped in place ; an unknown one stays", () => {
    const body = renderPayload('{ "msg": "Job {{jobId}}: {{status}} {{nope}}" }', { jobId: 3, status: 'ok"' });
    expect(JSON.parse(body)).toEqual({ msg: 'Job 3: ok" {{nope}}' });
  });

  test("empty: the default, which reads as JSON with every placeholder", () => {
    const body = JSON.parse(renderPayload("", notifiers.payloadValues(message)));
    expect(body).toEqual({
      title: message.title,
      text: message.text,
      status: "success",
      event: "status",
      job: { id: "12", form: "Deploy", user: "bob" },
      link: message.link,
    });
    expect(DEFAULT_PAYLOAD).toContain("{{link}}");
  });
});

describe("the body each type sends", () => {
  test("slack: the text as fallback, a section in mrkdwn (escaped), a button to the job", () => {
    const body = notifiers.slackBody({ ...message, text: "a <b> & c" }, "Open the job");
    expect(body.text).toContain("a <b> & c");
    expect(body.blocks[0].text.text).toBe(`*${message.title}*\na &lt;b&gt; &amp; c`);
    expect(body.blocks[1].elements[0]).toMatchObject({ type: "button", url: message.link, text: { text: "Open the job" } });
  });

  test("teams: a message with one Adaptive Card, its title, text and an open-url action", () => {
    const body = notifiers.teamsBody(message, "Open the job");
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    const card = body.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body.map((b) => b.text)).toEqual([message.title, message.text]);
    expect(card.actions).toEqual([{ type: "Action.OpenUrl", title: "Open the job", url: message.link }]);
    expect(notifiers.teamsBody({ ...message, link: "" }).attachments[0].content.actions).toEqual([]);
  });

  test("telegram: HTML, escaped, the chat, a link, and cut to Telegram's length", () => {
    const body = notifiers.telegramBody({ ...message, text: "<script>" }, "-100", "Open");
    expect(body).toMatchObject({ chat_id: "-100", parse_mode: "HTML", disable_web_page_preview: true });
    expect(body.text).toBe(`<b>${message.title}</b>\n&lt;script&gt;\n<a href="${message.link}">Open</a>`);
    const long = notifiers.telegramBody({ ...message, text: "x".repeat(10000) }, "1");
    expect(long.text.length).toBeLessThanOrEqual(4096);
    expect(long.text).toContain("...");
  });

  test("telegram: the raw text is cut before escaping, so no entity is ever split", () => {
    // every '&' becomes '&amp;' : cutting the escaped text left a dangling '&am'
    for (let n = 3990; n < 4005; n++) {
      const body = notifiers.telegramBody({ ...message, text: "&".repeat(n) }, "1");
      const text = body.text.split("\n")[1];
      expect(text.replace(/\.\.\.$/, "")).toMatch(/^(&amp;)*$/);
      expect(body.text.length).toBeLessThanOrEqual(4096);
    }
    // a huge title is limited and still leaves room for the text
    const big = notifiers.telegramBody({ ...message, title: "<".repeat(5000), text: "hello" }, "1");
    expect(big.text).toContain("hello");
    expect(big.text.length).toBeLessThanOrEqual(4096);
    expect(big.text.split("\n")[0]).toMatch(/^<b>(&lt;)*\.\.\.<\/b>$/);
  });
});

describe("sending to a channel", () => {
  test("slack and teams post their body to the webhook address", async () => {
    await notifiers.send({ name: "s", type: "slack", webhook_url: "https://hooks.slack.com/services/T/B/X" }, message);
    await notifiers.send({ name: "t", type: "teams", webhook_url: "https://prod.westeurope.logic.azure.com/wf" }, message);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["POST", "https://hooks.slack.com/services/T/B/X"],
      ["POST", "https://prod.westeurope.logic.azure.com/wf"],
    ]);
    expect(requests[0].data.blocks).toBeDefined();
    expect(requests[1].data.attachments).toBeDefined();
    expect(requests.every((r) => r.timeout > 0)).toBe(true);
  });

  test("telegram: the bot token from its api credential, in the Bot API's path ; its own API", async () => {
    resolved["^tg-bot$"] = { user: "", password: "123:ABC" };
    await notifiers.send({ name: "tg", type: "telegram", token_credential: "tg-bot", chat_id: "-42" }, message);
    await notifiers.send({ name: "tg", type: "telegram", token_credential: "tg-bot", chat_id: "-42", api_url: "http://127.0.0.1:9/" }, message);
    expect(requests[0].url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(requests[1].url).toBe("http://127.0.0.1:9/bot123:ABC/sendMessage");
    expect(requests[0].data.chat_id).toBe("-42");
  });

  test("a failure says its status, never the address (the secret)", async () => {
    resolved["^tg-bot$"] = { user: "", password: "123:SECRET" };
    axiosFails = Object.assign(new Error("Request failed"), { response: { status: 404, data: { description: "Not Found" } } });
    const err = await notifiers.send({ name: "tg", type: "telegram", token_credential: "tg-bot", chat_id: "1" }, message).catch((e) => e);
    expect(err.message).toMatch(/answered 404/);
    expect(err.message).not.toContain("SECRET");
  });

  test("webhook: its method, its headers, the bearer token, the template rendered, the TLS check off", async () => {
    resolved["^hook-token$"] = { user: "", password: "t0k" };
    await notifiers.send(
      {
        name: "w",
        type: "webhook",
        url: "https://hooks.example.com/af",
        method: "PUT",
        headers: '{"X-Source":"af"}',
        token_credential: "hook-token",
        payload: '{"job":"{{jobId}}","s":"{{status}}"}',
        verify_tls: 0,
      },
      message,
    );
    const r = requests[0];
    expect(r.method).toBe("PUT");
    expect(r.headers).toMatchObject({ "X-Source": "af", Authorization: "Bearer t0k", "Content-Type": "application/json" });
    expect(JSON.parse(r.data)).toEqual({ job: "12", s: "success" });
    expect(r.httpsAgent?.options?.rejectUnauthorized).toBe(false);
  });

  test("mail: through its server, to the recipients ; none is an error", async () => {
    const maildo = vi.spyOn(Settings, "maildo").mockResolvedValue("<id@x>");
    const ch = { name: "m", type: "mail", server: "smtp.example.com", port: 25, from_address: "af@example.com" };
    expect(await notifiers.send(ch, message, ["a@example.com", "b@example.com"])).toBe("<id@x>");
    expect(maildo.mock.calls[0][0]).toMatchObject({ mail_server: "smtp.example.com", mail_from: "af@example.com" });
    expect(maildo.mock.calls[0][1]).toBe("a@example.com,b@example.com");
    expect(maildo.mock.calls[0][3]).toContain(message.link);
    await expect(notifiers.send(ch, message, [])).rejects.toThrow(/no address/);
    maildo.mockRestore();
  });

  test("mail without a login: no credential, or an smtp one without a user, sends with no auth", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<id@x>" });
    const nodemailer = (await import("nodemailer")).default;
    const transport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail });
    // no credential : the channel's own server
    await notifiers.send({ name: "relay", type: "mail", server: "relay.example.com", port: 25, from_address: "af@example.com" }, message, ["a@example.com"]);
    expect(transport.mock.calls[0][0]).toMatchObject({ host: "relay.example.com", port: 25, secure: false });
    expect(transport.mock.calls[0][0].auth).toBeUndefined();
    // an smtp credential with only its server
    rows.relay = { name: "relay", credential_type: "smtp", host: "smtp.relay.example.com", port: 587, secure: 1 };
    resolved["^relay$"] = { user: "", password: "" };
    await notifiers.send({ name: "m", type: "mail", credential: "relay", from_address: "af@example.com" }, message, ["a@example.com"]);
    expect(transport.mock.calls[1][0]).toMatchObject({ host: "smtp.relay.example.com", port: 587, secure: true });
    expect(transport.mock.calls[1][0].auth).toBeUndefined();
    // with a user : its login
    resolved["^relay$"] = { user: "u", password: "p" };
    await notifiers.send({ name: "m", type: "mail", credential: "relay", from_address: "af@example.com" }, message, ["a@example.com"]);
    expect(transport.mock.calls[2][0].auth).toEqual({ user: "u", pass: "p" });
    transport.mockRestore();
  });

  test("by name: an unknown or a turned-off channel is skipped, one failing never stops the others", async () => {
    channels = [
      { id: 1, name: "off", type: "slack", enabled: 0, webhook_url: "https://x/off" },
      { id: 2, name: "bad", type: "slack", enabled: 1, webhook_url: "https://x/bad" },
      { id: 3, name: "good", type: "teams", enabled: 1, webhook_url: "https://x/good" },
    ];
    // the bad one's webhook fails, the good one's answers
    axiosFails = (config) => (config.url.endsWith("/bad") ? new Error("boom") : null);
    const results = await notifiers.sendToChannels(["gone", "off", "bad", "good", "good"], message, [], "Test");
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["gone", false],
      ["off", false],
      ["bad", false],
      ["good", true],
    ]);
  });
});

describe("a channel checked by its type", () => {
  test("its type is one of five, and stays what it was made as", async () => {
    await expect(NotificationChannel.create({ name: "x", type: "sms" })).rejects.toThrow(/one of mail, slack, teams, telegram, webhook/);
    channels = [{ id: 5, name: "s", type: "slack", webhook_url: "https://hooks.slack.com/x" }];
    await expect(NotificationChannel.update({ type: "teams" }, 5)).rejects.toThrow(/stays what it was made as/);
  });

  test("mail needs an smtp credential with its server, or its own ; the first one is active", async () => {
    await expect(NotificationChannel.create({ name: "m", type: "mail" })).rejects.toThrow(/needs its mail server/);
    rows.nohost = { name: "nohost", credential_type: "smtp", host: "" };
    await expect(NotificationChannel.create({ name: "m", type: "mail", credential: "nohost" })).rejects.toThrow(/needs its mail server/);
    rows.api = { name: "api", credential_type: "api" };
    await expect(NotificationChannel.create({ name: "m", type: "mail", server: "smtp", credential: "api" })).rejects.toThrow(/needs an smtp or an entraid credential/);
    const data = { name: "m", type: "mail", server: "smtp" };
    await NotificationChannel.create(data);
    expect(data.is_active).toBe(1);
    expect(data.enabled).toBe(1);
    expect(queries.some((q) => /SET is_active = 0 WHERE id <> \? AND type = 'mail'/.test(q.sql) && q.args[0] === 7)).toBe(true);
  });

  test("mail without a credential (a relay): its own server, port and TLS are kept", async () => {
    const data = { name: "relay", type: "mail", server: "relay.example.com", port: "25", secure: 0, credential: "" };
    await expect(NotificationChannel.create(data)).resolves.toBe(7);
    expect(data).toMatchObject({ server: "relay.example.com", port: 25, credential: null });
    // an update that drops the credential needs the channel's own server
    channels = [{ id: 3, name: "m", type: "mail", credential: "o365", server: null }];
    rows.o365 = { name: "o365", credential_type: "smtp", host: "smtp.office365.com", port: 587, secure: 1 };
    await expect(NotificationChannel.update({ credential: "" }, 3)).rejects.toThrow(/needs its mail server/);
    await expect(NotificationChannel.update({ credential: "", server: "relay.example.com" }, 3)).resolves.toBeTruthy();
  });

  test("mail with a credential that has its server: the channel's own server is emptied, not by the seed", async () => {
    rows.o365 = { name: "o365", credential_type: "smtp", host: "smtp.office365.com", port: 587, secure: 1 };
    const data = { name: "m", type: "mail", server: "typed.example.com", port: 25, secure: 1, credential: "o365" };
    await NotificationChannel.create(data);
    expect(data).toMatchObject({ server: null, port: null, secure: 0, credential: "o365" });
    const seeded = { name: "m", type: "mail", server: "typed.example.com", credential: "o365" };
    await NotificationChannel.create(seeded, { fromSeed: true });
    expect(seeded.server).toBe("typed.example.com");
  });

  test("slack and teams need an http(s) webhook ; its mask sent back keeps the stored one", async () => {
    await expect(NotificationChannel.create({ name: "s", type: "slack" })).rejects.toThrow(/needs its webhook address/);
    await expect(NotificationChannel.create({ name: "s", type: "teams", webhook_url: "ftp://x" })).rejects.toThrow(/http\(s\) url/);
    await expect(NotificationChannel.create({ name: "s", type: "slack", webhook_url: "**********" })).rejects.toThrow(/needs its webhook address/);
    channels = [{ id: 5, name: "s", type: "slack", webhook_url: "https://hooks.slack.com/x" }];
    await expect(NotificationChannel.update({ webhook_url: "**********", description: "d" }, 5)).resolves.toBeTruthy();
  });

  test("telegram needs its token's api credential and its chat", async () => {
    await expect(NotificationChannel.create({ name: "t", type: "telegram", chat_id: "1" })).rejects.toThrow(/bot token/);
    rows.tg = { name: "tg", credential_type: "api" };
    await expect(NotificationChannel.create({ name: "t", type: "telegram", token_credential: "tg" })).rejects.toThrow(/chat id/);
    await expect(NotificationChannel.create({ name: "t", type: "telegram", token_credential: "tg", chat_id: "1" })).resolves.toBe(7);
  });

  test("webhook: an http(s) url, POST or PUT, headers a JSON object, a payload that gives JSON", async () => {
    const base = { name: "w", type: "webhook", url: "https://hooks.example.com" };
    await expect(NotificationChannel.create({ name: "w", type: "webhook" })).rejects.toThrow(/needs its url/);
    await expect(NotificationChannel.create({ ...base, method: "GET" })).rejects.toThrow(/POST, PUT/);
    await expect(NotificationChannel.create({ ...base, headers: "[1]" })).rejects.toThrow(/JSON object/);
    await expect(NotificationChannel.create({ ...base, headers: "{nope" })).rejects.toThrow(/do not read as JSON/);
    await expect(NotificationChannel.create({ ...base, payload: '{"a": {{jobId}} }' })).rejects.toThrow(/JSON template/);
    const data = { ...base, payload: '{"a":"{{jobId}}"}' };
    await NotificationChannel.create(data);
    expect(data).toMatchObject({ method: "POST", verify_tls: 1, enabled: 1 });
  });

  test("only mail has an active one ; the API hands a webhook address back masked", async () => {
    const data = { name: "s", type: "slack", webhook_url: "https://hooks.slack.com/x", is_active: 1 };
    await NotificationChannel.create(data);
    expect(data.is_active).toBe(0);
    expect(NotificationChannel.masked({ name: "s", webhook_url: "https://secret" }).webhook_url).toBe("**********");
    expect(NotificationChannel.masked({ name: "m", webhook_url: null }).webhook_url).toBe("");
  });

  test("the active mail channel: turned off, there is none", async () => {
    channels = [{ id: 1, name: "m", type: "mail", is_active: 1, enabled: 0 }, { id: 2, name: "s", type: "slack", is_active: 1, enabled: 1 }];
    expect(await NotificationChannel.findActive()).toBe(null);
    channels[0].enabled = 1;
    expect((await NotificationChannel.findActive()).name).toBe("m");
  });
});
