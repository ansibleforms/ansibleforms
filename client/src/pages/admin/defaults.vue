<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Appearance > Defaults : how the app looks for      */
/*  everyone by default - the theme and its colour, the forms     */
/*  list's view, the time zone (in the database), the language    */
/*  (an environment variable). A user's own choice (the top bar,  */
/*  the profile) wins over them.                                  */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import Theme from '@/lib/Theme';
import Time, { BROWSER, DATE_FORMATS } from '@/lib/Time';
import dayjs from 'dayjs';
import State from '@/lib/State';
import { useEnvVars } from '@/composables/useEnvVars';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useSeedManaged } from '@/composables/useSeedManaged';

const { t } = useI18n();

// two tabs, as Profile > Preferences (the defaults of what a user picks there) : how the app looks,
// dates and times ; kept in the address, named last in the title
const tabs = computed(() => [
  { key: 'appearance', label: t('profilePage.tabAppearance'), icon: 'palette' },
  { key: 'datetime', label: t('profilePage.tabDateTime'), icon: 'clock' },
]);
const { activeTab, tabLink } = useRouteTab('appearance', (key) => tabs.value.some((x) => x.key === key));
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value) || tabs.value[0];
  return [
    { title: t('sidebar.defaults'), icon: 'display', to: tabLink('appearance') },
    { title: tab.label, icon: tab.icon, to: tabLink(tab.key) },
  ];
});
// each setting's tab, in Profile > Preferences' order
const GROUPS = { appearance: ['language', 'theme', 'forms'], datetime: ['timezone', 'date'] };
const authenticated = ref(false);
// the page's values read once : until then its fields as grey placeholders
const loaded = ref(false);

// ─── what the settings row keeps ──────────────────────────────────────────────
// the theme and its colour, the forms view, the time zone
const theme = ref(lookOf({})); // as edited
const savedTheme = ref(null); // as saved
// Follow the browser first (the default : light or dark as the user's browser is), then the themes
const themeOptions = computed(() => [
  { value: 'system', label: t('settings.settingsPage.themeSystem') },
  ...Theme.themes().map((th) => ({ value: th.value, label: th.title })),
]);
// the colours a Color theme offers
const colorPalette = [
  { label: 'Blue', hex: '#008cba' },
  { label: 'Cyan', hex: '#0369a1' },
  { label: 'Navy', hex: '#1b2a4a' },
  { label: 'Indigo', hex: '#521ea6' },
  { label: 'Purple', hex: '#4a2a8f' },
  { label: 'Pink', hex: '#bb1c5e' },
  { label: 'Red', hex: '#b92d34' },
  { label: 'Orange', hex: '#c2570c' },
  { label: 'Green', hex: '#198754' },
  { label: 'Teal', hex: '#0f766e' },
  { label: 'Slate', hex: '#475569' },
  { label: 'Brown', hex: '#795548' },
];

// the time zones : UTC, each user's browser's own, or any zone
const timezones = computed(() => [
  { value: 'UTC', label: 'UTC' },
  { value: 'browser', label: t('settings.interface.timezoneBrowser') },
  ...Time.zones()
    .filter((z) => z !== 'UTC')
    .map((z) => ({ value: z, label: z })),
]);
// the date formats, each shown as today's date reads in it
// each date format as the app writes a date with it : the date, the time and the zone, in the
// default time zone chosen above, then the pattern
const dateFormats = computed(() => {
  // each user's browser : this one's zone, as this admin's own browser shows it
  const pref = theme.value.default_timezone || 'UTC';
  const zone = pref === BROWSER ? Time.browserZone() : pref;
  const now = new Date();
  let name = zone;
  try {
    name = Time.zoneName(now, zone) || zone;
  } catch {
    // an unknown zone : its own name
  }
  return DATE_FORMATS.map((f) => {
    let example;
    try {
      example = dayjs(now).tz(zone).format(`${f} HH:mm`);
    } catch {
      example = dayjs(now).utc().format(`${f} HH:mm`);
    }
    return { value: f, label: `${example} ${name}  (${f})` };
  });
});
const formsViews = computed(() =>
  ['tiles', 'list'].map((v) => ({ value: v, label: t(`settings.interface.formsView_${v}`) })),
);

/**
 * What the page edits of a settings row : light, the blue, tiles and UTC without them.
 *
 * Args:
 *   row (object): the settings row.
 *
 * Returns:
 *   object: the fields, as the page edits them.
 */
function lookOf(row) {
  return {
    // none set : Follow the browser, as the app does without one (lib/Theme.js)
    default_theme: row?.default_theme || 'system',
    default_theme_color: Theme.current(row?.default_theme_color || '#008cba'),
    forms_view: row?.forms_view || 'tiles',
    default_timezone: row?.default_timezone || 'UTC',
    default_date_format: row?.default_date_format || 'YYYY-MM-DD',
  };
}
const themeDirty = computed(
  () => !!savedTheme.value && JSON.stringify(theme.value) !== JSON.stringify(savedTheme.value),
);

