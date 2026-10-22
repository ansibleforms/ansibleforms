// The config seed and the objects a repository holds : an object of a list section (a credential,
// a runner ...) or the directory a repository holds is git's, never the seed's too. Adopted by the
// seed, it became managed and every pull of its repository was refused from then on ; it is left
// as it is now, said, as the sections read through the repository types are (applyDeclared).
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
// the warnings, recorded
const warnings = [];
vi.mock("./__mocks__/logger.js", async (importOriginal) => {
  const mock = await importOriginal();
  return { ...mock, default: { ...mock.default, warning: (m) => warnings.push(m) } };
});
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { listSections, applyListSection, applyLdap } = await import("../src/lib/seed.js");

const summary = () => ({ created: [], updated: [], released: [], pruned: [], adopted: [], recloned: [], unchanged: 0 });

beforeEach(() => {
  warnings.length = 0;
  CrudModel.flushAllLocal();
});

test("a credential a repository holds : not adopted by the seed, its next pull still applies", async () => {
  process.env.SEED_HELD_PW = "s3cret";
  fx.reset({ repositories: [{ id: 1, name: "creds", uri: "x", use_for_credentials: 1 }] });
  fx.writeFile("creds", "credentials", "git.yaml", { name: "git", credential_type: "git", user: "bot", password: "${SEED_HELD_PW}", description: "from git" });
  await RepoObjects.syncRepository(await RepoObjects.descriptorOf("credentials"), "creds");
  CrudModel.flushAllLocal();
  const done = summary();
  const section = listSections.find((s) => s.key === "credentials");
  await applyListSection(section, { items: [{ name: "git", credential_type: "git", user: "seeduser", password: "p", description: "from seed" }] }, done);
  const row = fx.rowNamed("credentials", "git");
  assert.equal(row.description, "from git");
  assert.ok(!Number(row.managed), "never managed");
  assert.deepEqual([done.updated, done.adopted], [[], []]);
  assert.match(warnings.join("\n"), /The config seed declares the credential 'git', which repository 'creds' holds \(credentials\/git.yaml\): not applied/);
  // the repository's own change still reaches it
  fx.writeFile("creds", "credentials", "git.yaml", { name: "git", credential_type: "git", user: "bot", password: "${SEED_HELD_PW}", description: "changed in git" });
  CrudModel.flushAllLocal();
  const pulled = await RepoObjects.syncRepository(await RepoObjects.descriptorOf("credentials"), "creds");
  assert.deepEqual(pulled.refused || [], []);
  assert.equal(fx.rowNamed("credentials", "git").description, "changed in git");
});

test("the directory a repository holds : not adopted by the seed's ldap section", async () => {
  fx.reset({ ldap: [{ id: 1, name: "default", server: "ldap.git.local", enable: 1, managed: 0, repository: "dirs", repo_file: "ldap/default.yaml" }] });
  const done = summary();
  await applyLdap({ server: "ldap.seed.local", enable: true }, done);
  const row = fx.rowNamed("ldap", "default");
  assert.equal(row.server, "ldap.git.local");
  assert.ok(!Number(row.managed));
  assert.deepEqual([done.updated, done.adopted], [[], []]);
  assert.match(warnings.join("\n"), /The config seed declares the ldap 'default', which repository 'dirs' holds/);
});
