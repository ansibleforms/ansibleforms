<script setup>
/******************************************************************/
/*                                                                */
/*  The confirm dialog : the app's own question before a delete,  */
/*  a reject or a list action (askConfirm, lib/confirmPrompt.js), */
/*  in place of the browser's confirm(). Its button goes on ;     */
/*  Cancel, the cross, Escape or the backdrop turn it down.       */
/*  Above every other dialog : asked from one (a repository's     */
/*  usages, from its New dialog), it shows over it, not under.    */
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
  <!-- its layer : above any dialog open, nested ones too (styles below) -->
  <div class="af-confirm-layer">
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
        <!-- what the action will do, a paragraph each ; a heading ({ heading }) opens a section of
           its own (a repository's usages turned on or off at once, a section per type) -->
        <template v-for="(line, i) in details" :key="`d${i}`">
          <p v-if="line && line.heading" class="af-confirm-heading">{{ line.heading }}</p>
          <p v-else class="af-confirm-detail" :class="{ 'mb-0': i === details.length - 1 }">
            {{ line }}
          </p>
        </template>
      </template>
      <template #footer>
        <BsButton icon="times" @click="answerConfirm(false)">{{ t('common.cancel') }}</BsButton>
        <BsButton :icon="confirmPrompt.icon" colorClass="primary" @click="answerConfirm(true)">{{
          confirmPrompt.ok || t('common.confirm')
        }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>
<style scoped>
/* above every dialog, the nested ones (1065, their backdrop 1060) and a job's node output (1062)
   too : mounted before the pages (App.vue), at Bootstrap's 1055 it lay under a dialog open on the
   page, its backdrop dimming the dialog under it */
.af-confirm-layer :deep(.modal) {
  z-index: 1080;
}
.af-confirm-layer :deep(.modal-backdrop) {
  z-index: 1075;
}
/* the details under the question : a size smaller, in the secondary text colour */
.af-confirm-detail {
  font-size: 0.875rem;
  color: var(--bs-secondary-color);
}
/* a section's heading among the details : bold, in the body colour, close to its paragraphs */
.af-confirm-heading {
  margin-top: 1rem;
  margin-bottom: 0.4rem;
  font-weight: 600;
}
</style>
