'use strict';
/******************************************************************/
/*                                                                */
/*  The builds of the RTE images : each one a job (job_type       */
/*  build), so its live log, its abort, its history and its       */
/*  retention are a job's. A build is handed to a builder that is */
/*  connected and approved (runners of type builder,              */
/*  runners/rteHub.js), the least busy one ; what it builds is    */
/*  in the job's extravars (__build__ : the definition, its       */
/*  Dockerfile and files, the reference it is pushed to, the      */
/*  registry and signing credentials by name - resolved and       */
/*  sealed for the builder when it is handed over, never stored). */
/*                                                                */
/******************************************************************/
import mysql from "../models/db.model.js";
import Job from "../models/job.model.js";
import Runner from "../models/runner.model.js";
import Credential from "../models/credential.model.v2.js";
import Errors from "./errors.js";
import logger from "./logger.js";
import { appVersion } from "./version.js";
import { getImage } from "./rteImages.js";
import { buildContextOf, imageRefOf, imageTagOf } from "./rteDockerfile.js";
import { kick, socketState } from "../runners/rteHub.js";

// the job type of a build
export const BUILD_JOB_TYPE = "build";

/**
 * The builders, each with whether it can take a build now : approved, turned on, its socket
 * alive, and how many it builds.
 *
 * Returns:
 *   Promise<object[]>: { runner, online, running }.
 */
export async function builders() {
  const rows = (await Runner.findAll()).filter((r) => r.type === "builder");
  return Promise.all(
    rows.map(async (runner) => {
      const st = await socketState(runner.name).catch(() => null);
      const online = !!(st?.alive && st.rte_id) && !Number(runner.pending) && !!Number(runner.enabled ?? 1);
      return { runner, online, running: Number(st?.info?.capacity?.running || 0) };
    }),
  );
}

/**
 * The builder a build goes to : the least busy one online.
 *
 * Returns:
 *   Promise<object>: its runner.
 *
 * Raises:
 *   ConflictError: no builder is online.
 */
export async function pickBuilder() {
  const online = (await builders()).filter((b) => b.online).sort((a, b) => a.running - b.running);
  if (!online.length) throw new Errors.ConflictError("No builder is online: start one and approve it under Connections > Builders");
  return online[0].runner;
}

/**
 * Starts a build of an image : a job handed to a builder.
 *
 * Args:
 *   name (string): the image.
 *   user (object): who builds it ({ username, type }).
 *
 * Returns:
 *   Promise<object>: { jobId, ref, builder }.
 *
 * Raises:
 *   NotFoundError: no such image.
 *   BadRequestError: the image is not valid, or names no registry credential (or one of another
 *     type), or its signing credential is no signing key.
 *   ConflictError: no builder is online.
 */
export async function startBuild(name, user) {
  const found = await getImage(name);
  if (found.error) throw new Errors.BadRequestError(`Runtime environment '${name}' cannot be built: ${found.error}`);
  const image = found.image;
  const registryName = image.registry?.credential;
  if (!registryName) throw new Errors.BadRequestError(`Runtime environment '${name}' names no registry to push to`);
  const registry = await Credential.findByName(registryName).catch(() => null);
  if (!registry || registry.credential_type !== "registry") throw new Errors.BadRequestError(`'${registryName}' is no container registry credential`);
  const signingName = image.sign?.credential || null;
  if (signingName) {
    const signing = await Credential.findByName(signingName).catch(() => null);
    if (!signing || signing.credential_type !== "signing_key") throw new Errors.BadRequestError(`'${signingName}' is no signing key credential`);
  }
  const builder = await pickBuilder();
  const ref = imageRefOf(image, registry.url, appVersion);
  const build = { image, files: buildContextOf(image, appVersion), ref, tag: imageTagOf(image, appVersion), arch: image.arch || "all", appVersion, registry: registryName, signing: signingName, sbom: !!image.sbom };
  const jobId = await Job.create({
    // its name in the jobs list and on its page : what it is and which image
    form: `RTE build: ${name}`,
    target: name,
    user: user?.username || "AnsibleForms",
    user_type: user?.type || "local",
    status: "running",
    job_type: BUILD_JOB_TYPE,
    runner: builder.name,
    runner_kind: "builder",
    extravars: JSON.stringify({ __build__: build }),
    credentials: "{}",
    notifications: "{}",
  });
  await Job.printJobOutput(`ok: [Building runtime environment ${name} as ${ref} on builder ${builder.name}]`, "stdout", jobId, 1);
  logger.notice(`Runtime environment '${name}': build ${jobId} handed to builder '${builder.name}' (${ref})`);
  kick(jobId, builder);
  return { jobId, ref, builder: builder.name };
}

/**
 * The builds, newest first : each job's image, status, reference and result.
 *
 * Args:
 *   limit (number): how many.
 *
 * Returns:
 *   Promise<object[]>: { id, image, status, user, start, end, builder, ref, appVersion, digest,
 *     signed, sbom, definition }.
 */
export async function listBuilds(limit = 200) {
  const rows = await mysql.do(
    "SELECT id, target, status, user, start, end, runner, extravars, awx_artifacts FROM AnsibleForms.`jobs` WHERE job_type = ? ORDER BY id DESC LIMIT ?",
    [BUILD_JOB_TYPE, Number(limit) || 200],
  );
  const parse = (v) => {
    try {
      return typeof v === "string" ? JSON.parse(v) : v || {};
    } catch {
      return {};
    }
  };
  return (rows || []).map((r) => {
    const build = parse(r.extravars).__build__ || {};
    const result = parse(r.awx_artifacts);
    return {
      id: r.id,
      image: r.target,
      status: r.status,
      user: r.user,
      start: r.start,
      end: r.end,
      builder: r.runner,
      ref: build.ref || "",
      appVersion: build.appVersion || "",
      tag: build.tag || "",
      digest: result.digest || "",
      signed: !!result.signed,
      sbom: !!result.sbom,
      // the definition it was built from, as it was then (to tell a definition changed since)
      definition: build.image || null,
    };
  });
}

export default { startBuild, listBuilds, builders, pickBuilder, BUILD_JOB_TYPE };
