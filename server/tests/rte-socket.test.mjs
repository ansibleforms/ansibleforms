// The RTE socket's pieces that need no socket : the addresses (rte/socket/protocol.js), a job's
// items kept on disk until acked (rte/socket/spool.js), the structured events read as the
// playbook writes them (rte/events.js), and the job files packed by the controller and unpacked by the
// RTE (lib/jobFiles.js, rte/socket/files.js).
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";

const { socketUrl, inboundUrl, encode, decode } = await import("../src/rte/socket/protocol.js");
const { JobSpool } = await import("../src/rte/socket/spool.js");
const { createEventTail } = await import("../src/rte/events.js");
const { bundleOf, bundleByHash, readChunks } = await import("../src/lib/jobFiles.js");
const { FileCache } = await import("../src/rte/socket/files.js");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-socket-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the socket's addresses", () => {
  test("CONTROLLER_URL as people know it becomes the controller's socket", () => {
    assert.equal(socketUrl("https://forms.example.com"), "wss://forms.example.com/api/v2/rte/socket");
    assert.equal(socketUrl("https://forms.example.com/af/"), "wss://forms.example.com/af/api/v2/rte/socket");
    assert.equal(socketUrl("http://app:8000"), "ws://app:8000/api/v2/rte/socket");
    // the socket's path given already : kept as it is
    assert.equal(socketUrl("wss://x/api/v2/rte/socket"), "wss://x/api/v2/rte/socket");
    assert.throws(() => socketUrl("ftp://x"), /http or https/);
  });

  test("an inbound runner's address becomes the RTE's socket", () => {
    assert.equal(inboundUrl("http://rte:8000"), "ws://rte:8000/rte/v1/socket");
    assert.equal(inboundUrl("https://rte.dmz.local:8443/"), "wss://rte.dmz.local:8443/rte/v1/socket");
  });

  test("a frame without a type is not a message", () => {
    assert.deepEqual(decode(encode({ t: "ack", jobId: 1, seq: 2 })), { t: "ack", jobId: 1, seq: 2 });
    assert.equal(decode("{\"jobId\":1}"), null);
    assert.equal(decode("not json"), null);
  });
});

describe("a job's spool", () => {
  test("items are numbered, acked, and the file goes once the end is stored", () => {
    const sp = new JobSpool(dir, 7);
    sp.append({ kind: "output", record: { output: "a" } });
    sp.append({ kind: "output", record: { output: "b" } });
    sp.append({ kind: "end", status: "success" });
    assert.equal(sp.seq, 3);
    assert.equal(sp.get(2).record.output, "b");
    assert.equal(sp.ack(2), false, "the end is not acked yet");
    assert.equal(sp.ack(3), true, "everything acked and ended");
    sp.remove();
    assert.equal(fs.existsSync(path.join(dir, "job-7.jsonl")), false);
  });

  test("a restart resends what was not acked, from the file", () => {
    const sp = new JobSpool(dir, 9);
    for (let i = 1; i <= 5; i++) sp.append({ kind: "output", record: { output: `line ${i}` } });
    sp.ack(3);
    // a new process : the spool read back from its file
    const again = JobSpool.loadAll(dir);
    assert.equal(again.length, 1);
    assert.equal(again[0].jobId, 9);
    assert.equal(again[0].acked, 3);
    assert.equal(again[0].next, 4, "the next item to send is the first not acked");
    assert.equal(again[0].ended, false);
    assert.equal(again[0].get(5).record.output, "line 5");
  });

  test("a rewind after a reconnect sends again from the first item not acked", () => {
    const sp = new JobSpool(dir, 3);
    sp.append({ kind: "log", content: "x" });
    sp.append({ kind: "log", content: "y" });
    sp.next = 3;
    sp.ack(1);
    sp.rewind();
    assert.equal(sp.next, 2);
  });
});

describe("the structured events", () => {
  test("lines are read as the plugin writes them, in order, a cut line kept for later", async () => {
    const file = path.join(dir, "events.jsonl");
    const got = [];
    const tail = createEventTail({ file, write: async (batch) => got.push(...batch) });
    fs.writeFileSync(file, JSON.stringify({ type: "play", play: "p" }) + "\n" + JSON.stringify({ type: "task", task: "t" }) + "\n{\"type\":\"ok\"");
    await new Promise((r) => setTimeout(r, 700));
    fs.appendFileSync(file, ",\"host\":\"h1\"}\n" + JSON.stringify({ type: "stats", data: { h1: { ok: 1 } } }) + "\n");
    await tail.stop();
    assert.deepEqual(got.map((e) => [e.order, e.type]), [[1, "play"], [2, "task"], [3, "ok"], [4, "stats"]]);
    assert.equal(got[2].host, "h1");
    assert.equal(fs.existsSync(file), false, "the file goes once read");
  });
});

