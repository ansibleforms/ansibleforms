// CI against a real database (.github/workflows/ci.yml, job `database`) : the schema the fresh
// install and the patches build, checked where the unit tests cannot - they never run SQL.
//
//   node scripts/ci-database.mjs <base url>
//
// Waits for the app to be ready, compares the database with the schema manifest
// (models/schema.model.js), and signs in as the default admin. Exits 1 on any difference.
import { SCHEMA_MANIFEST } from "../src/models/schema.model.js";
import { missingFromManifest } from "../src/lib/schemaCompleteness.js";
import mysql from "../src/models/db.model.js";

const base = process.argv[2] || "http://127.0.0.1:8000";
const fail = (msg) => {
  console.error(`FAIL : ${msg}`);
  process.exit(1);
};

// ready : the database answers and the schema is there (lib/readiness.js)
const until = Date.now() + 180000;
for (;;) {
  const res = await fetch(`${base}/api/v2/ready`).catch(() => null);
  if (res?.status === 200) break;
  if (Date.now() > until) fail(`not ready after 3 minutes (${res ? `${res.status} ${await res.text()}` : "no answer"})`);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("ready");

const { missingTables, missingColumns, missingIndexes } = await missingFromManifest(SCHEMA_MANIFEST, mysql);
if (missingTables.length || missingColumns.length || missingIndexes.length) {
  fail(`the schema lacks tables [${missingTables}] columns [${missingColumns}] indexes [${missingIndexes}]`);
}
console.log("schema complete");

const login = await fetch(`${base}/api/v2/auth/login`, {
  method: "POST",
  headers: { authorization: `Basic ${Buffer.from("admin:AnsibleForms!123").toString("base64")}` },
});
if (login.status !== 200) fail(`the default admin cannot sign in (${login.status})`);
const { token } = await login.json();
const profile = await fetch(`${base}/api/v2/profile`, { headers: { authorization: `Bearer ${token}` } });
if (profile.status !== 200) fail(`the admin's profile answered ${profile.status}`);
console.log("admin signs in");
await mysql.end?.();
process.exit(0);
