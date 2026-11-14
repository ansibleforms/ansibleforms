// The app's own SSH key is made at start (Ssh.generate) even when the home path has no .ssh
// folder yet : a fresh install with HOME_PATH on a new volume logged "Saving key ... failed: No
// such file or directory" and never had a key. The folder is made first, readable by its user only.
import { test, describe, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

// the app config the models read (tests/__mocks__/app.config.js, vitest.config.js alias)
const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: Ssh } = await import("../src/models/ssh.model.js");

/**
 * Whether ssh-keygen can be run here.
 *
 * Returns:
 *   boolean: true when it answers.
 */
function hasKeygen() {
  try {
    execFileSync("ssh-keygen", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    // older OpenSSH has no -V : its usage on stderr, exit 1, still installed
    try {
      execFileSync("which", ["ssh-keygen"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

const saved = appConfig.homePath;
let home;
afterEach(() => {
  appConfig.homePath = saved;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe("the app's SSH key at start", () => {
  test.skipIf(!hasKeygen())("a home path without .ssh : the folder made (0700), then the key", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "af-ssh-home-"));
    appConfig.homePath = home;
    await Ssh.generate(true);
    const dir = path.join(home, ".ssh");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(dir, "id_rsa")));
    assert.ok(fs.existsSync(path.join(dir, "id_rsa.pub")));
  });
});
