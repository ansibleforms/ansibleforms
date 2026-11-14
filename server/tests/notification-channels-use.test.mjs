// Notification channels in use : a form names them (its notifications, its approval - the schema
// takes channels next to recipients), a job's end and an approval reach them with a link to the
// job, and the mail servers of a 7 release candidate become mail channels when the database is
// upgraded.
import { describe, test, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import Ajv from "ajv";
import { createRequire } from "module";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the queries ; each answers what the test queues (else [])
const queries = [];
let answers = [];
// a transaction runs its statements through the same responder, each marked as part of it
let transactions = 0;
vi.mock("../src/models/db.model.js", () => {
  const run = async (sql, args, tx = false) => {
    queries.push({ sql, args, tx });
    const next = answers.find((a) => a.match.test(sql));
    return next ? (typeof next.rows === "function" ? next.rows(sql, args) : next.rows) : [];
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

// what reached the channels
const sent = [];
vi.mock("../src/lib/notifiers.js", () => ({
  sendToChannels: async (names, message, recipients, context) => {
    sent.push({ names, message, recipients, context });
    return names.map((name) => ({ name, ok: true }));
  },
}));

const require = createRequire(import.meta.url);
const Job = (await import("../src/models/job.model.js")).default;
const { default: Settings } = await import("../src/models/settings.model.js");
const { channelsOfForm } = await import("../src/models/form.model.js");
const { default: NotificationChannel } = await import("../src/models/notificationChannel.model.js");
const { moveMailServersToChannels, copyMailSettingsToServers, moveMailServersToCredentials, moveSsoClientsToCredentials, moveLdapServersToCredentials, moveRunnerSecretsToCredentials, moveConnectionsToCredentials, retypeConnectionCredentials, moveBannerSwitchToAnnouncements } = await import("../src/models/schema.model.js");

beforeEach(() => {
  queries.length = 0;
  transactions = 0;
  answers = [];
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("a form's channels, in the schema", () => {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));
  const validate = ajv.compile(JSON.parse(fs.readFileSync(new URL("../schema/form_schema.json", import.meta.url), "utf8")));
  const form = (over) => ({ name: "f", type: "ansible", playbook: "p.yml", roles: ["admin"], fields: [], ...over });

  test("notifications take channels next to recipients, or alone ; one of them at least", () => {
    expect(validate(form({ notifications: { channels: ["ops-slack"], onStatus: ["failed"] } }))).toBe(true);
    expect(validate(form({ notifications: { recipients: ["a@example.com"], channels: ["ops-teams"] } }))).toBe(true);
    expect(validate(form({ notifications: { onStatus: ["failed"] } }))).toBe(false);
    expect(validate(form({ notifications: { channels: [""] } }))).toBe(false);
  });

  test("an approval takes channels, with or without its mail notifications", () => {
    expect(validate(form({ approval: { message: "ok ?", roles: ["admin"], channels: ["approvers"] } }))).toBe(true);
  });

  test("the channels a form names: its notifications', its approval's and its steps', each once", () => {
    expect(
      channelsOfForm({
        notifications: { channels: ["a", "b"] },
        approval: { channels: ["b", "c"] },
        steps: [{ notifications: { channels: ["d"] } }, { approval: { channels: ["", "e"] } }],
      }),
    ).toEqual(["a", "b", "c", "d", "e"]);
    expect(channelsOfForm({})).toEqual([]);
  });
});

describe("a job's end and an approval reach the channels", () => {
  const job = { id: 12, form: "Deploy", job_type: "ansible", status: "success", user: "bob", output: "" };

  test("a status notification with channels only: a short text and the link to the job", async () => {
    vi.spyOn(Job, "findById").mockResolvedValue({ ...job, notifications: JSON.stringify({ channels: ["ops"], onStatus: ["success"] }) });
    vi.spyOn(Settings, "findUrl").mockResolvedValue({ url: "https://af.example.com/" });
    expect(await Job.sendStatusNotification(12)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].names).toEqual(["ops"]);
    expect(sent[0].message).toMatchObject({ status: "success", event: "status", link: "https://af.example.com/jobs/12" });
    expect(sent[0].message.text).toContain("12");
    expect(sent[0].message.text).toContain("Deploy");
  });

  test("a status it does not notify on: nothing sent", async () => {
    vi.spyOn(Job, "findById").mockResolvedValue({ ...job, notifications: JSON.stringify({ channels: ["ops"], onStatus: ["failed"] }) });
    expect(await Job.sendStatusNotification(12)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("an approval with channels: its title and message, the link, its mail recipients handed on", async () => {
    vi.spyOn(Settings, "findUrl").mockResolvedValue({ url: "https://af.example.com" });
    const approval = { title: "Remove $(vm) ?", message: "About to remove $(vm).", roles: ["admin"], channels: ["approvers"] };
    expect(await Job.sendApprovalNotification(approval, { vm: "web1" }, 30)).toBe(true);
    expect(sent[0].names).toEqual(["approvers"]);
    expect(sent[0].message).toMatchObject({ title: "Remove web1 ?", text: "About to remove web1.", link: "https://af.example.com/jobs/30", status: "approve" });
    expect(sent[0].context).toBe("Approval");
  });

  test("a mail channel named: the usual mail through it, not the active one ; the others by name", async () => {
    vi.spyOn(Job, "findById").mockResolvedValue({ ...job, notifications: JSON.stringify({ recipients: ["ops@example.com"], channels: ["relay", "ops"], onStatus: ["any"] }) });
    vi.spyOn(Settings, "findUrl").mockResolvedValue({ url: "https://af.example.com" });
    const relay = { id: 2, name: "relay", type: "mail", enabled: 1, server: "relay.example.com", port: 25, from_address: "af@example.com" };
    vi.spyOn(NotificationChannel, "findByName").mockImplementation(async (name) => (name === "relay" ? relay : null));
    const mailed = vi.spyOn(Job, "_buildAndSendEmail").mockResolvedValue(true);
    expect(await Job.sendStatusNotification(12)).toBe(true);
    expect(mailed).toHaveBeenCalledTimes(1);
    expect(mailed.mock.calls[0][0]).toMatchObject({ recipients: ["ops@example.com"], templatePath: "jobstatus.html", server: relay });
    expect(sent[0].names).toEqual(["ops"]);
  });

  test("no mail channel named: the usual mail through the active one", async () => {
    vi.spyOn(Job, "findById").mockResolvedValue({ ...job, notifications: JSON.stringify({ recipients: ["ops@example.com"], onStatus: ["any"] }) });
    const mailed = vi.spyOn(Job, "_buildAndSendEmail").mockResolvedValue(true);
    await Job.sendStatusNotification(12);
    expect(mailed.mock.calls[0][0].server).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test("no url set: the channels still get it, without a link", async () => {
    vi.spyOn(Settings, "findUrl").mockResolvedValue({ url: "" });
    await Job.sendApprovalNotification({ message: "m", roles: ["admin"], channels: ["x"] }, {}, 1);
    expect(sent[0].message.link).toBe("");
  });
});

describe("the mail servers of a release candidate become mail channels", () => {
  test("no mail_servers table: nothing to do", async () => {
    answers = [{ match: /SHOW TABLES FROM AnsibleForms LIKE 'mail_servers'/, rows: [] }];
    expect(await moveMailServersToChannels()).toBe(null);
  });

  test("copied as mail channels, then the table dropped", async () => {
    answers = [
      { match: /LIKE 'mail_servers'/, rows: [{ t: "mail_servers" }] },
      { match: /^INSERT INTO AnsibleForms\.`notification_channels`/, rows: { affectedRows: 2 } },
      { match: /SELECT m\.name FROM AnsibleForms\.`mail_servers` m WHERE NOT EXISTS/, rows: [] },
      { match: /SHOW TABLES FROM \?\? WHERE/, rows: [{ Tables_in_AnsibleForms: "mail_servers" }] },
      { match: /DROP TABLE IF EXISTS/, rows: { affectedRows: 0 } },
    ];
    expect(await moveMailServersToChannels()).toMatch(/Moved 2 mail server\(s\)/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`notification_channels`/.test(q.sql));
    expect(insert.sql).toMatch(/SELECT m\.name, m\.description, 'mail', 1, m\.is_active/);
    expect(queries.some((q) => /DROP TABLE IF EXISTS/.test(q.sql))).toBe(true);
  });

  test("one named like a channel of another type: not copied over it, and the table kept", async () => {
    answers = [
      { match: /LIKE 'mail_servers'/, rows: [{ t: "mail_servers" }] },
      { match: /^INSERT INTO/, rows: { affectedRows: 1 } },
      { match: /SELECT m\.name FROM AnsibleForms\.`mail_servers` m WHERE NOT EXISTS/, rows: [{ name: "ops" }] },
    ];
    expect(await moveMailServersToChannels()).toMatch(/ops could not move/);
    expect(queries.some((q) => /DROP TABLE/.test(q.sql))).toBe(false);
  });

  test("the mail settings of before: the first mail channel, only while there is none", async () => {
    answers = [{ match: /COUNT\(\*\) AS n FROM AnsibleForms\.`notification_channels` WHERE type = 'mail'/, rows: [{ n: 1 }] }];
    expect(await copyMailSettingsToServers()).toBe(null);
    answers = [
      { match: /COUNT\(\*\) AS n/, rows: [{ n: 0 }] },
      { match: /SELECT \* FROM AnsibleForms\.`settings`/, rows: [{ mail_server: "smtp.example.com", mail_port: 25 }] },
    ];
    expect(await copyMailSettingsToServers()).toMatch(/mail channel 'default'/);
    const insert = queries.find((q) => /INSERT INTO AnsibleForms\.`notification_channels`/.test(q.sql));
    expect(insert.sql).toMatch(/VALUES \(\?, \?, 'mail', 1/);
  });

  test("copied once: the settings' server and login emptied with the copy, in one transaction", async () => {
    answers = [
      { match: /COUNT\(\*\) AS n/, rows: [{ n: 0 }] },
      { match: /SELECT \* FROM AnsibleForms\.`settings`/, rows: [{ mail_server: "smtp.example.com", mail_port: 25, mail_username: "af", mail_password: "enc" }] },
    ];
    expect(await copyMailSettingsToServers()).toMatch(/credential 'mail-login'/);
    expect(transactions).toBe(1);
    const writes = queries.filter((q) => /^(INSERT|UPDATE)/.test(q.sql));
    expect(writes.map((q) => q.tx)).toEqual([true, true, true]);
    expect(writes[2].sql).toMatch(/UPDATE AnsibleForms\.`settings` SET mail_server = ''/);
  });

  test("a hand-made credential named mail-login is not taken over", async () => {
    answers = [
      { match: /COUNT\(\*\) AS n/, rows: [{ n: 0 }] },
      { match: /SELECT \* FROM AnsibleForms\.`settings`/, rows: [{ mail_server: "smtp.example.com", mail_username: "af" }] },
      { match: /SELECT 1 FROM AnsibleForms\.`credentials` WHERE name = \?/, rows: (sql, args) => (args[0] === "mail-login" ? [{ 1: 1 }] : []) },
    ];
    expect(await copyMailSettingsToServers()).toMatch(/credential 'mail-login-2'/);
  });

  test("a channel of another type named default: not overwritten, the settings kept", async () => {
    answers = [
      { match: /COUNT\(\*\) AS n/, rows: [{ n: 0 }] },
      { match: /SELECT \* FROM AnsibleForms\.`settings`/, rows: [{ mail_server: "smtp.example.com" }] },
      { match: /SELECT type FROM AnsibleForms\.`notification_channels` WHERE name = 'default'/, rows: [{ type: "slack" }] },
    ];
    expect(await copyMailSettingsToServers()).toMatch(/slack channel is named 'default'/);
    expect(queries.some((q) => /^(INSERT|UPDATE)/.test(q.sql))).toBe(false);
  });
});

describe("a mail channel's server moves to its smtp credential", () => {
  const channel = (over) => ({ id: 1, name: "office", server: "smtp.example.com", port: 587, secure: 1, credential: "o365", ...over });

  test("no channel with a server left: nothing to do", async () => {
    expect(await moveMailServersToCredentials()).toBe(null);
  });

  test("a credential without a server: the channel's goes into it, the channel's emptied", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`notification_channels`/, rows: [channel()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "o365", host: null }] },
    ];
    expect(await moveMailServersToCredentials()).toMatch(/office into o365/);
    const into = queries.find((q) => /^UPDATE AnsibleForms\.`credentials` SET host/.test(q.sql));
    expect(into.args).toEqual(["smtp.example.com", 587, 1, 9]);
    const emptied = queries.find((q) => /^UPDATE AnsibleForms\.`notification_channels` SET server = NULL/.test(q.sql));
    expect(emptied.args).toEqual(["o365", 1]);
  });

  test("a credential with another server: a copy with the channel's, which the channel then names", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`notification_channels`/, rows: [channel()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "o365", host: "other.example.com", port: 25, secure: 0 }] },
    ];
    expect(await moveMailServersToCredentials()).toMatch(/a copy of o365, o365-office/);
    expect(queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql)).args.slice(2, 5)).toEqual(["smtp.example.com", 587, 1]);
    expect(queries.find((q) => /SET server = NULL/.test(q.sql)).args).toEqual(["o365-office", 1]);
  });

  test("a channel without a credential (a relay) keeps its own server: it is not read", async () => {
    expect(await moveMailServersToCredentials()).toBe(null);
    const read = queries.find((q) => /FROM AnsibleForms\.`notification_channels`/.test(q.sql));
    expect(read.sql).toMatch(/credential IS NOT NULL AND credential <> ''/);
  });

  test("a credential it names that is not there: a new smtp one without a user", async () => {
    answers = [{ match: /FROM AnsibleForms\.`notification_channels`/, rows: [channel({ name: "relay", credential: "gone", port: 25, secure: 0 })] }];
    expect(await moveMailServersToCredentials()).toMatch(/relay into relay-smtp/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql));
    expect(insert.sql).toMatch(/'smtp'/);
    expect(insert.args).toEqual(["relay-smtp", "The server of the mail channel relay", "smtp.example.com", 25, 0]);
  });
});

