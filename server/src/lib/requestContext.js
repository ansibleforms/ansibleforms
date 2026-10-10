/******************************************************************/
/*                                                                */
/*  The request a line of the log belongs to : every request gets */
/*  an id - the X-Request-Id a proxy sent, or a new one - returned */
/*  in the response's X-Request-Id and carried by every log line  */
/*  written while it is served (AsyncLocalStorage). One request   */
/*  can then be followed through the log, across a proxy's log.   */
/*                                                                */
/******************************************************************/
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

const storage = new AsyncLocalStorage();

// what a request id may be : a proxy's, kept as it is when it looks like one
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The request being served now.
 *
 * Returns:
 *   object|null: { requestId }, or null outside a request.
 */
export function currentRequest() {
  return storage.getStore() || null;
}

/**
 * The express middleware : the request's id, in the response and in the log context.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 *   next (function): the next handler.
 */
export function requestContext(req, res, next) {
  const given = String(req.headers?.["x-request-id"] || "");
  const requestId = SAFE_ID.test(given) ? given : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  storage.run({ requestId }, next);
}

export default { currentRequest, requestContext };
