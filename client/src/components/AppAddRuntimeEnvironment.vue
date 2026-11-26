<script setup>
/******************************************************************/
/*                                                                */
/*  Add runtime environment, under the New runner dialog's Image  */
/*  dropdown : the Designer's Runtime environments opened in a    */
/*  new tab, so the dialog being filled in is kept. Once one is   */
/*  built, its image is in the dropdown (reopen the dialog).      */
/*                                                                */
/******************************************************************/
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

/** Opens the Designer's Runtime environments in a new tab. */
function open() {
  window.open('/designer/rteimages', '_blank', 'noopener');
}
</script>

<template>
  <BsButton icon="plus" @click="open">{{ t('settings.runners.addRuntimeEnvironment') }}</BsButton>
</template>