describe("a mail channel sends through its credential's server", () => {
  test("the credential's server, port and TLS ; its own while the credential has none", async () => {
    answers = [{ match: /credential/, rows: [{ name: "o365", host: "smtp.office365.com", port: 587, secure: 1 }] }];
    vi.spyOn(NotificationChannel, "resolveCredential").mockResolvedValue({ user: "u", password: "p" });
    const config = await NotificationChannel.toMailConfig({ name: "m", server: "old.example.com", port: 25, credential: "o365", from_address: "af@example.com" });
    expect(config).toMatchObject({ mail_server: "smtp.office365.com", mail_port: 587, mail_secure: 1, mail_username: "u" });
    answers = [{ match: /credential/, rows: [{ name: "old-login", host: null }] }];
    const legacy = await NotificationChannel.toMailConfig({ name: "m", server: "old.example.com", port: 25, credential: "old-login" });
    expect(legacy).toMatchObject({ mail_server: "old.example.com", mail_port: 25 });
  });

  test("a relay's credential has no user: no login", async () => {
    answers = [{ match: /credential/, rows: [{ name: "relay-smtp", host: "relay.example.com", port: 25 }] }];
    vi.spyOn(NotificationChannel, "resolveCredential").mockResolvedValue({ user: "", password: "" });
    const config = await NotificationChannel.toMailConfig({ name: "r", credential: "relay-smtp" });
    expect(config).toMatchObject({ mail_server: "relay.example.com", mail_username: "" });
  });
});

