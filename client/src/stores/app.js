// Utilities
//
// pinia and vue only : the bundler keeps its own helpers in this store's chunk, so an import of
// anything from the vendor chunk here (axios) makes a loop that leaves the page blank - see
// designerSwitchedOffNow in router/index.js
import { defineStore, getActivePinia } from 'pinia';
import { ref } from 'vue';

/**
 * A value the server put in index.html for the first frame (server/src/lib/indexMeta.js) : the
 * instance's name, its labels and their colours.
 *
 * Args:
 *   name (string): the meta tag's name.
 *
 * Returns:
 *   string|null: its content ; null when empty, or when the page carries no such tag (then the
 *     api says, State.loadAppConfig).
 */
function servedMeta(name) {
  return (typeof document !== 'undefined' && document.querySelector(`meta[name="${name}"]`)?.content) || null;
}

// the labels beside the logo as index.html carries them (af-labels, JSON) : none when absent or
// unreadable
function servedLabels() {
  try {
    const list = JSON.parse(servedMeta('af-labels') || '[]');
    return Array.isArray(list) ? list.filter((l) => l && l.name) : [];
  } catch {
    return [];
  }
}

// the user's time zone preference, kept in this browser like the theme ; storage can be
// unavailable (private mode), then the default applies
function loadTimezone() {
  try {
    return localStorage.getItem('af_timezone') || 'UTC';
  } catch {
    return 'UTC';
  }
}

// the user's date format, kept in this browser like the time zone ; none : the app's default
function loadDateFormat() {
  try {
    return localStorage.getItem('af_date_format') || 'YYYY-MM-DD';
  } catch {
    return 'YYYY-MM-DD';
  }
}

export const useAppStore = defineStore('app', () => {
  const theme = ref('light'); // default theme
  // a colour theme shown while a colour is hovered (Theme.previewColor) : 'color', else null - the
  // header's logo follows it, then comes back to the theme's own
  const themePreview = ref(null);
  const profile = ref(null);
  const authenticated = ref(false);
  const isAdmin = ref(false);
  const version = ref('');
  const customLogo = ref(null); // logo data url shown in the navbar
  const logoIsDefault = ref(true); // true while the seeded default logo is active
  const customFavicon = ref(null); // the website icon's data url ; null : the bundled one
  const serverBuild = ref(null);
  const clientBuild = ref(null);
  const approvals = ref(0);
  // the RTEs that asked to join and wait for an admin's approval (Connections > Runners), for
  // whoever sees the runners ; 0 for the others
  const runnerApprovals = ref(0);
  // the designer lock as /api/v2/lock answers it ({ free } or { lock, match }) : the lock icon
  // on the header's Designer link ; null while unknown or for a user without the designer
  const designerLock = ref(null);
  const errorMessage = ref('');
  const schemaData = ref(null);
  const chatEnabled = ref(false); // ENABLE_CHAT and a configured provider (/api/v2/app/config)
  const designerEnabled = ref(true); // SHOW_DESIGNER : the designer there at all (/api/v2/app/config)
  // STORED_JOB_UNUSED_DAYS (/api/v2/app/config) : the most days a stored job may stay unused, and
  // what the Store dialog starts at ; 0 never removes one (lib/storedJobUnused.js)
  const storedJobUnusedDays = ref(0);
  const appConfigLoaded = ref(false); // /api/v2/app/config read at least once (State.loadAppConfig)
  // Settings > Appearance (/api/v2/app/config) : the name in the browser tab and on
  // the sign-in page, the label beside the logo and its colour, the announcements under the
  // header ({ id, message, level, end_at } of each running now), the forms list's view for
  // everyone. The name and the label from the first frame, as index.html carries them
  const appName = ref(servedMeta('af-app-name'));
  // the labels beside the logo (Settings > Appearance > Labels) : { name, color } of each shown
  const labels = ref(servedLabels());
  const announcements = ref([]);
  const formsView = ref(null);
  // the header's own links (Settings > Appearance > Links > Custom), for who is signed in
  const headerLinks = ref([]);
  // the time zone dates are shown in : 'UTC', 'browser' or an IANA zone (lib/Time.js) ; read
  // here so every page re-renders its dates when the user picks another one
  const timezone = ref(loadTimezone());
  // the date format dates are shown in (lib/Time.js) : the user's, else the app's default
  const dateFormat = ref(loadDateFormat());
  // the server runs a newer build than this tab (App.vue's response interceptor) ; the banner
  // under the header offers a reload, and can be dismissed for the rest of this visit
  const newVersionAvailable = ref(false);
  const newVersionDismissed = ref(false);
  // the server waits for the disclaimer's acceptance (App.vue's response interceptor, code
  // disclaimer_required) : its dialog shows over the page (AppDisclaimer)
  const disclaimerOpen = ref(false);

  // const doubleCount = computed(() => count.value * 2)
  // function increment() {
  //   count.value++
  // }

  return {
    theme,
    themePreview,
    profile,
    authenticated,
    isAdmin,
    version,
    customLogo,
    logoIsDefault,
    customFavicon,
    serverBuild,
    clientBuild,
    approvals,
    runnerApprovals,
    designerLock,
    errorMessage,
    schemaData,
    chatEnabled,
    designerEnabled,
    storedJobUnusedDays,
    appConfigLoaded,
    appName,
    labels,
    announcements,
    formsView,
    headerLinks,
    timezone,
    dateFormat,
    newVersionAvailable,
    disclaimerOpen,
    newVersionDismissed,
  };
});

/**
 * Whether the designer is switched off for the instance (SHOW_DESIGNER, /api/v2/app/config) : then
 * no one sees it, whatever their role options. False before the store exists (a test, an early
 * route check).
 *
 * Returns:
 *   boolean: true when switched off.
 */
export function designerSwitchedOff() {
  if (!getActivePinia()) return false;
  return useAppStore().designerEnabled === false;
}
