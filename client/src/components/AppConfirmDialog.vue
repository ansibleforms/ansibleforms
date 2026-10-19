<script setup>
/******************************************************************/
/*                                                                */
/*  The confirm dialog : the app's own question before a delete,  */
/*  a reject or a list action (askConfirm, lib/confirmPrompt.js), */
/*  in place of the browser's confirm(). Its button goes on ;     */
/*  Cancel, the cross, Escape or the backdrop turn it down.       */
/*                                                                */
/******************************************************************/
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmPrompt, answerConfirm, confirmLines } from '@/lib/confirmPrompt';

const { t } = useI18n();
// the question and what follows it, each on a line of its own
const lines = computed(() => confirmLines(confirmPrompt.message));
const details = computed(() => confirmPrompt.details || []);
</script>

<template>
  <BsModal
    v-if="confirmPrompt.open"
    size="md"
    :icon="confirmPrompt.icon"
    :footerClose="false"
    @close="answerConfirm(false)"
  >
    <template #title>{{ confirmPrompt.title || t('common.confirm') }}</template>
    <template #default>
      <p v-for="(line, i) in lines" :key="i" :class="{ 'mb-0': i === lines.length - 1 && !details.length }">
        {{ line }}
      </p>
      <!-- what the action will do, a paragraph each -->
      <p
        v-for="(line, i) in details"
        :key="`d${i}`"
        class="af-confirm-detail"
        :class="{ 'mb-0': i === details.length - 1 }"
      >
        {{ line }}
      </p>
    </template>
    <template #footer>
      <BsButton icon="times" @click="answerConfirm(false)">{{ t('common.cancel') }}</BsButton>
      <BsButton :icon="confirmPrompt.icon" colorClass="primary" @click="answerConfirm(true)">{{
        confirmPrompt.ok || t('common.confirm')
      }}</BsButton>
    </template>
  </BsModal>
</template>
<style scoped>
/* the details under the question : a size smaller, in the secondary text colour */
.af-confirm-detail {
  font-size: 0.875rem;
  color: var(--bs-secondary-color);
}
</style>
