// Prometheus metrics (lib/metrics.js) : with METRICS_TOKEN only, to a caller that sends it.
import { describe, test, expect } from "vitest";
import { metricsHandler, routeLabel, httpMetrics, registry } from "../src/lib/metrics.js";

function scrape(headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {}, body: "",
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = JSON.stringify(b); resolve(this); return this; },
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { this.body = b; resolve(this); },
    };
    metricsHandler()({ headers }, res);
  });
}

describe("the metrics", () => {
  test("off without METRICS_TOKEN : 404", async () => {
    delete process.env.METRICS_TOKEN;
    expect((await scrape()).statusCode).toBe(404);
  });

  test("the token, or 401 ; with it the Prometheus text", async () => {
    process.env.METRICS_TOKEN = "a-long-metrics-token";
    try {
      expect((await scrape()).statusCode).toBe(401);
      expect((await scrape({ authorization: "Bearer wrong" })).statusCode).toBe(401);
      const ok = await scrape({ authorization: "Bearer a-long-metrics-token" });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toMatch(/af_process_cpu_user_seconds_total/);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  test("a request is counted under its api mount, never its ids", async () => {
    expect(routeLabel("/api/v2/job/12/output?x=1")).toBe("/api/v2/job");
    expect(routeLabel("/rte/v1/jobs/9")).toBe("/rte/v1");
    expect(routeLabel("/assets/x.js")).toBe("other");
    const listeners = {};
    httpMetrics({ originalUrl: "/api/v2/job/12", method: "GET" }, { statusCode: 200, on: (e, f) => { listeners[e] = f; } }, () => {});
    listeners.finish();
    expect(await registry.getSingleMetricAsString("af_http_requests_total")).toMatch(/af_http_requests_total\{route="\/api\/v2\/job",method="GET",status="200"\} 1/);
  });
});
