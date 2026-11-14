// lib/directoryViews.js : the LDAP and SSO users and groups beside the local ones in the Users and
// Groups lists - those seen at sign-in, and those the roles name - with their roles by the
// login's rule.
import { test, expect } from "vitest";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";

const { splitRef, rolesOfDirectoryUser, directoryUserRows, directoryGroupRows } = await import(
  "../src/lib/directoryViews.js"
);

const roles = [
  { name: "admin", users: ["local/admin"], groups: ["local/admins"] },
  { name: "ops", users: ["ldap/carol"], groups: ["ldap/ops", "azuread/Ops"] },
  { name: "auditors", users: ["oidc/dave"], groups: [] },
  { name: "default", users: [], groups: [] },
];

test("a reference splits into a directory type and a name ; a local one or none is not one", () => {
  expect(splitRef("ldap/ops")).toEqual({ type: "ldap", name: "ops" });
  expect(splitRef("azuread/jane@example.com")).toEqual({ type: "azuread", name: "jane@example.com" });
  expect(splitRef("local/admin")).toBeNull();
  expect(splitRef("ops")).toBeNull();
  expect(splitRef("ldap/")).toBeNull();
});

test("a directory user's roles: by name, through a group seen, and default", () => {
  expect(rolesOfDirectoryUser(roles, "ldap", "bob", ["ldap/ops"]).sort()).toEqual(["default", "ops"]);
  expect(rolesOfDirectoryUser(roles, "ldap", "carol", []).sort()).toEqual(["default", "ops"]);
  // azuread/Ops is Entra ID's group, not LDAP's
  expect(rolesOfDirectoryUser(roles, "ldap", "eve", ["ldap/Ops"])).toEqual(["default"]);
});

test("a directory user's effective roles: a role with admin: true counts as the admin role, as at sign-in", async () => {
  const { effectiveRolesOfDirectoryUser } = await import("../src/lib/directoryViews.js");
  const { effectiveRoleNames } = await import("../src/lib/adminRole.js");
  const withOption = [
    { name: "ops", users: ["ldap/carol"], groups: ["ldap/ops"] },
    { name: "platformAdmins", users: ["oidc/cto"], groups: ["ldap/infra-admins"], options: { admin: true } },
    // admin: true on the default role grants nothing : it is everyone's
    { name: "default", users: [], groups: [], options: { admin: true } },
  ];
  // through a group seen, and by name never seen
  expect(effectiveRolesOfDirectoryUser(withOption, "ldap", "jdoe", ["ldap/infra-admins"]).sort()).toEqual(["admin", "default", "platformAdmins"]);
  expect(effectiveRolesOfDirectoryUser(withOption, "oidc", "cto", []).sort()).toEqual(["admin", "default", "platformAdmins"]);
  // no role that grants admin : no admin
  expect(effectiveRolesOfDirectoryUser(withOption, "ldap", "bob", ["ldap/ops"]).sort()).toEqual(["default", "ops"]);
  // the lists still count the roles the config lists, admin not added
  expect(rolesOfDirectoryUser(withOption, "ldap", "jdoe", ["ldap/infra-admins"]).sort()).toEqual(["default", "platformAdmins"]);
  // the shared rule : each name once, admin once
  expect(effectiveRoleNames([{ name: "a", options: { admin: true } }, { name: "b", options: { admin: true } }, { name: "admin" }])).toEqual(["a", "admin", "b"]);
  expect(effectiveRoleNames([{ name: "ops", options: { admin: false } }])).toEqual(["ops"]);
});

test("the users list: those seen, then those the roles name who never signed in, once", () => {
  const rows = directoryUserRows(
    [
      { type: "ldap", username: "bob", display_name: "Bob", groups: ["ldap/ops"], last_login: "2026-10-11", blocked: 0 },
      // Carol signed in as CAROL : the role's ldap/carol is her, not a second row
      { type: "ldap", username: "CAROL", groups: [], last_login: "2026-10-10", blocked: 1 },
    ],
    roles,
  );
  expect(rows.map((r) => r.id)).toEqual(["ldap/bob", "ldap/CAROL", "oidc/dave"]);
  const [bob, carol, dave] = rows;
  expect(bob).toMatchObject({ source: "ldap", description: "Bob", group_ids: ["ldap/ops"], role_count: 2, seen: true });
  expect(carol.blocked).toBe(true);
  expect(dave).toMatchObject({ source: "oidc", seen: false, role_count: 2, group_ids: [] });
});

test("the groups list: the groups seen and those a role names, their members and roles", () => {
  const rows = directoryGroupRows(
    [
      { type: "ldap", username: "bob", groups: ["ldap/ops", "ldap/dev"] },
      { type: "ldap", username: "amy", groups: ["ldap/ops"] },
    ],
    roles,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(Object.keys(by).sort()).toEqual(["azuread/Ops", "ldap/dev", "ldap/ops"]);
  expect(by["ldap/ops"]).toMatchObject({ user_count: 2, role_count: 1, members: ["bob", "amy"] });
  expect(by["ldap/dev"]).toMatchObject({ user_count: 1, role_count: 0 });
  expect(by["azuread/Ops"]).toMatchObject({ source: "azuread", user_count: 0, role_count: 1 });
});
