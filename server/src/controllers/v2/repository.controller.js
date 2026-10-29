'use strict';
import Repository from '../../models/repository.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import cronService from '../../services/cron.service.js';
import logger from '../../lib/logger.js';
import i18n from '../../lib/i18n.js';
import { SECRET_MASK, isMasked } from '../../lib/secretMask.js';
import CredentialModel from '../../models/credential.model.v2.js';
import Errors from '../../lib/errors.js';
import { isAdminRequest } from '../../lib/adminGrants.js';
import { designerRepositories, designerGitOutput } from '../../lib/designerForms.js';

/**
 * Whether a credential carries what git signs in with : a user, and a password (stored, or read
 * from a secret store). A token alone (an api or a runner's credential) is no git login.
 *
 * Args:
 *   cred (object): the credential's row (findRowByName).
 *
 * Returns:
 *   boolean: true when it has a user and a password.
 */
function hasLogin(cred) {
  const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  return filled(cred?.user) && (filled(cred?.password) || (filled(cred?.secret_store) && filled(cred?.secret_ref)));
}

/**
 * Checks the credential a repository is given, and what moving a repository takes along. Git signs
 * in with a user and a password, so the credential must carry both, whatever its type (a git, a
 * userpass, a database login an admin chooses). A user who is not an admin may not name a
 * credential only an admin may (models/credential.model.v2.js isAdminGuarded : a runner's, a
 * connection's, a sign-in's), whose secret would otherwise be sent to an address of their choice,
 * and moving a repository to another address drops the credential and the password it keeps,
 * unless they are chosen or typed again with it. An admin's move is left as it is.
 *
 * Args:
 *   req (object): the request (its body is changed in place).
 *   existing (object|null): the repository as it is, null on a create.
 *
 * Returns:
 *   Promise<{dropPassword: boolean}>: whether the update clears the repository's own password.
 *
 * Raises:
 *   Errors.BadRequestError: the credential does not exist, or lacks a user or a password.
 *   Errors.AccessDeniedError: the credential is an admin's.
 */
