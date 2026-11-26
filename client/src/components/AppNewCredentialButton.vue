<script setup>
/******************************************************************/
/*                                                                */
/*  Add credential : the button of a record's Credentials tab,    */
/*  under its credential dropdown - the credentials' own dialog   */
/*  over the page, its type preset ; the credential it creates    */
/*  is said back (created), for the page to choose it.            */
/*                                                                */
/*  @props:                                                       */
/*      type: String - the credential type preset (ldap, smtp...) */
/*      disabled: Boolean - the record cannot be changed now      */
/*  @emits:                                                       */
/*      created: String - the new credential's name               */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import getSettings from '@/config/settings';

defineProps({
  type: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  // its words when the kind it makes says it better (New registry) ; New credential without
  label: { type: String, default: '' },
});
const emit = defineEmits(['created']);
const { t } = useI18n();
const credentialsSettings = computed(() => getSettings(t).credentials);
const creator = ref(null);
</script>
<template>
  <BsButton icon="plus" :disabled="disabled" @click="creator?.newItem(type ? { credential_type: type } : {})">{{
    label || t('settings.repositories.newCredential')
  }}</BsButton>
  <!-- the credentials' dialog only, over the page -->
  <div class="af-nested-dialogs">
    <AppAdminMulti
      ref="creator"
      dialogOnly
      :apiVersion="2"
      :settings="credentialsSettings"
      @created="(name) => emit('created', name)"
    />
  </div>
</template>