describe("an SSO provider's client moves to a credential of its type", () => {
  test("its own client: a new credential, named after it, with its tenant ; the provider's emptied", async () => {
    answers = [{ match: /FROM AnsibleForms\.`oauth2_providers`/, rows: [{ id: 3, name: "Contoso Entra ID", provider: "azuread", tenant_id: "t-1", redirect_uri: "https://f/cb", client_id: "c-1", client_secret: "enc", credential: null }] }];
    expect(await moveSsoClientsToCredentials()).toMatch(/Contoso Entra ID into contoso-entra-id-sso/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql));
    expect(insert.args).toEqual(["contoso-entra-id-sso", "c-1", "enc", "The client of the SSO provider Contoso Entra ID", "entraid", "t-1", null, "https://f/cb"]);
    expect(queries.find((q) => /SET client_id = NULL/.test(q.sql)).args).toEqual(["contoso-entra-id-sso", 3]);
  });

  test("a credential already: its issuer copied into it when it has none", async () => {
    answers = [{ match: /FROM AnsibleForms\.`oauth2_providers`/, rows: [{ id: 4, name: "kc", provider: "oidc", issuer: "https://kc/realms/a", credential: "kc-app" }] }];
    expect(await moveSsoClientsToCredentials()).toMatch(/kc kept kc-app/);
    const into = queries.find((q) => /^UPDATE AnsibleForms\.`credentials` SET issuer/.test(q.sql));
    expect(into.args).toEqual(["https://kc/realms/a", "kc-app"]);
  });

  test("nothing of its own left: nothing to do", async () => {
    expect(await moveSsoClientsToCredentials()).toBe(null);
  });
});

