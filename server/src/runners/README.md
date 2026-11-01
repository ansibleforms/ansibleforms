# Runners and the RTE

Developer notes on where AnsibleForms runs a job. From v7 on the app runs nothing itself:
every job runs on a **runner**, a row of the `runners` table with a type.

| Type | Runs | What it is |
|---|---|---|
| `rte` | playbooks (`type: ansible` forms) | a runtime environment container: this server started with `AF_ROLE=rte`, image `ghcr.io/ansibleforms/ansibleforms-rte-full` (or `-rte-core`, `-rte-base`) |
| `awx` | templates (`type: awx` forms) | AWX / Ansible Automation Platform / Ascender |
| `semaphore` | templates (`type: awx` forms that name it with `runner:`) | Semaphore UI, one project per runner (`project` is its id), signed in with an API token |
| `rundeck` | jobs (`type: awx` forms that name it with `runner:`) | Rundeck, one project per runner (`project` is its name), signed in with an API token, API v41 |
| `jenkins` | jobs (`type: awx` forms that name it with `runner:`) | Jenkins, signed in with a user (`username`) and its API token, its jobs under a folder when `project` names one |

## Why

Until v6 a playbook ran as a child process of the app container, and AWX was wired into
`job.model.js` in its own way. Customers could not change the runtime (collections, python
packages, ssh setup) without rebuilding the app image, the app could not scale, and every new
target would have been another special case. Now there is one interface for every target,
and a runtime container customers fork and rebuild, which gives **exactly the same result**
as the old local runs: it is the same code.

## The idea in one picture

```
 browser ──▶ app (AF_ROLE unset or app)                    RTE (AF_ROLE=rte)
             │ Job.launch ─▶ orchestrator                    │
             │               ├─ approval gate                │
             │               └─ runner.launch(ctx)           │
             │                    ├─ rte ─▶ rteHub ◀════ one WebSocket ════▶ runAnsibleJob
             │                    │         (outbound : the RTE dials the app,
             │                    │          inbound  : the app dials the RTE)
             │                    └─ awx ─▶ AWX API, output tracked back
             ▼
        ┌──────────────── MySQL (the app's alone in the socket modes) ────────────────┐
        │ jobs (row = the input, status, abort flag, runner) ; job_output ; job_events │
        │ runner_leases (which app node holds which RTE's socket) ; credentials        │
        └──────────────────────────────────────────────────────────────────────────────┘
```

Three choices carry the design:

1. **The RTE is this same server, started in another role** (`AF_ROLE=rte`). It holds the only
   code that runs a playbook (`rte/ansible-core.js`). `index.js` loads only the modules of its
   role: an RTE never loads the web app, the app never loads ansible-core, and a socket-mode
   RTE loads nothing of the database.
