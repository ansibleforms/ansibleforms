'use strict';
import { execFile as execFileCb } from 'child_process';
import logger from '../lib/logger.js';
import fs from 'fs';
import { inspect, promisify } from 'node:util';
import os from 'os';
import Errors from '../lib/errors.js';
import path from 'path';

const KnownHosts = {};
const execFile = promisify(execFileCb);
// a host name, an IPv4 or an IPv6 address : what ssh-keyscan takes, and nothing it could read as
// an option or anything more
const HOST = /^[A-Za-z0-9_.:-]+$/;

function hostsFile() {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}
KnownHosts.findAll = async function () {
  const file = hostsFile();
  try {
    if (!fs.existsSync(file)) return [];
    const data = await fs.promises.readFile(file, 'utf8');
    return data.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    logger.error(inspect(e));
    throw new Errors.InternalServerError('Failed to read known_hosts');
  }
};
KnownHosts.remove = async function (host) {
  if (!host || host === 'undefined' || host === 'null') {
    throw new Errors.BadRequestError('Invalid or missing host');
  }
  logger.notice(`Removing host ${host}`);
  const file = hostsFile();
  if (!fs.existsSync(file)) {
    return { host, removed: false, message: 'known_hosts file missing' };
  }
  try {
    const content = await fs.promises.readFile(file, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const remaining = [];
    let removedCount = 0;
    for (const line of lines) {
      const first = line.split(/\s+/)[0];
      if (first === host) {
        removedCount++;
        continue;
      }
      remaining.push(line);
    }
    if (removedCount === 0) {
      return { host, removed: false, message: 'Host not found', removedCount: 0 };
    }
    await fs.promises.writeFile(file, remaining.join('\n') + '\n', 'utf8');
    return { host, removed: true, message: 'Host removed', removedCount };
  } catch (e) {
    logger.error(inspect(e));
    throw new Errors.InternalServerError('Failed to remove host');
  }
};
// add ssh known hosts
KnownHosts.add = async function (host) {
  if (!host || host === 'undefined' || host === 'null') {
    throw new Errors.BadRequestError('Invalid or missing host');
  }
  if (!HOST.test(host) || host.startsWith('-')) {
    throw new Errors.BadRequestError('Invalid host: a host name or an IP address only');
  }
  logger.notice(`Adding keys for host ${host}`);
  try {
    // no shell : the host is ssh-keyscan's one argument, never a second command
    const { stdout, stderr } = await execFile('ssh-keyscan', ['--', host]);
    if (stderr) logger.debug(stderr);
    if (!stdout) throw new Errors.InternalServerError('No keyscan output');
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    await fs.promises.mkdir(path.dirname(hostsFile()), { recursive: true });
    await fs.promises.appendFile(hostsFile(), stdout.endsWith('\n') ? stdout : stdout + '\n', 'utf8');
    return { host, added: true, message: 'Host keys added', keysCount: lines.length };
  } catch (e) {
    if (e instanceof Errors.ApiError) throw e;
    logger.error(inspect(e));
    throw new Errors.InternalServerError('Failed to add host keys');
  }
};

/**
 * Replaces the known hosts with these lines, in this order : what a repository holding the SSH page
 * declares (lib/repoObjects/ssh.js). The lines are checked there.
 *
 * Args:
 *   lines (string[]): the known_hosts lines.
 *
 * Returns:
 *   Promise<void>
 */
KnownHosts.replaceAll = async function (lines) {
  const file = hostsFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
};

export default KnownHosts;
