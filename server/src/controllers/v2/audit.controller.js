import Audit from '../../models/audit.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import helpers from '../../lib/common.js';

// Read only by design : there is deliberately no create, update or delete handler
// here. Entries are written by Audit.log from the middleware and the models, and
// removed only by the retention sweep.

// an instant as the page sends a period's bounds : a day, or a day and a time with an optional
// zone (2026-11-14, 2026-11-13T23:00:00.000Z, 2026-11-14T00:00:00+01:00)
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Whether a period bound is one the read side takes : none, or one ISO date (or date and time)
 * that is a real instant. A repeated parameter (an array) is not one.
 *
 * Args:
 *   value (any): query.from or query.to.
 *
 * Returns:
 *   boolean: true when it is.
 */
export function validInstant(value) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false;
  return !isNaN(new Date(value).getTime());
}

/**
 * The filter of a request, checked : the period's bounds must be ISO dates, or the request is
 * refused with a reason rather than read with a bound silently dropped.
 *
 * Args:
 *   req (object): the request ; its query's actor, actorType, action, targetType, target,
 *     outcome, from, to, limit and offset.
 *
 * Returns:
 *   object: filter, the filter to read with ; or error, the translated reason (a 400).
 */
export function readQuery(req) {
  const q = req.query || {};
  // the period, [from, to)
  if (!validInstant(q.from) || !validInstant(q.to)) {
    return { error: i18n.t(req, 'audit.invalidPeriod') };
  }
  return {
    filter: {
      actor: q.actor,
      actorType: q.actorType,
      action: q.action,
      targetType: q.targetType,
      target: q.target,
      outcome: q.outcome,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    },
  };
}

/**
 * A page of the trail, filtered, the newest first.
 *
 * Args:
 *   req (object): the request ; its query's filters, from and to (ISO, [from, to)), limit and
 *     offset.
 *   res (object): the response ; 400 for a period that is not one.
 */
const findAll = async function (req, res) {
  const { filter, error } = readQuery(req);
  if (error) return res.status(400).json(RestResult.error(error));
  try {
    const result = await Audit.find(filter);
    res.json(RestResult.single(result));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'audit.failedGet'), helpers.getError(err)));
  }
};

/**
 * The values the filters offer : the actions and actors recorded, and the oldest entry's time
 * (the first year of the period).
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 */
const facets = async function (req, res) {
  try {
    res.json(RestResult.single(await Audit.facets()));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'audit.failedGet'), helpers.getError(err)));
  }
};

export default { findAll, facets };