describe("the job files", () => {
  const tree = (root) => {
    fs.mkdirSync(path.join(root, "roles/web/tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "site.yml"), "- hosts: all\n");
    fs.writeFileSync(path.join(root, "roles/web/tasks/main.yml"), "- debug: msg=hi\n");
    fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: x\n");
    fs.writeFileSync(path.join(root, "extravars_12.json"), "{\"secret\":1}");
  };

  test("an unchanged folder keeps its hash, a changed one gets another", async () => {
    const root = path.join(dir, "playbooks");
    tree(root);
    const a = await bundleOf(root);
    const b = await bundleOf(root);
    assert.equal(a.hash, b.hash);
    fs.writeFileSync(path.join(root, "site.yml"), "- hosts: web\n");
    const c = await bundleOf(root);
    assert.notEqual(c.hash, a.hash);
    assert.equal(bundleByHash(c.hash).sha256, c.sha256);
    assert.equal(await bundleOf(path.join(dir, "none")), null);
  });

  test("the RTE receives a bundle in chunks, checks it and unpacks it - git and extravars left out", async () => {
    const root = path.join(dir, "src");
    tree(root);
    const b = await bundleOf(root);
    const cache = new FileCache(path.join(dir, "cache"));
    let asked = null;
    const ready = cache.ensure(b.hash, (h) => {
      asked = h;
      return true;
    });
    assert.equal(asked, b.hash);
    await readChunks(b.file, 64, async (buf, last) => cache.deliver({ hash: b.hash, data: buf.toString("base64"), last, sha256: last ? b.sha256 : undefined }));
    const file = await ready;
    // kept packed : nothing unpacked in the cache itself
    assert.equal(file, cache.path(b.hash));
    assert.deepEqual(fs.readdirSync(path.join(dir, "cache")).filter((n) => n !== "jobs"), [path.basename(file)]);
    const jobDir = cache.jobFolder(12);
    const folder = await cache.checkout(b.hash, () => assert.fail("asked again"), path.join(jobDir, "playbooks"));
    assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(folder, "site.yml"), "utf8"), "- hosts: all\n");
    assert.ok(fs.existsSync(path.join(folder, "roles/web/tasks/main.yml")));
    assert.equal(fs.existsSync(path.join(folder, ".git")), false);
    assert.equal(fs.existsSync(path.join(folder, "extravars_12.json")), false);
    // cached : not asked again
    assert.equal(cache.has(b.hash), true);
    assert.equal(await cache.ensure(b.hash, () => assert.fail("asked again")), file);
  });

  test("each job unpacks the files in its own folder, removed when it ends", async () => {
    const root = path.join(dir, "src-jobs");
    tree(root);
    const b = await bundleOf(root);
    const cache = new FileCache(path.join(dir, "cache-jobs"));
    const ready = cache.ensure(b.hash, () => true);
    await readChunks(b.file, 4096, async (buf, last) => cache.deliver({ hash: b.hash, data: buf.toString("base64"), last, sha256: last ? b.sha256 : undefined }));
    await ready;
    const one = cache.jobFolder(1);
    const two = cache.jobFolder(2);
    const a = await cache.checkout(b.hash, () => false, path.join(one, "playbooks"));
    const c = await cache.checkout(b.hash, () => false, path.join(two, "playbooks"));
    // what one job writes or changes, the other never sees
    fs.writeFileSync(path.join(a, "site.yml"), "changed by job 1\n");
    fs.writeFileSync(path.join(a, "fetched.txt"), "left by job 1\n");
    assert.equal(fs.readFileSync(path.join(c, "site.yml"), "utf8"), "- hosts: all\n");
    assert.equal(fs.existsSync(path.join(c, "fetched.txt")), false);
    cache.release(one);
    assert.equal(fs.existsSync(one), false);
    assert.equal(fs.existsSync(two), true);
    // the next job gets the files as the controller sent them
    const three = cache.jobFolder(3);
    const d = await cache.checkout(b.hash, () => false, path.join(three, "playbooks"));
    assert.equal(fs.readFileSync(path.join(d, "site.yml"), "utf8"), "- hosts: all\n");
    // release removes nothing outside the jobs folder
    cache.release(path.join(dir, "cache-jobs"));
    assert.equal(cache.has(b.hash), true);
  });

  test("a new start removes its own job folders and old transfers, never another RTE's", () => {
    const where = path.join(dir, "cache-prune");
    const hash = "d".repeat(64);
    const other = "e".repeat(64);
    fs.mkdirSync(path.join(where, "jobs", "rte-a", "7-abc"), { recursive: true });
    fs.writeFileSync(path.join(where, "jobs", "rte-a", "7-abc", "hosts"), "secret=1\n");
    fs.mkdirSync(path.join(where, "jobs", "rte-b", "8-def"), { recursive: true });
    fs.writeFileSync(path.join(where, `${hash}.part`), "half");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(path.join(where, `${hash}.part`), old, old);
    // another RTE's transfer, still coming
    fs.writeFileSync(path.join(where, `${other}.part`), "coming");
    fs.mkdirSync(path.join(where, hash));
    fs.writeFileSync(path.join(where, `${hash}.tar.gz`), "kept");
    new FileCache(where, 20, "rte-a");
    assert.deepEqual(fs.readdirSync(where).sort(), [`${hash}.tar.gz`, `${other}.part`, "jobs"]);
    // its own folder made anew, empty but for its alive file ; the other RTE's kept
    assert.deepEqual(fs.readdirSync(path.join(where, "jobs")).sort(), ["rte-a", "rte-b"]);
    assert.deepEqual(fs.readdirSync(path.join(where, "jobs", "rte-a")), [".alive"]);
  });

  test("a damaged bundle is refused", async () => {
    const root = path.join(dir, "src2");
    tree(root);
    const b = await bundleOf(root);
    const cache = new FileCache(path.join(dir, "cache2"));
    const ready = cache.ensure(b.hash, () => true);
    cache.deliver({ hash: b.hash, data: Buffer.from("not a tarball").toString("base64"), last: true, sha256: b.sha256 });
    await assert.rejects(ready, /damaged/);
    assert.equal(cache.has(b.hash), false);
  });
});

