<script setup>
/******************************************************************/
/*                                                                */
/*  The sign-in card's frame : the login background, the theme    */
/*  switcher at the top right, then the card with the logo, the   */
/*  instance's name and environment, and "Please sign in". What   */
/*  the card asks for (the fields, Sign in, the single sign-on)   */
/*  is the default slot.                                          */
/*                                                                */
/*  The login page fills it with its form ; the sign-out page     */
/*  with the form's grey placeholders (AppSkeleton 'login'), so   */
/*  the login card then appears in exactly the same spot.         */
/*                                                                */
/*  @props:                                                       */
/*      busy: Boolean - on the way to the single sign-on provider */
/*            : the fields and the buttons greyed out, nothing to */
/*            click twice                                         */
/*                                                                */
/******************************************************************/

import { ref } from 'vue';
import { useAppStore } from '@/stores/app';
import Theme from '@/lib/Theme';
import { useI18n } from 'vue-i18n';

// INIT

const store = useAppStore();
const { t } = useI18n();

// PROPS

defineProps({
  busy: { type: Boolean, default: false },
});

// the theme, picked in the switcher : the logo follows it
const currentTheme = ref(Theme.load());
</script>

<template>
  <div class="d-flex align-items-center py-4 bg-body-tertiary login vh-100">
    <div class="dropdown position-fixed top-0 end-0 mt-3 me-3 bd-mode-toggle">
      <BsThemeSwitcher buttonClass="btn-bd-primary py-2" v-model="currentTheme" />
    </div>

    <div class="card form-signin w-100 m-auto" :class="{ 'login-busy': busy }" :aria-busy="busy">
      <div class="card-body">
        <div class="login-logo" :class="{ 'login-logo-instance': store.appName || store.labels.length }">
          <!-- an uploaded logo ; not the server's built-in default, which is the light logo and
               would replace the dark theme's own -->
          <img v-if="store.customLogo && !store.logoIsDefault" :src="store.customLogo" alt="AnsibleForms" />
          <img v-else-if="currentTheme === 'dark'" :src="'img/logo_dark.svg'" alt="AnsibleForms" />
          <!-- the color theme's white logo is made for its colored header : the card is white -->
          <img v-else :src="'img/logo_light.svg'" alt="AnsibleForms" />
        </div>
        <!-- which instance : its name and its environment (Settings > Appearance) -->
        <div v-if="store.appName || store.labels.length" class="login-instance">
          <span v-if="store.appName" class="login-app-name">{{ store.appName }}</span>
          <AppLabels />
        </div>
        <h5 class="card-title login-title">{{ t('login.pleaseSignIn') }}</h5>
        <slot></slot>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-signin {
  /* the width of a usual login card : wider stretches the fields */
  max-width: 450px;
  padding: 1rem;
  /* a soft shadow all around, lifting the card off the background */
  box-shadow: 0 0 1.5rem rgba(0, 0, 0, 0.18);
}

/* the logo heads the card, larger than in the header (33px) : the card is 500px wide.
   An svg without width/height has no size of its own, so it gets a height, and the width
   follows from its ratio ; raster images keep their own size, never scaled up. */
.login-logo {
  display: flex;
  justify-content: center;
  margin-bottom: 1.625rem;
  img {
    max-width: 100%;
    max-height: 56px;
  }
  img[src$='.svg'],
  img[src^='data:image/svg+xml'] {
    height: 56px;
    width: auto;
  }
}

/* which instance : its name and its environment's label, between the logo and the title.
   It belongs to the logo, so it sits close under it, and keeps the logo's own room
   (1.625rem) to the title : the title is as far from it as from the logo without one. */
.login-logo.login-logo-instance {
  margin-bottom: 0.75rem;
}
.login-instance {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-bottom: 1.625rem;
}
.login-app-name {
  font-size: 1.1rem;
  font-weight: 600;
}
/* the labels centred under the logo : without the header's pull towards its logo */
.login-instance :deep(.af-labels) {
  margin: 0;
}
.login-title {
  text-align: center;
  margin-bottom: 1rem;
}

/* on the way to the single sign-on provider : the fields and the buttons greyed out, nothing to
   click twice ; the logo, the title and the page's background stay as they are */
.login-busy {
  pointer-events: none;
}
.login-busy :deep(:is(.form-control, .input-group-text)) {
  background-color: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
}
.login-busy :deep(:is(.btn, .login-sso-btn)) {
  opacity: 0.5;
  filter: grayscale(1);
  transition:
    opacity 0.15s ease,
    filter 0.15s ease;
}

/* the menu's text label is meant for the collapsed header : the login page has none, so
   small screens keep the icon alone, as large ones do */
.bd-mode-toggle :deep(.d-lg-none) {
  display: none !important;
}
[data-bs-theme='light'] {
  .login {
    background-image: var(--af-login-background-light) !important;
    background-size: cover;
  }
}
[data-bs-theme='dark'] {
  .login {
    background-image: var(--af-login-background-dark) !important;
    background-size: cover;
  }
}
[data-bs-theme='color'] {
  .login {
    background-image: var(--af-login-background-color) !important;
    background-size: cover;
  }
}
</style>