2. **The app holds the database ; the RTE gets the job over one WebSocket** (`RTE_MODE`
   outbound or inbound, contract 3). The app sends the job - what the RTE used to read in the
   database, its secrets sealed for it, the hashes of its files - and writes what the RTE sends
   back: output, events, log, start, end. The RTE has no database credentials and no
   `ENCRYPTION_SECRET`. Up to 7.2 the database was the bus: the RTE read the job row and wrote
   its output itself. That is `RTE_MODE=database`, the default all through 7.x, deprecated in
   7.3 and removed in 8 (see [Database mode](#database-mode-deprecated)).
3. **The app resolves the secrets, the RTE never does.** At hand-over the app resolves the
   job's credential map, its ansible login and its vault password (`lib/jobSecrets.js`, from
   the credentials table and the secret stores) and sends them with the job, sealed with
   AES-256-GCM under a key derived from the RTE's token and the job id
   (`lib/sealedSecrets.js`). The bundle opens for that RTE and that job only, also over plain
   http. The RTE never reads the credentials table nor a secret store.

## RTE modes

`RTE_MODE` on the RTE picks how it talks to the app (`rte/start.js`); the runner row carries the
same `rte_mode`, so the app knows whether to wait for a call or to dial.

| Mode | Who opens the connection | For | The RTE needs |
|---|---|---|---|
| `outbound` | the RTE dials `APP_URL` + `/api/v2/rte/socket` and redials when it drops | a DMZ, NAT, a zone that allows no incoming connection: only the RTE's zone to the app, on the app's port | `RTE_TOKEN`, `APP_URL`, `RTE_NAME` ; `RTE_JOIN_TOKEN` the first time |
| `inbound` | an app node dials the runner's address + `/rte/v1/socket` | networks where the centre opens every connection ; a compose project, a pod | `RTE_TOKEN` ; `RTE_URL` and `RTE_JOIN_TOKEN` to register itself |
| `database` (deprecated) | nobody: both sides read and write the database | 7.0 to 7.2 setups, until they move | the app's `DB_*`, `ENCRYPTION_SECRET` to register itself |

Whoever dialed, the socket carries the same messages. In both socket modes a runner signs in
with an RTE credential (Connections > Credentials, `credential_type: rte`): its password is
the RTE's `RTE_TOKEN`, its url the inbound RTE's address.

## Code map

| File | What it does |
|---|---|
| `runners/index.js` | The registry: `RUNNERS = { awx, rte, semaphore, rundeck, jenkins }`, `RUNNER_TYPES`, `getRunner(type)`. |
| `runners/orchestrator.js` | Between "the job may start" and "a runner runs it": the approval gate (the `APPROVE [...]` line, status `approve`, the notification), `resolveRunner`, `dispatch` (writes `jobs.runner`). |
| `runners/rte.js` | App side of an RTE: health/version check, launch (socket modes: the job written for the hub to send ; database mode: `POST /rte/v1/jobs`), wait for the row's status, cancel. |
| `runners/awx/index.js` | The awx runner: launch, cancel, check. |
| `runners/awx/api.js` | The AWX API calls and the output tracking (`Awx.launch`, `launchTemplate`, `trackJob`, `trackWorkflowJob`, `abortJob`, the `find*ByName` lookups), all taking the runner row. |
| `runners/semaphore.js` | The semaphore runner: a Semaphore UI template in the runner's `project`, found by name or id, launched with the form's values as extra vars (`environment`) and the form's `inventory` (by name or id), its task followed once a second (output lines, `success` / `error` / `stopped`), stopped on abort. An inventory or a limit the template does not allow (`task_params`) fails the launch: Semaphore would silently ignore it. |
| `runners/rundeck.js` | The rundeck runner: a Rundeck job in the runner's `project`, found by `group/name`, name or uuid, run with only the options it declares, its output read on by offset and lastmod (ERROR lines as stderr, each line's `[node]` once the output comes from several nodes), `succeeded` / `aborted` / anything else failed, aborted on abort. |
| `runners/jenkins.js` | The jenkins runner: a Jenkins job, found by its name or folder path (under the runner's folder), built with only the parameters it declares (`buildWithParameters`, no quiet period), followed through the queue (why it waits, said once; cancelled on abort) and then its console read on by `start` and `X-Text-Size` (whole lines, the console notes taken out), `SUCCESS` / `ABORTED` / anything else failed, stopped on abort. |
| `runners/common.js` | What the runners that follow a remote job share: `clientFor` (axios with the runner's certificate settings), `contactTolerance`, `lostContact`, `jobEnded`, `delay`. |
| `runners/rteHub.js` | The app's side of the RTE sockets: who an RTE calling in is (`authenticate`: its token, or a join token that adds it), the leases (`runner_leases`), the inbound dials, `dispatch` (the jobs waiting for a socket, the aborts), storing the items and acking them, sending job files, the RTE's heartbeat in `nodes`, `POST /api/v2/rte/register`. |
| `rte/start.js` | The RTE's start: `RTE_MODE` picks the mode and loads only its modules. |
| `rte/socket/protocol.js` | The socket's messages (contract 3), paths, close reasons and limits (ping every 20 s, dead after 60 s, 64 items in flight per job, 256 KiB file chunks). |
| `rte/socket/session.js` | One socket as both sides use it: JSON messages, the ping, a silent peer dropped. |
| `rte/socket/rte-socket.js` | The RTE in a socket mode: `dialOut` (outbound), the inbound listener, `registerInbound`, `socketJobIO` (the job's I/O through the app), capacity, cancel. |
| `rte/socket/spool.js` | A job's numbered items on the RTE's disk until the app acks them (`RTE_SPOOL_PATH`). |
| `rte/socket/files.js` | The job files the app sends (`RTE_FILES=transfer`), cached by hash (`RTE_CACHE_PATH`). |
| `rte/events.js`, `rte/callback_plugins/af_events.py` | The structured events: the callback plugin writes one JSON line per play, task and host result (`AF_EVENTS_FILE`) ; the tail hands them on in order. |
| `rte/jobio-db.js` | The job's I/O in database mode (deprecated): the database read and written by the RTE. |
| `lib/jobFiles.js` | The app packs a job's playbooks folder and inventories as tar.gz bundles named by a hash of their content. |
| `models/jobEvent.model.js`, `models/runnerJoinToken.model.js` | `job_events` (the Hosts and tasks panel) ; the join tokens, stored hashed. |
| `rte/server.js` | The RTE in database mode (deprecated): its API, the job claim, its own clean-up. |
| `rte/ansible-core.js` | The one place a playbook runs: `runAnsibleJob`, `buildAnsibleArgs` (no shell), `executeCommand` (process group, abort flag, output limit, job log). |
| `models/runner.model.js` | The `runners` table: per-type validation, one default per type, masked secrets. |
| `models/job.model.js` | `Job.launch`, `Job.continue` (approval), multistep, notifications, `Job.lastOrder`. |
| `/docker/runner/rte-base`, `/docker/runner/rte-core`, `/docker/runner/rte-full`, `/examples/rte` | The RTE images in three layers - the base (no python, no ansible), core (ansible-core and the essentials), full (the ansible package with collections and what the v6 image had) - and examples to build your own on them. |

### The runner contract

```js
runner = {
  type: 'rte' | 'awx' | ...,
  capabilities: { playbook: Boolean, template: Boolean },
  check(row) -> Promise<details>,    // the Runners page's Test connection, and the Status page
  launch(ctx) -> Promise<boolean>,   // resolves when the job has ENDED (a multistep waits on it)
  cancel(ctx) -> Promise<void>,      // the fast path ; the abort flag always works too
}
ctx = { jobId, jobType, extravars, credentialMap, runner /* the row, secrets decrypted */ }
```

The approval gate is never a runner's business: a job reaches `launch` only once it may run.
Multistep stays in `job.model.js`; each step is a child job that goes through the same path,
so steps can name different runners.

## Where a job runs

`resolveRunner`, in this order:

| The form says | A runner of the job's type is *Default* | The job runs |
|---|---|---|
| `runner: <name>` (or the deprecated `awx: <name>`) | (ignored) | on that runner; it must be able to run the job (an rte runs playbooks, an awx, a semaphore, a rundeck or a jenkins runs templates), and a name nobody added fails the job with "No runner named ..." |
| nothing | yes | on the default runner of the matching type (`rte` for playbooks, `awx` for templates) |
| nothing | no | nowhere: the job fails with "No runner to run this playbook : add one of type rte ..." |

`awx: <name>` logs a deprecation warning once per name; it is removed in 8.

## The life of a playbook job

1. `Job.launch` builds the extravars and inserts the `jobs` row (status `running`). From
   here the row is the input.
2. `orchestrator.dispatch`: with an approval and not yet approved, the gate writes the
   `APPROVE` line, sets status `approve` and stops. `Job.approve` → `Job.continue` writes the
   extravars it continues with back to the row, then dispatches again with `approved`.
3. `resolveRunner` picks the runner; `jobs.runner` records it.
4. **Socket modes**: the app writes `ok: [Running on RTE <name> (<mode>)]` and the job waits
   for the node that holds the runner's socket (`runner_leases`): at once when it is this
   node, else within 2 seconds (`dispatch`). That node sends `run` with the job, its sealed
   secrets and its files' hashes ; the RTE answers `claimed`, or `refused` when it is full
   (`RTE_MAX_JOBS`: the job waits and is sent again, `RTE_QUEUE_MINUTES`) or of another
   contract. It asks with `fetch` for the bundles it does not have and runs the job from
   there. Every output batch, event batch, log, start, exit and end is an `item`, numbered
   and written to the job's spool before it is sent ; the app stores it (`job_output`,
   `job_events` with `INSERT IGNORE` on (job, order), `Job.createOutputOnce`) and acks up to
   that number, at most 64 items in flight. After a reconnect, to the same node or another,
   the RTE sends again what was not acked and the app skips what it stored: each item
   exactly once. The launching node polls the row once a second until the status is final.

   **Database mode** (deprecated): the app writes `ok: [Running on RTE <name> (<url>)]`,
   posts the job id, and polls the row once a second until the status is final. The RTE claims the job
   (`UPDATE jobs SET host=<its name> WHERE id=? AND status='running' AND job_type='ansible' AND
   (host IS NULL OR host=<its name>)` - a repeated call is harmless, an AWX job or a multistep is
   never taken), then runs `runAnsibleJob({ jobId, secrets })`. The app sends its contract and
   the sealed secrets with the job id; an RTE of another contract refuses it, and so does one
   whose bundle does not open (another token, another job) - before it claims anything. When the POST gets no answer, the app follows the job if
   the RTE claimed it, and fails it only if not.
5. Output (database mode; the socket modes send the same as items): every chunk becomes a `job_output` row; `order` continues from `MAX(order)` in the
   database (`Job.lastOrder`), so two writers (app then RTE) never collide. A
   `.joblogs/job_log_<id>.log` the playbook writes is stored in `jobs.job_log` every 2 seconds
   and at the end, then removed.
6. End: `Job.endJobStatus` writes the last line, the status and sends the status mail.

### Abort

`Job.abort` sets `jobs.abort_requested` and calls the runner's `cancel` (`jobs.runner` says
which). An RTE stops the playbook's process group at once; AWX cancels its job. The flag is
the fallback: the RTE sees it on the next output line or within 2 seconds, the AWX tracker on
its next poll. When AWX answers the tracker's own cancel with 405 (already cancelling), the job
ends `aborted`.

### Who cleans up what

`jobs.host` holds who runs a job: the RTE's name, `rte-<hostname>-<port>`; nothing for AWX
jobs. The name needs no setting: two RTEs on one machine listen on different ports, and a
restarted RTE keeps its name.

Every process writes a heartbeat in `nodes` (RTEs too). A job belongs to the RTE running it
(`jobs.host`), otherwise to the app node or worker that started it (`jobs.tracker`).

- App node or worker start: abandons the jobs it followed itself (`tracker` = its name, no
  `host`). An RTE job carries on when the app restarts.
- RTE start: abandons the jobs carrying its own name. Hourly: those older than a day, except
  what it is running right now.
- The worker, every minute: abandons the jobs of any node (RTE or app) whose heartbeat is two
  minutes old - a pod replaced under a new name included - and releases the repository and
  schedule claims those nodes held. Hourly: jobs older than a day that nobody owns.
- Right after a start or the worker's sweep abandoned jobs: the abandoned jobs of the last 24
  hours that still run on a runner which can follow them again (AWX, AAP, Ascender: `resume`
  in the runner) are taken over in one statement, back to `running`, and followed by this
  node until they end with what the runner reports (`lib/jobResume.js`). Their stdout is read
  again in full; a step of a multistep then fails its multistep, whose loop is gone. A job the
  runner no longer knows stays abandoned, with an end and a line saying why.

## The RTE API

### Socket modes

| Call | Answer |
|---|---|
| `GET /live`, `GET /ready` (the RTE) | no token : 200 while the process answers ; 200 unless it is stopping (and, outbound, until it is welcomed by the app), else 503 - for Kubernetes probes and the installer |
| `GET /metrics` (the RTE) | with `METRICS_TOKEN` |
| `GET /rte/v1/socket` (inbound RTE) | the WebSocket an app node opens, `Authorization: Bearer <RTE_TOKEN>` ; a newer socket replaces the older one |
| `GET /api/v2/rte/socket` (the app) | the WebSocket an outbound RTE opens with its token, its name and, the first time, a join token |
| `POST /api/v2/rte/register` (the app) | an inbound RTE with `RTE_JOIN_TOKEN` registers its address once ; the app adds the runner and its `<name>-rte` credential. Body `{ mode: "inbound", url, cert }` : `cert` is the RTE's certificate (PEM, its `HTTPS_CERT`), sent when it runs `HTTPS=1` with an `https://` `RTE_URL` ; it becomes the credential's ca_bundle (ignore_certs off) and the app dials the RTE pinned to it |

### Database mode (deprecated)

All calls need `Authorization: Bearer <RTE_TOKEN>`.

| Call | Answer |
|---|---|
| `GET /live`, `GET /ready` | no token : 200 while the process answers ; 200 when the database answers and the RTE is not stopping, else 503 - for a load balancer or Kubernetes probes |
| `GET /rte/v1/health` | `{ id, version, contract, ansible, running: [jobIds] }` |
| `POST /rte/v1/jobs` `{ jobId }` | `202` accepted; `404` unknown job; `409` not running, or claimed by another runner |
| `GET /rte/v1/jobs/:id` | `running`, `finished` (+ `jobStatus`), or `unknown` |
| `POST /rte/v1/jobs/:id/cancel` | `202`; `409` when this RTE does not run it |

### Leases and heartbeats

One app node at a time holds an RTE's socket: its row in `runner_leases`, renewed every 20 s,
lasts 60 s. An outbound RTE's call takes the lease on the node it reaches ; for an inbound
runner every node tries every 10 s (`UPDATE` then `INSERT IGNORE`) and the winner dials. That
node writes the RTE's heartbeat in `nodes`, so the Status page, the Runners page (the mode and
the connection pill) and the worker's sweeps see a socket-mode RTE as any other ; a lost
node's lease runs out and another node takes the socket.