describe("what goes wrong on the RTE's side", () => {
  test("a character cut between two reads of the events file is read whole", async () => {
    const file = path.join(dir, "events-utf8.jsonl");
    const got = [];
    const tail = createEventTail({ file, write: async (batch) => got.push(...batch) });
    const line = Buffer.from(JSON.stringify({ type: "task", task: "créer le dépôt ✓" }) + "\n", "utf8");
    // cut inside the 3 bytes of the check mark
    const cut = line.indexOf(Buffer.from("✓", "utf8")) + 1;
    fs.writeFileSync(file, line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 700));
    fs.appendFileSync(file, line.subarray(cut));
    await tail.stop();
    assert.equal(got.length, 1);
    assert.equal(got[0].task, "créer le dépôt ✓");
  });

  test("a bundle that cannot be written fails its job, never the process", async () => {
    const cache = new FileCache(path.join(dir, "cache3"));
    const hash = "c".repeat(64);
    // the cache folder gone (a volume unmounted) : the write stream fails
    fs.rmSync(path.join(dir, "cache3"), { recursive: true, force: true });
    await assert.rejects(cache.ensure(hash, () => true), /could not be written/);
    assert.equal(cache.pending.size, 0);
  });
});

describe("the RTE dialing the controller again", async () => {
  const { redialWait, socketJobIO, jobs, dialOut } = await import("../src/rte/socket/rte-socket.js");
  const { CLOSE, REFUSED_REDIAL_MS, CONTRACT_REDIAL_MS } = await import("../src/rte/socket/protocol.js");

  test("a socket that dropped : a backoff of 1 s doubling up to 30 s", () => {
    assert.deepEqual(redialWait({ code: 1006, status: null, delay: 1000, random: 0 }), { wait: 1000, delay: 2000, refused: false });
    assert.equal(redialWait({ code: 1006, status: null, delay: 30000, random: 0 }).delay, 30000);
    // an id taken frees itself : the usual backoff
    assert.equal(redialWait({ code: CLOSE.ID_TAKEN, status: null, delay: 1000, random: 0 }).refused, false);
  });

  test("rejected, removed, a token refused, a name taken : a long wait, not a flood of dials", () => {
    for (const close of [{ code: CLOSE.UNAUTHORIZED }, { code: 1006, status: 401 }, { code: 1006, status: 403 }, { code: 1006, status: 409 }]) {
      const next = redialWait({ status: null, delay: 4000, random: 0, ...close });
      assert.equal(next.refused, true, JSON.stringify(close));
      assert.equal(next.wait, REFUSED_REDIAL_MS);
    }
    assert.ok(REFUSED_REDIAL_MS >= 10 * 60 * 1000);
  });

  test("another contract (an upgrade under way) : about a minute, not ten", () => {
    const next = redialWait({ code: CLOSE.CONTRACT, status: null, delay: 4000, random: 0 });
    assert.equal(next.refused, true);
    assert.equal(next.wait, CONTRACT_REDIAL_MS);
    assert.ok(CONTRACT_REDIAL_MS >= 30 * 1000 && CONTRACT_REDIAL_MS <= 2 * 60 * 1000);
    assert.equal(next.delay, 1000);
  });

  test("a controller it cannot reach : why at warning once, not every dial, and its return said once", async () => {
    const http = await import("http");
    const { WebSocketServer } = await import("ws");
    // the RTE's side writes to the real logger (the alias covers ../lib/logger.js only)
    const { default: logger } = await import("../src/lib/logger.js");
    const wss = new WebSocketServer({ noServer: true });
    // the controller answers 404 (a wrong CONTROLLER_URL path) until it is told to let the socket in
    let open = false;
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nothing here" }));
    });
    server.on("upgrade", (req, socket, head) => {
      if (open) return wss.handleUpgrade(req, socket, head, (ws) => ws.on("error", () => {}));
      socket.write("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"error\":\"nothing here\"}");
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const before = process.env.CONTROLLER_URL;
    process.env.CONTROLLER_URL = `http://joe:pw@127.0.0.1:${server.address().port}/af`;
    const warn = vi.spyOn(logger, "warning");
    const notice = vi.spyOn(logger, "notice");
    const token = "rte-token-0123456789";
    const said = (spy, what) => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(what));
    let stop;
    try {
      stop = dialOut(token);
      // two dials refused the same way (the backoff : 1 to 2 s between them)
      for (let i = 0; i < 250 && said(warn, "cannot reach").length < 1; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 2300));
      const warned = said(warn, "cannot reach the controller");
      assert.equal(warned.length, 1, warned.join("\n"));
      assert.match(warned[0], /at ws:\/\/127\.0\.0\.1:\d+\/af\/api\/v2\/rte\/socket: no runner socket at this address \(HTTP 404: nothing here\)/);
      assert.match(warned[0], /CONTROLLER_URL.*BASE_URL/);
      assert.ok(!warned[0].includes("joe") && !warned[0].includes("pw@"), "no credentials of the address");
      assert.ok(!warned[0].includes(token), "never the token");
      // the controller lets it in : said once, at notice
      open = true;
      for (let i = 0; i < 250 && !said(notice, "reached the controller").length; i++) await new Promise((r) => setTimeout(r, 20));
      const back = said(notice, "reached the controller");
      assert.equal(back.length, 1);
      assert.match(back[0], /again, after \d+ failed dial\(s\)/);
    } finally {
      stop?.();
      warn.mockRestore();
      notice.mockRestore();
      if (before === undefined) delete process.env.CONTROLLER_URL;
      else process.env.CONTROLLER_URL = before;
      wss.close();
      server.close();
    }
  }, 15000);

  test("a cancel of a job this RTE does not know yet is kept a minute, then applied by its run", async () => {
    const { onCancel, earlyCancels, rememberCancel, takeEarlyCancel } = await import("../src/rte/socket/rte-socket.js");
    earlyCancels.clear();
    onCancel({ t: "cancel", jobId: 91 });
    assert.ok(earlyCancels.has(91), "kept, not dropped");
    assert.equal(takeEarlyCancel(91), true, "the run takes it");
    assert.equal(takeEarlyCancel(91), false, "once");
    // older than a minute : forgotten
    rememberCancel(92, 1000);
    assert.equal(takeEarlyCancel(92, 1000 + 61000), false);
    // a job known and ended : nothing kept
    jobs.set(93, { running: false, spool: {} });
    try {
      onCancel({ t: "cancel", jobId: 93 });
      assert.equal(earlyCancels.has(93), false);
    } finally {
      jobs.delete(93);
    }
    // at most 1000 kept, the oldest go first
    for (let i = 1; i <= 1005; i++) rememberCancel(10000 + i);
    assert.equal(earlyCancels.size, 1000);
    assert.equal(earlyCancels.has(10001), false);
    assert.equal(earlyCancels.has(11005), true);
    earlyCancels.clear();
  });

  test("events are masked before they reach the spool, as the output is", async () => {
    const { registerJobSecrets, forgetJobSecrets } = await import("../src/lib/outputMask.js");
    const appended = [];
    jobs.set(77, { spool: { append: (item) => appended.push(item) } });
    registerJobSecrets(77, ["s3cr3t-value"]);
    try {
      await socketJobIO.writeEvents(77, [{ type: "ok", order: 1, result: { msg: "password is s3cr3t-value", rc: 0, nested: ["s3cr3t-value"] } }]);
    } finally {
      jobs.delete(77);
      forgetJobSecrets(77);
    }
    const ev = appended[0].events[0];
    assert.equal(JSON.stringify(ev).includes("s3cr3t-value"), false);
    assert.equal(ev.result.rc, 0, "the shape and the numbers kept");
    assert.equal(ev.result.nested.length, 1);
  });
});
