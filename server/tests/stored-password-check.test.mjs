// A connection check with the masked password tests with the stored one : only against the
// stored server, never against one the request names (it would receive the password). The mail
// check has no stored password since 7.6 (the mail goes through the mail channels).
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const storedLdap = { server: "ldap.corp", port: 636, enable_tls: 1, ignore_certs: 0, cert: "", ca_bundle: "", bind_user_dn: "cn=svc", bind_user_pw: "Bind-Secret" };
let ldapChecked = null;
vi.mock("../src/models/ldap.model.js", () => {
  function Ldap(cfg) { Object.assign(this, cfg); }
  // the default directory, as /ldap hands it to the directory handlers
  Ldap.find = async () => ({ id: 1, ...storedLdap });
  Ldap.findById = async (id) => (String(id) === "1" ? { id: 1, ...storedLdap } : null);
  Ldap.connectionOf = async () => null;
  Ldap.checkCredential = async () => {};
  Ldap.check = async (cfg) => { ldapChecked = cfg; return "ok"; };
  return { default: Ldap };
});

const storedSettings = { mail_server: "smtp.corp", mail_port: 587, mail_secure: 0, mail_username: "svc", mail_password: "Mail-Secret" };
let mailChecked = null;
vi.mock("../src/models/settings.model.js", () => {
  function Settings(cfg) { Object.assign(this, cfg); }
  Settings.find = async () => ({ ...storedSettings });
  Settings.mailcheck = async (cfg) => { mailChecked = cfg; return "id-1"; };
  return { default: Settings };
});

// no active mail channel : the masked password has nothing to stand for
vi.mock("../src/models/notificationChannel.model.js", () => ({ default: { findActive: async () => null } }));

const ldapController = (await import("../src/controllers/v2/ldap.controller.js")).default;
const settingsController = (await import("../src/controllers/v2/settings.controller.js")).default;

function call(handler, body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return handler({ body, headers: {} }, res).then(() => res);
}

beforeEach(() => { ldapChecked = null; mailChecked = null; });

describe("/ldap/check with the masked bind password", () => {
  const masked = { ...storedLdap, bind_user_pw: "**********" };

  test("checks the stored server with the stored password, a port as text and a flag as true count the same", async () => {
    const res = await call(ldapController.check, { ...masked, port: "636", enable_tls: true });
    expect(res.statusCode).toBe(200);
    expect(ldapChecked.bind_user_pw).toBe("Bind-Secret");
  });

  test.each([["server", "evil.example.com"], ["port", 389], ["enable_tls", 0], ["ignore_certs", 1], ["ca_bundle", "-----BEGIN-----"]])(
    "another %s never receives the stored password", async (field, value) => {
      const res = await call(ldapController.check, { ...masked, [field]: value });
      expect(res.statusCode).toBe(400);
      expect(ldapChecked).toBe(null);
    });

  test("a typed password checks any server", async () => {
    const res = await call(ldapController.check, { ...masked, server: "other.corp", bind_user_pw: "typed" });
    expect(res.statusCode).toBe(200);
    expect(ldapChecked.bind_user_pw).toBe("typed");
  });
});

describe("/settings/mailcheck with the masked mail password", () => {
  const masked = { ...storedSettings, mail_password: "**********", to: "a@b.c" };

  // 7.6 : the settings hold no mail password any more, the mask stands for the active mail
  // channel (tests/settings-old-mail-fields.test.mjs) ; without one it is refused
  test("a masked password without an active mail channel is refused, whatever server", async () => {
    for (const body of [masked, { ...masked, mail_server: "evil.example.com" }]) {
      const res = await call(settingsController.mailcheck, { ...body });
      expect(res.statusCode).toBe(400);
      expect(mailChecked).toBe(null);
    }
  });

  test("a typed password tests the server sent, with the values sent and nothing stored", async () => {
    const res = await call(settingsController.mailcheck, { ...storedSettings, mail_secure: true, mail_password: "typed", to: "a@b.c" });
    expect(res.statusCode).toBe(200);
    expect(mailChecked).toEqual({ mail_server: "smtp.corp", mail_port: 587, mail_secure: 1, mail_username: "svc", mail_password: "typed", mail_from: undefined });
  });
});
