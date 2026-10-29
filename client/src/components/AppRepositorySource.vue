<script setup>
/******************************************************************/
/*                                                                */
/*  Where an object kept in a repository comes from, on its page  */
/*  (a schedule's, a credential's, a runner's) : its Source, the  */
/*  Repository: <name> badge, its file beside it, and what a save */
/*  does. Nothing for an object kept in the app only.             */
/*                                                                */
/*  Props                                                         */
/*    record  the object ({ repository, repo_file })              */
/*    type    a type kept in one file (chat, settings, defaults) :*/
/*            the repository that holds it, read here             */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { repositoryBadge, singleTypeSource } from '@/lib/repositoryUsage';

const props = defineProps({
  record: { type: Object, default: null },
  type: { type: String, default: '' },
});
const { t } = useI18n();
// a type kept in one file : where it is, as a record of a repository says it
const single = ref(null);
onMounted(async () => {
  if (props.type) single.value = await singleTypeSource(props.type);
});
const source = computed(() => (props.type ? single.value : props.record));
</script>

<template>
  <div v-if="source?.repository" class="mb-3 af-repository-source">
    <div class="form-label fw-bold">{{ t('settings.repositories.source') }}</div>
    <span v-html="repositoryBadge(t, source)"></span>
    <span class="ms-2 font-monospace small text-body-secondary">{{ source.repo_file }}</span>
    <div class="form-text">
      {{ t('settings.repositories.sourceRepositoryHelp', { name: source.repository }) }}
    </div>
  </div>
</template>
