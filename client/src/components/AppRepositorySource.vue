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
/*                                                                */
/******************************************************************/
import { useI18n } from 'vue-i18n';
import { repositoryBadge } from '@/lib/repositoryUsage';

defineProps({
  record: { type: Object, default: null },
});
const { t } = useI18n();
</script>

<template>
  <div v-if="record?.repository" class="mb-3 af-repository-source">
    <div class="form-label fw-bold">{{ t('settings.repositories.source') }}</div>
    <span v-html="repositoryBadge(t, record)"></span>
    <span class="ms-2 font-monospace small text-body-secondary">{{ record.repo_file }}</span>
    <div class="form-text">
      {{ t('settings.repositories.sourceRepositoryHelp', { name: record.repository }) }}
    </div>
  </div>
</template>