describe("an LDAP directory's servers move to its ldap credential", () => {
  const dir = (over) => ({ id: 2, name: "eu", server: "ldap.eu:636", port: 636, enable_tls: 1, ignore_certs: 0, cert: null, ca_bundle: "CA", bind_user_dn: "cn=svc", bind_user_pw: "enc", credential: "eu-bind", ...over });

  test("a credential without servers: the directory's go into it, the directory's emptied", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`ldap`/, rows: [dir()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "eu-bind", host: null }] },
    ];
    expect(await moveLdapServersToCredentials()).toMatch(/eu into eu-bind/);
    const into = queries.find((q) => /^UPDATE AnsibleForms\.`credentials` SET \?/.test(q.sql));
    expect(into.args[0]).toMatchObject({ host: "ldap.eu:636", port: 636, secure: 1, ca_bundle: "CA" });
    expect(queries.find((q) => /UPDATE AnsibleForms\.`ldap` SET server = NULL/.test(q.sql)).args).toEqual(["eu-bind", 2]);
  });

  test("its own bind account: a new ldap credential with it and the servers", async () => {
    answers = [{ match: /FROM AnsibleForms\.`ldap`/, rows: [dir({ credential: null })] }];
    expect(await moveLdapServersToCredentials()).toMatch(/eu into eu-ldap/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials` SET/.test(q.sql));
    expect(insert.args[0]).toMatchObject({ name: "eu-ldap", user: "cn=svc", password: "enc", credential_type: "ldap", host: "ldap.eu:636" });
  });

  test("nothing of its own left: nothing to do", async () => {
    expect(await moveLdapServersToCredentials()).toBe(null);
  });
});

describe("a runner's token or login moves to a credential", () => {
  test("a token: an api credential with it ; a Jenkins: a userpass one with its user and token", async () => {
    answers = [{ match: /FROM AnsibleForms\.`runners`/, rows: [
      { id: 1, name: "semaphore-prod", type: "semaphore", token: "enc-t" },
      { id: 2, name: "jenkins-ci", type: "jenkins", username: "af", token: "enc-j" },
      { id: 3, name: "awx-login", type: "awx", use_credentials: 1, username: "admin", password: "enc-p" },
    ] }];
    expect(await moveRunnerSecretsToCredentials()).toMatch(/3 runner/);
    const inserts = queries.filter((q) => /^INSERT INTO AnsibleForms\.`credentials` SET/.test(q.sql)).map((q) => q.args[0]);
    expect(inserts[0]).toMatchObject({ name: "semaphore-prod-token", credential_type: "api", user: null, password: "enc-t" });
    expect(inserts[1]).toMatchObject({ name: "jenkins-ci-login", credential_type: "userpass", user: "af", password: "enc-j" });
    expect(inserts[2]).toMatchObject({ name: "awx-login-login", credential_type: "userpass", user: "admin", password: "enc-p" });
    expect(queries.filter((q) => /UPDATE AnsibleForms\.`runners` SET token = NULL/.test(q.sql)).map((q) => q.args)).toEqual([
      ["semaphore-prod-token", 1], ["jenkins-ci-login", 2], ["awx-login-login", 3],
    ]);
  });

  test("none left: nothing to do", async () => {
    expect(await moveRunnerSecretsToCredentials()).toBe(null);
  });
});

describe("the announcements' switch of before moves to each announcement", () => {
  test("switched on: nothing to do", async () => {
    answers = [{ match: /SELECT banner_show/, rows: [{ banner_show: 1 }] }];
    expect(await moveBannerSwitchToAnnouncements()).toBe(null);
    expect(queries.some((q) => /UPDATE/.test(q.sql))).toBe(false);
  });
  test("switched off: every announcement disabled, the switch back on", async () => {
    answers = [
      { match: /SELECT banner_show/, rows: [{ banner_show: 0 }] },
      { match: /UPDATE AnsibleForms\.`announcements`/, rows: { affectedRows: 2 } },
    ];
    expect(await moveBannerSwitchToAnnouncements()).toMatch(/disabled 2 announcement/);
    expect(queries.some((q) => /SET banner_show = 1/.test(q.sql))).toBe(true);
  });
});

describe("a secret store's and a runner's address move to their credential", () => {
  const store = (over) => ({ id: 1, name: "vault", type: "vault", address: "https://vault.example.com:8200/", ignore_certs: 0, ca_bundle: "CA", credential: "vault-token", ...over });
  const runner = (over) => ({ id: 2, name: "jenkins", type: "jenkins", address: "http://jenkins:8080", ignore_certs: 1, ca_bundle: null, credential: "jenkins-login", ...over });

  test("no record with an address left: nothing to do", async () => {
    expect(await moveConnectionsToCredentials()).toBe(null);
  });

  test("a credential without an address: the record's goes into it, the record's emptied", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`secret_stores`/, rows: [store()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "vault-token", credential_type: "api", url: null }] },
    ];
    expect(await moveConnectionsToCredentials()).toMatch(/vault into vault-token/);
    const into = queries.find((q) => /^UPDATE AnsibleForms\.`credentials` SET \?/.test(q.sql));
    expect(into.args).toEqual([{ url: "https://vault.example.com:8200", ignore_certs: 0, ca_bundle: "CA" }, 9]);
    const emptied = queries.find((q) => /^UPDATE AnsibleForms\.`secret_stores`/.test(q.sql));
    expect(emptied.args).toEqual([{ url: "", ignore_certs: 0, ca_bundle: null, credential: "vault-token" }, 1]);
  });

  test("a credential with another address: a copy with the record's, which the record then names", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [runner()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "jenkins-login", credential_type: "userpass", url: "http://other:8080" }] },
    ];
    expect(await moveConnectionsToCredentials()).toMatch(/a copy of jenkins-login, jenkins-login-jenkins/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql));
    expect(insert.args.slice(2)).toEqual(["userpass", "http://jenkins:8080", 1, null, 9]);
    expect(queries.find((q) => /^UPDATE AnsibleForms\.`runners`/.test(q.sql)).args).toEqual([{ uri: "", ignore_certs: 0, ca_bundle: null, credential: "jenkins-login-jenkins" }, 2]);
  });

  test("the same address: nothing copied, the record's emptied", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [runner()] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials` WHERE name/, rows: [{ id: 9, name: "jenkins-login", credential_type: "userpass", url: "http://jenkins:8080" }] },
    ];
    await moveConnectionsToCredentials();
    expect(queries.some((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql))).toBe(false);
    expect(queries.find((q) => /^UPDATE AnsibleForms\.`runners`/.test(q.sql)).args[0].credential).toBe("jenkins-login");
  });

  test("no credential: a new one with the store's token or AppID, the store's own emptied", async () => {
    answers = [
      {
        match: /FROM AnsibleForms\.`secret_stores`/,
        rows: [store({ name: "legacy", credential: null, token: "enc" }), store({ id: 3, name: "ccp", type: "cyberark_ccp", credential: null, app_id: "AF", client_cert: "CERT", client_key: "enckey" })],
      },
    ];
    expect(await moveConnectionsToCredentials()).toMatch(/legacy into legacy-token, ccp into ccp-appid/);
    const inserts = queries.filter((q) => /^INSERT INTO AnsibleForms\.`credentials` SET/.test(q.sql)).map((q) => q.args[0]);
    expect(inserts[0]).toMatchObject({ name: "legacy-token", credential_type: "api", password: "enc", url: "https://vault.example.com:8200" });
    expect(inserts[1]).toMatchObject({ name: "ccp-appid", credential_type: "cyberark", user: "AF", client_cert: "CERT", client_key: "enckey" });
    const emptied = queries.find((q) => /^UPDATE AnsibleForms\.`secret_stores`/.test(q.sql));
    expect(emptied.args[0]).toMatchObject({ url: "", token: null, credential: "legacy-token" });
  });

  test("an RTE that registered itself and a seeded record are left as they are", async () => {
    await moveConnectionsToCredentials();
    const select = queries.find((q) => /FROM AnsibleForms\.`runners`/.test(q.sql));
    expect(select.sql).toMatch(/node_id IS NULL/);
    expect(select.sql).toMatch(/COALESCE\(managed, 0\) = 0/);
  });
});

