<script setup>
/******************************************************************/
/*                                                                */
/*  Profile page                                                  */
/*  The signed-in user's account, preferences (language, theme),  */
/*  password and permissions : one view each, picked in the left  */
/*  menu, in the same page layout as the settings pages           */
/*                                                                */
/*  @query:                                                       */
/*      view: account | preferences | password | permissions |    */
/*            token (only for roles with allowApiTokens or        */
/*            extendedTokenExpiration)                            */
/*                                                                */
/******************************************************************/

import { ref, computed, watch, onBeforeUnmount, useId } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router';
import { askToLeave } from '@/lib/unsavedPrompt';
import { useAppStore } from '@/stores/app';
import Theme from '@/lib/Theme';
import Helpers from '@/lib/Helpers';
import TokenStorage from '@/lib/TokenStorage';
import Profile from '@/lib/Profile';
import { languages, fallbackLanguage } from '@/config/languages';
import dayjs from 'dayjs';
import Time, { DATE_FORMATS } from '@/lib/Time';
import { profileViews, profileMenuViews } from '@/config/profileViews';
import { roleOptionGroups, roleOptionDescription, roleOptionLabel, effectiveRoleOption } from '@/config/roles';
import BaseUrl from '@/lib/BaseUrl';
import { neverExpires } from '@/lib/apiTokens';
import { rememberSsoOrigin, ssoSettled, ssoReturning } from '@/lib/ssoReturn';
import { hasPermission } from '@/lib/permission';
import { useRouteTab } from '@/composables/useRouteTab';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import {
  notificationsSupported,
  notificationPermission,
  notificationsActive,
  turnNotificationsOn,
  turnNotificationsOff,
} from '@/lib/jobNotifications';
import BsSwitch from '@/components/BsSwitch.vue';

// INIT

const store = useAppStore();
const route = useRoute();
const router = useRouter();
const { t, te, locale } = useI18n();

// the same swatches as the header's theme switcher
const palette = [
  '#008cba',
  '#0369a1',
  '#1b2a4a',
  '#521ea6',
  '#4a2a8f',
  '#bb1c5e',
  '#b92d34',
  '#c2570c',
  '#198754',
  '#0f766e',
  '#475569',
  '#795548',
];

// the views of the left menu (config/profileViews.js) ; the menu lists them alphabetically, see
// menuViews. The api token's view follows the role options of the store's profile
const VIEWS = profileViews(t, () => store.profile?.options);
// the menu : the views the user may open, alphabetically by their (translated) label, as in
// the designer's menu ; the page opens on the first of them
const menuViews = computed(() => profileMenuViews(VIEWS, locale.value));

// DATA

const themeColor = ref(Theme.getColor());
// the forms page's view : the same cookie the forms page keeps it in, so either place changes it
const formsView = ref(Helpers.getCookie('forms_view_mode') === 'list' ? 'list' : 'tiles');
const password = ref({ currentPassword: '', password: '', password2: '' });
const saving = ref(false);

// the open view, from the address (/profile/<view>) so a view can be linked to ; /profile alone,
// or a view the user may not open, opens the first of the menu, at its own address
const viewFromPath = (v) => (menuViews.value.some((x) => x.name === v) ? v : menuViews.value[0].name);
const currentView = ref(viewFromPath(route.params.view));
watch(
  () => route.params.view,
  (pathView) => {
    currentView.value = viewFromPath(pathView);
    if (pathView !== currentView.value) router.replace(`/profile/${currentView.value}`).catch(() => {});
  },
  { immediate: true },
);

// COMPUTED

const profile = computed(() => store.profile || {});
// the groups read (Profile.load) : the token carries none
const groupsKnown = computed(() => Array.isArray(profile.value.groups));
// the roles to show : every user also carries public, default's name before 7, so that forms still
// listing it match - it is the same role, shown once as default
const shownRoles = computed(() => (profile.value.roles || []).filter((r) => r !== 'public'));
// only local accounts have a password AnsibleForms can change ; ldap, Entra ID and oidc
// passwords are managed by their own provider
const isLocal = computed(() => profile.value.type == 'local');
// the options in their groups, as the role's page shows them (config/roles.js) ; an option the
// server sends that is in no group (a hand-written key) lands in "other", under its own name
const PERMISSION_GROUPS = [
  ...roleOptionGroups.map((g) => ({ name: g.name, title: () => t(g.title), keys: g.keys })),
  { name: 'other', title: () => t('profilePage.groupOther'), keys: [] },
];
const permissionGroups = computed(() => {
  const opts = profile.value.options || {};
  // showExtraVars (capital V) is the server's legacy spelling of showExtravars, listed under
  // jobs : not shown twice
  const grouped = new Set([...PERMISSION_GROUPS.flatMap((g) => g.keys), 'showExtraVars']);
  return (
    PERMISSION_GROUPS.map((g) => {
      const keys = g.keys.filter((k) => k in opts);
      if (g.name === 'other') keys.push(...Object.keys(opts).filter((k) => !grouped.has(k)));
      // what applies (config/roles.js effectiveRoleOption) : an option included in another that is on
      // is allowed, one missing the option it needs is not - and the row says why
      const options = keys.map((k) => {
        const eff = effectiveRoleOption(opts, k);
        const note = eff.includedBy
          ? t('settings.settingsPage.roleOptionIncluded', { option: roleOptionLabel(t, eff.includedBy) })
          : eff.needs
            ? t('settings.settingsPage.roleOptionNeeds', { option: roleOptionLabel(t, eff.needs) })
            : '';
        return {
          key: k,
          description: roleOptionDescription(t, te, k),
          value: eff.value,
          note,
          access: eff.value ? t('profilePage.allowed') : t('profilePage.notAllowed'),
        };
      });
      return { name: g.name, title: g.title(), options, allowed: options.filter((o) => o.value).length };
    })
      .filter((g) => g.options.length)
      // the tabs in alphabetical order of their title, in the user's language ; Other last
      .sort((a, b) => (a.name === 'other') - (b.name === 'other') || a.title.localeCompare(b.title, locale.value))
  );
});

