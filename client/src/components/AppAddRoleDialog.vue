<script setup>
/******************************************************************/
/*                                                                */
/*  Add role : the dialog of a user's or a group's Roles tab - a  */
/*  role it is not named in yet, picked from a list ; Save names  */
/*  it there (the page saves the forms config).                   */
/*                                                                */
/*  @props:                                                       */
/*      choices: Array - the role names it can be added to        */
/*  @emits:                                                       */
/*      save: String - the role picked                            */
/*      close: the dialog closed without saving                   */
/*                                                                */
/******************************************************************/
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  choices: { type: Array, required: true },
});
const emit = defineEmits(['save', 'close']);
const { t } = useI18n();
// the role picked : the first one at first
const picked = ref(props.choices[0] || '');
</script>
<template>
  <BsModal size="md" icon="user-shield" @close="emit('close')">
    <template #title>{{ t('settings.settingsPage.addRole') }}</template>
    <template #default>
      <label class="form-label fw-bold" for="af-add-role">{{ t('settings.common.role') }}</label>
      <div class="input-group">
        <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="user-shield" /></span>
        <select id="af-add-role" v-model="picked" class="form-select" :disabled="!choices.length">
          <option v-for="n in choices" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div v-if="!choices.length" class="text-muted small mt-1">{{ t('settings.settingsPage.noRoleLeft') }}</div>
    </template>
    <template #footer>
      <BsButton icon="save" :disabled="!picked" @click="emit('save', picked)">{{ t('settings.common.save') }}</BsButton>
    </template>
  </BsModal>
</template>
