"use strict";
import Runner, { SECRET_MASK } from "../../models/runner.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import { RUNNER_TYPES, getRunner } from "../../runners/index.js";
import RunnerJoinToken from "../../models/runnerJoinToken.model.js";
import { socketState, isSocketRunner, dropSocket, pushSettings } from "../../runners/rteHub.js";
import { publish } from "../../lib/liveEvents.js";
import { isAdminRequest } from "../../lib/adminGrants.js";
import RepoObjects from "../../lib/repoObjects/index.js";
import { listImages } from "../../lib/rteImages.js";
import { listBuilds } from "../../lib/rteBuilds.js";
import { appVersion } from "../../lib/version.js";

// the token and password are stored encrypted and decrypted on read, so they never leave
// here unmasked
function maskSecrets(runner) {
  if (!runner) return runner;
  const copy = { ...runner };
  if (copy.token) copy.token = SECRET_MASK;
  if (copy.password) copy.password = SECRET_MASK;
  return copy;
}

const find = async (req, res) => {
  try {
    if (req.query.name) {
      return res.json(RestResult.single(maskSecrets(await Runner.findByName(req.query.name))));
    }
    // the builders (?type=builder : Connections > Builders) apart from the runners
    const builders = req.query.type === 'builder';
    const rows = (await Runner.findAll()).filter((r) => (r.type === 'builder') === builders);
    const list = await withSocket(rows);
    return res.json(RestResult.list(list.map(maskSecrets)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

/**
 * Adds to each socket-mode RTE its socket : whether an app node holds it, which one, and what
 * the RTE last said (version, capacity, files mode) - the Runners page shows it.
 *
 * Args:
 *   list (object[]): the runners.
 *
 * Returns:
 *   Promise<object[]>: the runners, a socket-mode one with `socket` ({ connected, node, direction,
 *     version, capacity, files, settings, env } or { connected: false }) : settings
 *     the ones in effect on the RTE, env the values its own variables set.
 */
async function withSocket(list) {
  return Promise.all((list || []).map(async (r) => {
    if (!isSocketRunner(r)) return r;
    const st = await socketState(r.name).catch(() => null);
    // connected : a lease alive with the RTE that answered on it ; a lease alone is a node still
    // dialing an inbound RTE that does not answer
    if (!st?.alive || !st.rte_id) return { ...r, socket: { connected: false } };
    const info = st.info || {};
    return { ...r, socket: { connected: true, node: st.node_id, direction: st.direction, rteId: st.rte_id, version: info.version, ansible: info.ansible, capacity: info.capacity, files: info.files, settings: info.settings, env: info.env } };
  }));
}

/**
 * GET /api/v2/runner/images : the images a new AnsibleForms runner can run, for the New runner
 * dialog's Image step - the published rte-full and rte-core of this release's major, then every
 * runtime environment of the Designer that has a successful build, its image as that build pushed
 * it. One never built is not listed : there is no image to run yet.
 */
const images = async (req, res) => {
  try {
    const major = String(appVersion || "").split(".")[0] || "7";
    const records = ["full", "core"].map((kind) => ({
      image: `ghcr.io/ansibleforms/ansibleforms-rte-${kind}:${major}`,
      name: `rte-${kind}`,
      label: `rte-${kind}`,
      published: true,
    }));
    const [defined, builds] = await Promise.all([listImages().catch(() => []), listBuilds().catch(() => [])]);
    const names = new Set(defined.filter((d) => !d.error).map((d) => d.name));
    // the newest successful build of each : the builds come newest first
    const seen = new Set();
    for (const b of builds) {
      if (b.status !== "success" || !b.ref || !names.has(b.image) || seen.has(b.image)) continue;
      seen.add(b.image);
      records.push({ image: b.ref, name: b.image, label: `${b.image} (${b.ref})`, published: false });
    }
    return res.json(RestResult.list(records));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// the types a runner can have, with what each can run
const types = async (req, res) => {
  try {
    // a builder is no runner a form can name
    return res.json(RestResult.list(RUNNER_TYPES.filter((type) => type !== 'builder').map((type) => ({ type, ...getRunner(type).capabilities }))));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

/**
 * Refuses a change of the runners to anyone but an admin. A runner receives the secrets of
 * every job it runs : an RTE gets them sealed with its token, AWX as extra vars. Whoever
 * chooses a runner's address and token - or which runner is the default - chooses where
 * every credential goes, so that is the admin role's, not every user with settings access.
 *
 * Args:
 *   req (object): the request.
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin.
 */
function assertAdmin(req) {
  // the one admin rule (lib/adminGrants.js) : the credentials a runner signs in with are guarded
  // by it too (controllers/v2/credential.controller.js)
  if (!isAdminRequest(req)) {
    throw new Errors.AccessDeniedError(i18n.t(req, "resources.runnerAdminOnly"));
  }
}

const create = async (req, res) => {
  try {
    assertAdmin(req);
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    // the runners repository follows (lib/repoObjects) : the new runner a new file, and the
    // others' files where they changed - the default of a type is one runner, so making this one
    // the default clears it on the others
    const created = await RepoObjects.following("runners", () => Runner.create(req.body));
    // { message, id }, as the other records answer a create
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "resources.runnerAdded"), id: created }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    const runner = await Runner.findById(req.params.id);
    if (!runner) throw new Errors.NotFoundError(i18n.t(req, "resources.runnerNotFound"));
    return res.json(RestResult.single(maskSecrets(runner)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    assertAdmin(req);
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    // the runners repository follows : this runner's changed fields written to its file, and the
    // others' where it changed them (made the default, it is no longer theirs)
    const updated = await RepoObjects.following("runners", () => Runner.update(req.body, req.params.id));
    if (!updated) throw new Errors.NotFoundError(i18n.t(req, "resources.runnerNotFound"));
    // its RTE gets its settings now when this node holds its socket, else at the next renewal
    const saved = await Runner.findById(req.params.id).catch(() => null);
    if (saved) pushSettings(saved);
    return res.json(RestResult.single(updated));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const deleteRunner = async (req, res) => {
  try {
    assertAdmin(req);
    // its name first : an RTE's socket on this node is closed at once (another node's closes at
    // its next lease renewal, the runner gone)
    const before = await Runner.findStoredById(req.params.id);
    const deleted = await RepoObjects.holding([], async () => {
      const deleted = await Runner.delete(req.params.id);
      if (!deleted) throw new Errors.NotFoundError(i18n.t(req, "resources.runnerNotFound"));
      if (before?.name) dropSocket(before.name, "deleted under Connections > Runners");
      // one of the runners repository : its file goes too, for the repository's Push
      if (before?.repository) await RepoObjects.appDeleted("runners", before);
      return deleted;
    }, before);
    return res.json(RestResult.single(deleted));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// how many RTEs wait for approval : the header bell's count, for whoever sees the runners ;
// { count }, as every answer is an object
const pendingCount = async (req, res) => {
  try {
    return res.json(RestResult.single({ count: await Runner.countPending() }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// an RTE that asked to join, approved : it takes jobs from now on
const approve = async (req, res) => {
  try {
    assertAdmin(req);
    // approved, it may become the default of its type : the runners repository follows
    const runner = await RepoObjects.following("runners", () => Runner.approve(req.params.id));
    publish("runners");
    return res.json(RestResult.single(maskSecrets(runner)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// an RTE that asked to join, rejected : removed with its credential, its socket closed
const reject = async (req, res) => {
  try {
    assertAdmin(req);
    const runner = await Runner.reject(req.params.id);
    dropSocket(runner.name, "rejected under Connections > Runners");
    publish("runners");
    return res.json(RestResult.single(maskSecrets(runner)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

/**
 * The message Test connection shows : for an RTE, what it said of itself too (its release, its
 * Ansible version and, in socket mode, the app node holding its socket), in the user's language.
 * Another type of runner, or an RTE that said nothing, keeps the plain message.
 *
 * Args:
 *   req (object): the request, for its language.
 *   runner (object): the runner tested.
 *   details (object): what its check() returned.
 *
 * Returns:
 *   string: the message.
 */
export function checkMessage(req, runner, details) {
  if (runner?.type !== "rte" && runner?.type !== "builder") return i18n.t(req, "resources.runnerConnectionOk");
  const parts = [];
  if (details?.version) parts.push(i18n.t(req, "resources.runnerRteRelease", { version: details.version }));
  // the RTE says "2.18.1" from "ansible-playbook [core 2.18.1]", or the whole first line of an
  // older ansible that prints no core version
  const ansible = details?.ansible ? String(details.ansible).trim() : "";
  if (ansible) parts.push(i18n.t(req, /^\d/.test(ansible) ? "resources.runnerAnsibleCore" : "resources.runnerAnsible", { version: ansible }));
  if (details?.socketNode) parts.push(i18n.t(req, "resources.runnerOnNode", { node: details.socketNode }));
  if (!parts.length) return i18n.t(req, "resources.runnerConnectionOk");
  return i18n.t(req, "resources.runnerConnectionOkDetails", { details: parts.join(i18n.t(req, "resources.runnerDetailsSeparator")) });
}

// read only : the runner's health, never a job
const check = async (req, res) => {
  try {
    const runner = await Runner.findById(req.params.id);
    if (!runner) throw new Errors.NotFoundError(i18n.t(req, "resources.runnerNotFound"));
    const details = await Runner.check(runner);
    return res.json(RestResult.single({ result: checkMessage(req, runner, details), details }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// ─── join tokens (Connections > Runners > Add runner) ─────────────────────────

// the join tokens : every user with connections access sees them (never the tokens themselves)
const findJoinTokens = async (req, res) => {
  try {
    return res.json(RestResult.list(await RunnerJoinToken.findAll()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a new join token, shown once : an admin's, as adding a runner is
const createJoinToken = async (req, res) => {
  try {
    assertAdmin(req);
    const made = await RunnerJoinToken.create(req.body || {}, req?.user?.user);
    // the token itself, this once ; the message for a client that shows one
    return res.status(201).json(RestResult.single({ ...made, message: i18n.t(req, "resources.joinTokenMade") }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a join token revoked : it adds no runner any more, the runners it added stay
const revokeJoinToken = async (req, res) => {
  try {
    assertAdmin(req);
    if (!(await RunnerJoinToken.revoke(req.params.id))) throw new Errors.NotFoundError(i18n.t(req, "resources.joinTokenNotFound"));
    return res.json(RestResult.single({ message: i18n.t(req, "resources.joinTokenRevoked") }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a join token deleted
const deleteJoinToken = async (req, res) => {
  try {
    assertAdmin(req);
    if (!(await RunnerJoinToken.remove(req.params.id))) throw new Errors.NotFoundError(i18n.t(req, "resources.joinTokenNotFound"));
    return res.json(RestResult.single({ message: i18n.t(req, "resources.joinTokenDeleted") }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

export default { find, types, images, create, findById, update, delete: deleteRunner, check, approve, reject, pendingCount, findJoinTokens, createJoinToken, revokeJoinToken, deleteJoinToken };
