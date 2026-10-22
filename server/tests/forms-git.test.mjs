// tests for the forms <-> git pure helpers (issue #414) ; run with `npm test`
// (node --test). Covers the pull-error mapping, config-repo resolution and the
// per-file save-target placement (incl. staging of new forms).
const { test } = await import("vitest");
import assert from "node:assert/strict";
import path from "path";
import { friendlyPullError, configRepoFromPath, resolveTargetDir, claimAllOrRollback } from "../src/lib/forms-git.js";

test("friendlyPullError rewrites local-change conflicts, passes the rest through", () => {
  // the git message when uncommitted local work blocks the merge
  const gitMsg = "error: Your local changes to the following files would be overwritten by merge:\n\tforms/a.yaml\nPlease commit your changes or stash them before you merge.";
  const friendly = friendlyPullError(gitMsg, "myrepo");
  assert.match(friendly, /Repository 'myrepo' has changes not pushed yet: push them first \(Push\), or reset the repository to discard them/);
  // asked directly (a pull refused before git runs) : the same message
  assert.equal(friendlyPullError("", "myrepo", true), friendly);

  // an unrelated error is returned unchanged
  assert.equal(friendlyPullError("fatal: could not read from remote repository", "myrepo"), "fatal: could not read from remote repository");
  // null / undefined become an empty string, never a crash
  assert.equal(friendlyPullError(undefined, "myrepo"), "");
  assert.equal(friendlyPullError(null, "myrepo"), "");
});

test("configRepoFromPath returns the repo holding config, or null", () => {
  const repoRoot = "/data/persistent/repositories";
  // config.yaml inside a repository -> that repository's name
  assert.equal(configRepoFromPath(path.join(repoRoot, "main-forms", "config.yaml"), repoRoot), "main-forms");
  // config in a forms subfolder layout -> still the repository name (first segment)
  assert.equal(configRepoFromPath(path.join(repoRoot, "main-forms", "forms.yaml"), repoRoot), "main-forms");
  // config living locally (outside the repositories root) -> null
  assert.equal(configRepoFromPath("/data/persistent/config.yaml", repoRoot), null);
  // missing inputs -> null, no crash
  assert.equal(configRepoFromPath("", repoRoot), null);
  assert.equal(configRepoFromPath(path.join(repoRoot, "x", "config.yaml"), ""), null);
  // a folder whose name only starts like the root's is not in it ; nor is the root itself
  assert.equal(configRepoFromPath("/data/persistent/repositories2/x/config.yaml", repoRoot), null);
  assert.equal(configRepoFromPath(repoRoot, repoRoot), null);
});

test("resolveTargetDir prefers the form's own repository, then holder, then staging", () => {
  const repoA = { name: "repoA", path: "/r/repoA/forms" };
  const repoB = { name: "repoB", path: "/r/repoB/forms" };
  const staging = { name: null, path: "/r/staging", staging: true };
  const formsDirs = [repoA, repoB, staging];

  // x.yaml physically exists in BOTH repos (same name, different repos)
  const holds = (dir, file) => ((dir === repoA || dir === repoB) && file === "x.yaml");

  // a form tagged with its repository goes back to THAT repo, not the first holder
  assert.equal(resolveTargetDir("repoB", "x.yaml", formsDirs, holds), repoB);
  assert.equal(resolveTargetDir("repoA", "x.yaml", formsDirs, holds), repoA);
  // no repository tag : the folder that already holds the file wins (first match)
  assert.equal(resolveTargetDir(null, "x.yaml", formsDirs, holds), repoA);
  // a brand new file (no repo, nowhere yet) goes to staging
  assert.equal(resolveTargetDir(null, "new.yaml", formsDirs, holds), staging);
  // a repository that no longer exists falls back to holder/staging
  assert.equal(resolveTargetDir("gone", "new.yaml", formsDirs, holds), staging);
});

test("resolveTargetDir falls back to the first folder when there is no staging (local mode)", () => {
  const localDir = { name: null, path: "/local/forms" };
  assert.equal(resolveTargetDir(null, "new.yaml", [localDir], () => false), localDir);
});

test("claimAllOrRollback holds every claim when they all succeed", async () => {
  const claimed = [], released = [];
  // token is the prior status to restore (null is a valid token, not a skip)
  const held = await claimAllOrRollback(["a", "b", "c"],
    n => { claimed.push(n); return "success"; },
    (n, t) => { released.push([n, t]); });
  assert.deepEqual(claimed, ["a", "b", "c"]);
  assert.deepEqual(held, [{ name: "a", token: "success" }, { name: "b", token: "success" }, { name: "c", token: "success" }]);
  assert.deepEqual(released, []); // success path does NOT release : the caller does, after its work
});

test("claimAllOrRollback rolls back already-held claims (reverse order) when one fails", async () => {
  const released = [];
  await assert.rejects(
    claimAllOrRollback(["a", "b", "c", "d"],
      n => { if (n === "c") throw new Error("busy"); return "ok"; },
      (n, t) => { released.push([n, t]); }),
    /busy/);
  // a and b were claimed, c threw, d never attempted : a,b released in REVERSE
  assert.deepEqual(released, [["b", "ok"], ["a", "ok"]]);
});

test("claimAllOrRollback skips undefined-token (untracked) resources, never holding them", async () => {
  // 'staging' returns undefined => not a tracked repo => must not be held/released
  const held = await claimAllOrRollback(["repo", "staging"],
    n => (n === "staging" ? undefined : null),
    () => {});
  assert.deepEqual(held, [{ name: "repo", token: null }]);
  // and a later failure must not try to release the skipped one
  const released = [];
  await assert.rejects(
    claimAllOrRollback(["repo", "staging", "boom"],
      n => { if (n === "boom") throw new Error("x"); return n === "staging" ? undefined : null; },
      (n, _t) => released.push(n)),
    /x/);
  assert.deepEqual(released, ["repo"]); // staging was skipped, only repo rolled back
});
