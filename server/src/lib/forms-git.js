// Pure helpers for the forms <-> git feature (issue #414).
// Kept free of database / filesystem access so they can be unit tested in
// isolation (see tests/forms-git.test.mjs), mirroring src/lib/baseurl.js.
import path from "path";

// Map a raw `git pull` failure to a clear, actionable message. The common case
// is a working tree with local (unpushed) changes that block the merge ; any
// other error is passed through unchanged. Called with no git output but
// `unpushed` true, it gives that message directly : a pull refused before git
// runs, because the working tree has changes (Repository.assertNoLocalChanges),
// says exactly what a pull git refused says.
export function friendlyPullError(message, name, unpushed = false) {
  const m = String(message || "");
  if (unpushed || /local changes|would be overwritten|commit your changes|stash them|Please commit/i.test(m)) {
    return `Repository '${name}' has changes not pushed yet: push them first (Push), or reset the repository to discard them`;
  }
  return m;
}

// Given the absolute path config.yaml was resolved to, and the repositories
// root, return the name of the repository that holds config (its first path
// segment under the root), or null when config lives outside any repository.
// Compared by path segments : /app/repos2/x is not under /app/repos.
export function configRepoFromPath(configPath, repoPath) {
  if (!configPath || !repoPath) return null;
  const rel = path.relative(path.resolve(repoPath), path.resolve(configPath));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0] || null;
}

// Resolve which folder a form file is written to on save, in priority order:
//   1. the form's own `repository` (set on load when several forms repos exist)
//      — keeps a form in its repo even if another repo has a same-named file ;
//   2. the folder that already holds the file (keeps an existing file in place) ;
//   3. the staging folder (a brand new file), or the single folder otherwise.
// `holds(dir, source)` tells whether a folder already contains the file (the
// caller injects the filesystem check, keeping this function pure).
export function resolveTargetDir(repository, source, formsDirs, holds) {
  if (repository != null) {
    const byRepo = formsDirs.find(d => d.name === repository);
    if (byRepo) return byRepo;
  }
  const holder = formsDirs.find(d => holds(d, source));
  if (holder) return holder;
  return formsDirs.find(d => d.staging) || formsDirs[0];
}

// Claim a set of named resources with all-or-nothing semantics : claim each in
// order, and if any claim throws, release the ones already claimed (in reverse)
// before rethrowing - so a failed claim never leaves a partial hold. Returns the
// list of { name, token } actually held (token === undefined means "skip", e.g.
// an untracked resource, and is not held). The caller releases the returned set
// when its work is done. `claim(name)` returns a token (or undefined to skip) ;
// `release(name, token)` frees it. Pure orchestration : the DB/lock side effects
// are injected, which keeps the rollback logic unit-testable. (issue #414)
export async function claimAllOrRollback(names, claim, release) {
  const held = [];
  try {
    for (const name of names) {
      const token = await claim(name);
      if (token !== undefined) held.push({ name, token });
    }
    return held;
  } catch (e) {
    for (const h of held.reverse()) {
      try { await release(h.name, h.token); } catch (_) { /* best effort rollback */ }
    }
    throw e;
  }
}