describe("an RTE added by hand moves its address and token to a credential", () => {
  test("no credential: a new one with its token, the runner's own emptied", async () => {
    answers = [{ match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 5, name: "rte-dc2", type: "rte", address: "https://rte-dc2:8000", token: "enc", ignore_certs: 0, ca_bundle: null, credential: null }] }];
    expect(await moveConnectionsToCredentials()).toMatch(/rte-dc2 into rte-dc2-token/);
    const insert = queries.find((q) => /^INSERT INTO AnsibleForms\.`credentials` SET/.test(q.sql)).args[0];
    expect(insert).toMatchObject({ name: "rte-dc2-token", credential_type: "api", password: "enc", url: "https://rte-dc2:8000" });
    const update = queries.find((q) => /^UPDATE AnsibleForms\.`runners`/.test(q.sql)).args[0];
    expect(update).toMatchObject({ token: null, credential: "rte-dc2-token" });
    // its address kept : an RTE still on 7.2 finds its runner by it, and adds no second one
    expect(update).not.toHaveProperty("uri");
  });

  test("moved before (its credential has its address): nothing to do again", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 5, name: "rte-dc2", type: "rte", address: "https://rte-dc2:8000/", token: null, ignore_certs: 0, ca_bundle: null, credential: "rte-dc2-token" }] },
      { match: /SELECT name, url FROM AnsibleForms\.`credentials`/, rows: [{ name: "rte-dc2-token", url: "https://rte-dc2:8000" }] },
    ];
    expect(await moveConnectionsToCredentials()).toBe(null);
    expect(queries.some((q) => /^UPDATE|^INSERT/.test(q.sql))).toBe(false);
  });
});