const view = computed(() => VIEWS.find((v) => v.name === currentView.value));
// desktop notifications are offered only to a user who sees its jobs
const mayNotify = computed(() => hasPermission(store.profile?.options, 'showJobs'));
// Preferences in tabs, kept in the address (/profile/preferences/<tab>) : how the app looks (its
// language, theme and forms view), dates and times, and the notifications for a user who sees its jobs
const prefTabs = computed(() => [
  { key: 'appearance', label: t('profilePage.tabAppearance'), icon: 'palette' },
  { key: 'datetime', label: t('profilePage.tabDateTime'), icon: 'clock' },
  ...(mayNotify.value ? [{ key: 'notifications', label: t('profilePage.tabNotifications'), icon: 'bell' }] : []),
]);
// a permission group's table : the option, what it allows (and why it applies or not), whether the
// user has it ; the description searched with its note
const permissionColumns = computed(() => [
  { key: 'key', label: t('profilePage.columnSetting'), keep: true },
  { key: 'description', label: t('profilePage.columnDescription'), value: (o) => `${o.description} ${o.note}` },
  { key: 'access', label: t('profilePage.columnAccess'), keep: true, end: true, class: 'text-end' },
]);
// a permission group's icon : as its place in the app
const PERMISSION_ICONS = { settings: 'gear', designer: 'pen-to-square', jobs: 'history', access: 'user-shield' };
const permissionIcon = (name) => PERMISSION_ICONS[name] || 'ellipsis';
// the open view's tabs : Preferences' ; Password one tab of its own (every settings page a table or
// a page in tabs) ; the others none (cards of their own, or the API token's table)
const viewTabs = computed(() => {
  if (currentView.value === 'preferences') return prefTabs.value;
  if (currentView.value === 'password') return [{ key: 'change', label: t('nav.changePassword'), icon: 'key' }];
  // a tab per group of options, how many of them are allowed beside its name
  if (currentView.value === 'permissions')
    return permissionGroups.value.map((g) => ({
      key: g.name,
      label: g.title,
      icon: permissionIcon(g.name),
      count: `${g.allowed}/${g.options.length}`,
    }));
  return [];
});
const { activeTab: prefTab, tabLink: prefTabLink } = useRouteTab(
  () => viewTabs.value[0]?.key || 'appearance',
  (key) => viewTabs.value.some((x) => x.key === key),
);
// the title's steps on a view in tabs : the view, then its tab
const crumbs = computed(() => {
  if (!viewTabs.value.length) return undefined;
  const tab = viewTabs.value.find((x) => x.key === prefTab.value) || viewTabs.value[0];
  return [
    { title: view.value.label(), icon: view.value.icon, to: prefTabLink(viewTabs.value[0].key) },
    { title: tab.label, icon: tab.icon, to: prefTabLink(tab.key) },
  ];
});
// how the account signs in : a readable name and an icon per login type
const loginType = computed(() => Profile.loginType(t, profile.value.type));

const pageDescription = computed(() =>
  currentView.value === 'password' && !isLocal.value
    ? t('profilePage.description.passwordElsewhere')
    : view.value.description(),
);

const sidebarSections = computed(() => [
  {
    title: '',
    items: menuViews.value.map((v) => ({
      title: v.label(),
      icon: v.icon,
      active: currentView.value === v.name,
      action: () => openView(v.name),
    })),
  },
]);

const passwordError = computed(() => {
  const p = password.value;
  if (p.password2 && p.password !== p.password2) return t('profilePage.mismatch');
  return '';
});
const canSavePassword = computed(() => {
  const p = password.value;
  return p.currentPassword && p.password && p.password === p.password2 && !saving.value;
});

// the api token : a login with the user's password and a longer expiry (the login endpoint's
// expiryDays, honoured for roles with allowApiTokens or extendedTokenExpiration) ; an SSO account has no password
// here, its token is made from this session (#1068), which must have signed in a few minutes ago :
// else the sign-in runs again first, and the token is made on the way back. Shown once ; it ends
// at its expiry, when it is revoked (the list under it), or with a password change or a block.
// The server caps the expiry at API_TOKEN_MAX_DAYS : only the lifetimes up to that cap are offered,
// plus the cap itself, so a longer choice is never silently shortened.
const tokenMaxDays = ref(90);
// a role with extendedTokenExpiration may also make one that never expires ('never')
const canNeverExpire = computed(
  () => !!profile.value?.options?.allowApiTokens && !!profile.value?.options?.extendedTokenExpiration,
);
const TOKEN_LIFETIMES = computed(() => {
  const max = tokenMaxDays.value;
  const list = [30, 90, 180, 365].filter((d) => d <= max);
  if (!list.includes(max)) list.push(max);
  if (canNeverExpire.value) list.push('never');
  return list;
});
// the lifetimes as the select shows them : 90 days ... , Never expires
const lifetimeOptions = computed(() =>
  TOKEN_LIFETIMES.value.map((d) => ({
    value: d,
    label: d === 'never' ? t('apiTokens.neverExpires') : t('profilePage.token.days', { n: d }),
  })),
);
const tokenForm = ref({ days: 90, password: '', name: '' });
axios
  .get('/api/v2/auth/settings')
  .then((result) => {
    const max = parseInt(result.data?.apiTokenMaxDays, 10);
    if (!max) return;
    tokenMaxDays.value = max;
    if (tokenForm.value.days > max) tokenForm.value.days = Math.min(90, max);
  })
  .catch(() => {});
const tokenResult = ref(null);
const creatingToken = ref(false);
// the accounts that sign in with a password here confirm it ; an SSO account signs in again instead
const usesPassword = computed(() => ['local', 'ldap'].includes(profile.value.type));
const canSubmitToken = computed(() => !creatingToken.value && (!usesPassword.value || !!tokenForm.value.password));
// the list under the form, read again once a token is made
const tokensReload = ref(0);
// the token asked for before the sign-in ran again, made on the way back : only right after that
// sign-in, by the same user, a few minutes later at most (an abandoned one is never made later)
const PENDING_TOKEN = 'af_pending_token';
const PENDING_MAX_MS = 5 * 60 * 1000;
// the app's own address, its sub path included when it is hosted under one (BaseUrl) : the
// origin alone pointed the example at the proxy's root, where the api is not
const tokenExample = computed(
  () => `curl -H "Authorization: Bearer $TOKEN" ${window.location.origin}${BaseUrl}/api/v2/job`,
);

// where the token list's toolbar goes (the title line)
const tokenToolsId = `af-token-tools-${useId()}`;
const tokenPagerId = `af-token-pager-${useId()}`;
// the New token wizard : its steps, the one shown, the furthest reached
const tokenDialog = ref(false);
const tokenStep = ref(0);
const tokenReached = ref(0);
const tokenSteps = computed(() => [
  { key: 'token', label: t('profilePage.token.stepToken') },
  { key: 'confirm', label: t('profilePage.token.stepConfirm') },
  { key: 'copy', label: t('profilePage.token.stepCopy') },
]);

