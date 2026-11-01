<script setup>
/******************************************************************/
/*                                                                */
/*  App AnsibleForms Nav component                                */
/*  Contains the top navigation bar                               */
/*                                                                */
/******************************************************************/

import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useAppStore } from '@/stores/app';
import { settingsMenu } from '@/lib/settingsMenu';
import { mayOpen } from '@/lib/routePermission';
import { useI18n } from 'vue-i18n';
import Theme from '@/lib/Theme';
import Helpers from '@/lib/Helpers';
import State from '@/lib/State';
import Profile from '@/lib/Profile';
import { languages, fallbackLanguage } from '@/config/languages';

// INIT
const store = useAppStore();
const { t, locale } = useI18n();

function setLanguage(code) {
  locale.value = code;
  Helpers.setCookie('af_language', code);
}

// ENV-BASED HOME MENU LABEL/ICON

import axios from 'axios';
import Time from '@/lib/Time';
import { useLiveEvent } from '@/composables/useLiveEvent';
import { jobsPath } from '@/lib/jobsPath';
import { iconOrDefault } from '@/lib/iconName';
import { useRouter } from 'vue-router';
import { followJobNotifications } from '@/lib/jobNotifications';

onMounted(async () => {
  try {
    const res = await axios.get('/api/v2/app/config');
    // the switches, the name, the label, the announcement and the default language
    // (State.applyAppConfig)
    State.applyAppConfig(res.data || {});
    if (res.data?.defaultTheme) {
      Theme.applyServerDefault(res.data.defaultTheme, res.data.defaultThemeColor);
      currentTheme.value = store.theme;
    }
  } catch (e) {
    // fallback to defaults if API fails
    console.error('Failed to fetch app config:', e);
  }
});

// the banner's reload : the new index.html (served no-cache) brings the new bundle
function reloadPage() {
  window.location.reload();
}

// how the signed-in account signs in, shown under its name in the user menu
const loginType = computed(() => Profile.loginType(t, store.profile?.type));
// the person's name when the sign-in brought one (ldap, microsoft entra id, openid connect),
// else the username ; with a name shown, the username goes on the line under it, and how the
// account signs in on a line of its own under that
const displayName = computed(() => store.profile?.displayName || store.profile?.username || '');
const userSubname = computed(() => (store.profile?.displayName ? store.profile.username : ''));

// the approvals bell : the count is loaded when the header appears (also right after a
// login, which used to leave it at 0 until a reload), and again whenever the jobs change
// (lib/liveEvents.js) - a request for approval shows up as it is made
function refreshApprovals() {
  State.refreshApprovals().catch(() => {
    // not logged in (any more) or the server is down : the next page load tells
  });
}
useLiveEvent('jobs', refreshApprovals);
// and the RTEs waiting for approval : again whenever the runners change (one asked to join,
// was approved or rejected)
function refreshRunnerApprovals() {
  State.refreshRunnerApprovals().catch(() => {});
}
useLiveEvent('runners', refreshRunnerApprovals);
onMounted(refreshRunnerApprovals);
watch(() => store.profile, refreshRunnerApprovals);
// the bell : jobs and runners waiting for approval. One kind waiting (or none) : the bell opens its
// page ; both : a menu with each and its count
const bellItems = computed(() =>
  [
    store.approvals > 0 && {
      key: 'jobs',
      label: t('nav.jobsWaiting'),
      icon: 'list-check',
      count: store.approvals,
      to: jobsPath('approve'),
    },
    store.runnerApprovals > 0 && {
      key: 'runners',
      label: t('nav.runnersWaiting'),
      icon: 'rocket',
      count: store.runnerApprovals,
      to: '/settings/runners',
    },
  ].filter(Boolean),
);
const bellCount = computed(() => bellItems.value.reduce((n, i) => n + i.count, 0));
const bellLink = computed(() => (bellItems.value.length === 1 ? bellItems.value[0] : null));
const bellTitle = computed(() => (bellLink.value ? bellLink.value.label : t('jobs.menu.approve')));
// desktop notifications, when turned on in Profile > Preferences : the user's jobs that end, the
// jobs that wait for its approval (lib/jobNotifications.js), on every page with the header
const router = useRouter();
let stopJobNotifications = null;
onMounted(() => {
  stopJobNotifications = followJobNotifications({ t, router, store });
});
onBeforeUnmount(() => stopJobNotifications?.());
// the designer lock taken or released : the lock on the Designer link follows at once
useLiveEvent('designer', () => State.refreshDesignerLock());
// Settings > Appearance saved (here, in another tab, by another admin) : the announcement, the
// label, the name and the Designer link follow at once
useLiveEvent('appearance', () => {
  State.loadAppConfig();
  State.loadHeaderLinks();
});
// the designer lock on the Designer link, once a minute (the designer page itself refreshes
// it every few seconds while it is open) ; and Settings > Appearance once a minute too, so an
// open tab gets a new announcement and drops one whose end has passed (the server stops
// sending it), as the label and the name changed meanwhile
let lockTimer = null;
let configTimer = null;