describe("the credentials of the secret stores and runners get the type of their kind", () => {
  const cred = (over) => ({ id: 9, name: "login", credential_type: "userpass", url: "http://jenkins", managed: 0, ...over });

  test("used by one kind only: its type becomes that kind", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 2, type: "jenkins", flavour: null, credential: "login" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred()] },
    ];
    expect(await retypeConnectionCredentials()).toMatch(/login is jenkins/);
    expect(queries.find((q) => /SET credential_type = \?/.test(q.sql)).args).toEqual(["jenkins", 9]);
  });

  test("an awx runner's: its flavour ; a Vault's: vault", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`secret_stores`/, rows: [{ id: 1, type: "vault", flavour: null, credential: "vt" }] },
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 3, type: "awx", flavour: "aap", credential: "aap-login" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: (sql, args) => [cred({ name: args[0], credential_type: "api" })] },
    ];
    expect(await retypeConnectionCredentials()).toMatch(/vt is vault, aap-login is aap/);
  });

  test("used by several kinds, or by something else that checks its type: a copy per other kind", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`secret_stores`/, rows: [{ id: 1, type: "vault", flavour: null, credential: "shared" }] },
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 2, type: "rte", flavour: null, credential: "shared" }] },
      { match: /UNION SELECT/, rows: [{ name: "shared" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred({ name: "shared", credential_type: "api", url: "https://vault" })] },
    ];
    expect(await retypeConnectionCredentials()).toMatch(/a copy of shared for vault, shared-vault, a copy of shared for rte, shared-rte/);
    expect(queries.some((q) => /SET credential_type = \?/.test(q.sql))).toBe(false);
    expect(queries.find((q) => /^UPDATE AnsibleForms\.`runners` SET credential/.test(q.sql)).args).toEqual(["shared-rte", 2]);
    expect(queries.find((q) => /SET url = NULL/.test(q.sql)).args).toEqual([9]);
  });

  test("of its kind already, or of the config seed: left as it is", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 2, type: "jenkins", flavour: null, credential: "login" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred({ credential_type: "jenkins" })] },
    ];
    expect(await retypeConnectionCredentials()).toBe(null);
    answers[1] = { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred({ managed: 1 })] };
    expect(await retypeConnectionCredentials()).toBe(null);
  });

  test("awx, aap and ascender are one family: an aap credential of an awx runner is left as it is", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 3, type: "awx", flavour: null, credential: "tower" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred({ name: "tower", credential_type: "aap" })] },
    ];
    expect(await retypeConnectionCredentials()).toBe(null);
    expect(queries.some((q) => /SET credential_type = \?|^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql))).toBe(false);
  });

  test("an awx and an aap runner sharing one login: retyped once, never split", async () => {
    answers = [
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 3, type: "awx", flavour: null, credential: "tower" }, { id: 4, type: "awx", flavour: "aap", credential: "tower" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred({ name: "tower", credential_type: "api" })] },
    ];
    expect(await retypeConnectionCredentials()).toMatch(/^Gave .*\(tower is awx\)$/);
    expect(queries.some((q) => /^INSERT INTO AnsibleForms\.`credentials`/.test(q.sql))).toBe(false);
  });

  test("once: its marker recorded, also with nothing to do ; marked, nothing is read or rewritten", async () => {
    expect(await retypeConnectionCredentials()).toBe(null);
    expect(queries.find((q) => /^INSERT IGNORE INTO AnsibleForms\.`schema_migrations`/.test(q.sql)).args[0]).toBe("retype_connection_credentials");
    queries.length = 0;
    answers = [
      { match: /FROM AnsibleForms\.`schema_migrations`/, rows: [{ 1: 1 }] },
      { match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 2, type: "jenkins", flavour: null, credential: "login" }] },
      { match: /SELECT \* FROM AnsibleForms\.`credentials`/, rows: [cred()] },
    ];
    expect(await retypeConnectionCredentials()).toBe(null);
    expect(queries.length).toBe(1);
  });
});

