<script setup>
/******************************************************************/
/*                                                                */
/*  The notice of a page whose values the config seed manages :   */
/*  read only here, as every seeded record's page says it.        */
/*                                                                */
/******************************************************************/
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <div class="alert alert-secondary py-2">
    <FaIcon icon="lock" class="me-2" />{{ t('settings.common.seedManagedNotice') }}
  </div>
</template>
