/******************************************************************/
/*                                                                */
/*  The parts of the settings a role may be given without the     */
/*  rest (Show settings menu, showSettings, gives them all) :     */
/*    appearance   showAppearanceSettings                         */
/*    connections  showConnectionsSettings                        */
/*  Each has its own api (mounted behind sectionGuard) and its    */
/*  share of the two endpoints every part writes through : the    */
/*  settings row (/api/v2/settings) and the environment           */
/*  variables (/api/v2/config/env), checked field by field so a   */
/*  part never reaches another's (the mail, the url, sign-in).    */
/*                                                                */
/******************************************************************/

export const SETTINGS_SECTIONS = {
  appearance: {
    option: 'showAppearanceSettings',
    // Settings > Appearance : defaults, name, links (the environment label of before is the
    // labels' first now : Settings > Appearance > Labels, its own api)
    settingsFields: [
      'app_name', 'default_date_format', 'default_language', 'default_theme',
      'default_theme_color', 'default_timezone', 'forms_view', 'header_links',
    ],
    // what the config seed manages of them (read only on their pages), and the repository
    // holding each page's file (the Repository line of their pages)
    readFields: ['seed_managed_fields', 'source_defaults', 'source_logo', 'source_icon', 'source_name', 'source_links'],
    envVars: ['DEFAULT_LANGUAGE', 'SHOW_DESIGNER'],
  },
  connections: {
    option: 'showConnectionsSettings',
    // Settings > Connections : its pages read the instance's url (an endpoint they show), the MCP
    // switches the config seed manages (read only there), and the repository holding the MCP
    // settings and the chat assistant (the Repository line of their pages)
    settingsFields: [],
    readFields: ['url', 'seed_managed_fields', 'source_mcp', 'source_chat_assistant'],
    envVars: ['ENABLE_CHAT', 'ENABLE_MCP', 'MCP_READ_ONLY', 'MCP_CHAT_FORMS_ONLY'],
  },
};

/** The user's role options, from a request. */
function optionsOf(req) {
  return req?.user?.user?.options || {};
}

/**
 * Whether a request's user may use a part of the settings : all of them, or that part.
 *
 * Args:
 *   req (object): the request.
 *   section (string): 'appearance' or 'connections'.
 *
 * Returns:
 *   boolean: true when it may.
 */
export function maySection(req, section) {
  const options = optionsOf(req);
  return !!(options.showSettings || options[SETTINGS_SECTIONS[section]?.option]);
}

/** The parts of the settings a request's user has on their own (not with showSettings). */
function ownSections(req) {
  const options = optionsOf(req);
  return Object.values(SETTINGS_SECTIONS).filter((s) => options[s.option]);
}

/**
 * Whether a request's user has every setting (showSettings) : no field is checked then.
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   boolean: true with showSettings.
 */
export function hasAllSettings(req) {
  return !!optionsOf(req).showSettings;
}

/**
 * The fields of the settings row a request's user may change ; null for every one.
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   Set|null: the fields, or null with showSettings.
 */
export function writableSettingsFields(req) {
  if (hasAllSettings(req)) return null;
  return new Set(ownSections(req).flatMap((s) => s.settingsFields));
}

/**
 * The fields of the settings row a request's user may read ; null for every one.
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   Set|null: the fields, or null with showSettings.
 */
export function readableSettingsFields(req) {
  if (hasAllSettings(req)) return null;
  return new Set(ownSections(req).flatMap((s) => [...s.settingsFields, ...(s.readFields || [])]));
}

/**
 * Whether a request's user may read and change an environment variable.
 *
 * Args:
 *   req (object): the request.
 *   name (string): the variable.
 *
 * Returns:
 *   boolean: true with showSettings, or when one of their parts holds it.
 */
export function mayEnvVar(req, name) {
  if (hasAllSettings(req)) return true;
  return ownSections(req).some((s) => s.envVars.includes(name));
}

/**
 * Whether a request's user has any part of the settings (all of them, or one).
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   boolean: true when they have one.
 */
export function anySection(req) {
  return hasAllSettings(req) || ownSections(req).length > 0;
}

export default { SETTINGS_SECTIONS, maySection, hasAllSettings, writableSettingsFields, readableSettingsFields, mayEnvVar, anySection };
