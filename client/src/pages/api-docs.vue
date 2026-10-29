<script setup>
// An info page : where the interactive API documentation is, in the user's language
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <AppNav />
  <div class="container py-5">
    <div class="row justify-content-center">
      <div class="col-lg-8">
        <div class="card shadow-sm border-0 mb-4">
          <div class="card-body">
            <h1 class="mb-3">{{ t('apiDocs.title') }}</h1>
            <p class="lead">{{ t('apiDocs.welcome') }}</p>
            <!-- the version in bold, inside the translated sentence -->
            <i18n-t keypath="apiDocs.version" tag="p" scope="global">
              <template #version><strong>v2</strong></template>
            </i18n-t>
            <div class="bg-light p-3 rounded border mb-3">
              <div class="mb-2">{{ t('apiDocs.endpoint') }}</div>
              <pre class="mb-0" style="font-family: 'Fira Mono', 'Consolas', monospace; background: none; border: none">
<a href="api/v2/docs">/api/v2/docs</a>
              </pre>
            </div>
            <p class="mb-0 text-muted">
              {{ t('apiDocs.hint') }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
