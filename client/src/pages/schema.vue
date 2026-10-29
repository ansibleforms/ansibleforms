<script setup>
import axios from 'axios';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '@/stores/app';
import { toast } from 'vue-sonner';
import State from '@/lib/State';
import { useI18n } from 'vue-i18n';

const store = useAppStore();
// the language of this browser (the af_language cookie), else the instance's default, read below
// with the app's config : the database is not there yet, so nobody is signed in
const { t } = useI18n();

defineEmits(['recheckSchema']);

const error = store.errorMessage;
const loading = ref(false);
const countdown = ref(3);
let countdownInterval = null;

const success = computed(() => {
  return store.schemaData?.success?.join('<br>') || '';
});

const failed = computed(() => {
  return store.schemaData?.failed?.join('<br>') || '';
});

const isSchemaReady = computed(() => {
  return success.value && !failed.value && !error.value;
});

async function create() {
  loading.value = true;
  toast.info(t('schema.creating'));
  try {
    const createResult = await axios.post(`/api/v2/schema`, {});
    toast.success(createResult.data.message);
    // Full page reload to reinitialize app with new database
    window.location.href = document.baseURI;
  } catch (error) {
    toast.error(error.message);
    loading.value = false;
  }
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function startCountdown() {
  // clear first : a second call used to leave the previous interval running, so the
  // counter dropped twice a second and the reload fired early
  stopCountdown();
  countdown.value = 3;
  countdownInterval = setInterval(() => {
    countdown.value--;
    if (countdown.value <= 0) {
      stopCountdown();
      window.location.href = document.baseURI;
    }
  }, 1000);
}

// Without this the countdown survived leaving the page and then navigated the browser to
// the app root regardless of where the user had gone in the meantime - a hard reload out
// from under them a few seconds after they left.
onBeforeUnmount(stopCountdown);

onMounted(async () => {
  // the instance's default language (DEFAULT_LANGUAGE) and name : the server answers without its
  // database, from its environment
  State.loadAppConfig();
  try {
    const result = await State.checkDatabase();
    if (result) {
      startCountdown();
    }
  } catch (err) {
    // Database check failed, stay on schema page
    console.error('Database check failed:', err);
  }
});
</script>

<template>
  <section class="min-vh-100 bg-light d-flex align-items-center">
    <div class="container">
      <div v-if="!loading" class="row justify-content-center">
        <div class="col-12 col-md-8 col-lg-6">
          <div v-if="isSchemaReady" class="alert alert-success">
            <h5>{{ t('schema.ready') }}</h5>
            <p class="mb-0">{{ t('schema.redirecting', { n: countdown }, countdown) }}</p>
          </div>
          <div class="alert alert-danger" v-if="error != ''" v-text="error"></div>
          <div class="alert alert-success" v-if="success" v-html="success"></div>
          <div class="alert alert-warning" v-if="failed" v-html="failed"></div>
          <div v-if="error != 'Schema creation is disabled'">
            <form action="" class="card p-4 mb-3" v-if="failed && !success">
              <div class="mb-3">
                <p>{{ t('schema.firstSetup') }}</p>
                <p>{{ t('schema.willCreate') }}</p>
                <table class="table table-bordered">
                  <tbody>
                    <tr>
                      <th>{{ t('schema.databaseSchema') }}</th>
                      <td>AnsibleForms</td>
                    </tr>
                    <tr>
                      <th>{{ t('schema.tables') }}</th>
                      <td>{{ t('schema.allTables') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="mb-3">
                <button type="button" class="btn btn-success" @click="create()">
                  <span class="me-2"><font-awesome-icon icon="magic" /></span><span>{{ t('common.create') }}</span>
                </button>
              </div>
            </form>
            <form action="" class="card p-4 mb-3" v-if="failed && success">
              <div>{{ t('schema.partial') }}</div>
            </form>
          </div>
          <div v-else class="card p-4 mb-3">
            <div>
              {{ t('schema.disabled') }}<br />
              {{ t('schema.contactAdmin') }}
            </div>
          </div>
          <div v-if="error == 'FATAL ERROR'" class="card p-4 mb-3">
            <div>{{ t('schema.unreachable') }}</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