### Updating an RTE

An RTE does not have to follow every app release. The app and the RTE agree on a **contract**:
the socket's messages in the socket modes (`SOCKET_CONTRACT`, 3, in `rte/socket/protocol.js`),
the RTE API and what the RTE reads and writes in the database in database mode
(`server/src/rte/contract.js`).
As long as both speak the same contract, an RTE you tested and approved keeps working with newer
app releases; Test connection and the Status page show its release next to the app's, in green.

The contract number goes up only when a change would break older RTEs, and the release notes
then say *RTEs must be updated*. Until you update them, Test connection refuses them with that
reason and the Status page shows them in red. The RTE image is still published with every
release, so its tags always match the app's.

## Using a runner, step by step

1. **Start an RTE** (see [Running it](#running-it)) with a token of its own (`RTE_TOKEN`),
   its mode and its name (`RTE_NAME`): outbound with `APP_URL`, inbound with `APP_URL` and
   `RTE_URL`. Or let the installer do it: `ansibleforms-installer`, role Runner.
2. **It asks to join** (`rteHub.askToJoin`): the app adds a runner of that name waiting for
   approval, turned off, with an RTE credential `<name>-rte` holding its token (and, inbound,
   its address), and what it said of itself (host, address, mode, version, its token's
   fingerprint, which the RTE logs and the installer prints). The header bell counts it. At
   most `PENDING_MAX` (20) wait ; the worker removes those not handled within a day.
3. **An admin approves it** (`POST /api/v2/runner/:id/approve`, the review dialog of
   Connections > Runners): it is enabled, and the default of its type when there is none.
   Rejected (`/reject`), it is removed with its credential and its socket closed. A join token
   (`RTE_JOIN_TOKEN`, made through `POST /api/v2/runner/jointoken`) approves it at once, for
   unattended installs. Or add both by hand: an RTE credential under Connections >
   Credentials, then a runner of type *RTE* with its mode and that credential. *Test
   connection* shows its release, contract, ansible, mode, files and capacity.
4. **Point forms at it**: `runner: <name>` on a form or a step (also in the designer's form
   settings), or tick *Default* on the runner.

An AWX/AAP connection is a runner of type *AWX* with an AWX credential ; the v7 upgrade moves
the existing AAP connections there. A database-mode RTE (deprecated) still adds itself when it
starts (`RTE_REGISTER=1`), with the app's database settings and `ENCRYPTION_SECRET`.

A database-mode runner moves to a socket mode by itself: once its RTE restarts with `RTE_MODE`
outbound or inbound, the runner's name as `RTE_NAME` and the runner's own token, the runner takes
that mode, keeps its jobs and is no longer swept as a registered row; no approval is needed (the
installer's upgrade of a 7.2 Runner does exactly this). A join token never moves it, and a
runner the config seed declares in database mode stays refused until the seed says `rte_mode`.

## Where the token lives

| Side | Where | How |
|---|---|---|
| RTE | the environment variable `RTE_TOKEN` of the RTE | `-e RTE_TOKEN=...`, a compose `environment:` entry, a Kubernetes secret, or the installer's `rte.env` / `.env`. The RTE refuses to start without one of at least 16 characters. |
| App | the password of the runner's RTE credential (Connections > Credentials) | written when the RTE joins with a join token, typed on the Credentials page, or `password: ${SOME_ENV}` in the config seed's credentials. Stored encrypted with `ENCRYPTION_SECRET`; the API only ever shows `********`. A runner's own `token` still works, deprecated since 7.3 (removed in 8): the seed folds it into a credential. |

It is not an environment variable of the app: every runner has its own credential, so every
RTE can have a different token. A wrong token closes the socket (the reason is logged on both
sides) or, in database mode, fails the job with "the RTE ... refused the token".
In dev the `dev:rte` script uses `dev-rte-token-not-a-secret`; never outside a dev machine.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `AF_ROLE` | RTE | `rte` (set in the image); the app is `all` (unset), `app` or `worker` - see [examples/scale](../../../examples/scale) |
| `RTE_MODE` | RTE | `outbound`, `inbound` or `database` (the default in 7.x, deprecated) |
| `RTE_TOKEN` | RTE | the token of its socket (or of every call, database mode) ; the app holds the same value in the runner's RTE credential |
| `APP_URL`, `APP_TLS_VERIFY` | RTE | outbound (and a join): the app's address as people open it ; whether its certificate is checked (1, the default) |
| `RTE_NAME` | RTE | socket modes: its runner's name ; unset: its node id, which changes with the container |
| `RTE_JOIN_TOKEN` | RTE | socket modes, the first time: a join token, presented once |
| `RTE_FILES`, `RTE_CACHE_PATH` | RTE | `transfer` (default): the app sends the job files, cached by hash ; `local`: from the RTE's own disk (a shared volume) |
| `RTE_FILES_MAX_MB` | app | the largest folder the app sends (512) |
| `RTE_SPOOL_PATH` | RTE | where items wait until acked |
| `RTE_MAX_JOBS`, `RTE_DRAIN_SECONDS`, `RTE_QUEUE_MINUTES` | RTE, RTE, app | playbooks at once (10) ; the wait for running playbooks on a stop (25 s) ; how long a job waits for a full RTE, and a running job for its disconnected socket RTE (60 min) |
| `RTE_URL` | RTE | inbound with a join token, or database mode registering itself: the address the app reaches it on (`http://rte:8000`) |
| `RTE_REGISTER` | RTE | database mode: 1 (default) the RTE adds itself as a runner ; 0: add it by hand |
| `DB_*`, `ENCRYPTION_SECRET` | RTE | database mode only: the app's own values (`ENCRYPTION_SECRET` to store its token when it registers itself) |
| `ANSIBLE_PATH`, `PROCESS_MAX_BUFFER`, `REPO_PATH`, `HOME_PATH`, `UPLOAD_PATH` | RTE | where its playbooks, repositories, SSH key and uploads are |
| `PORT`, `HTTPS`, `HTTPS_CERT`, `HTTPS_KEY` | RTE | as for the app |
| `AWX_API_PREFIX` | app | the AWX API prefix, added to an awx runner uri without an `/api/` path (a uri may carry it : `https://aap.example.com/api/controller/v2`) |

All are in `server/help.yaml`. The RTE ones are kept off the app's settings page on purpose:
they describe the process, not a setting.

## Running it

**On a dev machine:** `npm run dev` (in the repository root) starts the client, the app and an
RTE next to it on port 8010, in database mode (no `RTE_MODE`). For the socket modes, start it
with `RTE_MODE=inbound` (and a runner of mode inbound on `http://127.0.0.1:8010`) or
`RTE_MODE=outbound APP_URL=http://127.0.0.1:3001 RTE_NAME=dev RTE_JOIN_TOKEN=<a join token>`. Both use `server/.env.development`, so they share the
database and the folders. The RTE adds itself as runner `127.0.0.1-8010` (`RTE_URL` is
`http://127.0.0.1:8010`), or keeps a row you made at that address. More RTEs:
`PORT=8011 npm run dev:rte` in another terminal ; each adds itself.

| Script (root) | Starts |
|---|---|
| `npm run dev` | client + app + an RTE on 8010 |
| `npm run dev:local` | client + app only (playbook forms then need another runner) |
| `npm run dev:rte` | the RTE alone |

**As a container**, outbound (the job files come from the app):

```bash
docker run -d --name rte \
  -e RTE_MODE=outbound -e APP_URL=https://forms.example.com -e RTE_NAME=dmz-1 \
  -e RTE_TOKEN=<a token of its own> -e RTE_JOIN_TOKEN=<a join token, the first time> \
  -v rte-data:/app/dist/persistent \
  ghcr.io/ansibleforms/ansibleforms-rte-full:7
```

Inbound, the app dials it: `-p 8010:8000 -e RTE_MODE=inbound -e RTE_URL=http://<this host>:8010`
with the same token and join token. The docker setup and the Helm chart run their RTE inbound
with `RTE_FILES=local` on the app's volume. **Without containers**, the installer's native
mode runs the same server as a systemd service.

Customers make it their own by building FROM one of the three layers:
- `ansibleforms-rte-base`, with their own python and ansible ;
- `ansibleforms-rte-core`, adding `RUN ansible-galaxy collection install ...` / `pip install ...` ;
- `ansibleforms-rte-full`, ready to run with the ansible package, its collections and what the 6.5 image had.

See [examples/rte](../../../examples/rte).

## Security

- A socket-mode RTE holds no database credentials and no `ENCRYPTION_SECRET`: it gets the jobs
  it runs, their sealed secrets and their files, and nothing else. An outbound RTE listens to
  nothing from outside but its probes ; an inbound one takes only a socket carrying its token.
- Every socket and every call carries the RTE's token; anything else is refused. Nothing else
  restricts who may call an inbound RTE - no address list, no client certificate - so keep it
  off the public network. `HTTPS=1` works as for the app : an inbound RTE with `HTTPS=1` and an
  `https://` `RTE_URL` sends its certificate when it registers, and the app dials it pinned to
  that certificate (its fingerprint shown on a runner waiting for approval,
  `pending_info.cert_fingerprint`). Over plain `http://` to another host the app logs a warning
  once per runner : the token crosses the network in clear.
- A join token adds a runner, or gives a new token to one still waiting for approval ; it never
  takes over an approved runner (409), whose token only its RTE or an admin changes.
- A join token adds a runner: it is shown once, stored hashed, and can expire or be limited to
  a number of uses ; delete it once the RTEs joined.
- A fake RTE (a runner pointed at another address, or a stolen token) receives the jobs, with
  their secrets: only admins can change runners and credentials.
- A database-mode RTE (deprecated) holds the database password, and `ENCRYPTION_SECRET` when it
  registers itself. Even with the token its API can only start a job that already exists and
  is `running`, report its status, cancel it, and answer health.
- A runner receives the secrets of every job it runs, so only the admin role adds, changes or
  deletes runners; users with settings access see and test them.

## Known limits

- With `RTE_FILES=transfer` the app sends the playbooks folder and the inventories ; the SSH
  key, `known_hosts` and uploads still come from the RTE's own disk. A folder bigger than
  `RTE_FILES_MAX_MB` is not sent: mount it and use `RTE_FILES=local`. A database-mode RTE uses
  its own disk for everything: mount the app's folders, or run it on the same machine.
- A form's `playbookSubPath` must exist on the RTE; a missing folder fails the job with the
  folder's name and what to mount.
- A multistep job, an AWX, a Semaphore and a Rundeck job are followed by the app node that
  started them: when that node goes, the job is abandoned (within two minutes on a cluster, at
  its restart otherwise). An AWX job is then followed again by another node, or by the same
  one once it is back; a Semaphore, Rundeck or Jenkins job stays abandoned. A step already
  handed to an RTE still finishes; the others go on over there.
- Semaphore and Rundeck runners have no default: a template form that names no runner goes to
  the default awx runner, so such a form names its runner. The task / execution id is kept in
  `jobs.awx_id`.

## Later

`findDefault` by capability (a default per playbook / template rather than
per type); following multistep and AWX jobs from the worker, so they survive the app node that
started them. (The worker role and several app nodes exist since 7: see
[examples/scale](../../../examples/scale).)

## Tests

- `tests/rte-ansible.test.mjs` - a job run from its row (credentials, vault, sub path, failure
  lines, output order, the job log), the ansible arguments, the approval gate, which runner a
  job goes to (per-type default, `runner:`, `awx:` alias, capabilities, no runner).
- `tests/job-abort-remote.test.mjs` - abort through the flag, no shell, process group, vault
  password on stdin, the output limit.
- `tests/awx-workflow.test.mjs` - AWX tracking against a fake AWX, incl. the 405 cancel.
- `tests/semaphore-runner.test.mjs` - the semaphore runner against a fake Semaphore: template by
  name or id, extra vars, output once per line, the status map, stop, launch refusals, lost contact.
- `tests/rundeck-runner.test.mjs` - the rundeck runner against a fake Rundeck: the job by group/name
  or uuid, only declared options, output read on by offset, the status map, abort, lost contact.
- `tests/runner-model.test.mjs` - per-type validation and default, masked secrets.
- `tests/schema-awx-to-runners.test.mjs` - the awx table moving into runners.
- `tests/rte-socket.test.mjs` - the socket's addresses, the spool (each item exactly once, resent after a reconnect), the events tail, the job files cache.
- `tests/rte-hub.test.mjs` - the app's side : who calls in (its token, a join token that adds the runner and its credential, an inbound registration), the items stored once after a reconnect (output, events, log, the end), a job lost by a restarted RTE.
- `tests/rte-tls-pin.test.mjs` - an inbound RTE over TLS : the certificate it sends, kept in its credential and pinned, its fingerprint for the approval, the dial pinned to it, the warning for plain http.
- `tests/rte-server.test.mjs` - the database-mode RTE API : the token, which jobs it takes, the contract.
- `tests/rte-handover.test.mjs` - the app's side : a refusal, a lost answer, the contract sent.
- `tests/rte-contract.test.mjs` - an RTE accepted by contract, not by release.
- `tests/worker-lock.test.mjs`, `tests/node-scope.test.mjs` - one worker, who ends whose jobs.
- `tests/health.test.mjs`, `tests/config-seed.test.mjs` - the runners check and seed section.
