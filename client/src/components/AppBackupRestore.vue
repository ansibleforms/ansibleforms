<script>
// the backups being restored, by folder : shared by every instance (the backups' list and a
// backup's page), so a restore started on one is not started again from the other meanwhile
const restores = {};
</script>
<script setup>
/******************************************************************/
/*                                                                */
/*  A backup's Restore dialog : what the backup holds, the        */
/*  "create a new backup before restoring" switch, Restore and,   */
/*  when it holds one, Restore environment. Opened from the       */
/*  backups' list (its row's Restore) and from a backup's page    */
/*  (its Restore button) : one dialog, one restore flow.          */
/*                                                                */
/******************************************************************/
import { ref, watch } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers.js';

const { t } = useI18n();

const props = defineProps({
  // the backup to restore (a record of GET /api/v2/backup) ; null : the dialog closed
  backup: { type: Object, default: null },
});
// close : the dialog is done with (the parent forgets the backup) ; restored : a restore
// finished, the parent reads its records again
const emit = defineEmits(['close', 'restored']);

const backupFirst = ref(true);
// every time it opens, the switch is on again (recommended)
watch(
  () => props.backup,
  () => {
    backupFirst.value = true;
  },
);

/**
 * Closes the dialog.
 */
function restoreClose() {
  emit('close');
}

// Separate from triggerRestore on purpose. The environment file is captured by every backup
// but never restored with one, because DB_HOST, the paths and the TLS locations in it describe
// the machine the backup was taken on - so this is an explicit, separate action.
/**
 * Restores the backup's environment file only.
 *
 * Args:
 *   item (object): the backup.
 */
async function triggerRestoreEnv(item) {
  try {
    const result = await axios.post(`/api/v2/backup/${item.folder}/restore-env`, {});
    const data = result.data?.data ?? result.data;
    if (data?.restored) {
      toast.success(t('admin.backups.restoreEnvDone'));
    } else {
      toast.warning(data?.reason || t('admin.backups.notFound'));
    }
    restoreClose();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

/**
 * Restores the backup (the database, config.yaml and the forms folder), after a new backup
 * when the switch is on.
 *
 * Args:
 *   item (object): the backup.
 */
async function triggerRestore(item) {
  // the button is hidden for these, but the row action can still open the dialog :
  // never send a restore the server is going to refuse anyway
  if (item && !item.valid) {
    toast.error(t('admin.backups.incompleteDetail'));
    return;
  }
  // Read the choice BEFORE closing the dialog : closing resets backupFirst to true, and it
  // used to run first - so unticking "backup before restore" changed nothing and a full
  // mysqldump was taken every time. Worse than wasted work: the model aborts the whole
  // restore when that pre-backup fails, so a restore could be refused because of a backup
  // the user had explicitly declined.
  const withBackup = backupFirst.value;
  restoreClose();
  if (item) {
    if (!restores[item.folder]) {
      try {
        restores[item.folder] = t('admin.backups.restoring');
        const result = await axios.post(`/api/v2/backup/${item.folder}/restore?backupFirst=${withBackup}`, {});
        // restored, but the older schema could not be brought up to this release : a warning
        if (result.data?.schemaUpgraded === false) toast.warning(result.data.message);
        else toast.success(result.data.message);
        emit('restored', item);
      } catch (err) {
        const msg = Helpers.parseAxiosResponseError(err, t('admin.backups.restoreFailed'));
        toast.error(msg);
      } finally {
        // by FOLDER, the key it was set under. A backup record has no `id` at all
        // (describeBackup returns folder/date/description/valid), so this deleted
        // restores[undefined] and left the in-progress marker set for ever -
        // every later restore of that folder answered "restore in progress" and
        // the only way out was reloading the page.
        delete restores[item.folder];
      }
    } else {
      toast.warning(t('admin.backups.restoreInProgress'));
    }
  }
}
</script>

<template>
  <BsModal v-if="backup" @close="restoreClose" icon="undo">
    <template #title> {{ t('admin.backups.restoreTitle') }} {{ backup.folder }} </template>
    <template #default>
      <div v-if="!backup.valid" class="alert alert-warning mt-3 mb-0" role="alert">
        <strong>{{ t('admin.backups.incomplete') }}</strong><br />
        {{ t('admin.backups.incompleteDetail') }}
      </div>
      <ul class="list-group list-group-flush mt-3">
        <li class="list-group-item">
          <strong>{{ t('admin.backups.folder') }}:</strong> {{ backup.folder }}
        </li>
        <li class="list-group-item">
          <strong>{{ t('admin.backups.date') }}:</strong> {{ Helpers.formatServerDate(backup.date) }}
        </li>
        <li class="list-group-item" v-if="backup.description">
          <strong>{{ t('admin.backups.description') }}:</strong> {{ backup.description }}
        </li>
        <li class="list-group-item">
          <strong>{{ t('admin.backups.backupFile') }}:</strong>
          <span v-if="backup.backupFileExists">
            {{ backup.backupFileName }} ({{ Helpers.humanFileSize(backup.backupFileSize) }})
          </span>
          <span v-else>
            {{ t('admin.backups.notFound') }}
          </span>
        </li>
        <li class="list-group-item">
          <strong>{{ t('admin.backups.configYaml') }}:</strong>
          <span v-if="backup.configYamlExists">
            {{ backup.configYamlName }} ({{ Helpers.humanFileSize(backup.configYamlSize) }})
          </span>
          <span v-else>
            {{ t('admin.backups.notFound') }}
          </span>
        </li>
        <li class="list-group-item">
          <strong>{{ t('admin.backups.envFile') }}:</strong>
          <span v-if="backup.envFileExists">
            {{ backup.envFileName }} ({{ Helpers.humanFileSize(backup.envFileSize) }})
            <div class="form-text">{{ t('admin.backups.envFileHelp') }}</div>
          </span>
          <span v-else>
            {{ t('admin.backups.notFound') }}
          </span>
        </li>
        <li class="list-group-item">
          <strong>{{ t('admin.backups.formsDirectory') }}:</strong>
          <span v-if="backup.formsDirExists">
            {{ backup.formsDirName }}/ ({{ t('admin.backups.fileCount', backup.formsDirFileCount) }},
            {{ Helpers.humanFileSize(backup.formsDirTotalSize) }})
          </span>
          <span v-else>
            {{ t('admin.backups.notFound') }}
          </span>
        </li>
      </ul>
      <br />
      <BsCheckbox v-model="backupFirst" :label="t('admin.backups.backupBeforeRestore')" class="mb-3" />
    </template>
    <template #footer>
      <BsButton
        v-if="backup.envFileExists"
        icon="file-import"
        colorClass="secondary"
        @click="triggerRestoreEnv(backup)"
        >{{ t('admin.backups.restoreEnv') }}</BsButton
      >
      <BsButton v-if="backup.valid" icon="undo" @click="triggerRestore(backup)">{{
        t('admin.backups.restoreTitle')
      }}</BsButton>
    </template>
  </BsModal>
</template>
