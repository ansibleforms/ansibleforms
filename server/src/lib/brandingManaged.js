'use strict';
// The fields the config seed manages per field (its branding, links and mcp sections) : read only
// in the app, as every seeded object is - refused with a 403 by the helpers that save them
// (lib/appearance.js, lib/envSave.js, lib/brandImages.js), whatever page or request calls them ;
// the seed itself writes them (opts.fromSeed). They live in the settings row and in environment
// settings, so the seed's hold is kept per field, one list for every section : the names of the
// fields they declare (an MCP setting by its variable), in the settings row's branding_managed
// (JSON). A field it stops declaring is released, and all are when the seed is turned off
// (lib/seed.js).
import mysql from "../models/db.model.js";
import Errors from "./errors.js";

// the appearance fields : the branding's (lib/repoObjects/branding.js) and the links'
// (lib/repoObjects/links.js), the seed's branding and links sections
export const BRANDING_FIELDS = [
  "app_name",
  "header_links",
  "show_designer",
  "default_theme",
  "default_theme_color",
  "forms_view",
  "default_timezone",
  "default_date_format",
  "default_language",
  "logo",
  "icon",
];

// the two that are environment settings, by their variable
export const BRANDING_ENV = { DEFAULT_LANGUAGE: "default_language", SHOW_DESIGNER: "show_designer" };

// the MCP server's settings (Settings > Connections > MCP : its switch and its options), by their
// variable : the MCP type's (lib/repoObjects/mcp.js) and the seed's mcp section, each a field
export const MCP_ENV = /^(ENABLE_MCP|MCP_[A-Z0-9_]+)$/;

/**
 * Whether the seed can hold a field : an appearance field or an MCP setting.
 *
 * Args:
 *   field (string): its name (an MCP setting's variable).
 *
 * Returns:
 *   boolean: true when it is one.
 */
export const seedField = (field) => BRANDING_FIELDS.includes(field) || MCP_ENV.test(String(field));

/**
 * The fields the config seed manages (the appearance fields, the MCP settings).
 *
 * Returns:
 *   Promise<string[]>: their names ; none when it manages none (or they cannot be read).
 */
export async function seedManagedBranding() {
  try {
    const rows = await mysql.do("SELECT branding_managed FROM AnsibleForms.`settings` LIMIT 1");
    const list = JSON.parse(rows?.[0]?.branding_managed || "[]");
    return Array.isArray(list) ? list.filter(seedField) : [];
  } catch {
    return [];
  }
}

/**
 * Records the fields the config seed manages now (the ones its sections declare).
 *
 * Args:
 *   fields (string[]): their names ; none releases them all.
 *
 * Returns:
 *   Promise<string[]>: the ones released (managed before, no longer).
 */
export async function setSeedManagedBranding(fields) {
  const before = await seedManagedBranding();
  const now = (fields || []).filter(seedField);
  if (JSON.stringify([...before].sort()) !== JSON.stringify([...now].sort())) {
    await mysql.do("UPDATE AnsibleForms.`settings` SET branding_managed = ?", [now.length ? JSON.stringify(now) : null]);
  }
  return before.filter((f) => !now.includes(f));
}

/**
 * Refuses a change of fields the config seed manages : 403, as the API refuses a change
 * of any seeded object. The seed's own write passes.
 *
 * Args:
 *   fields (string[]): the fields a save changes (an MCP setting by its variable).
 *   opts (object): { fromSeed (true : the seed's own write) }.
 *
 * Raises:
 *   Errors.AccessDeniedError: one of them is the seed's, named.
 */
export async function assertBrandingFree(fields, opts = {}) {
  if (opts.fromSeed || !fields?.length) return;
  const managed = await seedManagedBranding();
  const held = fields.filter((f) => managed.includes(f));
  if (held.length) throw new Errors.AccessDeniedError(`Managed by the config seed and read only here: ${held.join(", ")}`);
}
