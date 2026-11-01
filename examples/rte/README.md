# Your own RTE

Since 7, playbooks run in an RTE (runtime environment) container. It is the
AnsibleForms server started with `AF_ROLE=rte`, next to python and ansible. We publish
it in three layers, each built on the one before. Build your own on the layer that fits.

| Image | What is in it | Use it |
|---|---|---|
| `ghcr.io/ansibleforms/ansibleforms-rte-base` | node and the AnsibleForms server, git, ssh. No python and no ansible, so it runs no playbook by itself. | To build an RTE with **your own** python and ansible version: [Dockerfile.own-ansible](Dockerfile.own-ansible) |
| `ghcr.io/ansibleforms/ansibleforms-rte-core` | the base + python 3.14, ansible-core and a few common libraries (`jmespath`, `netaddr`, `requests`, `paramiko`). No collections. | To build a **smaller** RTE with only the collections and libraries your playbooks use: [Dockerfile.netapp](Dockerfile.netapp), [Dockerfile.vmware](Dockerfile.vmware) |
| `ghcr.io/ansibleforms/ansibleforms-rte-full` | the core + the `ansible` package on the same ansible-core, and what the AnsibleForms image had before 7: the NetApp, AWS and community collections, pandas, pyvmomi, boto3 and more | **The default.** Run it as it is: the Helm chart and the docker setup do, and playbooks from 6.5 find what they used. |

What each layer adds: [docker/runner/rte-base](../../docker/runner/rte-base/Dockerfile),
[docker/runner/rte-core](../../docker/runner/rte-core/Dockerfile) (with [docker/runner/rte-core/requirements.txt](../../docker/runner/rte-core/requirements.txt)), and
[docker/runner/rte-full](../../docker/runner/rte-full/Dockerfile) (with [docker/runner/rte-full/](../../docker/runner/rte-full)).

## Build and run it

```bash
docker build -f examples/rte/Dockerfile.netapp -t my-rte-netapp .
```

Run it like the published image, in a socket mode: it holds no database credentials, only its
`RTE_TOKEN` (at least 16 characters). In `inbound` mode the app dials it, as the Docker Compose
project, the Helm chart and [the scale example](../scale) run their RTE:

```bash
docker run -d --name rte -e RTE_MODE=inbound -e RTE_TOKEN=change-me-at-least-16-characters \
  -e HTTPS=0 -e PORT=8000 my-rte-netapp
```

The app then needs its runner: type RTE, mode inbound, and an RTE credential with the address
the app reaches it on and the same token. Add it under Connections > Runners, or declare it in
the config seed:

```yaml
credentials:
  items:
    - name: rte-netapp
      credential_type: rte
      url: http://rte:8000
      password: ${RTE_TOKEN}
runners:
  items:
    - name: rte-netapp
      type: rte
      rte_mode: inbound
      credential: rte-netapp
```

Forms run on it with `runner: rte-netapp`. An RTE that the app cannot reach dials the app
instead (`RTE_MODE=outbound` with `APP_URL`), and joins once an admin approves it or with a join
token (`RTE_JOIN_TOKEN`). The mode without a socket, `database`, is deprecated and removed in
8.0.0. See [the RTE modes](https://ansibleforms.com/rte/modes.html) and
[the runners README](../../server/src/runners/README.md).

## Keep it on the app's release

An RTE runs the app's own server code. Build FROM the same release as the app: `:7` follows
the app's `:7`, and an exact `:7.x.y` pins both. An RTE on an older release keeps working as
long as it speaks the same contract (`server/src/rte/contract.js`). The Status page says when
one must be rebuilt.

## Bake it in, or mount it

- **Bake it in** (the examples above): the image holds everything the playbooks need. It is
  reproducible and starts fast. This is the way for production.
- **Mount it**: collections in `/etc/ansible/collections` and roles in `/etc/ansible/roles`,
  from a volume. You get no rebuild per change, but what runs depends on what is on that
  volume. python libraries cannot be mounted this way: they go into the image.
