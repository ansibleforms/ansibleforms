// A repository being pushed read as a pull running : status was both the last pull's result and
// the lock every git operation takes (pull, push, clone, reset, a designer save), and the
// repositories' Pull badge is drawn from it. So while a push ran, the Pull badge said running and
// the Push badge did not.
//
// The lock stays status ('running', one git operation per repository on every node), and what
// runs under it is said apart : a pull sets pull_status 'running', a push push_status 'running',
// each in the claim's own statement. These run the model's real statements against one
// repository row, and look at it while git runs, after, and after a stale claim is released.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── one repositories row, written by the model's own UPDATE statements ─────────────────────────
// Enough of MariaDB for them : a SET of `col = ?`, a quoted literal, NULL, NOW(), another column,
// or IF(col = 'running', 'failed', col), evaluated left to right as MariaDB does ; and the WHERE
// guards the lock depends on (free for a claim, held for a release).
let row = {};

/**
 * Splits a SET clause on its top-level commas (not those inside IF(...)).
 *
 * Args:
 *   text (string): the assignments.
 *
 * Returns:
 *   string[]: one assignment each.
 */
function splitAssignments(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && depth === 0 && ch === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The value one assignment's expression gives, on the row as it is so far.
 *
 * Args:
 *   expr (string): the expression.
 *   params (unknown[]): the statement's parameters, consumed in order.
 *
 * Returns:
 *   unknown: the value.
 */
function evaluate(expr, params) {
  if (expr === "?") return params.shift();
  if (expr === "NULL") return null;
  if (expr === "NOW()") return "now";
  const literal = /^'(.*)'$/.exec(expr);
  if (literal) return literal[1];
  const ifRunning = /^IF\((\w+) = 'running', 'failed', (\w+)\)$/.exec(expr);
  if (ifRunning) return row[ifRunning[1]] === "running" ? "failed" : row[ifRunning[2]];
  if (/^\w+$/.test(expr)) return row[expr];
  throw new Error(`the fake database cannot evaluate '${expr}'`);
}

/**
 * Runs an UPDATE of AnsibleForms.`repositories` on the row.
 *
 * Args:
 *   statement (string): the SQL.
 *   params (unknown[]): its parameters.
 *
 * Returns:
 *   object: { affectedRows }.
 */
function update(statement, params) {
  const sql = statement.replace(/\br\./g, "");
  const [, setClause, whereClause] = /\bset (.*?) where (.*)$/is.exec(sql);
  // the claim takes a free repository only, a release clears a held one only
  if (/COALESCE\(status,''\) <> 'running'/.test(whereClause) && row.status === "running") return { affectedRows: 0 };
  if (/\bstatus = 'running'/.test(whereClause) && row.status !== "running") return { affectedRows: 0 };
  const queue = [...params];
  for (const assignment of splitAssignments(setClause)) {
    const [, column, expr] = /^(\w+) = (.*)$/s.exec(assignment);
    row[column] = evaluate(expr.trim(), queue);
  }
  return { affectedRows: 1 };
}

vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (statement, params = []) => {
      if (/^\s*update AnsibleForms\.`repositories`/i.test(statement)) return update(statement, params);
      if (/^\s*select/i.test(statement)) return [{ ...row }];
      return { affectedRows: 0 };
    },
  },
}));

// ─── git : each operation looks at the row while it runs ────────────────────────────────────────
const during = {};
let gitFails = false;
vi.mock("../src/models/repo.model.js", () => ({
  default: {
    pull: async () => {
      during.pull = { ...row };
      if (gitFails) throw new Error("fatal: unable to access the remote");
      return "Already up to date.";
    },
    clone: async () => {
      during.clone = { ...row };
      return "Cloning into 'x'...";
    },
    sync: async () => {
      during.sync = { ...row };
      if (gitFails) throw new Error("rejected: non-fast-forward");
      return "pushed";
    },
    delete: async () => {},
    info: async () => "abc1234",
    hasChanges: async () => false,
    maskGitToken: (s) => s,
    isValidName: () => true,
    folderOf: () => process.cwd(),
  },
}));