describe("each move writes a credential and the record naming it in one transaction", () => {
  // a crash between the two used to leave a credential nothing named, and the next start
  // made a second one (-2) beside it
  const writes = () => queries.filter((q) => /^(INSERT|UPDATE)/.test(q.sql));

  test("a mail channel, an SSO provider, an LDAP directory, a runner, a secret store", async () => {
    answers = [{ match: /FROM AnsibleForms\.`notification_channels`/, rows: [{ id: 1, name: "relay", server: "smtp", port: 25, secure: 0, credential: null }] }];
    await moveMailServersToCredentials();
    answers = [{ match: /FROM AnsibleForms\.`oauth2_providers`/, rows: [{ id: 3, name: "e", provider: "azuread", client_id: "c", credential: null }] }];
    await moveSsoClientsToCredentials();
    answers = [{ match: /FROM AnsibleForms\.`ldap`/, rows: [{ id: 2, name: "eu", server: "ldap.eu", credential: null }] }];
    await moveLdapServersToCredentials();
    answers = [{ match: /FROM AnsibleForms\.`runners`/, rows: [{ id: 1, name: "s", type: "semaphore", token: "t" }] }];
    await moveRunnerSecretsToCredentials();
    answers = [{ match: /FROM AnsibleForms\.`secret_stores`/, rows: [{ id: 1, name: "v", type: "vault", address: "https://v", token: "t", credential: null }] }];
    await moveConnectionsToCredentials();
    expect(transactions).toBe(5);
    expect(writes().length).toBe(10);
    expect(writes().every((q) => q.tx)).toBe(true);
  });
});