// ─── the language : an environment variable ───────────────────────────────────
const { envItems, envEdits, envDirty, envRestartPending, loadEnvironmentVariables, saveEnvironmentVariables } =
  useEnvVars(['DEFAULT_LANGUAGE']);
// the language's help : said as the page's other defaults, translated
const languageEnv = computed(() => envItems.value.map((e) => ({ ...e, hint: t('settings.interface.languageHelp') })));

// leaving with a change unsaved asks first
const dirty = computed(() => themeDirty.value || envDirty.value);
useUnsavedGuard(dirty, () => save());

/**
 * Loads what the page edits of the settings row.
 */
async function loadTheme() {
  try {
    const result = await axios.get('/api/v2/settings/');
    theme.value = lookOf(result.data);
    savedTheme.value = lookOf(result.data);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

/**
 * Saves what changed : the settings row's fields, then the variables.
 */
async function save() {
  if (themeDirty.value) {
    try {
      await axios.put('/api/v2/settings/', { ...theme.value });
      toast.success(t('settings.common.nameUpdated', { name: t('sidebar.defaults') }));
      await loadTheme();
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err));
      return;
    }
  }
  if (envDirty.value) await saveEnvironmentVariables();
  // the app follows at once : the forms view, the time zone, the date format
  await State.loadAppConfig();
}

// ─── search ──────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows the page, as Settings > General's : the
// settings whose label or help has it, under the tab's name, the tab set aside meanwhile.
const { search, searching, matchingKeys } = useRecordSearch();
// each setting by what it can be found by, in the page's order
const shownFields = computed(() =>
  matchingKeys([
    ['theme', t('settings.settingsPage.defaultTheme'), t('settings.settingsPage.defaultThemeHelp')],
    ['language', ...languageEnv.value.flatMap((e) => [e.short, e.name, e.hint, e.description])],
    ['forms', t('settings.interface.formsView'), t('settings.interface.formsViewHelp')],
    ['timezone', t('settings.interface.timezone'), t('settings.interface.timezoneHelp')],
    ['date', t('settings.interface.dateFormat'), t('settings.interface.dateFormatHelp')],
  ]),
);
// a tab's settings shown now : searching, those that match ; else its own, when it is open
const groupShown = (group) =>
  searching.value
    ? GROUPS[group].filter((k) => shownFields.value.includes(k))
    : activeTab.value === group
      ? GROUPS[group]
      : [];
const shown = (key) => Object.keys(GROUPS).some((g) => groupShown(g).includes(key));
// the room above a setting : none above the first one shown in its tab
const spaced = (key) => {
  const group = Object.keys(GROUPS).find((g) => GROUPS[g].includes(key));
  return groupShown(group)[0] !== key;
};
// searching : the tabs with a match, each under its name, the first without a line above
const searchHeads = computed(() => Object.keys(GROUPS).filter((g) => groupShown(g).length));

