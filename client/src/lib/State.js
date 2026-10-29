import axios from 'axios';
import { mayOpen } from '@/lib/routePermission';
import { useAppStore } from '@/stores/app';
import TokenStorage from '@/lib/TokenStorage';
import Profile from '@/lib/Profile';
import Navigate from '@/lib/Navigate';
import Time from '@/lib/Time';
import { ssoSettled } from '@/lib/ssoReturn';
import i18n, { applyDefaultLanguage } from '@/plugins/i18n';

// the approvals count being read (refreshApprovals), shared while it is in flight
let approvalsInFlight = null;

var State = {
  loadProfile() {
    const store = useAppStore();
    var payload = TokenStorage.getPayload();
    const user = payload?.user || {};
    // the token carries no groups (#1036) : the ones already loaded for the same user stay, and
    // the server is asked for them (Profile.load puts them on the profile)
    const previous = store.profile;
    const same = previous && previous.username === user.username && previous.type === user.type;
    store.profile =
      !Array.isArray(user.groups) && same && Array.isArray(previous.groups)
        ? { ...user, groups: previous.groups }
        : user;
    if (user.username && !Array.isArray(user.groups)) Profile.load();
  },

  refreshAuthenticated() {
    const store = useAppStore();
    store.authenticated = TokenStorage.isAuthenticated();
    // console.log("checking if is admin")
    var payload = TokenStorage.getPayload();
    store.isAdmin = payload?.user?.roles?.includes('admin') || false;
  },

  async loadVersion() {
    const store = useAppStore();
    try {
      // Get server version and build info
      const result = await axios.get(`/api/v2/version`);
      store.version = result.data.version || result.data; // handle both old and new formats
      store.serverBuild = result.data.server || null;

      // the client's own build, baked into the bundle by vite.config.mjs : it identifies the code
      // running in this tab, so a tab left open across an upgrade shows a mismatch. 'dev' when
      // the bundle was built without build-info.json, or under test (no vite define)
      store.clientBuild =
        typeof __CLIENT_BUILD__ !== 'undefined' ? __CLIENT_BUILD__ : { gitSha: 'dev', dirty: false, buildTime: null };
    } catch (err) {
      // silent fail
    }
  },
  async loadLogo() {
    const store = useAppStore();
    try {
      const result = await axios.get(`/api/v2/logo`);
      store.customLogo = result.data?.logo || null;
      store.logoIsDefault = result.data?.isDefault ?? true;
    } catch (err) {
      // silent fail, the bundled default logo is shown
      store.customLogo = null;
      store.logoIsDefault = true;
    }
  },
  // the website icon (Settings > Appearance > Icon) : the stored one in the browser tab, or
  // the bundled favicon.svg of index.html
  async loadFavicon() {
    const store = useAppStore();
    try {
      const result = await axios.get(`/api/v2/favicon`);
      store.customFavicon = result.data?.favicon || null;
    } catch (err) {
      store.customFavicon = null;
    }
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    // the bundled one is remembered once, to come back to when the stored one is removed
    if (!link.dataset.bundled) link.dataset.bundled = link.getAttribute('href') || 'favicon.svg';
    link.setAttribute('href', store.customFavicon || link.dataset.bundled);
  },
  // what the instance switches on : the chat button (ENABLE_CHAT and a provider) and the
  // designer (SHOW_DESIGNER), as the server says
  async loadAppConfig() {
    try {
      const result = await axios.get(`/api/v2/app/config`);
      State.applyAppConfig(result.data || {});
    } catch (err) {
      useAppStore().chatEnabled = false;
    }
  },
  // what /api/v2/app/config says, into the app : the switches, and Settings > Appearance >
  // Interface's name (the browser tab), label, announcements and forms view
  applyAppConfig(data) {
    const store = useAppStore();
    store.chatEnabled = !!data.chatEnabled;
    store.designerEnabled = data.designerEnabled !== false;
    store.appName = data.appName || null;
    store.labels = Array.isArray(data.labels) ? data.labels : [];
    store.announcements = Array.isArray(data.announcements) ? data.announcements : [];
    store.formsView = data.formsView || null;
    // the time zone for everyone : only while this browser has not chosen its own (the profile)
    if (!Time.hasOwnPreference()) store.timezone = data.timezone || 'UTC';
    // the date format for everyone : only while this browser has not chosen its own
    if (!Time.hasOwnDateFormat()) store.dateFormat = data.dateFormat || 'YYYY-MM-DD';
    // the language for everyone (DEFAULT_LANGUAGE, Settings) : only while this browser has not
    // chosen its own (the af_language cookie). Here, so the pages shown before anyone signs in
    // (the login, the change of a default password, the database setup) read it too, not only
    // the pages with the header
    applyDefaultLanguage(data.defaultLanguage);
    store.appConfigLoaded = true;
    document.title = data.appName || 'AnsibleForms';
  },
  // the header's own links (Settings > Appearance > Links > Custom) : signed in only, so not
  // in the public /api/v2/app/config
  async loadHeaderLinks() {
    try {
      const result = await axios.get('/api/v2/app/links');
      useAppStore().headerLinks = Array.isArray(result.data) ? result.data : [];
    } catch (err) {
      // not signed in (any more) or the server is down : none
      useAppStore().headerLinks = [];
    }
  },
  // the jobs waiting for approval, for the header bell. One change of the jobs is heard by the
  // header and by the desktop notifications (lib/jobNotifications.js) at once : a read already
  // in flight is shared, so both get the same count from one request. Returns the count.
  refreshApprovals() {
    if (approvalsInFlight) return approvalsInFlight;
    const store = useAppStore();
    approvalsInFlight = axios
      .get('/api/v2/job/approvals')
      .then((res) => {
        store.approvals = res?.data || 0;
        return Number(store.approvals) || 0;
      })
      .finally(() => {
        approvalsInFlight = null;
      });
    return approvalsInFlight;
  },

  // the RTEs waiting for approval, for the header bell : only for a user who sees the runners
  // (the api answers 403 to the others)
  async refreshRunnerApprovals() {
    const store = useAppStore();
    if (!mayOpen('/settings/runners', store.profile?.options)) {
      store.runnerApprovals = 0;
      return;
    }
    const res = await axios.get('/api/v2/runner/pending').catch(() => null);
    store.runnerApprovals = Number(res?.data?.count) || 0;
  },

  // who holds the designer lock, for the lock icon on the header's Designer link ; only for
  // a user who sees the designer (the lock api answers 403 to the others)
  async refreshDesignerLock() {
    const store = useAppStore();
    if (!store.profile?.options?.showDesigner || !store.designerEnabled) {
      store.designerLock = null;
      return;
    }
    try {
      const res = await axios.get('/api/v2/lock');
      store.designerLock = res?.data || null;
    } catch (err) {
      // the designer is disabled, or the server is down : no icon rather than a wrong one
      store.designerLock = null;
    }
  },

  // Check the schema and see what's missing.
  async checkDatabase() {
    // create timestamp to add to api call to prevent caching
    const timestamp = new Date().getTime();
    const store = useAppStore();
    try {
      const result = await axios.get(`/api/v2/schema?${timestamp}`);
      store.schemaData = result.data;
      return true;
    } catch (err) {
      let responseData = err?.response?.data;
      if (responseData && typeof responseData === 'object') {
        if (responseData.error) {
          store.errorMessage = responseData.error;
        } else if (responseData.message) {
          store.errorMessage = responseData.message;
        }
        if (responseData.result) {
          store.schemaData = responseData.result.data;
        }
        return false;
      } else {
        // in the user's language, as the error page around it
        store.errorMessage = `${i18n.global.t('errors.schemaCheckFailed')}\n\n${i18n.global.t('errors.unknownError')}`;
        throw new Error(store.errorMessage, { cause: err });
      }
    }
  },
  async init(router, route) {
    // back from a single sign-on provider : the tokens are being stored (lib/ssoReturn.js)
    await ssoSettled();
    State.refreshAuthenticated();
    if (!TokenStorage.isAuthenticated()) {
      console.log('Not authenticated, redirecting to login');
      Navigate.toLogin(router, route);
    } else {
      State.loadProfile();
      State.loadVersion();
      State.loadLogo();
      State.loadFavicon();
      State.loadAppConfig();
      State.refreshApprovals();
      Navigate.toOrigin(router, route);
    }
  },
};

export default State;
