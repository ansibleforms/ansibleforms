// The RTE images : definitions read from the runner_rte: lists of the repositories used for them,
// saved back where they were (comments kept), and the Dockerfile a builder is handed
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo, repoFolder: (await import("./fixtures/repoObjects.mjs")).repo.folderOf }));
vi.mock("../src/models/repository.model.js", async () => ({ default: { ...(await import("./fixtures/repoObjects.mjs")).repository, getConfigPath: async () => "", getFormsFolders: async () => [], afterUsageChange: async () => null } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const images = await import("../src/lib/rteImages.js");
const docker = await import("../src/lib/rteDockerfile.js");
const { forgetScans } = await import("../src/lib/repoObjects/repoFiles.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (repo, file, text) => {
  fs.mkdirSync(path.dirname(path.join(fx.ROOT, repo, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, repo, file), text);
};
const read = (repo, file) => fs.readFileSync(path.join(fx.ROOT, repo, file), "utf8");
const VMWARE = { name: "rte-vmware", python: "3.14", ansible_core: "2.21.5", ansible_collections: [{ name: "community.vmware", version: "5.7.0" }], python_packages: ["pyvmomi==8.0.3.0.1"], os_packages: ["sshpass"] };

beforeEach(() => {
  fx.reset({ repositories: [{ id: 1, name: "images", use_for_rte: 1 }, { id: 2, name: "forms", use_for_forms: 1 }] });
  // its working tree, cloned
  fs.mkdirSync(path.join(fx.ROOT, "images"), { recursive: true });
  forgetScans();
});

describe("a definition", () => {
  test("canonical : both architectures, the newest python and its newest ansible-core, its tag app and its SBOM on by default", () => {
    assert.deepEqual(images.normalizeImage({ name: "rte-a" }), { name: "rte-a", arch: "all", python: "3.15", ansible_core: "2.22", registry: { tag: "app" }, sbom: true });
  });
  test("its arch amd64, arm64 or all, nothing else", () => {
    assert.equal(images.normalizeImage({ name: "a", arch: "arm64" }).arch, "arm64");
    assert.equal(images.normalizeImage({ name: "a", arch: "amd64" }).arch, "amd64");
    assert.throws(() => images.normalizeImage({ name: "a", arch: "s390x" }), /arch must be one of all, amd64, arm64/);
  });
  test("its ansible-core the newest its python runs when none is given, and the two must fit", () => {
    assert.throws(() => images.normalizeImage({ name: "a", python: "3.9" }), /python must be one of/);
    assert.equal(images.normalizeImage({ name: "a", python: "3.11" }).ansible_core, "2.19");
    assert.throws(() => images.normalizeImage({ name: "a", python: "3.14", ansible_core: "2.18.1" }), /ansible-core 2.18 runs on python 3.11, 3.12, 3.13, not 3.14/);
    assert.equal(images.normalizeImage({ name: "a", python: "3.13", ansible_core: "2.18.1" }).python, "3.13");
  });
  test("nothing that could reach a shell : OS packages are names, versions plain", () => {
    assert.throws(() => images.normalizeImage({ name: "a", os_packages: ["curl; rm -rf /"] }), /no OS package name/);
    assert.throws(() => images.normalizeImage({ name: "a", ansible_core: '2.18" && x' }), /no valid ansible-core version/);
    assert.throws(() => images.normalizeImage({ name: "a", python_packages: ["--index-url http://evil"] }), /no python package requirement/);
    assert.throws(() => images.normalizeImage({ name: "Bad Name" }), /no valid image name/);
    assert.throws(() => images.normalizeImage({ name: "a", ansible_collections: ["notacollection"] }), /no collection name/);
  });
});

describe("in the repositories", () => {
  test("read from any file giving runner_rte:, of the repositories used for them only", async () => {
    write("images", "teams/infra.yml", YAML.stringify({ runner_rte: [VMWARE] }));
    write("forms", "rte.yaml", YAML.stringify({ runner_rte: [{ name: "elsewhere" }] }));
    const list = await images.listImages();
    assert.deepEqual(list.map((f) => [f.name, f.repository, f.file, f.error]), [["rte-vmware", "images", "teams/infra.yml", ""]]);
    assert.equal(list[0].image.registry.tag, "app");
  });
  test("two of a name : both said, neither valid", async () => {
    write("images", "a.yaml", YAML.stringify({ runner_rte: [{ name: "dup" }] }));
    write("images", "b.yaml", YAML.stringify({ runner_rte: [{ name: "dup" }] }));
    const list = await images.listImages();
    assert.equal(list.length, 2);
    for (const f of list) assert.match(f.error, /given 2 times/);
  });
  test("a new one goes to rte.yaml of a folder of its name ; a save keeps the file's comments and the other entries", async () => {
    await images.saveImage({ name: "rte-new" });
    assert.match(read("images", "rte-new/rte.yaml"), /runner_rte:\n\s+- name: rte-new/);
    write("images", "teams/infra.yml", "# the infra team's images\nrunner_rte:\n  # vmware\n  - name: rte-vmware\n    base: rte-core\n  - name: rte-other\n");
    forgetScans();
    await images.saveImage({ ...VMWARE, description: "VMware playbooks" }, { original: "rte-vmware" });
    const text = read("images", "teams/infra.yml");
    assert.match(text, /# the infra team's images/);
    assert.match(text, /# vmware/);
    assert.match(text, /- name: rte-other/);
    assert.deepEqual(YAML.parse(text).runner_rte[0].ansible_collections, [{ name: "community.vmware", version: "5.7.0" }]);
    // the base of before : gone, the python says it
    assert.equal(YAML.parse(text).runner_rte[0].base, undefined);
    assert.equal(YAML.parse(text).runner_rte[0].python, "3.14");
    await assert.rejects(images.saveImage({ name: "rte-other" }, { original: "rte-vmware" }), /exists already/);
  });
  test("renamed in its own folder : the folder follows ; removed : the folder goes too", async () => {
    await images.saveImage({ name: "first" });
    forgetScans();
    const saved = await images.saveImage({ name: "second" }, { original: "first" });
    assert.equal(saved.file, "second/rte.yaml");
    assert.equal(fs.existsSync(path.join(fx.ROOT, "images", "first")), false);
    assert.match(read("images", "second/rte.yaml"), /- name: second/);
    forgetScans();
    await images.removeImage("second");
    assert.equal(fs.existsSync(path.join(fx.ROOT, "images", "second")), false);
  });
  test("removed : the entry, then the file once empty", async () => {
    write("images", "one.yaml", YAML.stringify({ runner_rte: [{ name: "solo" }] }));
    await images.removeImage("solo");
    assert.equal(fs.existsSync(path.join(fx.ROOT, "images", "one.yaml")), false);
    await assert.rejects(images.getImage("solo"), /no runtime environment named 'solo'/);
  });
});

describe("its registry", () => {
  test("its credential first, then its path and tag : a name and a repository of before read as them, saved the same way", async () => {
    const image = images.normalizeImage({ name: "a", registry: { path: "af/a", credential: "c" } });
    assert.deepEqual(Object.keys(image.registry), ["credential", "path", "tag"]);
    assert.deepEqual(image.registry, { credential: "c", path: "af/a", tag: "app" });
    assert.deepEqual(images.normalizeImage({ name: "a", registry: { name: "c", path: "af/a" } }), image);
    // a tag beside the registry, as before : its tag
    assert.equal(images.normalizeImage({ name: "a", tag: "stable" }).registry.tag, "stable");
    assert.equal(images.normalizeImage({ name: "a", registry: { tag: "v1" } }).registry.tag, "v1");
    assert.deepEqual(images.normalizeImage({ name: "a", registry: { credential: "c", repository: "af/a" } }), image);
    assert.throws(() => images.normalizeImage({ name: "a", registry: { path: "Af/A" } }), /no registry path/);
    write("images", "r.yaml", "runner_rte:\n  - name: a\n    registry:\n      credential: c\n      repository: af/a\n    tag: stable\n");
    forgetScans();
    await images.saveImage({ name: "a", description: "x", registry: { credential: "c", path: "af/a", tag: "stable" } }, { original: "a" });
    assert.match(read("images", "r.yaml"), /registry:\n\s+credential: c\n\s+path: af\/a\n\s+tag: stable/);
    assert.doesNotMatch(read("images", "r.yaml"), /^\s{4}tag:/m);
    assert.doesNotMatch(read("images", "r.yaml"), /repository:|name: c/);
  });
});

describe("whether it needs a build", () => {
  const image = images.normalizeImage({ name: "a", python: "3.14", registry: { credential: "c", path: "af/a" } });
  const found = { name: "a", image, error: "" };
  test("never built well : yes ; built from the same definition, its keys in any order or of before : no", () => {
    assert.equal(images.needsBuild(found, [{ image: "a", status: "failed", definition: image }], "7.8.0"), true);
    const reordered = { registry: { path: "af/a", name: "c" }, python: "3.14", name: "a" };
    assert.equal(images.needsBuild(found, [{ image: "a", status: "success", definition: reordered, appVersion: "7.8.0" }], "7.8.0"), false);
  });
  test("changed since, or built for another release while tagged app : yes", () => {
    const before = { ...image, python: "3.13" };
    assert.equal(images.needsBuild(found, [{ image: "a", status: "success", definition: before, appVersion: "7.8.0" }], "7.8.0"), true);
    assert.equal(images.needsBuild(found, [{ image: "a", status: "success", definition: image, appVersion: "7.7.0" }], "7.8.0"), true);
  });
});

describe("its signing key", () => {
  test("the credential it signs with, a key: or name: of before read as it ; none, or false : not signed", () => {
    assert.deepEqual(images.normalizeImage({ name: "a", sign: { credential: "k" } }).sign, { credential: "k" });
    assert.deepEqual(images.normalizeImage({ name: "a", sign: { key: "k" } }).sign, { credential: "k" });
    assert.deepEqual(images.normalizeImage({ name: "a", sign: { name: "k" } }).sign, { credential: "k" });
    assert.equal(images.normalizeImage({ name: "a", sign: false }).sign, undefined);
    assert.equal(images.normalizeImage({ name: "a" }).sign, undefined);
    assert.throws(() => images.normalizeImage({ name: "a", sign: "k" }), /sign is a map/);
  });
});

describe("its build", () => {
  test("from rte-base : its python, its ansible-core, its collections and packages from files, never on a RUN line, run as node", () => {
    const image = images.normalizeImage(VMWARE);
    const files = docker.buildContextOf(image, "7.8.0");
    assert.match(files.Dockerfile, /^FROM ghcr\.io\/ansibleforms\/ansibleforms-rte-base:7\.8\.0$/m);
    assert.match(files.Dockerfile, /uv python install "3\.14"/);
    assert.match(files.Dockerfile, /pip install --no-cache-dir "ansible-core==2\.21\.5"/);
    assert.match(files.Dockerfile, /apt-get install -y --no-install-recommends sshpass/);
    assert.doesNotMatch(files.Dockerfile, /pyvmomi|community\.vmware/);
    assert.match(files.Dockerfile, /USER node\n$/);
    assert.equal(files["requirements.txt"], "pyvmomi==8.0.3.0.1\n");
    assert.deepEqual(YAML.parse(files["requirements.yml"]), { collections: [{ name: "community.vmware", version: "5.7.0" }] });
    assert.equal(files["ansible.cfg"], docker.ANSIBLE_CFG);
  });
  test("on rte-base : its python by uv, its ansible.cfg ; a development version builds on the major", () => {
    const image = images.normalizeImage({ name: "own", python: "3.13", ansible_core: "2.18.12" });
    const files = docker.buildContextOf(image, "7.8.0-dev");
    assert.match(files.Dockerfile, /^FROM ghcr\.io\/ansibleforms\/ansibleforms-rte-base:7$/m);
    assert.match(files.Dockerfile, /uv python install "3\.13"/);
    assert.equal(files["ansible.cfg"], docker.ANSIBLE_CFG);
  });
  test("where it is pushed : the registry's host, its repository, the app's release or its tag", () => {
    const image = images.normalizeImage({ name: "rte-vmware", registry: { path: "af/rte-vmware" } });
    assert.equal(docker.imageRefOf(image, "https://registry.example.com/", "7.8.0"), "registry.example.com/af/rte-vmware:7.8.0");
    assert.equal(docker.imageRefOf({ ...image, registry: { ...image.registry, tag: "stable" } }, "registry.example.com", "7.8.0"), "registry.example.com/af/rte-vmware:stable");
  });
  // the uv and python against rte-core's Dockerfile : checked by ansibleforms/rte's CI, where it is built
  test("the same ansible.cfg as the published layers", () => {
    assert.equal(fs.readFileSync(path.join(here, "..", "ansible.cfg"), "utf8").trim(), docker.ANSIBLE_CFG.trim());
  });
});

describe("what its collections need themselves", () => {
  test("gathered once they are installed : their python requirements by pip, their bindep.txt by bindep", () => {
    const files = docker.buildContextOf(images.normalizeImage(VMWARE), "7.8.0");
    assert.equal(files["collection-deps.py"], docker.COLLECTION_DEPS_PY);
    const df = files.Dockerfile;
    assert.ok(df.indexOf("rte-collection-deps.py") > df.indexOf("ansible-galaxy collection install"));
    assert.match(df, /pip install --no-cache-dir -r \/tmp\/rte-deps\/requirements\.txt/);
    assert.match(df, /bindep -b -f \/tmp\/rte-deps\/bindep\.txt/);
    assert.match(df, /pip uninstall -y bindep/);
  });
  test("no collections, no step", () => {
    const files = docker.buildContextOf(images.normalizeImage({ name: "bare" }), "7.8.0");
    assert.equal(files["collection-deps.py"], undefined);
    assert.doesNotMatch(files.Dockerfile, /rte-collection-deps/);
  });
  // the script itself, where a python runs the tests
  const python = ["python3", "python"].find((p) => {
    try {
      return execFileSync(p, ["--version"], { stdio: "ignore" }) !== undefined;
    } catch {
      return false;
    }
  });
  test.runIf(python)("reads requirements.txt, bindep.txt and meta/execution-environment.yml, never an ansible-core", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-coldeps-"));
    const col = (ns, n) => path.join(dir, "c", "ansible_collections", ns, n);
    fs.mkdirSync(col("netapp", "ontap"), { recursive: true });
    fs.writeFileSync(path.join(col("netapp", "ontap"), "requirements.txt"), "netapp-lib>=2020\nansible-core>=2.15\n# a comment\n");
    fs.writeFileSync(path.join(col("netapp", "ontap"), "bindep.txt"), "libxml2-dev [platform:dpkg]\n");
    fs.mkdirSync(path.join(col("community", "x"), "meta"), { recursive: true });
    fs.writeFileSync(path.join(col("community", "x"), "meta", "execution-environment.yml"), "dependencies:\n  python:\n    - jmespath\n");
    fs.writeFileSync(path.join(dir, "deps.py"), docker.COLLECTION_DEPS_PY);
    execFileSync(python, ["-I", path.join(dir, "deps.py"), path.join(dir, "c"), path.join(dir, "out")]);
    const req = fs.readFileSync(path.join(dir, "out", "requirements.txt"), "utf8");
    assert.match(req, /^netapp-lib>=2020$/m);
    assert.doesNotMatch(req, /ansible-core/);
    assert.match(fs.readFileSync(path.join(dir, "out", "bindep.txt"), "utf8"), /^libxml2-dev \[platform:dpkg\]$/m);
    // the meta file's list : read when PyYAML is there, as in every RTE (ansible-core brings it)
    let yamlThere = true;
    try {
      execFileSync(python, ["-c", "import yaml"], { stdio: "ignore" });
    } catch {
      yamlThere = false;
    }
    if (yamlThere) assert.match(req, /^jmespath$/m);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("its ansible-core", () => {
  test("a release installs its latest patch, a version that one exactly", () => {
    assert.equal(docker.ansibleCoreRequirement("2.22"), "ansible-core~=2.22.0");
    assert.equal(docker.ansibleCoreRequirement("2.21.5"), "ansible-core==2.21.5");
    const image = images.normalizeImage({ name: "a", python: "3.15", ansible_core: "2.22" });
    assert.match(docker.dockerfileOf(image, "7.8.0"), /pip install --no-cache-dir "ansible-core~=2\.22\.0"/);
  });
  test("a release refused on a python it does not run on, on either base", () => {
    assert.throws(() => images.normalizeImage({ name: "a", python: "3.11", ansible_core: "2.22" }), /2\.22 runs on python 3\.13, 3\.14, 3\.15, not 3\.11/);
    assert.throws(() => images.normalizeImage({ name: "a", ansible_core: "2.18" }), /not 3\.15/);
  });
  test("the versions the editor offers come from the same table", () => {
    const v = docker.versionsOf();
    assert.deepEqual(v.pythons, docker.PYTHONS);
    assert.equal(v.defaultPython, "3.15");
    assert.equal(v.os, "Debian 13 (trixie)");
    assert.deepEqual(v.ansibleCore["2.22"], ["3.13", "3.14", "3.15"]);
  });
});
