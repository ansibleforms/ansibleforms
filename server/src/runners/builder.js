// A builder (ansibleforms/builder, the image ansibleforms-rte-builder) : it builds the RTE images (lib/rteBuilds.js) and runs
// no playbook nor template. It joins and keeps its socket as a socket-mode runner does
// (runners/rteHub.js), kept as a runner of type builder that the Runners page does not list ; its
// connection test and its cancels are the socket's, as an RTE's (read when used : rte.js imports
// the registry this module is part of).
const rte = async () => (await import("./rte.js")).default;

export default {
  type: "builder",
  capabilities: { playbook: false, template: false, build: true },
  async check(runner) {
    return (await rte()).check(runner);
  },
  async cancel(ctx) {
    return (await rte()).cancel(ctx);
  },
};
