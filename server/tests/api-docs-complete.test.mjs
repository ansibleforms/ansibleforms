// Every REST endpoint is in the API docs (src/swagger_v2.json, served on /api/v2/docs).
//
// The docs are the map a script, an integration or an AI reads to learn what the API can do.
// An endpoint left out of them does not exist for that reader : stored jobs and schedules were
// missing, and an AI concluded they could only be reached through MCP.
//
// So this reads the routes from the source - every `/api/v2/...` mount in app.js, the router it
// mounts and each `get`/`post`/`put`/`patch`/`delete` that router declares - and asks the docs
// for each one, by method and path. A new route without docs fails here.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(path.join(src, f), "utf8");

// not part of the API a caller scripts : the docs themselves, the branding images the login
// page loads, and MCP (a protocol with its own tool list, see /api/v2/mcp)
const NOT_DOCUMENTED = new Set(["docs", "favicon", "logo", "mcp"]);

// a path as both sides can compare it : no trailing slash, every parameter as {}
const norm = (p) => p.replace(/\/+$/, "").replace(/:\w+/g, "{}").replace(/\{[^}]+\}/g, "{}") || "/";

function documented() {
  const doc = JSON.parse(read("swagger_v2.json"));
  const ops = new Set();
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) ops.add(`${method.toUpperCase()} ${norm(p)}`);
  }
  return ops;
}

function routes() {
  const app = read("app.js");
  // the binding each import gives a routes module : default or named, as the module calls it
  const bindings = new Map();
  for (const [, def, named, file] of app.matchAll(/import\s+(\w+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s+"(\.\/(?:routes|chat)\/[^"]+)"/g)) {
    if (def) bindings.set(def, { file, name: "default" });
    for (const n of (named || "").split(",").map((s) => s.trim()).filter(Boolean)) bindings.set(n, { file, name: n });
  }
  const ops = [];
  for (const [, mount, args] of app.matchAll(/app\.use\(\s*[`'"]\/api\/v2\/([\w-]+)[`'"]\s*,([^;]*)\);/g)) {
    if (NOT_DOCUMENTED.has(mount)) continue;
    const binding = bindings.get(args.split(",").map((s) => s.trim()).pop());
    if (!binding) continue;
    const module = read(binding.file);
    // the variable the module exports under that name
    const variable =
      binding.name === "default" ? module.match(/export\s+default\s+(\w+)/)?.[1] : binding.name;
    for (const [, method, p] of module.matchAll(new RegExp(`\\b${variable}\\.(get|post|put|patch|delete)\\(\\s*['"\`]([^'"\`]*)['"\`]`, "g"))) {
      ops.push(`${method.toUpperCase()} ${norm(`/${mount}${p}`)}`);
    }
  }
  // the probes app.js answers itself (live, ready, metrics)
  for (const [, method, p] of app.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`'"]\/api\/v2(\/[^`'"]+)[`'"]/g)) {
    ops.push(`${method.toUpperCase()} ${norm(p)}`);
  }
  return ops;
}

test("the routes are read : the check would pass on nothing otherwise", () => {
  const ops = routes();
  assert.ok(ops.length > 200, `only ${ops.length} routes found`);
  assert.ok(ops.includes("GET /stored-jobs"));
});

test("every REST endpoint is in the API docs", () => {
  const doc = documented();
  const missing = [...new Set(routes())].filter((op) => !doc.has(op));
  assert.deepEqual(missing, [], `not in src/swagger_v2.json:\n  ${missing.join("\n  ")}`);
});

test("the API docs list no endpoint the server does not have", () => {
  // the docs had /help and /backup/restore long after the routes were gone or moved
  const served = new Set(routes());
  const stale = [...documented()].filter((op) => !served.has(op));
  assert.deepEqual(stale, [], `in src/swagger_v2.json but not served:\n  ${stale.join("\n  ")}`);
});