vi.mock("../src/models/crud.model.js", () => {
  class CrudModel {
    static getCache() {
      return null;
    }
    static async findByName(modelName, name) {
      return { id: 7, name, uri: "https://example.invalid/x.git", use_for_forms: 1 };
    }
    static async assertNotManaged() {}
  }
  return { default: CrudModel };
});

// no forms staged in the designer : a push has none to take along
const appConfig = (await import("./__mocks__/app.config.js")).default;
appConfig.formsStagingPath = "/nonexistent/forms_staging";
const { default: Repository } = await import("../src/models/repository.model.js");

describe("a push reads as a push, a pull as a pull", () => {
  beforeEach(() => {
    // last pulled and pushed fine, nothing holds it
    row = { name: "forms", status: "success", pull_status: "success", push_status: "success", claim_node: null };
    for (const key of Object.keys(during)) delete during[key];
    gitFails = false;
  });

  test("while a push runs, Push says running and Pull keeps the last pull", async () => {
    await Repository.sync("forms", "admin");
    assert.equal(during.sync.status, "running", "the push must hold the lock");
    assert.equal(during.sync.push_status, "running", "the Push badge did not say running");
    assert.equal(during.sync.pull_status, "success", "the Pull badge must keep the last pull");
  });

  test("a push that ends gives the lock back as the last pull, its own status as it ended", async () => {
    row.pull_status = row.status = "failed";
    await Repository.sync("forms", "admin");
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["failed", "failed", "success"]);
    gitFails = true;
    row.pull_status = row.status = "success";
    await assert.rejects(Repository.sync("forms", "admin"));
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["success", "success", "failed"]);
  });

  test("while a pull runs, Pull says running and Push keeps the last push", async () => {
    row.push_status = "failed";
    await Repository.pull("forms");
    assert.equal(during.pull.status, "running");
    assert.equal(during.pull.pull_status, "running", "the Pull badge did not say running");
    assert.equal(during.pull.push_status, "failed", "the Push badge must keep the last push");
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["success", "success", "failed"]);
  });

  test("a pull that fails says so on the Pull badge only", async () => {
    gitFails = true;
    await assert.rejects(Repository.pull("forms"));
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["failed", "failed", "success"]);
  });

  test("a clone (the settings' Pull) and a reset say running on the Pull badge", async () => {
    await Repository.clone("forms");
    assert.equal(during.clone.pull_status, "running");
    assert.equal(during.clone.push_status, "success");
    await Repository.reset("forms");
    assert.equal(during.clone.pull_status, "running");
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["success", "success", "success"]);
  });

  test("a designer save holds the lock and leaves both badges as they were", async () => {
    const prior = await Repository.claimForWrite("forms");
    assert.deepEqual([row.status, row.pull_status, row.push_status], ["running", "success", "success"]);
    await Repository.releaseWrite("forms", prior);
    assert.equal(row.status, "success");
  });

  test("one git operation at a time : a pull is refused while a push holds the repository", async () => {
    row.status = "running";
    row.push_status = "running";
    await assert.rejects(Repository.pull("forms"), /already running/);
    assert.equal(row.pull_status, "success", "a refused pull must not touch the Pull badge");
  });

  test("a stale claim of a push ends the push as failed, the last pull untouched", async () => {
    Object.assign(row, { status: "running", push_status: "running", claim_node: "gone" });
    await Repository.releaseStaleClaims();
    assert.deepEqual([row.status, row.pull_status, row.push_status, row.claim_node], ["failed", "success", "failed", null]);
  });

  test("a stale claim of a pull ends the pull as failed, the last push untouched", async () => {
    Object.assign(row, { status: "running", pull_status: "running", claim_node: "gone" });
    await Repository.releaseStaleClaims({ atStart: true });
    assert.deepEqual([row.status, row.pull_status, row.push_status, row.claim_node], ["failed", "failed", "success", null]);
  });
});
