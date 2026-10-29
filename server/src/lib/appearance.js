'use strict';
// Saving the fields of the settings row the app shows everywhere (the name, the links, the
// defaults ...) : what Settings > Appearance's pages save (controllers/v2/settings.controller.js)
// and what a Defaults, Name or Links repository or the config seed applies (lib/repoObjects),
// written once - converted and checked by the model's constructor, then shown at once in every
// open tab (the 'appearance' live event : the header re-reads /api/v2/app/config).
import Settings from "../models/settings.model.js";
import { forgetAppDefaults } from "../routes/v2/app.routes.js";
import { publish } from "./liveEvents.js";
import { APPEARANCE_FIELDS, assertSeedFree } from "./seedManaged.js";

/**
 * Saves fields of the settings row, as converted by Settings (its constructor).
 *
 * Args:
 *   fields (object): the fields sent ; those Settings does not know are left out.
 *   opts (object): { fromSeed (true : the config seed's own write) }.
 *
 * Returns:
 *   Promise<boolean>: false when none was one Settings knows (nothing written).
 *
 * Raises:
 *   Errors.AccessDeniedError: an appearance field the config seed manages changed (one sent as it is
 *     stored passes : a page sends back what it loaded).
 */
export async function saveSettingsFields(fields, opts = {}) {
  const record = new Settings(fields);
  // an effectively-empty record (no recognized fields) would produce invalid `UPDATE t set ?` SQL
  if (Object.keys(record).length === 0) return false;
  const stored = await Settings.find().catch(() => ({}));
  const changed = Object.keys(record).filter((k) => APPEARANCE_FIELDS.includes(k) && String(record[k] ?? "") !== String(stored[k] ?? ""));
  await assertSeedFree(changed, opts);
  await Settings.update(record);
  forgetAppDefaults();
  publish("appearance");
  return true;
}
