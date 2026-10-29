<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useVuelidate } from '@vuelidate/core';
import { required } from '@vuelidate/validators';
import TokenStorage from '@/lib/TokenStorage'; // work with tokens and local storage
import BaseUrl from '@/lib/BaseUrl';
import { rememberSsoOrigin } from '@/lib/ssoReturn';
import State from '@/lib/State'; // work with state
import Navigate from '@/lib/Navigate'; // navigate to routes
import Helpers from '@/lib/Helpers'; // helper functions
import { toast } from 'vue-sonner';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { rememberedSso, rememberSso } from '@/lib/loginSso';
import { useI18n } from 'vue-i18n';

// plugins

const route = useRoute();
const router = useRouter();
// the language of this browser (the af_language cookie), else the instance's default : nobody is
// signed in yet, so no profile says otherwise (plugins/i18n.js, State.applyAppConfig)
const { t } = useI18n();

// vuelidate
const rules = {
  user: {
    username: {
      required,
    },
    password: {
      required,
    },
  },
};
// data
const user = ref({
  username: '',
  password: '',
});

const loading = ref(false);
const entraIdEnabled = ref(false);
const entraGraphUrl = ref('');
const oidcEnabled = ref(false);
const oidcIssuer = ref('');
// the providers read from the server : until then the buttons of last time, in grey
const settingsRead = ref(false);
const lastSso = rememberedSso();
// Skip the login page, on for an enabled SSO provider (the server says which) : this page goes
// straight to that provider instead of showing its form
const ssoAutoLogin = ref(false);
// the flag logout.vue leaves for this tab : just signed out, the page stays
const SIGNED_OUT = 'af_signed_out';

// validation
const $v = useVuelidate(rules, { user });

// methods
// on the way to the provider : the form greys out at once (the provider's page can take a moment
// to come) ; the way back goes straight to the page the user wanted, else the forms page
// (lib/ssoReturn.js)
const ssoPending = ref(false);
function goToSso(issuer, path) {
  ssoPending.value = true;
  rememberSsoOrigin(route.query.from);
  localStorage.setItem('authIssuer', issuer);
  window.location.replace(`${BaseUrl}${path}`);
}
function authEntraId() {
  goToSso('azuread', '/api/v2/auth/entraid');
}
function authOidc() {
  goToSso('oidc', '/api/v2/auth/oidc');
}
// back on this page with the browser's Back button from the provider : the page comes from the
// browser's cache, greyed out as it was left
function onPageShow(e) {
  if (e.persisted) ssoPending.value = false;
}
window.addEventListener('pageshow', onPageShow);
onBeforeUnmount(() => window.removeEventListener('pageshow', onPageShow));
function getGroupsAndLogin(token, url, type = 'azuread') {
  // The token in the url is OUR handoff, not the provider's token (6.3.0) : the server reads
  // the groups itself at the login step - Microsoft Graph for Entra ID (#548), the handoff's
  // claim for OIDC
  tokenLogin(token, type === 'azuread' ? 'azuread' : 'oidc');
}
async function tokenLogin(token, type = 'azuread') {
  // The groups are the server's business : the claim in the handoff token (OIDC) or Microsoft
  // Graph (Entra ID), through the provider's group filter. The browser posts none - a list it
  // chose was never to be trusted.
  const loginProvider = type === 'azuread' ? 'entraid' : 'oidc';

  try {
    const result = await axios.post(`/api/v2/auth/${loginProvider}/login`, { token });
    processLogin(result.data);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('login.ssoFailed')));
  }
}
async function getSettings(token) {
  try {
    const result = await axios.get(`/api/v2/auth/settings`);

    entraIdEnabled.value = !!result.data.entraIdEnabled;
    entraGraphUrl.value = result.data.entraGraphUrl;

    oidcEnabled.value = !!result.data.oidcEnabled;
    oidcIssuer.value = result.data.oidcIssuer;
    rememberSso(Number(entraIdEnabled.value) + Number(oidcEnabled.value));
    ssoAutoLogin.value = !!result.data.ssoAutoLogin;
    // not on the way back from the provider (a handoff), and only where going there cannot
    // lock anyone out or loop : the form at /login?local, after signing out, after an SSO error
    if (!token && ssoAutoLogin.value && mayGoStraightToSso()) {
      loading.value = true;
      // the provider set to Skip the login page (the server says which)
      const to = result.data.ssoAutoLoginProvider;
      if (to === 'azuread' && entraIdEnabled.value) authEntraId();
      else if (to === 'oidc' && oidcEnabled.value) authOidc();
    }

    if (token && entraIdEnabled.value) {
      if (localStorage.getItem('authIssuer') == 'azuread')
        // get cookie and see if we issued azuread
        getGroupsAndLogin(token);
    }
    if (token && oidcEnabled.value) {
      // get cookie ans see if we issued oidc
      if (localStorage.getItem('authIssuer') == 'oidc')
        getGroupsAndLogin(token, `${oidcIssuer.value}/protocol/openid-connect/userinfo`, 'oidc');
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('login.settingsFailed')));
  } finally {
    settingsRead.value = true;
  }
}
/**
 * Whether the login page may send the user straight to the SSO provider (Skip the login page).
 *
 * Returns:
 *   boolean: false on /login?local (the form, for the local admin or a provider that fails),
 *     right after signing out in this tab (the provider's session would sign them back in), and
 *     when an SSO sign-in came back with an error (it would only fail again, in a loop).
 */
