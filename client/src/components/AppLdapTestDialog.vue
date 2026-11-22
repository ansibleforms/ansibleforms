<script setup>
/******************************************************************/
/*                                                                */
/*  An LDAP directory's test : a test user's sign-in on it, its   */
/*  servers in order, and the user's entry as the directory       */
/*  returns it. From the directories' list (as saved) and a       */
/*  directory's page (its fields as they are, saved or not).      */
/*                                                                */
/*  @props:                                                       */
/*      directory: Object - the directory (its id, and the fields */
/*                 to test with)                                  */
/*                                                                */
/*  @emits:                                                       */
/*      close: the dialog closed                                  */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import axios from 'axios';
import yaml from 'yaml';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  directory: { type: Object, required: true },
});
const emit = defineEmits(['close']);
const { t } = useI18n();

const testUser = ref('');
const testPassword = ref('');
const testResult = ref(null);
const testing = ref(false);

/**
 * Signs the test user in on the directory : its entry shown, or why it failed in a toast.
 */
async function performTest() {
  if (!testUser.value || !testPassword.value) {
    toast.error(t('admin.ldap.provideBoth'));
    return;
  }
  testing.value = true;
  try {
    const result = await axios.post(`/api/v2/ldapdirectory/${props.directory.id}/check`, {
      ...props.directory,
      testuser: testUser.value,
      testpassword: testPassword.value,
    });
    testResult.value = result.data;
    toast.success(t('admin.ldap.connectionSuccessful'));
  } catch (err) {
    testResult.value = null;
    const errorMessage = err.response?.data?.error || err.message;
    const errorDetail = err.response?.data?.details || '';
    toast.error(errorDetail ? `${errorMessage}, ${errorDetail}` : errorMessage);
  } finally {
    testing.value = false;
  }
}

const testResultYaml = computed(() => (testResult.value ? yaml.stringify(testResult.value) : ''));
</script>
<template>
  <BsModal @close="emit('close')" icon="plug">
    <template #title>
      {{ t('admin.ldap.testTitle') }}<span v-if="directory.name"> : {{ directory.name }}</span>
    </template>
    <template #default>
      <p class="mt-3 fs-6">
        {{ t('admin.ldap.testDescription') }}
      </p>
      <BsInput
        v-model="testUser"
        :isFloating="false"
        icon="user"
        :label="t('admin.ldap.testUsername')"
        type="text"
        :placeholder="t('admin.ldap.testUsernamePlaceholder')"
        class="mb-3"
      />
      <BsInput
        v-model="testPassword"
        :isFloating="false"
        icon="lock"
        :label="t('admin.ldap.testPassword')"
        type="password"
        :placeholder="t('admin.ldap.testPasswordPlaceholder')"
        class="mb-3"
      />
      <div v-if="testResult" class="alert alert-success mt-3">
        <h6><FaIcon icon="circle-check" class="me-2" />{{ t('admin.ldap.successTitle') }}</h6>
        <div class="mt-3">
          <strong>{{ t('admin.ldap.userInfo') }}</strong>
          <pre
            class="bg-body-tertiary p-3 mt-2 rounded"
            style="max-height: 300px; overflow-y: auto"
          ><code>{{ testResultYaml }}</code></pre>
        </div>
      </div>
    </template>
    <template #footer>
      <BsButton :icon="testing ? 'spinner' : 'check'" :disabled="testing" @click="performTest">{{
        t('admin.ldap.test')
      }}</BsButton>
    </template>
  </BsModal>
</template>
