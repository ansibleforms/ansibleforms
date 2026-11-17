<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '@/stores/app';

const { t } = useI18n();
const store = useAppStore();

// The reason the app could not start, as TEXT : it is the server's own message (a database or
// schema error, with whatever it quotes back), so it is never rendered as html. It used to go
// through v-html with its newlines turned into <br>, which ran any markup it carried ; the
// newlines are kept by the white-space rule on the element instead.
const errorMessageText = computed(() => String(store.errorMessage || '').replace('Error: ', ''));
</script>

<template>
  <section class="min-vh-100 bg-light d-flex align-items-center">
    <div class="container">
      <div class="row justify-content-center">
        <div class="col-md-6 col-lg-5">
          <div class="alert alert-warning shadow-sm p-4">
            <strong v-if="store.errorMessage !== ''" class="af-error-message">{{
              errorMessageText
            }}</strong><br /><br />
            {{ t('errors.endOfLine') }}<br />
            {{ t('errors.fixSteps') }}<br />
            <ol class="mt-2">
              <li>{{ t('errors.stepDatabase') }}</li>
              <li>{{ t('errors.stepSchema') }}</li>
              <li>{{ t('errors.stepLogin') }}</li>
              <li>
                {{ t('errors.stepEnvironment') }}
                <router-link class="btn btn-sm btn-secondary ms-2" to="/settings/general">{{
                  t('errors.settings')
                }}</router-link>
              </li>
              <li>
                {{ t('errors.stepLogs') }}
                <router-link class="btn btn-sm btn-secondary ms-2" to="/settings/server-log">{{
                  t('errors.logs')
                }}</router-link>
              </li>
              <li>
                {{ t('errors.stepConfig') }}<br />
                {{ t('errors.stepRepository') }}
                <router-link class="btn btn-sm btn-success ms-2" to="/settings/repositories">{{
                  t('errors.createRepository')
                }}</router-link>
              </li>
              <li>{{ t('errors.stepNetwork') }}</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* the server's message keeps its line breaks, as text */
.af-error-message {
  white-space: pre-line;
}
</style>
