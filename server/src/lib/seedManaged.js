'use strict';
// The fields the config seed manages per field (its defaults, logo, icon, name, links and mcp
// sections) : read only in the app, as every seeded object is - refused with a 403 by the helpers
// that save them (lib/appearance.js, lib/envSave.js, lib/brandImages.js), whatever page or request
// calls them ; the seed itself writes them (opts.fromSeed). They live in the settings row and in
// environment settings, so the seed's hold is kept per field, one list for every section : the
// names of the fields they declare (an MCP setting by its variable), in the settings row's
// seed_managed_fields (JSON). A field it stops declaring is released, and all are when the seed is
// turned off (lib/seed.js).
import mysql from "../models/db.model.js";
import Errors from "./errors.js";
import { APPEARANCE_SECTIONS, APPEARANCE_KEYS } from "./seed-schema.js";
import { yamlKeys } from "./repoObjects/yamlKeys.js";

// each appearance section's keys and the fields they set (the forms view : default_forms_view in
// the seed and a repository's file, forms_view in the settings row)
const KEYS = Object.fromEntries(Object.keys(APPEARANCE_SECTIONS).map((key) => [key, yamlKeys(APPEARANCE_KEYS[key])]));

// the fields of each appearance section, by the names the seed holds them (the settings row's)
const SECTION_FIELDS = Object.fromEntries(Object.entries(APPEARANCE_SECTIONS).map(([key, section]) => [key, Object.keys(section.properties).map(KEYS[key].fieldOf)]));

// the appearance fields : the Settings > Appearance pages', one seed section and one repository
// file each (lib/repoObjects/defaults.js, logo.js, icon.js, name.js, links.js)
export const APPEARANCE_FIELDS = Object.values(SECTION_FIELDS).flat();

// the two that are environment settings, by their variable
export const APPEARANCE_ENV = { DEFAULT_LANGUAGE: "default_language", SHOW_DESIGNER: "show_designer" };

// the MCP server's settings (Settings > Connections > MCP : its switch and its options), by their
// variable : the MCP type's (lib/repoObjects/mcp.js) and the seed's mcp section, each a field
export const MCP_ENV = /^(ENABLE_MCP|MCP_[A-Z0-9_]+)$/;

/**
 * The seed section a field it holds is declared in : an Appearance page's (defaults, logo, icon,
 * name, links), or mcp for an MCP setting.
 *
 * Args:
 *   field (string): its name (an MCP setting's variable).
 *
 * Returns:
 *   string|undefined: the section ; none for a field the seed never holds.
 */
export const sectionOfField = (field) =>
  MCP_ENV.test(String(field)) ? "mcp" : Object.keys(SECTION_FIELDS).find((key) => SECTION_FIELDS[key].includes(field));

/**
 * The key the seed's section names a field it holds by (default_forms_view for forms_view) : what
 * is said of it to the one who wrote the seed.
 *
 * Args:
 *   field (string): the field (an MCP setting's variable).
 *
 * Returns:
 *   string: its key in the seed ; the field itself for one named alike.
 */
export const seedKeyOf = (field) => {
  const section = sectionOfField(field);
  return KEYS[section] ? KEYS[section].keyOf(field) : field;
};

/**
 * The fields a seed's Appearance and mcp sections declare, by the names the seed holds them
 * (seed_managed_fields : the settings row's, an MCP setting's variable).
 *
 * Args:
 *   doc (object): the seed.
 *
 * Returns:
 *   string[]: the fields.
 */
export const seedFieldsOf = (doc) => [
  ...Object.keys(APPEARANCE_SECTIONS).flatMap((key) => Object.keys(doc?.[key] || {}).map(KEYS[key].fieldOf)),
  ...Object.keys(doc?.mcp || {}),
];

/**
 * Whether the seed can hold a field : an appearance field or an MCP setting.
 *
 * Args:
 *   field (string): its name (an MCP setting's variable).
 *
 * Returns:
 *   boolean: true when it is one.
 */
export const seedField = (field) => APPEARANCE_FIELDS.includes(field) || MCP_ENV.test(String(field));

/**
 * The fields the config seed manages (the appearance fields, the MCP settings).
 *
 * Returns:
 *   Promise<string[]>: their names ; none when it manages none (or they cannot be read).
 */
export async function seedManagedFields() {
  try {
    const rows = await mysql.do("SELECT seed_managed_fields FROM AnsibleForms.`settings` LIMIT 1");
    const list = JSON.parse(rows?.[0]?.seed_managed_fields || "[]");
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
export async function setSeedManagedFields(fields) {
  const before = await seedManagedFields();
  const now = (fields || []).filter(seedField);
  if (JSON.stringify([...before].sort()) !== JSON.stringify([...now].sort())) {
    await mysql.do("UPDATE AnsibleForms.`settings` SET seed_managed_fields = ?", [now.length ? JSON.stringify(now) : null]);
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
export async function assertSeedFree(fields, opts = {}) {
  if (opts.fromSeed || !fields?.length) return;
  const managed = await seedManagedFields();
  const held = fields.filter((f) => managed.includes(f));
  if (held.length) throw new Errors.AccessDeniedError(`Managed by the config seed and read only here: ${held.join(", ")}`);
}
