# AnsibleForms

[![CI](https://img.shields.io/github/actions/workflow/status/ansibleforms/ansibleforms/ci.yml?branch=main&label=CI)](https://github.com/ansibleforms/ansibleforms/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ansibleforms/ansibleforms?label=release)](https://github.com/ansibleforms/ansibleforms/releases/latest)
[![Image](https://img.shields.io/badge/image-ghcr.io-blue)](https://github.com/ansibleforms/ansibleforms/pkgs/container/ansibleforms)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-ansibleforms.com-informational)](https://ansibleforms.com)

AnsibleForms is a self-hosted web application that turns automation into self-service forms: users
fill in a form, AnsibleForms builds the variables and launches the job on a runner. A form runs an
Ansible playbook on a runtime environment container (RTE), a template on AWX, AAP, Ascender or
Semaphore, a job on Rundeck or Jenkins, or a workflow that chains any of these.
Everything about installing, configuring and writing forms is documented at [ansibleforms.com](https://ansibleforms.com).

## Features

- Forms for playbooks (RTE), templates (AWX, AAP, Ascender, Semaphore) and jobs (Rundeck, Jenkins)
- Workflows in AWX's syntax across runners, with conditions, approvals and success or failure links
- Cascaded dropdowns fed by databases, REST APIs, files and JavaScript or jq expressions
- Field dependencies, validation enforced on the server and wizard forms
- Approvals and notifications by mail, Slack, Teams, Telegram or webhook
- Local, LDAP, Entra ID and OIDC logins, roles per form category, a password policy and lockout
- Credentials kept encrypted or in HashiCorp Vault or CyberArk, sealed on their way to the RTE
- Job history and live output, abort and relaunch, stored jobs, one-off and recurring schedules
- Forms, playbooks and workflows kept in Git repositories, edited in the built-in designer
- A REST API with interactive docs, an MCP server and an optional chat assistant
- An audit log, syslog forwarding, Prometheus metrics, backups and health probes

## Installation

On a Linux server, run the installer and answer its questions:

```sh
curl -fsSL https://ansibleforms.com/install | sh
```

It installs a controller (the app, its database and an RTE) or a Runner, on Docker, Podman or Kubernetes.

Run again, it finds an AnsibleForms already installed and upgrades it.

The [installation guide](https://ansibleforms.com/installation) covers every option. The setups it uses also deploy by hand:

| Setup | Repository |
|---|---|
| Docker Compose | [ansibleforms/docker](https://github.com/ansibleforms/docker) |
| Kubernetes (Helm) | [ansibleforms/helm-charts](https://github.com/ansibleforms/helm-charts) |

The images, all on `ghcr.io/ansibleforms`, each for `linux/amd64` and `linux/arm64` under the same tags:

| Image | What it is |
|---|---|
| `ansibleforms` | The web app: interface, API, schedules and background work |
| `ansibleforms-rte-full` | The RTE that runs the playbooks: ansible with its collections. **The default** |
| `ansibleforms-rte-core` | A smaller RTE, ansible-core only, to build your own on ([examples/rte](examples/rte)) |
| `ansibleforms-rte-base` | The RTE without python or ansible, for your own versions of both |

## Release lines

Two major versions are maintained, each on its own branch with its own changelog and image tags.
Coming from 6? Read [Upgrading to 7](https://ansibleforms.com/upgrade-7) before you move over.

| Branch | Version | Status |
|---|---|---|
| `main` | 7.x | new features and fixes |
| `release/6.x` | 6.x | fixes only |

## Deployment topology

One container is enough: with `AF_ROLE` unset it serves the web app and runs the background work
(schema, seed, schedules, backups, repository syncs, cleanups). Playbooks run on any number of RTEs;
templates and jobs run on the AWX, Semaphore, Rundeck and Jenkins servers set up as runners.

To scale out or for high availability, split it: app nodes (`AF_ROLE=app`) behind a load balancer and a
worker (`AF_ROLE=worker`), all from the same image, on one database and one shared volume. A second worker
waits and takes over when the first stops; [examples/scale](examples/scale) has a compose file.

## Contributing

Contributions are welcome. Start with these files:

- [CONTRIBUTING.md](CONTRIBUTING.md): the development setup and the pull request rules
- [RELEASING.md](RELEASING.md): how releases are cut
- [SECURITY.md](SECURITY.md): how to report a security issue

## License

[GPL-3.0](LICENSE).