// a color still hovered when the page goes : the user's own theme again (Theme.previewColor)
onBeforeUnmount(() => Theme.endPreview());
// the fields the config seed manages : read only here
const { seeded, loadSeedManaged } = useSeedManaged();

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([loadTheme(), loadEnvironmentVariables(), loadSeedManaged()]);
  loaded.value = true;
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="display"
      :title="t('sidebar.defaults')"
      :description="t('settings.interface.description')"
      :crumbs="crumbs"
    >
      <!-- narrows the page ; the search box of the other pages -->
      <template #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="!searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in tabs" :key="tab.key" class="nav-item">
            <a
              class="nav-link"
              :class="{ active: activeTab === tab.key }"
              href="#"
              @click.prevent="activeTab = tab.key"
            >
              <FaIcon :icon="tab.icon" class="me-1" />
              {{ tab.label }}
            </a>
          </li>
        </ul>
      </template>
      <template #actions>
        <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
      </template>
      <template #default>
        <!-- the first load : the fields as grey placeholders, in their place -->
        <AppSkeleton v-if="!loaded" shape="form" :count="4" />
        <template v-else>
          <!-- kept under defaults: in a repository's file : which one, and the file -->
          <AppRepositorySource v-show="!searching" type="defaults" />
          <AppSeedNotice
            v-if="
              seeded(
                'default_language',
                'default_theme',
                'default_theme_color',
                'forms_view',
                'default_timezone',
                'default_date_format',
              )
            "
          />
          <div v-if="envRestartPending.length" class="alert alert-warning py-2">
            <FaIcon icon="triangle-exclamation" class="me-2" />
            {{ t('settings.settingsPage.envRestartPending', { names: envRestartPending.join(', ') }) }}
          </div>
          <div v-if="searching && !shownFields.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
          <!-- Appearance : the language, the theme, the forms view ; Date and time : the time zone and
               the date format - as Profile > Preferences. Searching : the matches of both, each under
               its tab's name, as Settings > General -->
          <div>
            <template v-if="searching && searchHeads.includes('appearance')">
              <hr v-if="searchHeads[0] !== 'appearance'" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHeads[0] === 'appearance' }"
              >
                <FaIcon :icon="tabs.find((x) => x.key === 'appearance').icon" class="me-1" />{{
                  tabs.find((x) => x.key === 'appearance').label
                }}
              </h6>
            </template>
            <!-- the language : an environment variable -->
            <template v-for="e in languageEnv" :key="e.name">
              <div v-show="shown('language')" :class="{ 'mt-4': spaced('language') }">
                <fieldset :disabled="seeded('default_language')">
                  <AppEnvField v-model="envEdits[e.name]" :e="e" class="af-defaults-wide" />
                </fieldset>
              </div>
            </template>
            <!-- the theme : no environment variable, kept in the database -->
            <fieldset :disabled="seeded('default_theme', 'default_theme_color')">
              <BsInput
                v-show="shown('theme')"
                class="af-interface-field"
                :class="{ 'mt-4': spaced('theme') }"
                :isFloating="false"
                type="select"
                icon="palette"
                v-model="theme.default_theme"
                :values="themeOptions"
                valueKey="value"
                labelKey="label"
                :label="t('settings.settingsPage.defaultTheme')"
                :help="t('settings.settingsPage.defaultThemeHelp')"
              />
              <div v-if="theme.default_theme === 'color'" v-show="shown('theme')" class="mt-2 ms-1">
                <div class="d-flex flex-wrap gap-2">
                  <button
                    v-for="c in colorPalette"
                    :key="c.hex"
                    type="button"
                    class="settings-color-swatch"
                    :style="{ backgroundColor: c.hex }"
                    :class="{ 'settings-color-swatch-active': theme.default_theme_color === c.hex }"
                    :title="c.label"
                    @click="theme.default_theme_color = c.hex"
                    @mouseenter="Theme.previewColor(c.hex)"
                    @mouseleave="Theme.endPreview()"
                    @focus="Theme.previewColor(c.hex)"
                    @blur="Theme.endPreview()"
                  >
                    <FaIcon v-if="theme.default_theme_color === c.hex" icon="check" class="settings-swatch-check" />
                  </button>
                </div>
              </div>
            </fieldset>
            <!-- the forms list's view : in the database -->
            <fieldset :disabled="seeded('forms_view')">
              <BsInput
                v-show="shown('forms')"
                class="af-interface-field"
                :class="{ 'mt-4': spaced('forms') }"
                :isFloating="false"
                type="select"
                icon="table-cells-large"
                v-model="theme.forms_view"
                :values="formsViews"
                valueKey="value"
                labelKey="label"
                :label="t('settings.interface.formsView')"
                :help="t('settings.interface.formsViewHelp')"
              />
            </fieldset>
            <template v-if="searching && searchHeads.includes('datetime')">
              <hr v-if="searchHeads[0] !== 'datetime'" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHeads[0] === 'datetime' }"
              >
                <FaIcon :icon="tabs.find((x) => x.key === 'datetime').icon" class="me-1" />{{
                  tabs.find((x) => x.key === 'datetime').label
                }}
              </h6>
            </template>
            <!-- the time zone and the date format : in the database -->
            <fieldset :disabled="seeded('default_timezone')">
              <BsInput
                v-show="shown('timezone')"
                class="af-interface-field"
                :class="{ 'mt-4': spaced('timezone') }"
                :isFloating="false"
                type="select"
                icon="clock"
                v-model="theme.default_timezone"
                :values="timezones"
                valueKey="value"
                labelKey="label"
                :label="t('settings.interface.timezone')"
                :help="t('settings.interface.timezoneHelp')"
              />
            </fieldset>
            <fieldset :disabled="seeded('default_date_format')">
              <BsInput
                v-show="shown('date')"
                class="af-interface-field"
                :class="{ 'mt-4': spaced('date') }"
                :isFloating="false"
                type="select"
                icon="calendar"
                v-model="theme.default_date_format"
                :values="dateFormats"
                valueKey="value"
                labelKey="label"
                :label="t('settings.interface.dateFormat')"
                :help="t('settings.interface.dateFormatHelp')"
              />
            </fieldset>
            <!-- the time now in the default zone and format : how dates read for whoever has not
                 picked their own, as Profile > Preferences shows it -->
            <template v-if="!searching && activeTab === 'datetime'">
              <label class="form-label fw-bold d-block mt-4">{{ t('profilePage.preview') }}</label>
              <AppTimePreview
                :zone="theme.default_timezone || 'UTC'"
                :format="theme.default_date_format || 'YYYY-MM-DD'"
              />
            </template>
          </div>
        </template>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the card ends at its own padding : no margin of the last field under it */
:deep(.card-body > .mb-3:last-child),
:deep(.card-body > :last-child > .mb-3:last-child) {
  margin-bottom: 0 !important;
}
/* the page's dropdowns one width, wider than the settings pages' usual one : a date format shows
   its example in full (a date, a time and a zone), the language below it as wide */
.af-interface-field :deep(.input-group),
.af-defaults-wide :deep(.input-group.input-group) {
  max-width: 26rem;
}
/* the space between the settings is theirs above (mt-4) : none of their own below, so the last one
   ends the card as on Profile > Preferences */
.af-interface-field {
  margin-bottom: 0 !important;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