function mayGoStraightToSso() {
  if (route.query.local !== undefined || route.query.error) return false;
  try {
    return !sessionStorage.getItem(SIGNED_OUT);
  } catch {
    return true;
  }
}

function processLogin(data) {
  // signed in : the next visit to the login page may go straight to SSO again
  try {
    sessionStorage.removeItem(SIGNED_OUT);
  } catch {
    // no storage (a private window) : nothing was kept
  }
  TokenStorage.storeToken(data.token);
  TokenStorage.storeRefreshToken(data.refreshtoken);

  if (!TokenStorage.isAuthenticated()) {
    // console.log("Not authenticated, redirecting to login")
    Navigate.toLogin(router, route);
  } else if (TokenStorage.getPayload()?.user?.mustChangePassword) {
    // the public default password : nothing else works until it is changed
    router.push({ name: '/change-password' });
  } else {
    // console.log("Authenticated")
    Navigate.toOrigin(router, route);
    State.refreshAuthenticated();
    State.loadProfile();
    // the approvals count is loaded by the header (AppNav) as soon as it appears
  }
}
async function login() {
  localStorage.removeItem('authIssuer'); // remove cookie, regular login
  if (!$v.value.user.$invalid) {
    try {
      console.log('Logging in');
      // the credentials as UTF-8, as the server reads them (Helpers.basicAuthHeader)
      var basicAuth = Helpers.basicAuthHeader(user.value.username, user.value.password);
      var postconfig = {
        headers: { Authorization: basicAuth },
      };
      const result = await axios.post(`/api/v2/auth/login`, {}, postconfig);
      processLogin(result.data);
    } catch (err) {
      TokenStorage.clear();
      toast.error(Helpers.parseAxiosResponseError(err, t('login.failed')));
    }
  } else {
    toast.error(t('login.formInvalid'));
    $v.value.user.$touch();
  }
}
onMounted(() => {
  // TODO => check database before all else

  // the SSO handoff comes in the fragment (#token=), which no server or proxy log sees ; it is
  // taken out of the address at once, and the server takes it only once
  const handoff = new URLSearchParams(String(route.hash || '').replace(/^#/, '')).get('token') || route.query.token;
  if (handoff) {
    router.replace({ path: route.path, query: { ...route.query, token: undefined }, hash: '' });
    loading.value = true;
    getSettings(handoff);
  } else {
    getSettings();
  }
  if (route.query.error) {
    toast.error(route.query.error);
  }
  State.loadVersion();
  State.loadLogo();
  State.loadFavicon();
  // the name in the browser tab and under the logo, the environment's label
  State.loadAppConfig();
});
</script>

<template>
  <!-- the background, the theme switcher, the card's logo and title (AppLoginFrame) : the
       sign-out page draws the same frame -->
  <AppLoginFrame :busy="ssoPending">
    <BsInput
      v-model="user.username"
      @keyup_enter="login()"
      :label="t('login.username')"
      :placeholder="t('login.username')"
      icon="user"
      :hasError="$v.user.username.$invalid && $v.user.username.$dirty"
      :errors="$v.user.username.$errors"
    />
    <BsInput
      v-model="user.password"
      @keyup_enter="login()"
      type="password"
      :label="t('login.password')"
      :placeholder="t('login.password')"
      icon="lock"
      :hasError="$v.user.password.$invalid && $v.user.password.$dirty"
      :errors="$v.user.password.$errors"
    />
    <!-- on the way to the single sign-on provider, or back from it with its token : a spinner and
         Signing in… -->
    <button class="btn btn-primary w-100 py-2 login-submit" @click="login()">
      <template v-if="ssoPending || loading">
        <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>{{ t('login.signingIn') }}
      </template>
      <template v-else>{{ t('login.submit') }}</template>
    </button>
    <!-- single sign-on : under a divider, its providers in a centred row of equal buttons -->
    <template v-if="entraIdEnabled || oidcEnabled">
      <div class="login-divider">
        <span>{{ t('common.orDivider') }}</span>
      </div>
      <div class="login-sso">
        <button
          v-if="entraIdEnabled"
          type="button"
          class="login-sso-btn"
          :title="t('login.withMicrosoft')"
          :aria-label="t('login.withMicrosoft')"
          @click="authEntraId()"
        >
          <!-- the Microsoft logo, as Microsoft's sign-in buttons carry it (its branding
                   guidelines) : four squares, its four colours -->
          <svg class="login-ms-logo" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
        </button>
        <button
          v-if="oidcEnabled"
          type="button"
          class="login-sso-btn"
          :title="t('login.withOidc')"
          :aria-label="t('login.withOidc')"
          @click="authOidc()"
        >
          <!-- the OpenID mark in its colours : the orange I, the grey swoosh and arrow -->
          <svg class="login-oidc-logo" viewBox="0 0 512 512" aria-hidden="true">
            <path fill="#f7931e" d="M310.2 18.9L232.7 56.7V493l77.4-36.5z" />
            <path
              fill="#9a9a9a"
              d="M232.7 444.4C144.2 433.3 77.7 385.1 77.7 327c0-55 59.7-101.3 141.4-115.4V162.3C94.3 177.5 0 245.3 0 327c0 84.5 101.1 154.5 232.7 166z"
            />
            <path
              fill="#9a9a9a"
              d="M323.8 162.3v49.3c30.5 5.3 57.8 14.9 80.2 27.9l-42 23.7 150 32.6L501.3 184.7l-39.9 22.6c-37.1-22.6-84.5-38.6-137.6-45z"
            />
          </svg>
        </button>
      </div>
    </template>
    <!-- the providers not read yet : as many grey buttons as last time, so the card does not
             grow when they come (lib/loginSso.js) -->
    <AppSkeleton v-else-if="!settingsRead && lastSso" shape="sso" :count="lastSso" :delay="0" />
  </AppLoginFrame>
</template>

<style scoped>
/* the one action on the page, so a solid button : the theme tints every btn-primary down to
   a pale fill (styles/textColors.scss, with !important), which made Sign in the faintest
   thing on the card. This selector is more specific, so it wins in every theme. */
.btn.login-submit {
  color: #fff !important;
  background-color: var(--bs-primary) !important;
  border-color: var(--bs-primary) !important;
  &:hover,
  &:focus-visible {
    background-color: color-mix(in srgb, var(--bs-primary) 85%, #000) !important;
    border-color: color-mix(in srgb, var(--bs-primary) 85%, #000) !important;
  }
}

/* or : a line each side of the word, between the sign in and the single sign-on */
.login-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.25rem 0 1rem;
  color: var(--bs-secondary-color);
  font-size: 0.875rem;
  &::before,
  &::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--af-field-border);
  }
}

/* the providers : a centred row of equal buttons, framed as the fields, their own colours */
.login-sso {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
}
.login-sso-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 4.5rem;
  height: 3rem;
  border: 1px solid var(--af-field-border);
  border-radius: 0.375rem;
  background: var(--bs-body-bg);
  font-size: 1.75rem;
  &:hover {
    background: var(--bs-tertiary-bg);
  }
  &:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 0.25rem var(--bs-focus-ring-color);
  }
}

/* the providers' logos : the same visual weight - the OpenID mark, narrower than the
   Microsoft squares, a little larger */
.login-ms-logo {
  width: 1.5rem;
  height: 1.5rem;
}
.login-oidc-logo {
  width: 1.75rem;
  height: 1.75rem;
}
</style>