/** Opens the wizard on its first step, the form empty. */
function openTokenWizard() {
  tokenResult.value = null;
  tokenForm.value.name = '';
  tokenForm.value.password = '';
  tokenStep.value = 0;
  tokenReached.value = 0;
  tokenDialog.value = true;
}

// a token is named : what it is for, so it is told apart in the list (and revoked as the right one)
const tokenNamed = computed(() => !!tokenForm.value.name.trim());

/**
 * A step of the wizard picked in its stepper. Once a token is shown, going back starts a new
 * token from the first step : the steps behind it still held the form of the token just made
 * (its name cleared, its password gone), and confirming it again made a second token by
 * accident while the first was no longer shown anywhere.
 *
 * Args:
 *   index (number): the step picked.
 */
function goTokenStep(index) {
  if (tokenResult.value && index < 2) {
    openTokenWizard();
    return;
  }
  tokenStep.value = index;
}

/** From the token (name, lifetime) to its confirmation ; only once it is named. */
function nextTokenStep() {
  if (!tokenNamed.value) return;
  tokenStep.value = 1;
  tokenReached.value = Math.max(tokenReached.value, 1);
}

/** Closes the wizard ; a token shown is gone from the page (it was shown once). */
function closeTokenWizard() {
  tokenDialog.value = false;
  tokenResult.value = null;
  tokenForm.value.password = '';
}

function showToken(token) {
  const exp = TokenStorage.decode(token).exp;
  tokenResult.value = {
    token,
    never: neverExpires(exp * 1000),
    expires: Time.format(exp * 1000),
  };
  tokenForm.value.name = '';
  tokensReload.value++;
  // the last step : the token, shown once (also on the way back from an SSO sign-in)
  tokenStep.value = 2;
  tokenReached.value = 2;
  tokenDialog.value = true;
}

async function createToken() {
  if (!canSubmitToken.value) return;
  if (!usesPassword.value) return createTokenFromSession();
  creatingToken.value = true;
  try {
    const query = new URLSearchParams({ expiryDays: tokenForm.value.days });
    if (tokenForm.value.name.trim()) query.set('name', tokenForm.value.name.trim());
    const result = await axios.post(
      `/api/v2/auth/login?${query}`,
      {},
      // the credentials as UTF-8, as the login page sends them (axios' own auth option sends
      // the name as Latin-1)
      { headers: { Authorization: Helpers.basicAuthHeader(profile.value.username, tokenForm.value.password) } },
    );
    const token = result.data?.token;
    if (!token) throw new Error('no token');
    showToken(token);
  } catch (err) {
    // the server's reason (a wrong password, a role without api tokens) when it gave one
    toast.error(
      err?.response
        ? Helpers.parseAxiosResponseError(err, t('profilePage.token.failed'))
        : t('profilePage.token.failed'),
    );
  } finally {
    tokenForm.value.password = '';
    creatingToken.value = false;
  }
}

/**
 * Makes the token from this session ; a sign-in too long ago runs the sign-in again first.
 *
 * Args:
 *   retry (boolean): false on the way back from that sign-in : asked again, it fails instead.
 */
async function createTokenFromSession(retry = true) {
  creatingToken.value = true;
  try {
    const result = await axios.post('/api/v2/profile/tokens', {
      expiryDays: tokenForm.value.days,
      name: tokenForm.value.name.trim(),
    });
    if (!result.data?.token) throw new Error('no token');
    showToken(result.data.token);
  } catch (err) {
    if (retry && err?.response?.status === 403 && err.response.data?.code === 'sign_in_again') {
      signInAgain();
      return;
    }
    toast.error(Helpers.parseAxiosResponseError(err, t('profilePage.token.failedSession')));
  } finally {
    creatingToken.value = false;
  }
}

// through the provider again, back to this page, where the token asked for is made
function signInAgain() {
  try {
    sessionStorage.setItem(
      PENDING_TOKEN,
      JSON.stringify({
        days: tokenForm.value.days,
        name: tokenForm.value.name,
        username: profile.value.username,
        at: Date.now(),
      }),
    );
  } catch {
    // no storage : the user asks again once back
  }
  toast.info(t('profilePage.token.signingInAgain'));
  rememberSsoOrigin('/profile/token');
  const issuer = profile.value.type === 'oidc' ? 'oidc' : 'azuread';
  localStorage.setItem('authIssuer', issuer);
  // reauth : the provider asks for the credentials again (a live provider session would answer
  // without asking), and only that sign-in counts as a recent one
  window.location.replace(`${BaseUrl}/api/v2/auth/${issuer === 'oidc' ? 'oidc' : 'entraid'}?reauth=1`);
}

// back from that sign-in : the token asked for before it
async function resumePendingToken() {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_TOKEN) || 'null');
    sessionStorage.removeItem(PENDING_TOKEN);
  } catch {
    pending = null;
  }
  if (!pending || !ssoReturning || !(Date.now() - Number(pending.at) < PENDING_MAX_MS)) return;
  await ssoSettled();
  // the user the new session is of (the profile may not be read yet)
  if (pending.username !== TokenStorage.getPayload()?.user?.username) return;
  // a number of days, or 'never' (a token that never expires) : kept as it was asked
  if (pending.days === 'never') tokenForm.value.days = 'never';
  else if (Number(pending.days)) tokenForm.value.days = Number(pending.days);
  tokenForm.value.name = String(pending.name || '');
  await createTokenFromSession(false);
}
resumePendingToken();

async function copyToken() {
  try {
    await Helpers.copyToClipboard(tokenResult.value.token);
    toast.success(t('profilePage.token.copied'));
  } catch {
    // no clipboard access (plain http) : the token stays selectable in its box
  }
}

// METHODS

function openView(name) {
  router.replace(`/profile/${name}`).catch(() => {});
}

function setLanguage(code) {
  locale.value = code;
  Helpers.setCookie('af_language', code);
}

function setTheme(theme) {
  if (theme === 'system') {
    Theme.chooseBrowser();
  } else if (theme === 'color') {
    Theme.choose('color');
    Theme.applyColor(themeColor.value);
  } else {
    Theme.clearColor();
    Theme.choose(theme);
  }
  followsBrowser.value = Theme.isFollowingBrowser();
}
// the theme the dropdown shows : Follow the browser while it is followed, else the theme ; the
// header's switch picks a theme of its own, so the browser is no longer followed then
const followsBrowser = ref(Theme.isFollowingBrowser());
watch(
  () => store.theme,
  () => {
    followsBrowser.value = Theme.isFollowingBrowser();
  },
);
const themeChoice = computed(() => (followsBrowser.value ? 'system' : store.theme));