// ─── the primary links : centred, after the logo, or their icons only ────────
// Centred in the bar on a wide screen ; but the logo and its environment label on the left, the
// own links menu and the buttons on the right change what fits. Measured : centred when they
// clear the logo and the buttons by 16 px ; else after the logo, closer together when needed ;
// else only their icons (their names as tooltips) - never under the buttons, never pushing them
// out.
const primaryNav = ref(null);
const navFit = ref('flow'); // 'centred', 'flow', 'tight' or 'compact'
const FIT_CLASSES = { centred: 'af-nav-centred', tight: 'af-nav-tight', compact: 'af-nav-compact' };

/**
 * Decides how the primary links sit, from their width with their names.
 */
function fitPrimaryNav() {
  const nav = primaryNav.value;
  const bar = nav?.closest('.af-header-inner');
  const utility = bar?.querySelector('.af-nav-utility');
  // the collapsed menu of a phone : a list, nothing to fit
  if (!nav || !bar || !utility || window.innerWidth < 768) {
    navFit.value = 'flow';
    return;
  }
  // their width in each way, measured before the frame is drawn ; the class put back after
  // (centred or after the logo, the same width)
  const widthAs = (fit) => {
    for (const c of Object.values(FIT_CLASSES)) nav.classList.remove(c);
    if (FIT_CLASSES[fit]) nav.classList.add(FIT_CLASSES[fit]);
    return nav.getBoundingClientRect().width;
  };
  const navWidth = widthAs('flow');
  const tightWidth = widthAs('tight');
  widthAs(navFit.value);
  const box = bar.getBoundingClientRect();
  // where the left side ends : after the labels beside the logo (AppLabels) when there are any,
  // else after the logo. The labels are measured whole : they give way (narrower, their names
  // cut short) only when even the links' icons alone leave them too little room, so what they
  // show at this moment must not decide how the links sit
  const labels = bar.querySelector('.af-labels');
  const brand = labels || bar.querySelector('.af-brand');
  if (labels) labels.style.flexShrink = '0';
  const leftEnd = brand ? brand.getBoundingClientRect().right : box.left;
  if (labels) labels.style.flexShrink = '';
  // where the buttons start when nothing pushes them : the bar's end less its padding and them
  const rightStart = box.right - (parseFloat(getComputedStyle(bar).paddingRight) || 0) - utility.offsetWidth;
  const middle = box.left + box.width / 2;
  if (window.innerWidth >= 1200 && middle - navWidth / 2 >= leftEnd + 16 && middle + navWidth / 2 <= rightStart - 16) {
    navFit.value = 'centred';
  } else if (leftEnd + 16 + navWidth + 16 <= rightStart) {
    navFit.value = 'flow';
  } else if (leftEnd + 16 + tightWidth + 16 <= rightStart) {
    navFit.value = 'tight';
  } else {
    navFit.value = 'compact';
  }
}
const refit = () => nextTick(fitPrimaryNav);
// what changes the room : the own links, the labels, the Designer link, the language, the logo
watch(
  () => [
    JSON.stringify(store.headerLinks || []),
    JSON.stringify(store.labels || []),
    store.designerEnabled,
    locale.value,
    store.customLogo,
  ],
  refit,
);
let navObserver = null;
onMounted(() => {
  refit();
  window.addEventListener('resize', fitPrimaryNav);
  // the links' own width changing (a label loaded, a font) : measured again
  if (typeof ResizeObserver !== 'undefined' && primaryNav.value) {
    navObserver = new ResizeObserver(fitPrimaryNav);
    navObserver.observe(primaryNav.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', fitPrimaryNav);
  navObserver?.disconnect();
});
onMounted(() => {
  refreshApprovals();
  State.loadHeaderLinks();
  State.refreshDesignerLock();
  lockTimer = setInterval(() => State.refreshDesignerLock(), 60000);
  configTimer = setInterval(() => State.loadAppConfig(), 60000);
});
onBeforeUnmount(() => {
  clearInterval(lockTimer);
  clearInterval(configTimer);
});

// DATA

const showVersion = ref(false);
const currentTheme = ref(Theme.load());
// the profile page can change the theme too: keep the header (logo, switcher) in step
watch(
  () => store.theme,
  (theme) => {
    if (theme) currentTheme.value = theme;
  },
);
const menuOptions = computed(() => [
  // every job ; a status, a job, the scheduled and stored jobs are the jobs too : the link stays active on them
  { title: t('nav.jobs'), link: '/jobs/all', also: ['/jobs'], icon: 'history' },
  // every settings page (all under /settings) keeps Settings active, not its General page alone
  { title: t('nav.settings'), link: '/settings/general', also: ['/settings'], icon: 'gear' },
  { title: t('nav.designer'), link: '/designer', icon: 'pen-to-square' },
]);
const helpMenuOptions = computed(() => [
  {
    title: t('nav.documentation'),
    href: 'https://ansibleforms.com',
    icon: 'arrow-up-right-from-square',
    target: '_blank',
  },
  { title: t('nav.apiDocs'), link: '/api-docs', icon: 'code', target: '_blank' },
]);
const profileMenu = computed(() => [
  { title: t('nav.logout'), link: '/logout', icon: 'arrow-right-from-bracket', target: '_self' },
]);

// COMPUTED

// the designer lock, for the lock on the Designer link : null when nobody holds it
const designerLockIndicator = computed(() => {
  const status = store.designerLock;
  if (!status || status.free || !status.lock) return null;
  if (status.match) {
    return { icon: 'lock', class: 'af-lock-mine', title: t('nav.designerLockedByMe') };
  }
  const who = status.lock.displayName || status.lock.username || '?';
  return { icon: 'lock', class: 'af-lock-other', title: t('nav.designerLockedBy', { user: who }) };
});

const menu = computed(() => {
  // Clone menuOptions to avoid mutating the original array
  let m = menuOptions.value.map((item) => ({ ...item }));

  // (the approvals count is on the bell in the header, not on the Jobs link)

  // Add home menu item
  m.unshift({
    title: t('nav.forms'),
    link: '/forms/all',
    // a category of forms, and a form, are the forms too : the link stays active on them
    also: ['/forms', '/form'],
    icon: 'rectangle-list',
    target: '_self',
  });

  // Settings : for a user who may open any settings page (the server log, the audit log, without
  // the settings themselves), and to the first of them
  const settingsPage = settingsMenu(t)
    .flatMap((s) => s.items)
    .find((i) => mayOpen(i.link, store?.profile?.options));
  if (!settingsPage) {
    m = m.filter((m) => m.link != '/settings/general');
  } else {
    const settings = m.find((x) => x.link == '/settings/general');
    if (settings) settings.link = settingsPage.link;
  }
  // the designer : switched on for the instance (Settings > Appearance > Links) and for the user
  if (!store?.profile?.options?.showDesigner || !store.designerEnabled) {
    m = m.filter((m) => m.link != '/designer');
  }
  // a lock on the Designer link while someone holds the designer : one color for the user
  // themselves, another for someone else, and who in its tooltip
  const designer = m.find((x) => x.link == '/designer');
  if (designer && designerLockIndicator.value) designer.indicator = designerLockIndicator.value;
  return m;
});

// the instance's own links in the header : each with the links inside it ; a menu's own
// address, when it has one, is the first entry of its menu
const ownLinks = computed(() => {
  const all = store.headerLinks || [];
  return all
    .filter((l) => !l.parent)
    .map((top) => {
      const children = all.filter((l) => l.parent === top.id);
      return {
        ...top,
        children,
        entries: top.url ? [top, ...children] : children,
        nav: { title: top.label, href: top.url, icon: iconOrDefault(top.icon), newTab: !!top.newTab },
      };
    });
});

const currentLanguage = computed(() => languages.find((l) => l.code === locale.value) || fallbackLanguage);

const helpMenu = computed(() => helpMenuOptions.value);

// Check if client/server builds match (cache detection)
const buildMismatch = computed(() => {
  const serverSha = store.serverBuild?.gitSha;
  const clientSha = store.clientBuild?.gitSha;
  if (!serverSha || !clientSha || serverSha === 'dev' || clientSha === 'dev') {
    return false; // dev mode, ignore
  }
  return serverSha !== clientSha;
});
</script>

<template>
  <!-- About : two build cards and a few lines, in a narrow dialog (af-about-dialog) -->
  <BsModal v-if="showVersion" size="md" dialogClass="af-about-dialog" @close="showVersion = false" icon="circle-info">
    <!-- named as its menu link, About ; the product and its version its first lines -->
    <template v-slot:title>{{ t('nav.about') }}</template>
    <template v-slot>
      <div class="af-about-product">
        <span class="af-about-name">{{ t('version.title') }}</span>
        <span class="af-about-version">v{{ store.version }}</span>
      </div>
      <!-- Cache Mismatch Warning -->
      <div v-if="buildMismatch" class="alert alert-warning d-flex align-items-center" role="alert">
        <font-awesome-icon icon="triangle-exclamation" class="me-2" />
        <div>
          <strong>{{ t('version.cacheMismatchTitle') }}</strong
          ><br />
          <small>{{ t('version.cacheMismatchMsg') }}</small>
        </div>
      </div>

      <div class="mb-3">
        <div class="row g-2">
          <div class="col-md-6">
            <div class="card">
              <div class="card-body">
                <h6 class="card-title">{{ t('version.serverBuild') }}</h6>
                <p class="card-text mb-1">
                  <small class="text-muted">{{ t('version.sha') }}:</small>
                  <code class="ms-1 fs-6 fw-bold">{{ store.serverBuild?.gitSha || 'unknown' }}</code>
                  <span v-if="store.serverBuild?.dirty" class="badge bg-warning ms-2">{{ t('version.dirty') }}</span>
                </p>
                <p class="card-text mb-0" v-if="store.serverBuild?.buildTime">
                  <small class="text-muted">{{ t('version.built') }}:</small>
                  <small class="ms-1">{{ Time.format(store.serverBuild.buildTime) }}</small>
                </p>
              </div>
            </div>
          </div>
          <div class="col-md-6">
            <div class="card">
              <div class="card-body">
                <h6 class="card-title">{{ t('version.clientBuild') }}</h6>
                <p class="card-text mb-1">
                  <small class="text-muted">{{ t('version.sha') }}:</small>
                  <code class="ms-1 fs-6 fw-bold">{{ store.clientBuild?.gitSha || 'unknown' }}</code>
                  <span v-if="store.clientBuild?.dirty" class="badge bg-warning ms-2">{{ t('version.dirty') }}</span>
                </p>
                <p class="card-text mb-0" v-if="store.clientBuild?.buildTime">
                  <small class="text-muted">{{ t('version.built') }}:</small>
                  <small class="ms-1">{{ Time.format(store.clientBuild.buildTime) }}</small>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p class="mt-3 fs-6 user-select-none">
        {{ t('version.license') }}<br />
        <br />
        {{ t('version.warranty') }}<br />

        <br />{{ t('version.findLicense') }}
        <a target="_blank" href="http://www.gnu.org/licenses/">http://www.gnu.org/licenses/</a><br />
      </p>
    </template>
  </BsModal>
  <BsNavBar :currentTheme="currentTheme">
    <!-- primary navigation, next to the logo -->
    <template #start>
      <ul ref="primaryNav" class="navbar-nav af-nav-primary me-auto" :class="FIT_CLASSES[navFit]">
        <BsNavLink v-for="m in menu" :key="m.link" :link="m" />
        <!-- the instance's own links (Settings > Appearance > Links > Custom), after them : a link
             with links inside it is a menu, its own address (if any) the first of them -->
        <template v-for="top in ownLinks" :key="top.id">
          <BsNavLink v-if="!top.children.length" :link="top.nav" />
          <li v-else class="nav-item dropdown">
            <a
              class="nav-link icon-link link-body-emphasis dropdown-toggle"
              href="#"
              role="button"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              :title="top.label"
              @click.prevent
            >
              <span class="af-nav-link-icon"><font-awesome-icon :icon="iconOrDefault(top.icon)" /></span>
              <span class="af-nav-text">{{ top.label }}</span>
            </a>
            <ul class="dropdown-menu">
              <li v-for="l in top.entries" :key="l.id">
                <!-- a page of the app in this tab : the router's ; a site, or a new tab : a plain link -->
                <router-link
                  v-if="l.url.startsWith('/') && !l.newTab"
                  class="dropdown-item d-flex align-items-center"
                  :to="l.url"
                >
                  <span class="icon"><font-awesome-icon :icon="iconOrDefault(l.icon)" fixed-width /></span>
                  <span class="ms-2">{{ l.label }}</span>
                </router-link>
                <a
                  v-else
                  class="dropdown-item d-flex align-items-center"
                  :href="l.url"
                  :target="l.newTab ? '_blank' : '_self'"
                  :rel="l.newTab ? 'noopener noreferrer' : undefined"
                >
                  <span class="icon"><font-awesome-icon :icon="iconOrDefault(l.icon)" fixed-width /></span>
                  <span class="ms-2">{{ l.label }}</span>
                  <font-awesome-icon
                    v-if="l.newTab"
                    icon="arrow-up-right-from-square"
                    class="ms-auto ps-3 af-menu-meta"
                  />
                </a>
              </li>
            </ul>
          </li>
        </template>
      </ul>
    </template>

    <ul class="navbar-nav af-nav-utility ms-auto">
      <!-- search : forms and pages, live as you type (also on "/" and Ctrl+K) -->
      <BsNavItem>
        <AppSearch />
      </BsNavItem>

      <!-- the approvals bell : a red count of what waits for an approval. Jobs or runners alone (or
           nothing) : it opens their page ; both : a menu, as the help menu, with each and its count -->
      <li v-if="bellItems.length > 1" class="nav-item dropdown">
        <button
          type="button"
          class="btn af-icon-btn af-bell"
          data-bs-toggle="dropdown"
          aria-expanded="false"
          :title="t('jobs.menu.approve')"
          :aria-label="t('jobs.menu.approve')"
        >
          <font-awesome-icon icon="bell" />
          <span class="af-bell-count">{{ bellCount > 99 ? '99+' : bellCount }}</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li v-for="item in bellItems" :key="item.key">
            <router-link class="dropdown-item d-flex align-items-center" :to="item.to">
              <span class="icon"><font-awesome-icon :icon="item.icon" fixed-width /></span>
              <span class="ms-2">{{ item.label }}</span>
              <span class="ms-auto ps-3 badge rounded-pill text-bg-danger">{{ item.count }}</span>
            </router-link>
          </li>
        </ul>
      </li>
      <BsNavItem v-else>
        <router-link
          class="btn af-icon-btn af-bell"
          :to="bellLink ? bellLink.to : jobsPath('approve')"
          :title="bellTitle"
          :aria-label="bellTitle"
        >
          <font-awesome-icon icon="bell" />
          <span v-if="bellCount > 0" class="af-bell-count">{{ bellCount > 99 ? '99+' : bellCount }}</span>
        </router-link>
      </BsNavItem>

      <!-- help menu -->
      <BsNavItem :dropdown="true">
        <BsNavMenu icon="circle-question" :title="t('common.help')" buttonClass="af-icon-btn">
          <li v-for="m in helpMenu" :key="m.title">
            <a
              v-if="m.href"
              type="button"
              class="dropdown-item d-flex align-items-center"
              :href="m.href"
              :target="m.target"
            >
              <span class="icon"><font-awesome-icon :icon="m.icon" /></span>
              <span class="ms-2">{{ m.title }}</span>
            </a>
            <router-link v-else class="dropdown-item d-flex align-items-center" :to="m.link" :target="m.target">
              <span class="icon"><font-awesome-icon :icon="m.icon" /></span>
              <span class="ms-2">{{ m.title }}</span>
            </router-link>
          </li>
          <li><hr class="dropdown-divider" /></li>
          <li>
            <button type="button" class="dropdown-item d-flex align-items-center" @click="showVersion = true">
              <span class="icon"><font-awesome-icon icon="circle-info" /></span>
              <span class="ms-2">{{ t('nav.about') }}</span>
              <span class="ms-auto ps-3 af-menu-version">v{{ store.version }}</span>
            </button>
          </li>
        </BsNavMenu>
      </BsNavItem>

      <!-- theme switcher -->
      <BsNavItem :dropdown="true">
        <BsThemeSwitcher v-model="currentTheme" buttonClass="af-icon-btn" />
      </BsNavItem>

      <!-- language switcher: shows the current language's flag -->
      <BsNavItem :dropdown="true">
        <button
          class="btn af-icon-btn"
          type="button"
          data-bs-toggle="dropdown"
          aria-expanded="false"
          :aria-label="t('nav.language')"
          :title="currentLanguage.label"
        >
          <AppFlag :code="currentLanguage.code" class="af-nav-flag" />
          <span class="d-md-none ms-2">{{ currentLanguage.label }}</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li v-for="lang in languages" :key="lang.code">
            <button
              type="button"
              class="dropdown-item d-flex align-items-center gap-2"
              :class="{ active: locale === lang.code }"
              @click="setLanguage(lang.code)"
            >
              <AppFlag :code="lang.code" />
              <span>{{ lang.label }}</span>
              <span v-if="locale === lang.code" class="ms-auto ps-3"><font-awesome-icon icon="check" /></span>
            </button>
          </li>
        </ul>
      </BsNavItem>

      <!-- user menu: profile and sign out -->
      <BsNavItem :dropdown="true" class="af-user-item">
        <!-- only the avatar, like the icon buttons beside it : the name and the login type are in
             the menu it opens, and in its tooltip -->
        <button
          class="btn af-user-btn"
          type="button"
          data-bs-toggle="dropdown"
          aria-expanded="false"
          :title="displayName"
          :aria-label="displayName"
        >
          <span class="af-avatar"><font-awesome-icon icon="user" /></span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end af-user-menu">
          <li class="af-user-card">
            <span class="af-avatar af-avatar-lg"><font-awesome-icon icon="user" /></span>
            <span class="d-flex flex-column lh-sm">
              <strong>{{ displayName }}</strong>
              <small v-if="userSubname" class="af-menu-meta">{{ userSubname }}</small>
              <!-- how it signs in : a soft pill with its icon, under who the user is -->
              <span class="af-menu-type"><FaIcon :icon="loginType.icon" class="me-1" />{{ loginType.label }}</span>
            </span>
          </li>
          <li><hr class="dropdown-divider" /></li>
          <li>
            <router-link class="dropdown-item d-flex align-items-center" to="/profile">
              <span class="icon"><font-awesome-icon icon="user-gear" /></span>
              <span class="ms-2">{{ t('nav.profile') }}</span>
            </router-link>
          </li>
          <li><hr class="dropdown-divider" /></li>
          <template v-for="m in profileMenu" :key="m.link">
            <li>
              <router-link class="dropdown-item d-flex align-items-center" :to="m.link" :target="m.target">
                <span class="icon"><font-awesome-icon :icon="m.icon" /></span>
                <span class="ms-2">{{ m.title }}</span>
              </router-link>
            </li>
          </template>
        </ul>
      </BsNavItem>
    </ul>
  </BsNavBar>
  <!-- the announcement of Settings > Appearance > Announcement -->
  <AppAnnouncement />
  <!-- the server runs a newer build than this tab (a tab opened before an upgrade, issue #660) :
       offer a reload, never reload by itself, so nothing typed in a form is lost -->
  <div v-if="store.newVersionAvailable && !store.newVersionDismissed" class="af-new-version" role="status">
    <FaIcon icon="circle-arrow-up" class="me-2" />
    <span>{{ t('version.newVersionAvailable') }}</span>
    <button type="button" class="btn btn-sm btn-primary ms-3" @click="reloadPage">
      <FaIcon icon="rotate-right" class="me-1" />{{ t('version.newVersionReload') }}
    </button>
    <button
      type="button"
      class="btn-close ms-auto"
      :aria-label="t('version.newVersionDismiss')"
      :title="t('version.newVersionDismiss')"
      @click="store.newVersionDismissed = true"
    ></button>
  </div>
</template>

<style lang="scss">
/* the About dialog's first line : the product, large and bold, its version beside it in grey */
.af-about-product {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.af-about-name {
  font-size: 1.25rem;
  font-weight: 600;
}
.af-about-version {
  color: var(--bs-secondary-color);
}
/* the About dialog : between Bootstrap's default (500px) and large (800px) */
.modal-dialog.af-about-dialog {
  max-width: 640px;
}
// ===============================================================
// Header navigation (not scoped: it styles the links and menus that
// BsNavLink, BsNavMenu and BsThemeSwitcher render inside the header)
// ===============================================================

.af-header {
  font-size: 0.875rem;

  // primary links: full header height, so the active underline sits on the bottom edge
  .af-nav-primary .nav-link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 1.0625rem;
    font-weight: 500;
    // a label of two words (My jobs) stays on one line
    white-space: nowrap;
    padding: 0.45rem 0.85rem !important;
    margin: 0 0.9rem;
    border-radius: 6px;
    color: var(--af-navbar-link-color) !important;
    transition:
      background-color 0.15s,
      color 0.15s;
    svg {
      font-size: 1.3em; // about 22px next to the 17px text
      opacity: 0.75;
    }
    &:hover {
      color: var(--af-navbar-link-hover-color) !important;
      background-color: var(--af-navbar-hover-bg);
    }
    &.active {
      color: var(--af-navbar-link-active-color) !important;
      font-weight: 600;
      svg {
        opacity: 1;
      }
    }
    @media (min-width: 768px) {
      &.active::after {
        content: '';
        position: absolute;
        left: 0.85rem;
        right: 0.85rem;
        bottom: calc((var(--af-header-height) - 100%) / -2);
        height: 3px;
        border-radius: 3px 3px 0 0;
        background-color: var(--af-navbar-indicator);
      }
    }
    .badge {
      font-size: 0.68rem;
      padding: 0.2em 0.5em;
      margin-left: 0.1rem !important;
    }
  }

  // on wide screens the primary links sit in the middle of the bar, independent of how
  // wide the logo and the user menu are ; narrower screens keep them next to the logo
  // (only when they fit : measured, see fitPrimaryNav)
  @media (min-width: 1200px) {
    .af-nav-primary.af-nav-centred {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
    }
  }
  // little room : closer together ; no room for their names : their icons only (their names
  // as tooltips)
  @media (min-width: 768px) {
    .af-nav-primary.af-nav-tight .nav-link,
    .af-nav-primary.af-nav-compact .nav-link {
      margin: 0 0.15rem;
    }
    .af-nav-primary.af-nav-compact .af-nav-text {
      display: none;
    }
  }

  // utility buttons on the right: icon only, square, subtle hover
  .af-nav-utility {
    align-items: center;
    gap: 0.25rem;
  }
  .af-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 42px;
    height: 42px;
    font-size: 1.25rem;
    padding: 0 0.5rem;
    border-radius: 6px;
    border: 0;
    color: var(--af-navbar-link-color) !important;
    .icon {
      margin-right: 0 !important;
    }
    svg {
      font-size: 1.45rem;
    }
    &::after {
      display: none; // no caret on icon buttons
    }
    // BsNavMenu repeats the title for the collapsed menu (below lg); the header expands at md,
    // so hide it there to keep the button icon-only
    @media (min-width: 768px) {
      .d-lg-none {
        display: none !important;
      }
    }
    &:hover,
    &.show {
      color: var(--af-navbar-link-hover-color) !important;
      background-color: var(--af-navbar-hover-bg);
    }
  }

  // the count on the approvals bell : a red circle on the bell's top right corner
  .af-bell {
    position: relative;
  }
  .af-bell-count {
    position: absolute;
    top: 1px;
    right: 0;
    min-width: 1.15rem;
    height: 1.15rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.15rem;
    text-align: center;
    color: #ffffff;
    background-color: var(--bs-danger);
    box-shadow: 0 0 0 2px var(--af-bg-navbar);
  }

  // light theme : its hover color is darker than the icons, so the buttons on the right
  // use a lighter grey instead, as the other themes lighten them ; the hover background
  // stays (the flag and the avatar lighten through their brightness filter below)
  [data-bs-theme='light'] & {
    // the bell, help and theme icons and the user name turn black
    .af-icon-btn,
    .af-user-btn {
      &:hover,
      &.show {
        color: #000000 !important;
      }
    }
  }

  // the flag in the language button, a little larger than the menu flags
  .af-nav-flag {
    width: 1.75rem;
    height: 1.2rem;
    transition: filter 0.15s;
  }
  // on hover the flag lightens, like the other header icons change color ; brightness and
  // not opacity, so it lightens on a dark header as well instead of fading into it
  .af-icon-btn:hover .af-nav-flag,
  .af-icon-btn.show .af-nav-flag,
  .af-user-btn:hover .af-avatar,
  .af-user-btn.show .af-avatar {
    filter: brightness(1.25);
  }

  // user button: avatar with the name next to it
  // the avatar sits in the row of icon buttons, with no separator before it
  .af-user-item {
    margin-left: 0.25rem;
  }
  .af-user-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    // a round hover area around the avatar, a little larger than it
    width: 42px;
    height: 42px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    color: var(--af-navbar-link-color) !important;
    &:hover,
    &.show {
      color: var(--af-navbar-link-hover-color) !important;
      // the circle around the avatar : the theme sets it apart so the avatar's ring (the
      // header's color, the box-shadow below) shows against it in every theme
      background-color: var(--af-avatar-hover-bg, var(--af-navbar-hover-bg));
    }
  }
  .af-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #ffffff;
    background-color: var(--af-avatar-bg);
    box-shadow: 0 0 0 2px var(--af-bg-navbar);
    transition: filter 0.15s;
  }
  .af-avatar-lg {
    width: 56px;
    height: 56px;
    font-size: 1.625rem;
  }

  // dropdown menus: rounded, hairline border, soft shadow
  .dropdown-menu {
    min-width: 15rem;
    padding: 0.35rem;
    margin-top: 0.5rem !important;
    font-size: 0.9375rem; // 15px
    border: 1px solid var(--af-header-border);
    border-radius: 10px;
    box-shadow:
      0 10px 30px rgba(15, 23, 42, 0.12),
      0 2px 6px rgba(15, 23, 42, 0.06);
  }
  .dropdown-item {
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    .icon {
      width: 1.1rem;
      text-align: center;
      opacity: 0.75;
    }
  }
  .dropdown-header {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.4rem 0.6rem 0.25rem;
  }
  .dropdown-divider {
    margin: 0.35rem 0;
  }
}

