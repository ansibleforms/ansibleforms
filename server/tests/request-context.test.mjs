// Every request has an id (lib/requestContext.js), in its response and its log lines.
import { describe, test, expect } from "vitest";
import { requestContext, currentRequest } from "../src/lib/requestContext.js";

function serve(headers = {}) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  let seen = null;
  requestContext({ headers }, res, () => { seen = currentRequest(); });
  return { res, seen };
}

describe("the request id", () => {
  test("a new one, in the response and the context", () => {
    const { res, seen } = serve();
    expect(res.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.requestId).toBe(res.headers["X-Request-Id"]);
  });

  test("a proxy's is kept when it looks like one, replaced when it does not", () => {
    expect(serve({ "x-request-id": "abc-123.def" }).res.headers["X-Request-Id"]).toBe("abc-123.def");
    expect(serve({ "x-request-id": "<script>" }).res.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(serve({ "x-request-id": "x".repeat(100) }).res.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("outside a request there is none", () => {
    expect(currentRequest()).toBe(null);
  });
});
