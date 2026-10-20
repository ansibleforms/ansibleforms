'use strict';
// Saving the fields of the settings row the app shows everywhere (the name, the links, the
// defaults ...) : what Settings > Appearance's pages save (controllers/v2/settings.controller.js)
// and what a branding repository or the config seed applies (lib/repoObjects/branding.js), written
// once - converted and checked by the model's constructor, then shown at once in every open tab
// (the 'appearance' live event : the header re-reads /api/v2/app/config).
import Settings from "../models/settings.model.js";
import { forgetAppDefaults } from "../routes/v2/app.routes.js";
import { publish } from "./liveEvents.js";

/**
 * Saves fields of the settings row, as converted by Settings (its constructor).
 *
 * Args:
 *   fields (object): the fields sent ; those Settings does not know are left out.
 *
 * Returns:
 *   Promise<boolean>: false when none was one Settings knows (nothing written).
 */
export async function saveSettingsFields(fields) {
  const record = new Settings(fields);
  // an effectively-empty record (no recognized fields) would produce invalid `UPDATE t set ?` SQL
  if (Object.keys(record).length === 0) return false;
  await Settings.update(record);
  forgetAppDefaults();
  publish("appearance");
  return true;
}