async function guardRepositoryCredential(req, existing) {
  const data = req.body;
  const outcome = { dropPassword: false };
  // a credential this write chooses (the one it already names, sent back, is not checked again)
  if (data.credential && data.credential !== existing?.credential) {
    const cred = await CredentialModel.findRowByName(data.credential);
    if (!cred) throw new Errors.BadRequestError(i18n.t(req, 'resources.credentialNotFound', { name: data.credential }));
    // refused first to who may not name it : the answer then says nothing of what it holds
    if (!isAdminRequest(req) && (await CredentialModel.isAdminGuarded(cred))) {
      throw new Errors.AccessDeniedError(i18n.t(req, 'resources.credentialNotAllowed', { name: data.credential }));
    }
    if (!hasLogin(cred)) {
      throw new Errors.BadRequestError(i18n.t(req, 'resources.repositoryCredentialType', { name: data.credential, type: cred.credential_type }));
    }
  }
  // moved elsewhere by a user who is not an admin : what it signs in with stays behind
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  if (existing && !isAdminRequest(req) && data.uri !== undefined && text(data.uri) !== text(existing.uri)) {
    const kept = data.credential === undefined ? existing.credential : data.credential;
    if (kept && kept === existing.credential) data.credential = '';
    const typed = typeof data.password === 'string' && data.password !== '' && !isMasked(data.password);
    if (!typed && existing.password) {
      delete data.password;
      outcome.dropPassword = true;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// What only an admin may change on a repository
// ---------------------------------------------------------------------------------------------

// the flags that make a repository's content what AnsibleForms loads and runs : its configuration
// (roles, and with them who is an admin), its forms, playbooks, workflows and inventories
const USE_FOR_FLAGS = ['use_for_config', 'use_for_forms', 'use_for_playbooks', 'use_for_workflows', 'use_for_inventories'];

// where its content comes from : the remote and the branch it pulls
const SOURCE_FIELDS = ['uri', 'branch'];

/**
 * Refuses to a user who is not an admin a write that chooses what AnsibleForms loads or runs. A
 * repository marked use_for_config, use_for_forms or use_for_playbooks (or workflows,
 * inventories) is pulled into the configuration, the forms and the playbooks : a user with only
 * connections access who could add one, point an existing one at a git server of their own, or
 * mark one of theirs so, would write the roles (and make themselves admin) or the code the
 * runners execute. Adding or deleting a repository, changing its address or its branch, and
 * setting or changing any of its use_for_* flags is therefore an admin's, as a runner is
 * (controllers/v2/runner.controller.js assertAdmin). The rest stays open to them : its
 * description, schedule, credential (guardRepositoryCredential), and pulling, pushing or
 * resetting it.
 *
 * Args:
 *   req (object): the request.
 *   existing (object|null): the repository as it is, null on a create or a delete (always refused
 *     to a user who is not an admin).
 *
 * Returns:
 *   void
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin and the write adds or deletes a
 *     repository, or changes its address, branch or a use_for_* flag.
 */
function assertRepositoryAdminFields(req, existing) {
  if (isAdminRequest(req)) return;
  const refuse = () => { throw new Errors.AccessDeniedError(i18n.t(req, 'resources.repositoryAdminOnly')); };
  // a create or a delete : the whole repository is what it changes
  if (!existing) refuse();
  const data = req.body || {};
  // text compared trimmed, so the dialog sending the same value back is no change
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  // a flag compared as on or off, whatever it is sent as (true, 1, '1', 'true', or off)
  const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';
  for (const field of SOURCE_FIELDS) {
    if (data[field] !== undefined && text(data[field]) !== text(existing[field])) refuse();
  }
  for (const field of USE_FOR_FLAGS) {
    if (data[field] !== undefined && flag(data[field]) !== flag(existing[field])) refuse();
  }
}

const find = async function(req, res) {
  try {
    const repositories = await Repository.withUnpushed(await Repository.findAll());
    // their pull and push outputs as the user reads them (lib/designerForms.js)
    res.json(RestResult.list(designerRepositories(repositories, req.user?.user)));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedFindRepositories'), err.message || String(err)));
  }
};

const create = async function(req, res) {
  if(req.body.constructor === Object && Object.keys(req.body).length === 0) {
    return res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
  }
  try {
    // a new repository is a new source of configuration, forms or playbooks : an admin's
    assertRepositoryAdminFields(req, null);
    await guardRepositoryCredential(req, null);
    const insertId = await Repository.create(req.body);
    // Fetch the created record to get all fields including cron
    const created = await Repository.findByName(req.body.name);
    // Add to cron service if cron expression exists
    if(created.cron && created.cron.trim() !== '') {
      logger.info(`Adding repository '${created.name}' to cron service with schedule: ${created.cron}`);
      cronService.addRepository(created.name, created.cron);
    }
    res.json(RestResult.single({ id: insertId }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedCreateRepository'), err.message || String(err)));
  }
};

const findByName = async function(req, res) {
  try {
    // its pull and push outputs as the user reads them (lib/designerForms.js)
    const [repository] = designerRepositories(await Repository.withUnpushed([await Repository.findByName(req.params.name)]), req.user?.user);
    repository.password = SECRET_MASK; // mask the password for api
    res.json(RestResult.single(repository));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedFindRepository'), err.message || String(err)));
  }
};

const update = async function(req, res) {
  if(req.body.constructor === Object && Object.keys(req.body).length === 0) {
    return res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
  }
  try {
    const existing = await Repository.findByName(req.params.name);
    if (!existing) throw new Errors.NotFoundError(i18n.t(req, 'resources.failedFindRepository'));
    // its address, branch and use_for_* flags : an admin's (the rest is the connections user's too)
    assertRepositoryAdminFields(req, existing);
    const { dropPassword } = await guardRepositoryCredential(req, existing);
    await Repository.update(req.body, req.params.name, { dropPassword });
    // The record may have been RENAMED : `name` is an editable field on the repositories
    // page. Reading it back by req.params.name found nothing and threw, so a rename that
    // had already committed was reported as a 500 - and neither cron call below ran, so
    // the scheduler kept pulling the OLD name (which no longer exists) and never
    // scheduled the new one.
    const newName = (req.body.name && req.body.name !== req.params.name) ? req.body.name : req.params.name;
    if (newName !== req.params.name) {
      logger.info(`Repository renamed '${req.params.name}' -> '${newName}', moving its cron entry`);
      cronService.removeRepository(req.params.name);
    }
    // Fetch the updated record to get the cron field
    const updated = await Repository.findByName(newName);
    // Update cron service with complete record
    if(updated.cron) {
      logger.info(`Updating repository '${updated.name}' in cron service with schedule: ${updated.cron}`);
      cronService.addRepository(updated.name, updated.cron);
    } else {
      logger.info(`Removing repository '${updated.name}' from cron service (no schedule)`);
      cronService.removeRepository(updated.name);
    }
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateRepository'), err.message || String(err)));
  }
};

const deleteRepository = async function(req, res) {
  try {
    // deleting one takes away what the configuration, the forms or the playbooks load : an admin's
    assertRepositoryAdminFields(req, null);
    await Repository.delete(req.params.name);
    // Remove from cron service
    logger.info(`Removing repository '${req.params.name}' from cron service`);
    cronService.removeRepository(req.params.name);
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedDeleteRepository'), err.message || String(err)));
  }
};

const clone = async function(req, res) {
  try {
    await Repository.clone(req.params.name);
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedCloneRepository'), err.message || String(err)));
  }
};

const reset = async function(req, res) {
  try {
    await Repository.reset(req.params.name);
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedResetRepository'), err.message || String(err)));
  }
};

const pull = async function(req, res) {
  try {
    await Repository.pull(req.params.name);
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedPullRepository'), err.message || String(err)));
  }
};

const sync = async function(req, res) {
  try {
    const output = await Repository.sync(req.params.name, req.user?.user?.username);
    // without the lines naming files, to a user some are hidden from
    res.json(RestResult.single({ output: designerGitOutput(output, req.user?.user) }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedSyncRepository'), err.message || String(err)));
  }
};

// designer-facing : list the forms repositories (no credentials exposed) with
// a 'dirty' flag (uncommitted/unpushed changes) and the config-origin repo name
const formsRepos = async function(req, res) {
  try {
    const { repositories, configRepo, staged } = await Repository.formsRepoStatus();
    res.json(RestResult.single({ count: repositories.length, repositories, configRepo, staged }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedFindRepositories'), err.message || String(err)));
  }
};

// designer-facing : commit & push one forms repository by name
const formsRepoSync = async function(req, res) {
  try {
    const repositories = await Repository.findPushableRepositories();
    if (!repositories.some(r => r.name === req.params.name)) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.noFormsRepositories')));
    }
    const output = await Repository.sync(req.params.name, req.user?.user?.username);
    // without the lines naming files, to a user some are hidden from
    res.json(RestResult.single({ output: designerGitOutput(output, req.user?.user) }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedSyncRepository'), err.message || String(err)));
  }
};

// designer-facing : commit & push all forms repositories
const formsRepoSyncAll = async function(req, res) {
  try {
    const repositories = await Repository.findPushableRepositories();
    if (repositories.length === 0) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.noFormsRepositories')));
    }
    const results = [];
    var failed = false;
    for (const repo of repositories) {
      try {
        const output = await Repository.sync(repo.name, req.user?.user?.username);
        results.push({ name: repo.name, status: "success", output: designerGitOutput(output, req.user?.user) });
      } catch (e) {
        failed = true;
        results.push({ name: repo.name, status: "failed", output: e.message });
      }
    }
    if (failed) {
      return res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedSyncRepository'), results.filter(r => r.status === "failed").map(r => `${r.name}: ${r.output}`).join("\n")));
    }
    res.json(RestResult.single({ results }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedSyncRepository'), err.message || String(err)));
  }
};

// designer-facing : pull one forms repository from its remote by name
const formsRepoPull = async function(req, res) {
  try {
    const repositories = await Repository.findPushableRepositories();
    if (!repositories.some(r => r.name === req.params.name)) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.noFormsRepositories')));
    }
    await Repository.pull(req.params.name);
    res.json(RestResult.single(null));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedPullRepository'), err.message || String(err)));
  }
};

// designer-facing : pull all forms repositories from their remote (refresh the
// working trees so the designer shows the latest remote state)
const formsRepoPullAll = async function(req, res) {
  try {
    const repositories = await Repository.findPushableRepositories();
    if (repositories.length === 0) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.noFormsRepositories')));
    }
    const results = [];
    var failed = false;
    for (const repo of repositories) {
      try {
        await Repository.pull(repo.name);
        results.push({ name: repo.name, status: "success" });
      } catch (e) {
        // a repository with changes not pushed yet is skipped, and the others are pulled
        // (Repository.assertNoLocalChanges) : it is said in the result, not a failure
        if (e instanceof Errors.ConflictError) {
          results.push({ name: repo.name, status: "skipped", output: e.message });
          continue;
        }
        failed = true;
        results.push({ name: repo.name, status: "failed", output: e.message });
      }
    }
    if (failed) {
      return res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedPullRepository'), results.filter(r => r.status !== "success").map(r => `${r.name}: ${r.output}`).join("\n")));
    }
    res.json(RestResult.single({ results, skipped: results.filter(r => r.status === "skipped").map(r => r.name) }));
  } catch(err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedPullRepository'), err.message || String(err)));
  }
};

export default {
    find,
    create,
    findByName,
    update,
    "delete": deleteRepository,
    clone,
    reset,
    pull,
    sync,
    formsRepos,
    formsRepoSync,
    formsRepoSyncAll,
    formsRepoPull,
    formsRepoPullAll
};