// the time zone the whole app shows dates in (lib/Time.js) : UTC, this browser's zone, or any
const timezone = computed({
  get: () => store.timezone || 'UTC',
  set: (value) => Time.setPreference(value),
});
// the date format dates show in : the app's default until the user picks one (lib/Time.js)
// desktop notifications (lib/jobNotifications.js) : only for a user who sees its jobs ; on once
// the browser allows them, off when it blocks them (the note says how to allow them again)
const canNotify = notificationsSupported();
const notifyOn = ref(notificationsActive());
const notifyBlocked = ref(notificationPermission() === 'denied');
const dateFormat = computed({
  get: () => Time.datePattern(),
  set: (value) => Time.setDateFormat(value),
});
const dateFormats = DATE_FORMATS;
const browserZone = Time.browserZone();
const allZones = Time.zones().filter((z) => z !== 'UTC');
// the time now as AnsibleForms shows it in the picked zone, under the picker : it ticks
// along while the page is open, and follows the picker at once
const now = ref(new Date());
const nowTimer = setInterval(() => (now.value = new Date()), 30000);
onBeforeUnmount(() => clearInterval(nowTimer));
// a color still hovered when the page goes : the user's theme again
onBeforeUnmount(() => Theme.endPreview());

function setFormsView(mode) {
  formsView.value = mode;
  Helpers.setCookie('forms_view_mode', mode, 365);
}

// ─── preferences : searched ───────────────────────────────────────────────────
// a word typed in the title line's search : the tabs set aside, each setting whose label or help
// has it shown under its tab's name, as on Settings > Appearance > Defaults
const prefSearch = ref('');
const prefSearching = computed(() => !!prefSearch.value.trim());
const PREF_GROUPS = {
  appearance: ['language', 'theme', 'forms'],
  datetime: ['timezone', 'date', 'preview'],
  notifications: ['notify'],
};
const prefTexts = computed(() => ({
  language: [t('profilePage.language'), t('profilePage.languageHint')],
  theme: [t('profilePage.theme'), t('profilePage.themeHint')],
  forms: [t('profilePage.formsView'), t('profilePage.formsViewHint')],
  timezone: [t('profilePage.timezone'), t('profilePage.timezoneHint')],
  date: [t('profilePage.dateFormat'), t('profilePage.dateFormatHint')],
  preview: [t('profilePage.preview')],
  notify: [t('profilePage.notifications'), t('profilePage.notificationsHint')],
}));
function prefMatches(key) {
  const q = prefSearch.value.trim().toLowerCase();
  return !q || prefTexts.value[key].some((x) => String(x).toLowerCase().includes(q));
}
// a tab's settings shown now : searching, those that match ; else its own, when it is open
const prefGroupShown = (group) =>
  prefSearching.value
    ? PREF_GROUPS[group].filter((k) => prefMatches(k))
    : prefTab.value === group
      ? PREF_GROUPS[group]
      : [];
const prefShown = (key) => Object.keys(PREF_GROUPS).some((g) => prefGroupShown(g).includes(key));
// the room above a setting : none above the first one shown in its tab
const prefSpaced = (key) => {
  const group = Object.keys(PREF_GROUPS).find((g) => PREF_GROUPS[g].includes(key));
  return prefGroupShown(group)[0] !== key;
};
// searching : the tabs with a match (Notifications only for a user who sees its jobs)
const prefHeads = computed(() =>
  Object.keys(PREF_GROUPS).filter((g) => (g !== 'notifications' || mayNotify.value) && prefGroupShown(g).length),
);

// ─── preferences : a draft, saved by Save ─────────────────────────────────────
// What the user picks is a draft until Save, as on every settings page : then each is applied
// and kept in this browser (the language and forms view in cookies, the theme, zone, date format
// and notifications in its storage). Leaving with a change unsaved asks first.
function currentPreferences() {
  return {
    language: locale.value,
    theme: themeChoice.value,
    color: themeColor.value,
    formsView: formsView.value,
    timezone: store.timezone || 'UTC',
    dateFormat: Time.datePattern(),
    notify: notifyOn.value,
  };
}
const draft = ref(currentPreferences());
const savedPrefs = ref(currentPreferences());
const prefsDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(savedPrefs.value));
const draftLanguage = computed(() => languages.find((l) => l.code === draft.value.language) || fallbackLanguage);
// changed elsewhere meanwhile (the header's theme or language) : read again, when nothing is unsaved
watch([() => store.theme, locale], () => {
  if (prefsDirty.value) return;
  draft.value = currentPreferences();
  savedPrefs.value = currentPreferences();
});

/**
 * Applies the draft : each preference changed is set and kept in this browser ; the
 * notifications ask the browser first, the first time (refused, they stay off).
 */
async function savePreferences() {
  const d = draft.value;
  const was = savedPrefs.value;
  if (d.language !== was.language) setLanguage(d.language);
  if (d.theme !== was.theme || (d.theme === 'color' && d.color !== was.color)) {
    themeColor.value = d.color;
    setTheme(d.theme);
  }
  if (d.formsView !== was.formsView) setFormsView(d.formsView);
  if (d.timezone !== was.timezone) timezone.value = d.timezone;
  if (d.dateFormat !== was.dateFormat) dateFormat.value = d.dateFormat;
  if (d.notify !== was.notify) {
    if (d.notify) {
      const answer = await turnNotificationsOn();
      notifyOn.value = answer === 'granted';
      notifyBlocked.value = answer === 'denied';
    } else {
      turnNotificationsOff();
      notifyOn.value = false;
    }
  }
  draft.value = currentPreferences();
  savedPrefs.value = currentPreferences();
  toast.success(t('profilePage.preferencesSaved'));
}
useUnsavedGuard(prefsDirty, savePreferences);
// another view of the profile (its menu) is the same page to the router : asked there too
onBeforeRouteUpdate((to, from) => {
  if (from.params.view !== 'preferences' || to.params.view === 'preferences' || !prefsDirty.value) return true;
  return askToLeave(savePreferences, () => prefsDirty.value);
});

