import express from "express";
import Settings from "../../models/settings.model.js";
import logger from "../../lib/logger.js";
import logConfig from "../../../config/log.config.js";
import appConfig from "../../../config/app.config.js";
import ChatSettings from "../../models/chatSettings.model.js";
import { onLive } from "../../lib/liveEvents.js";
import { isRunning } from "../../models/announcement.model.js";
import { settingDays } from "../../lib/storedJobExpiry.js";
const router = express.Router();

// /config is an unauthenticated bootstrap endpoint the SPA hits on every load,
// so cache the resolved defaults for a short TTL to avoid a DB round-trip
// per request. A change still propagates within CACHE_TTL_MS.
const CACHE_TTL_MS = 60 * 1000;
let defaultsCache = { value: undefined, fetchedAt: 0 };

/**
 * The appearance's defaults (Settings > Appearance), cached for a short time : this endpoint's,
 * and index.html's instance name and label (app-start.js, lib/indexMeta.js).
 *
 * Returns:
 *   Promise<Object>: { language, theme, color, appName, labels, ... }.
 */
export async function resolveDefaults() {
  if (defaultsCache.value !== undefined && (Date.now() - defaultsCache.fetchedAt) < CACHE_TTL_MS) {
    return defaultsCache.value;
  }
  // ENVIRONMENT first, then the database, then the built-in default - the same order the
  // rest of the app uses. An explicitly set DEFAULT_LANGUAGE therefore wins over the
  // default_language column, and the settings page greys that field out to say so.
  // (Before 6.3.0 the database value won and the variable was only a fallback.)
  const languageFromEnv = process.env.DEFAULT_LANGUAGE || null;
  let result = { language: languageFromEnv || "en", theme: null, color: null, appName: null, labels: [], announcements: [], formsView: null, timezone: null, dateFormat: null, headerLinks: [] };
  try {
    // language, theme and theme color all live on the same single settings row, so
    // they are read in ONE query : this endpoint blocks the SPA from rendering even
    // the login page, so a MySQL outage must cost one connectTimeout, not one per
    // setting.
    const defaults = await Settings.findAppDefaults();
    // only when the environment did not set one
    if (!languageFromEnv && defaults.language) {
      result.language = defaults.language;
    }
    result.theme = defaults.theme;
    result.color = defaults.color;
    result.appName = defaults.appName;
    result.labels = defaults.labels || [];
    result.announcements = defaults.announcements || [];
    result.formsView = defaults.formsView;
    result.timezone = defaults.timezone;
    result.dateFormat = defaults.dateFormat;
    result.headerLinks = defaults.headerLinks;
  } catch (e) {
    logger.debug("Could not read the defaults from database, using env var fallback")
  }
  defaultsCache = { value: result, fetchedAt: Date.now() };
  return result;
}

// Whether the chat button may show : ENABLE_CHAT, and a provider with a key and a model.
// Only a boolean - this route is unauthenticated, the provider details stay behind the
// settings page.
async function chatEnabled() {
  if (!appConfig.enableChat) return false;
  return ChatSettings.configuredCached();
}

/**
 * Forgets the cached defaults : a settings save shows at once, on this node and - through the
 * 'appearance' live event - on the others whose browsers watch.
 */
export function forgetAppDefaults() {
  defaultsCache = { value: undefined, fetchedAt: 0 };
}
onLive("appearance", forgetAppDefaults);

/**
 * The announcements running now : started (or no start) and not ended (or no end), as the
 * header shows them.
 *
 * Args:
 *   announcements (object[]): those not ended, { id, message, level, start_at, end_at }.
 *
 * Returns:
 *   object[]: { id, message, level, end_at } of each.
 */
function runningAnnouncements(announcements) {
  const now = Date.now();
  return (announcements || [])
    .filter((a) => isRunning(a, now))
    .map((a) => ({ id: a.id, message: a.message, level: a.level, end_at: a.end_at || null }));
}

router.get("/config", async (req, res) => {
  const defaults = await resolveDefaults();
  res.json({
    defaultLanguage: defaults.language,
    defaultTheme: defaults.theme,
    defaultThemeColor: defaults.color,
    // timezone the server logs and schedules in : the client renders cron next-run
    // previews in it, so a cron shown in the UI matches when the job really runs
    logTz: logConfig.tz,
    chatEnabled: await chatEnabled(),
    // whether the designer is there at all (SHOW_DESIGNER, Settings > Appearance > Links) :
    // the header's Designer link needs it as well as the user's showDesigner option
    designerEnabled: !!appConfig.showDesigner,
    // Settings > Appearance : the name in the browser tab and on the sign-in page,
    // the label beside the logo, the announcements under the header while they run, the forms
    // list's view for whoever has not chosen one
    appName: defaults.appName,
    labels: defaults.labels,
    announcements: runningAnnouncements(defaults.announcements),
    formsView: defaults.formsView,
    timezone: defaults.timezone,
    dateFormat: defaults.dateFormat,
    // STORED_JOB_UNUSED_DAYS : the Store dialog starts a stored job's days unused at it, and
    // offers no more (lib/storedJobExpiry.js) ; 0 never removes one
    storedJobUnusedDays: settingDays(appConfig.storedJobUnusedDays),
  });
});

// ─── the header's own links : for who is signed in only (app.js mounts it behind the login) ───
export const linksRouter = express.Router();
linksRouter.get("/", async (req, res) => {
  const defaults = await resolveDefaults();
  res.json(defaults.headerLinks || []);
});

export default router;
