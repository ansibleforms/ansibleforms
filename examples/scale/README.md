# AnsibleForms on several nodes

One image, started in different roles (`AF_ROLE`):

| Role | Runs | How many |
|---|---|---|
| unset | the controller's web interface and API **and** the worker, in one process: the default | 1 |
| `controller` | the web interface and the API (`app` before 7.8, still read) | as many as you like, behind a load balancer |
| `worker` | the background work: the database bootstrap and the config seed, the schedules, the nightly backup, the repository syncs, the cleanups | 1 at work; more wait and take over |
| `rte` | the playbooks (the `ansibleforms-rte-full` image) | as many as you like |

[compose.yaml](compose.yaml) runs two controller nodes behind nginx, two workers, one RTE and a database.
Copy [.env.example](.env.example) to `.env` and fill in the secrets first.

The RTE runs in `inbound` mode (`RTE_MODE=inbound`): the controller dials it at `http://rte:8000` with its
`RTE_TOKEN` and keeps one WebSocket open, held by one node at a time. The RTE holds no database
credentials and reads none of the `.env`. Its runner `rte` and the credential it signs in with are
declared by the config seed, [seed.yaml](seed.yaml), which the worker applies at every start
(`CONFIG_SEED_PATH`). See [the RTE modes](https://ansibleforms.com/rte/modes.html).

## What the nodes share

- **The database.** It holds everything the nodes must agree on: the jobs, the worker lock, the
  designer lock, the list of nodes (Status page) and the change notices that keep every node's
  caches current (a credential, a runner or a schedule edited on one node is in force on all of
  them within 5 seconds).
- **The persistent volume** (`/app/dist/persistent`): forms, the config, repositories, uploads,
  backups and the managed `.env`. Every controller node and the worker mount the same one, read-write.
- **`~/.ssh`**: the key and the known hosts used for git over ssh. The worker creates the key on
  the first start.
- **`ACCESS_TOKEN_SECRET`**, the same on every controller node, or a token signed by one node is refused
  by the next. A controller node refuses to start without it.
- **`ENCRYPTION_SECRET`**, the same on every controller node and worker, or a credential stored by one
  cannot be read by another. The RTE needs none: the controller sends it each job's secrets.
- **`RTE_TOKEN`**, the same on the RTE and in its credential (the seed reads it from `.env`).

## How it behaves

- **One worker at a time.** The worker holds the database lock `ansibleforms_worker`. When it
  stops, the database releases the lock and a waiting worker takes it within 10 seconds. When its
  host dies without a goodbye (power, a crashed node), the database would keep the lock for hours:
  a waiting worker ends that session once no worker has written a heartbeat for two minutes, and
  takes over. A worker that loses the lock to another one stops, and its container restarts as
  the one waiting. A worker whose start fails stops too, so it never holds the lock doing nothing.
- **The schema is the worker's.** On an empty database the worker creates it, and on an upgrade it
  patches it; controller nodes wait until both are done, and say in their log what is still missing.
- **Every container names itself** `<role>-<hostname>-<port>`: nothing to set. The Status page
  lists them all, RTEs included.
- **Jobs belong to a container.** A job running on an RTE belongs to that RTE; it carries on when
  the controller node that started it goes. Any other job (an AWX job, the steps of a multistep form)
  belongs to the controller node that started it. A container that restarts ends its own unfinished
  jobs; one that disappears (a replaced pod) has them ended by the worker after two minutes
  without a heartbeat.
- **SIGHUP** on any node re-applies the config seed: a controller node asks the worker to do it.
- **Status** shows every node, its role and version, which one is the worker, and warns when the
  nodes run different versions.

## Upgrading

Upgrade the **worker first**, then the controller nodes. The worker patches the schema; a controller node of
the new version waits until the schema is patched (it logs what it is waiting for), so controller nodes
upgraded first stay unready until the worker follows - the old ones keep serving meanwhile. RTEs
can follow at any time while they speak the same contract (`server/src/rte/contract.js`).

## Limits

- The **chat assistant** keeps its conversations in the memory of one controller node: use sticky
  sessions (nginx `ip_hash` here), or a single controller node.
- **Logs** stay in each container (`LOG_PATH` off the shared volume, as in `.env.example`):
  several processes rotating one file lose lines. The log viewer shows the log of the node that
  answers; send the logs somewhere central for the whole picture (`docker logs`, a log collector).
- **Galera and group replication** do not share the worker lock between database nodes: point
  every worker at the same database node.
- Settings changed on the settings page are written to the managed `.env` on the shared volume
  and applied on every node; the ones that need a restart need it on every node.