// the "newer version" banner under the header : the accent's light tint, one line
.af-new-version {
  display: flex;
  align-items: center;
  padding: 0.5rem 2.5rem;
  font-size: 0.9375rem;
  color: var(--bs-primary-text-emphasis);
  background-color: var(--bs-primary-bg-subtle);
  border-bottom: 1px solid var(--bs-primary-border-subtle);
}

.af-header {
  // the user menu grows with the name : a long one (an Entra ID e-mail address) stays on one
  // line and widens the menu, up to the screen width, where it is cut off with an ellipsis
  .af-user-menu {
    width: max-content;
    max-width: calc(100vw - 2rem);
  }
  .af-user-card {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 0.75rem 0.6rem;
    // the name's column : the rest of the card, so the account type's line runs to its right edge
    > span:last-child {
      flex: 1;
      min-width: 0;
    }
    strong,
    small {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .af-avatar {
      box-shadow: none;
      background-color: var(--af-primary);
    }
  }
  .af-menu-meta {
    color: var(--bs-secondary-color);
    font-size: 0.85rem;
  }
  // the version beside About : smaller, in the row's own colour at all times (the meta grey stayed
  // dark on a pressed row, whose text turns white)
  .af-menu-version {
    color: inherit;
    font-size: 0.85rem;
  }
  // how the account signs in (Local account, LDAP, Microsoft Entra ID) : a soft grey pill with
  // its icon under the name, apart from who the user is without a line
  .af-menu-type {
    align-self: flex-start;
    margin-top: 0.8rem;
    padding: 0.15rem 0.55rem;
    border-radius: 50rem;
    background: var(--bs-tertiary-bg);
    // the fields' darker grey, as the cards' and the pagers' borders
    border: 1px solid var(--af-field-border);
    color: var(--bs-secondary-color);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  // collapsed (mobile) menu: plain stacked list
  @media (max-width: 767.98px) {
    .navbar-collapse {
      padding: 0.5rem 0 0.75rem;
    }
    .af-nav-utility {
      flex-direction: row;
      justify-content: flex-start;
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--af-header-border);
    }
    .af-user-item {
      margin-left: auto;
    }
  }
}
</style>