// ─── account and permissions : searched ───────────────────────────────────────
// a word typed in the title line's search narrows the view : the account's rows by their label or
// a value (a group, a role, an LDAP or SSO group's whole name), the permissions by their option,
// description or note ; another view starts with none
const viewSearch = ref('');
const viewSearching = computed(() => !!viewSearch.value.trim());
watch(currentView, () => {
  viewSearch.value = '';
  prefSearch.value = '';
});
const hit = (...texts) => {
  const q = viewSearch.value.trim().toLowerCase();
  return (
    !q ||
    texts.some((x) =>
      String(x ?? '')
        .toLowerCase()
        .includes(q),
    )
  );
};
// the account's rows : each shown when its label or one of its values has the word ; a row of
// several values (groups, roles) keeps only those that have it, unless its label does
const accountRows = computed(() => {
  const groups = groupsKnown.value ? profile.value.groups : [];
  const many = (label, values) => (hit(label) ? values : values.filter((v) => hit(v)));
  return {
    username: hit(t('profilePage.username'), profile.value.username),
    loginType: hit(t('profilePage.loginType'), loginType.value.label),
    groups: hit(t('profilePage.groups')) || groups.some((g) => hit(g)),
    shownGroups: many(t('profilePage.groups'), groups),
    roles: hit(t('profilePage.roles')) || shownRoles.value.some((r) => hit(r)),
    shownRolesFiltered: many(t('profilePage.roles'), shownRoles.value),
  };
});
const accountNone = computed(
  () =>
    viewSearching.value &&
    !accountRows.value.username &&
    !accountRows.value.loginType &&
    !accountRows.value.groups &&
    !accountRows.value.roles,
);
// the permission groups with a row that matches, as their tables filter them (AppLinkedTable : a
// row by its cells)
const shownPermissionGroups = computed(() =>
  permissionGroups.value.filter((g) => g.options.some((o) => hit(o.key, o.description, o.note, o.access))),
);

