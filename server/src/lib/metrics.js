/******************************************************************/
/*                                                                */
/*  Prometheus metrics : GET /api/v2/metrics (an app node or the  */
/*  worker) and GET /metrics (an RTE), served only when           */
/*  METRICS_TOKEN is set, to a caller that sends it as a bearer   */
/*  token. What a dashboard or an alert needs :                   */
/*    - the process : cpu, memory, event loop lag, gc (prom-client */
/*      defaults, af_ prefixed) ;                                 */
/*    - http : requests and their duration, by mount and status ; */
/*    - jobs : running and awaiting approval now, and how the     */
/*      jobs of the last 24 hours ended ;                         */
/*    - nodes : the processes on the database, alive or not ;     */
/*    - logins : failed and locked out ;                          */
/*    - an RTE : the playbooks it runs now.                       */
/*                                                                */
/******************************************************************/
import { timingSafeEqual } from "crypto";
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "af_" });

const httpRequests = new client.Counter({
  name: "af_http_requests_total",
  help: "HTTP requests, by api mount, method and status",
  labelNames: ["route", "method", "status"],
  registers: [registry],
});
const httpDuration = new client.Histogram({
  name: "af_http_request_duration_seconds",
  help: "HTTP request duration, by api mount",
  labelNames: ["route"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
export const loginFailures = new client.Counter({
  name: "af_login_failures_total",
  help: "Failed logins (local and LDAP)",
  registers: [registry],
});
export const loginLockouts = new client.Counter({
  name: "af_login_lockouts_total",
  help: "Accounts locked after too many failed logins",
  registers: [registry],
});

/**
 * The api mount a path belongs to, as a label : /api/v2/job/12/output -> /api/v2/job. The rest
 * of the path would make a series per id.
 *
 * Args:
 *   path (string): the request path.
 *
 * Returns:
 *   string: the mount, or "other".
 */
export function routeLabel(path) {
  const m = /^\/api\/v2\/([a-z0-9-]+)/i.exec(String(path || ""));
  if (m) return `/api/v2/${m[1].toLowerCase()}`;
  if (/^\/rte\/v1\//.test(String(path || ""))) return "/rte/v1";
  return "other";
}

/**
 * The express middleware counting the requests and timing them.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 *   next (function): the next handler.
 */
export function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = routeLabel(req.originalUrl || req.url);
    end({ route });
    httpRequests.inc({ route, method: req.method, status: String(res.statusCode) });
  });
  next();
}

/**
 * Adds gauges read when Prometheus scrapes : what the database says now.
 *
 * Args:
 *   name (string): the metric's name.
 *   help (string): its description.
 *   labelNames (string[]): its labels.
 *   read (function): async (gauge) => void, sets the values.
 */
export function addScrapeGauge(name, help, labelNames, read) {
  if (registry.getSingleMetric(name)) return;
  new client.Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      try {
        this.reset();
        await read(this);
      } catch {
        // the database does not answer : the series are left out, the scrape still works
      }
    },
  });
}

/**
 * The /metrics handler : 404 without METRICS_TOKEN (switched off), 401 without the token.
 *
 * Returns:
 *   function: the express handler.
 */
export function metricsHandler() {
  return async (req, res) => {
    const token = process.env.METRICS_TOKEN || "";
    if (!token) return res.status(404).json({ error: "Not found" });
    const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return res.status(401).json({ error: "invalid token" });
    res.setHeader("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  };
}

export default { registry, httpMetrics, metricsHandler, addScrapeGauge, routeLabel, loginFailures, loginLockouts };
