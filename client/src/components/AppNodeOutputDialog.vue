<script setup>
/******************************************************************/
/*                                                                */
/*  AppNodeOutputDialog : a workflow node's output, opened from   */
/*  its graph (composables/useNodeOutput.js) - its name and its   */
/*  job's link in the product it ran on in the title, its output  */
/*  under it, over the graph's full screen too. Esc closes it     */
/*  first, before the full screen under it hears it.              */
/*                                                                */
/*  @props:                                                       */
/*      shown: Object - { node, html } or null                    */
/*      workflow: Object - the workflow's graph (run times)       */
/*      jobId: Number|String - the workflow job (each node's      */
/*             extravars and artifacts)                           */
/*      product: String - what it ran on (AWX, AAP ...), for the  */
/*               link's title                                     */
/*  @emits:                                                       */
/*      close, copy (text)                                        */
/*                                                                */
/******************************************************************/
import { onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  shown: { type: Object, default: null },
  workflow: { type: Object, default: null },
  jobId: { type: [Number, String], default: null },
  product: { type: String, default: 'AWX' },
});
const emit = defineEmits(['close', 'copy']);
const { t } = useI18n();

function onKey(e) {
  if (e.key !== 'Escape' || !props.shown) return;
  e.preventDefault();
  emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Teleport to="body">
    <div v-if="shown" class="af-node-modal">
      <BsModal size="xl" @close="emit('close')" icon="diagram-project">
        <template #title>
          {{ shown.node.name }}
          <!-- the node's job in the product it ran on -->
          <a
            v-if="shown.node.ui_url"
            :href="shown.node.ui_url"
            target="_blank"
            rel="noopener noreferrer"
            class="ms-2 small"
            :title="t('jobs.openInRunner', { id: shown.node.job, product })"
            >#{{ shown.node.job }}<FaIcon icon="arrow-up-right-from-square" class="ms-1"
          /></a>
        </template>
        <template #default>
          <AppAnsibleOutput
            :output="shown.html"
            :workflow="workflow"
            :jobId="jobId"
            :copyLabel="t('jobs.copy')"
            numbered
            @copy="(text) => emit('copy', text)"
          />
        </template>
      </BsModal>
    </div>
  </Teleport>
</template>

<style lang="scss">
/* a workflow node's output : over the graph's full screen (z-index 1056), and framed as the
   job's output panel */
.af-node-modal {
  .modal {
    z-index: 1062;
  }
  + .modal-backdrop,
  .modal-backdrop {
    z-index: 1061;
  }
  /* its header (the name, extravars, artifacts, run time) stays in place : only the part
     under it scrolls, its scrollbar starting under the header. Its own body only : a dialog
     opened from its output (a host's Task result) keeps its padding */
  > .modal > .modal-dialog > .modal-content > .modal-body {
    padding: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .af-ansible-groups,
  .af-node-card {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }
  .af-ansible-groups {
    border-radius: 0;
  }
  .af-node-head {
    flex: none;
  }
  .af-node-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
}
</style>