async function changePassword() {
  if (!canSavePassword.value) return;
  saving.value = true;
  try {
    await axios.put(`/api/v2/profile`, password.value);
    // a new password ends every session of the user, this one too : sign in again with it
    toast.success(t('profilePage.changedSignIn'));
    password.value = { currentPassword: '', password: '', password2: '' };
    TokenStorage.clear();
    router.push({ name: '/login' });
  } catch (err) {
    // the server's reason (the password policy, a wrong current password) rather than the status
    toast.error(Helpers.parseAxiosResponseError(err, t('profilePage.changeFailed')));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <BsSidebar :sections="sidebarSections" storageKey="af_profile_sidebar_collapsed" />
      <!-- account, preferences and permissions lay out cards of their own ; password and the api
           token sit in the page's card -->
      <AppSettings
        :title="view.label()"
        :icon="view.icon"
        :description="pageDescription"
        :crumbs="crumbs"
        :bare="currentView === 'account'"
      >
        <!-- Preferences' tabs, Password's one, above the page's card -->
        <template
          v-if="
            viewTabs.length &&
            !(currentView === 'preferences' && prefSearching) &&
            !(currentView === 'permissions' && viewSearching)
          "
          #tabs
        >
          <ul class="nav nav-tabs mb-0">
            <li v-for="tab in viewTabs" :key="tab.key" class="nav-item">
              <a class="nav-link" :class="{ active: prefTab === tab.key }" href="#" @click.prevent="prefTab = tab.key">
                <FaIcon :icon="tab.icon" class="me-1" />
                {{ tab.label }}
                <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
              </a>
            </li>
          </ul>
        </template>
        <!-- ===================== account ===================== -->
        <template v-if="currentView === 'account'">
          <div class="card">
            <!-- who : the person's name when the sign-in brought one (ldap, Entra ID, openid
                 connect), else the username - the username itself is a row below. Styled like
                 the permissions tables' headers, without a border-bottom of its own : the list
                 group under it draws that line (a list group in a card takes the card's border
                 on top), so both would double it -->
            <div class="card-body d-flex align-items-center af-identity py-2">
              <span class="fw-semibold text-truncate">{{ profile.displayName || profile.username }}</span>
            </div>
            <!-- the details : a label column and its values, one row each -->
            <ul class="list-group list-group-flush">
              <li v-show="accountRows.username" class="list-group-item af-detail">
                <span class="af-detail-label">{{ t('profilePage.username') }}</span>
                <span class="af-detail-value">{{ profile.username }}</span>
              </li>
              <li v-show="accountRows.loginType" class="list-group-item af-detail">
                <span class="af-detail-label">{{ t('profilePage.loginType') }}</span>
                <span class="af-detail-value"
                  ><FaIcon :icon="loginType.icon" class="text-body-secondary" style="margin-right: 0.2rem" />{{
                    loginType.label
                  }}</span
                >
              </li>
              <li v-show="accountRows.groups" class="list-group-item af-detail">
                <span class="af-detail-label"
                  >{{ t('profilePage.groups') }}
                  <span v-if="groupsKnown" class="af-count">{{ profile.groups.length }}</span></span
                >
                <!-- the groups are read from the server (the token does not carry them) : a grey bar
                     until then, rather than "none yet" -->
                <span v-if="!groupsKnown" class="af-detail-value"><AppSkeleton shape="inline" width="7rem" /></span>
                <span v-else class="af-detail-value">
                  <span v-for="g in accountRows.shownGroups" :key="g" class="badge af-chip"
                    ><FaIcon icon="users" class="me-1" />{{ g }}</span
                  >
                  <span v-if="!profile.groups.length" class="text-body-secondary">{{ t('profilePage.noneYet') }}</span>
                </span>
              </li>
              <li v-show="accountRows.roles" class="list-group-item af-detail">
                <span class="af-detail-label"
                  >{{ t('profilePage.roles') }} <span class="af-count">{{ shownRoles.length }}</span></span
                >
                <span class="af-detail-value">
                  <span v-for="r in accountRows.shownRolesFiltered" :key="r" class="badge af-chip"
                    ><FaIcon icon="user-shield" class="me-1" />{{ r }}</span
                  >
                  <span v-if="!shownRoles.length" class="text-body-secondary">{{ t('profilePage.noneYet') }}</span>
                </span>
              </li>
              <li v-if="accountNone" class="list-group-item text-body-secondary fst-italic">
                {{ t('settings.settingsPage.searchNone') }}
              </li>
            </ul>
          </div>
        </template>

        <!-- ===================== preferences ===================== -->
        <template v-else-if="currentView === 'preferences'">
          <!-- Appearance (the language, the theme, the forms view), Date and time (the zone, the date
               format, the time now in them), Notifications : the open tab ; searching, the matches
               of all, each under its tab's name, as on Settings > General -->
          <div v-if="prefGroupShown('appearance').length">
            <template v-if="prefSearching">
              <hr v-if="prefHeads[0] !== 'appearance'" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': prefHeads[0] === 'appearance' }"
              >
                <FaIcon :icon="viewTabs.find((x) => x.key === 'appearance').icon" class="me-1" />{{
                  viewTabs.find((x) => x.key === 'appearance').label
                }}
              </h6>
            </template>
            <div v-show="prefShown('language')" :class="{ 'mt-4': prefSpaced('language') }">
              <label class="form-label fw-bold">{{ t('profilePage.language') }}</label>
              <div class="input-group af-field">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="language" /></span>
                <button
                  class="form-select d-flex align-items-center gap-2 text-start"
                  type="button"
                  data-bs-toggle="dropdown"
                  aria-expanded="false"
                  :aria-label="t('profilePage.language')"
                >
                  <AppFlag :code="draftLanguage.code" />{{ draftLanguage.label }}
                </button>
                <ul class="dropdown-menu w-100">
                  <li v-for="lang in languages" :key="lang.code">
                    <button
                      type="button"
                      class="dropdown-item d-flex align-items-center gap-2"
                      :class="{ active: draft.language === lang.code }"
                      @click="draft.language = lang.code"
                    >
                      <AppFlag :code="lang.code" />{{ lang.label }}
                    </button>
                  </li>
                </ul>
              </div>
              <div class="form-text">{{ t('profilePage.languageHint') }}</div>
            </div>
            <div v-show="prefShown('theme')" :class="{ 'mt-4': prefSpaced('theme') }">
              <label class="form-label fw-bold">{{ t('profilePage.theme') }}</label>
              <div class="input-group af-field">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="palette" /></span>
                <select
                  class="form-select"
                  :value="draft.theme"
                  :aria-label="t('profilePage.theme')"
                  @change="draft.theme = $event.target.value"
                >
                  <option value="system">{{ t('settings.settingsPage.themeSystem') }}</option>
                  <option v-for="th in Theme.themes()" :key="th.value" :value="th.value">{{ th.title }}</option>
                </select>
              </div>
              <div v-if="draft.theme === 'color'" class="af-palette mt-3">
                <button
                  v-for="c in palette"
                  :key="c"
                  type="button"
                  class="af-swatch"
                  :class="{ active: draft.color === c }"
                  :style="{ backgroundColor: c }"
                  :aria-label="c"
                  @click="draft.color = c"
                  @mouseenter="Theme.previewColor(c)"
                  @mouseleave="Theme.endPreview()"
                  @focus="Theme.previewColor(c)"
                  @blur="Theme.endPreview()"
                >
                  <FaIcon v-if="draft.color === c" icon="check" />
                </button>
              </div>
              <div class="form-text">{{ t('profilePage.themeHint') }}</div>
            </div>
            <div v-show="prefShown('forms')" :class="{ 'mt-4': prefSpaced('forms') }">
              <label class="form-label fw-bold">{{ t('profilePage.formsView') }}</label>
              <div class="input-group af-field">
                <span class="input-group-text text-gray-500"
                  ><FaIcon :fixedwidth="true" icon="table-cells-large"
                /></span>
                <select
                  class="form-select"
                  :value="draft.formsView"
                  :aria-label="t('profilePage.formsView')"
                  @change="draft.formsView = $event.target.value"
                >
                  <option value="tiles">{{ t('forms.tiles') }}</option>
                  <option value="list">{{ t('forms.list') }}</option>
                </select>
              </div>
              <div class="form-text">{{ t('profilePage.formsViewHint') }}</div>
            </div>
          </div>
          <div v-if="prefGroupShown('datetime').length">
            <template v-if="prefSearching">
              <hr v-if="prefHeads[0] !== 'datetime'" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': prefHeads[0] === 'datetime' }"
              >
                <FaIcon :icon="viewTabs.find((x) => x.key === 'datetime').icon" class="me-1" />{{
                  viewTabs.find((x) => x.key === 'datetime').label
                }}
              </h6>
            </template>
            <div v-show="prefShown('timezone')" :class="{ 'mt-4': prefSpaced('timezone') }">
              <label class="form-label fw-bold">{{ t('profilePage.timezone') }}</label>
              <div class="input-group af-field">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="clock" /></span>
                <select v-model="draft.timezone" class="form-select" :aria-label="t('profilePage.timezone')">
                  <option value="UTC">UTC</option>
                  <option value="browser">{{ t('profilePage.timezoneBrowser', { zone: browserZone }) }}</option>
                  <optgroup :label="t('profilePage.timezoneAll')">
                    <option v-for="z in allZones" :key="z" :value="z">{{ z }}</option>
                  </optgroup>
                </select>
              </div>
              <div class="form-text">{{ t('profilePage.timezoneHint') }}</div>
            </div>
            <div v-show="prefShown('date')" :class="{ 'mt-4': prefSpaced('date') }">
              <label class="form-label fw-bold">{{ t('profilePage.dateFormat') }}</label>
              <div class="input-group af-field">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="calendar" /></span>
                <select v-model="draft.dateFormat" class="form-select" :aria-label="t('profilePage.dateFormat')">
                  <option v-for="f in dateFormats" :key="f" :value="f">{{ dayjs(now).format(f) }} ({{ f }})</option>
                </select>
              </div>
              <div class="form-text">{{ t('profilePage.dateFormatHint') }}</div>
            </div>
            <div v-show="prefShown('preview')" :class="{ 'mt-4': prefSpaced('preview') }">
              <label class="form-label fw-bold d-block">{{ t('profilePage.preview') }}</label>
              <AppTimePreview :zone="draft.timezone" :format="draft.dateFormat" />
            </div>
          </div>
          <div v-if="mayNotify && prefGroupShown('notifications').length">
            <template v-if="prefSearching">
              <hr v-if="prefHeads[0] !== 'notifications'" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': prefHeads[0] === 'notifications' }"
              >
                <FaIcon :icon="viewTabs.find((x) => x.key === 'notifications').icon" class="me-1" />{{
                  viewTabs.find((x) => x.key === 'notifications').label
                }}
              </h6>
            </template>
            <div v-show="prefShown('notify')" :class="{ 'mt-4': prefSpaced('notify') }">
              <label class="form-label fw-bold d-block" for="af-job-notifications">{{
                t('profilePage.notifications')
              }}</label>
              <BsSwitch
                id="af-job-notifications"
                :model-value="draft.notify"
                :disabled="!canNotify"
                @change="draft.notify = $event.target.checked"
                class="mb-0"
              />
              <div class="form-text">
                {{
                  !canNotify
                    ? t('profilePage.notificationsUnsupported')
                    : notifyBlocked
                      ? t('profilePage.notificationsBlocked')
                      : t('profilePage.notificationsHint')
                }}
              </div>
            </div>
          </div>
          <div v-if="prefSearching && !prefHeads.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </template>

        <!-- ===================== password ===================== -->
        <template v-else-if="currentView === 'password'">
          <form
            v-if="isLocal"
            class="af-field"
            @submit.prevent="changePassword"
            @keydown.enter.prevent="changePassword"
          >
            <div class="mb-3">
              <label class="form-label fw-bold" for="af-current-password">{{ t('profilePage.currentPassword') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="lock" /></span>
                <input
                  id="af-current-password"
                  v-model="password.currentPassword"
                  type="password"
                  class="form-control"
                  autocomplete="current-password"
                />
              </div>
            </div>
            <div class="mb-3">
              <label class="form-label fw-bold" for="af-new-password">{{ t('profilePage.newPassword') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
                <input
                  id="af-new-password"
                  v-model="password.password"
                  type="password"
                  class="form-control"
                  autocomplete="new-password"
                />
              </div>
            </div>
            <div>
              <label class="form-label fw-bold" for="af-confirm-password">{{ t('profilePage.confirmPassword') }}</label>
              <div class="input-group has-validation">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="check-double" /></span>
                <input
                  id="af-confirm-password"
                  v-model="password.password2"
                  type="password"
                  class="form-control"
                  :class="{ 'is-invalid': passwordError }"
                  autocomplete="new-password"
                />
                <div class="invalid-feedback">{{ passwordError }}</div>
              </div>
            </div>
          </form>
          <p v-else class="text-body-secondary mb-0">
            <FaIcon icon="circle-info" class="me-2" />{{ t('profilePage.elsewhere', { type: loginType.label }) }}
          </p>
        </template>

        <!-- ===================== permissions ===================== -->
        <!-- a tab per group, its options' table : each option's key, what it allows, whether the
             user has it ; searching, the matching options of every group, each under its name -->
        <template v-else-if="currentView === 'permissions'">
          <template v-for="(group, gi) in shownPermissionGroups" :key="group.name">
            <div v-if="viewSearching || group.name === prefTab">
              <template v-if="viewSearching">
                <hr v-if="gi > 0" class="mt-4 mb-0 af-search-line" />
                <h6 class="fw-bold text-body-secondary af-search-tab" :class="{ 'af-search-first': gi === 0 }">
                  <FaIcon :icon="permissionIcon(group.name)" class="me-1" />{{ group.title }}
                </h6>
              </template>
              <!-- the app's read-only table (AppLinkedTable) : its frame, header and columns ; the
                   page's search narrows it -->
              <AppLinkedTable
                :search="viewSearch"
                :columns="permissionColumns"
                :rows="group.options"
                rowKey="key"
                :exportName="`permissions-${group.name}`"
              >
                <template #cell-key="{ row }">
                  <code class="af-option-key">{{ row.key }}</code>
                </template>
                <template #cell-description="{ row }">
                  <span :class="row.value ? '' : 'text-body-secondary'">{{ row.description }}</span>
                  <div v-if="row.note" class="small text-body-secondary">{{ row.note }}</div>
                </template>
                <template #cell-access="{ row }">
                  <span class="badge rounded-pill af-pill" :class="row.value ? 'af-pill-green' : 'af-pill-grey'">
                    <FaIcon :icon="row.value ? 'check' : 'xmark'" class="me-1" />{{ row.access }}
                  </span>
                </template>
              </AppLinkedTable>
            </div>
          </template>
          <div v-if="viewSearching && !shownPermissionGroups.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </template>

        <!-- ===================== api token ===================== -->
        <template v-else-if="currentView === 'token'">
          <!-- the tokens made, each to revoke ; New token (top right) opens the wizard -->
          <AppApiTokens
            url="/api/v2/profile/tokens"
            :reload="tokensReload"
            :toolbarTo="'#' + tokenToolsId"
            :pagerTo="'#' + tokenPagerId"
          />
          <!-- the wizard : the token (its name and lifetime), the confirmation (the password, or a
               sign-in again for an SSO account), then the token itself, shown once -->
          <BsModal v-if="tokenDialog" size="lg" icon="code" :footerClose="false" @close="closeTokenWizard">
            <template #title>{{ t('profilePage.token.new') }}</template>
            <!-- its steps, above the fields and out of their scroll -->
            <template #top>
              <AppWizardSteps :steps="tokenSteps" :current="tokenStep" :reached="tokenReached" @go="goTokenStep" />
            </template>
            <template #default>
              <div v-if="tokenStep === 2 && tokenResult">
                <label class="form-label fw-semibold" for="af-token">{{
                  tokenResult.never
                    ? t('profilePage.token.createdNever')
                    : t('profilePage.token.created', { date: tokenResult.expires })
                }}</label>
                <div class="input-group mb-2">
                  <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
                  <input
                    id="af-token"
                    class="form-control font-monospace"
                    :value="tokenResult.token"
                    readonly
                    @focus="$event.target.select()"
                  />
                  <button type="button" class="btn btn-outline-primary" @click="copyToken">
                    <FaIcon icon="copy" class="me-1" />{{ t('profilePage.token.copy') }}
                  </button>
                </div>
                <div class="alert alert-warning d-flex align-items-start gap-2 py-2 mb-4">
                  <FaIcon icon="triangle-exclamation" class="mt-1" /><span>{{ t('profilePage.token.once') }}</span>
                </div>
                <p class="mb-2 text-body-secondary">{{ t('profilePage.token.example') }}</p>
                <pre class="af-token-example mb-4"><code>{{ tokenExample }}</code></pre>
              </div>
              <!-- the request : a lifetime and the password -->
              <!-- its fields as every dialog's : the name above the field, bold, the help under it -->
              <div v-else-if="tokenStep === 0">
                <BsInput
                  v-model="tokenForm.name"
                  :isFloating="false"
                  type="text"
                  icon="tag"
                  :required="true"
                  :label="t('profilePage.token.name')"
                  :help="t('profilePage.token.nameHint')"
                  @keyup_enter="nextTokenStep"
                />
                <BsInput
                  v-model="tokenForm.days"
                  :isFloating="false"
                  type="select"
                  icon="hourglass-half"
                  :required="true"
                  :values="lifetimeOptions"
                  valueKey="value"
                  labelKey="label"
                  :label="t('profilePage.token.lifetime')"
                  :help="t('profilePage.token.lifetimeHint')"
                />
              </div>
              <form v-else class="af-field" @submit.prevent="createToken" @keydown.enter.prevent="createToken">
                <p v-if="!usesPassword" class="text-body-secondary mb-0">
                  <FaIcon icon="circle-info" class="me-2" />{{
                    t('profilePage.token.signInAgainHint', { type: loginType.label })
                  }}
                </p>
                <BsInput
                  v-else
                  v-model="tokenForm.password"
                  :isFloating="false"
                  type="password"
                  icon="lock"
                  :required="true"
                  :label="t('profilePage.token.password')"
                  :help="t('profilePage.token.passwordHint')"
                  @keyup_enter="createToken"
                />
              </form>
            </template>
            <template #footer>
              <BsButton v-if="tokenStep === 1" icon="arrow-left" @click="tokenStep = 0">{{
                t('common.previous')
              }}</BsButton>
              <BsButton
                v-if="tokenStep === 0"
                icon="arrow-right"
                :colorClass="tokenNamed ? 'primary' : 'secondary'"
                :disabled="!tokenNamed"
                @click="nextTokenStep"
                >{{ t('common.next') }}</BsButton
              >
              <BsButton
                v-if="tokenStep === 1"
                icon="code"
                :colorClass="canSubmitToken ? 'primary' : 'secondary'"
                :disabled="!canSubmitToken"
                @click="createToken"
                >{{ t('profilePage.token.create') }}</BsButton
              >
              <BsButton icon="times" @click="closeTokenWizard">{{ t('common.close') }}</BsButton>
            </template>
          </BsModal>
        </template>

        <!-- the view's action, where the settings pages put their Save button : below the card,
             on the right, grey until the form can be sent, then the accent color -->
        <!-- the token list's pager, under the card as on the other lists -->
        <template v-if="currentView === 'token'" #footer>
          <div :id="tokenPagerId"></div>
        </template>
        <!-- the token list's search and buttons, on the title line as on the other lists -->
        <template v-if="currentView === 'preferences'" #headerActions>
          <BsSearch v-model="prefSearch" />
        </template>
        <template v-else-if="currentView === 'account' || currentView === 'permissions'" #headerActions>
          <BsSearch v-model="viewSearch" />
        </template>
        <template v-else-if="currentView === 'token'" #headerActions>
          <div :id="tokenToolsId" class="af-title-flow"></div>
        </template>
        <template v-if="currentView === 'preferences'" #actions>
          <BsButton icon="save" :disabled="!prefsDirty" @click="savePreferences">{{
            t('settings.common.save')
          }}</BsButton>
        </template>
        <template v-else-if="(currentView === 'password' && isLocal) || currentView === 'token'" #actions>
          <BsButton
            v-if="currentView === 'password'"
            icon="key"
            :colorClass="canSavePassword ? 'primary' : 'secondary'"
            :disabled="!canSavePassword"
            @click="changePassword"
            >{{ t('profilePage.change') }}</BsButton
          >
          <BsButton v-else icon="plus" @click="openTokenWizard">{{ t('profilePage.token.new') }}</BsButton>
        </template>
      </AppSettings>
    </main>
  </div>
</template>

<style scoped lang="scss">
/* a tab's count (a permission group's allowed of all), as a user's page's tabs */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
// the identity band at the top of the account card
/* the line under the account's header : a table's light line (the list under it takes the card's
   darker border on top otherwise) */
.af-identity + .list-group {
  border-top-color: var(--bs-border-color);
}
/* a card's header (the account's name, a permission group's name and count) : as tall as a table's
   header (py-2 on it), its grey */
.af-identity {
  padding: 1.25rem;
  background-color: var(--bs-tertiary-bg);
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
}
// a detail row : the label in a fixed column, the value next to it
// every row as high as one with chips (3.5rem), whatever it holds ; more chips than fit
// wrap and make that row taller only then. The label and the first line of values share
// one line height (a chip's), and the row aligns them at its top : with many groups or
// roles, the label stays on the first line instead of drifting to the middle of the row.
$af-detail-line: 1.8rem;
.af-detail {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  min-height: 3.5rem;
  // the padding leaves room for the row's 1px bottom border, so a one-line row is 3.5rem
  padding: calc((3.5rem - #{$af-detail-line} - 1px) / 2) 1.25rem;
}
.af-detail-label {
  flex: 0 0 11rem;
  line-height: $af-detail-line;
  color: var(--bs-secondary-color);
  font-weight: 500;
}
.af-detail-value {
  flex: 1 1 auto;
  min-width: 0;
  min-height: $af-detail-line;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  // the chips are spaced by the gap here, not by their own margin
  .af-chip {
    margin: 0;
  }
}
.af-count {
  display: inline-block;
  // its own line height : the label's (a chip's) would make the count taller than the line
  line-height: 1.5;
  min-width: 1.4rem;
  margin-left: 0.35rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  font-size: 0.75rem;
  text-align: center;
  background-color: var(--bs-secondary-bg);
}
.af-chip {
  font-size: 0.85rem;
  font-weight: 500;
  margin: 0 0.35rem 0.35rem 0;
  padding: 0.45em 0.8em;
  color: var(--bs-body-color);
  background-color: var(--bs-secondary-bg);
  border: 1px solid var(--bs-border-color);
}

// one width for the fields of every view (password, api token, preferences) ; in a form (and
// the New token wizard's details) only its fields have that width, so their help text below can
// use the whole width, as in the preferences cards
.af-field {
  max-width: 480px;
}
form.af-field,
.af-field.af-field-help-wide {
  max-width: none;
  .input-group {
    max-width: 480px;
  }
}
.af-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 420px;
}
// round, as the header's theme menu (components/BsThemeSwitcher.vue)
.af-swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: #ffffff;
  font-size: 0.65rem;
  transition:
    transform 0.15s,
    border-color 0.15s;
  &:hover {
    transform: scale(1.2);
  }
  &.active {
    border-color: var(--bs-body-color);
    box-shadow: 0 0 0 2px var(--bs-body-bg);
  }
  svg {
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.5));
  }
}

// a card holding a table : the table is clipped to the card's rounded corners, which its
// own background would otherwise cover (the side borders then stopped short of the bottom)
.af-table-card {
  overflow: hidden;
}
// permissions : the option key under its readable name, and the allowed / not allowed pill
.af-option-key {
  font-size: 0.75rem;
  color: var(--bs-secondary-color);
}
.af-pill {
  flex-shrink: 0;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.4em 0.75em;
}
// the curl example under a new token
.af-token-example {
  padding: 0.75rem 1rem;
  border-radius: var(--bs-border-radius);
  background-color: var(--bs-tertiary-bg);
  border: 1px solid var(--bs-border-color);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
