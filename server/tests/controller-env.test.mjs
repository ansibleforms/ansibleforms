// The controller's names in the environment (lib/controllerEnv.js, lib/role.js) : CONTROLLER_URL and
// CONTROLLER_TLS_VERIFY on an RTE, AF_ROLE=controller for the web process ; the names of before 7.8
// (APP_URL, APP_TLS_VERIFY, AF_ROLE=app) still read, the new one winning, each old one said.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { controllerUrl, controllerTlsVerify, controllerEnvWarnings } from "../src/lib/controllerEnv.js";
import { currentRole, ROLES } from "../src/lib/role.js";

describe("the controller's address and certificate check", () => {
  test("the new names read ; the old ones when only they are set ; the new one wins", () => {
    assert.equal(controllerUrl({ CONTROLLER_URL: "https://forms.example.com" }), "https://forms.example.com");
    assert.equal(controllerUrl({ APP_URL: "https://old.example.com" }), "https://old.example.com");
    assert.equal(controllerUrl({ CONTROLLER_URL: "https://new", APP_URL: "https://old" }), "https://new");
    assert.equal(controllerUrl({}), undefined);
    assert.equal(controllerTlsVerify({}), true);
    assert.equal(controllerTlsVerify({ CONTROLLER_TLS_VERIFY: "0" }), false);
    assert.equal(controllerTlsVerify({ APP_TLS_VERIFY: "0" }), false);
    assert.equal(controllerTlsVerify({ CONTROLLER_TLS_VERIFY: "1", APP_TLS_VERIFY: "0" }), true);
  });

  test("each old name still set is said, once, with the one to use", () => {
    assert.deepEqual(controllerEnvWarnings({ CONTROLLER_URL: "x" }), []);
    assert.deepEqual(controllerEnvWarnings({ APP_URL: "x", APP_TLS_VERIFY: "0", CONTROLLER_TLS_VERIFY: "1", AF_ROLE: "App" }), [
      "APP_URL is deprecated, use CONTROLLER_URL (removed in 8.0)",
      "APP_TLS_VERIFY is deprecated, use CONTROLLER_TLS_VERIFY (removed in 8.0) : CONTROLLER_TLS_VERIFY is set too and wins, APP_TLS_VERIFY is ignored",
      "AF_ROLE=app is deprecated, use AF_ROLE=controller (removed in 8.0)",
    ]);
  });
});

describe("AF_ROLE", () => {
  test("controller is the web process ; app, its name before, read as controller", () => {
    assert.deepEqual(ROLES, ["all", "controller", "worker", "rte"]);
    assert.equal(currentRole({ AF_ROLE: "controller" }), "controller");
    assert.equal(currentRole({ AF_ROLE: " APP " }), "controller");
    assert.equal(currentRole({}), "all");
    assert.equal(currentRole({ AF_ROLE: "workr" }), "workr");
  });
});
