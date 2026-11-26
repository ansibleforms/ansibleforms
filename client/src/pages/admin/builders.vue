<script setup>
/******************************************************************/
/*                                                                */
/*  The builders' list (Connections > Builders) : the RTE         */
/*  builders that build and push the RTE images the Designer      */
/*  defines (the image ansibleforms-rte-builder,                  */
/*  github.com/ansibleforms/builder), kept as runners of type     */
/*  builder (config/settings.js builders). A row opens its page   */
/*  (builder.vue) ; Test connection asks its socket. One that     */
/*  asked to join waits in the notice above the list, reviewed as */
/*  a runner is (AppRunnerApproval). New is a dialog in steps,    */
/*  as a runner's : the builder, then its RTE token credential.   */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import getSettings from '@/config/settings';
import { useAppStore } from '@/stores/app';
import { useLiveEvent } from '@/composables/useLiveEvent';

const { t } = useI18n();
const store = useAppStore();
const settings = computed(() => getSettings(t).builders);
const authenticated = ref(false);
const list = ref(null);
// adding, approving, rejecting and removing builders : manageBuilders (an admin's by default)
const canManage = computed(() => !!store.profile?.options?.manageBuilders);

// ─── the builders waiting for approval : the notice above the list ───────────
const pending = ref([]);
const reviewing = ref(null);

/** Reads the builders that asked to join and wait for approval. */
async function loadPending() {
  const res = await axios.get('/api/v2/runner/?type=builder').catch(() => null);
  pending.value = (res?.data?.records || []).filter((r) => Number(r.pending));
}

/**
 * What a builder waiting for approval said of itself : its host or address, its fingerprint.
 *
 * Args:
 *   r (object): the builder.
 *
 * Returns:
 *   string: the words.
 */
function detailsOf(r) {
  let i = {};
  try {
    i = JSON.parse(r?.pending_info || '{}') || {};
  } catch {
    // nothing said
  }
  return t('designer.rte.askedFrom', { host: i.host || i.ip || '?', fingerprint: i.fingerprint || '?' });
}

/** After an approval or a rejection : the notice and the list read again. */
async function decided() {
  reviewing.value = null;
  await loadPending();
  list.value?.loadItems();
}

// a builder changed elsewhere (asked to join, approved, its socket up or down)
useLiveEvent('runners', async () => {
  await loadPending();
  list.value?.loadItems(false);
});

// ─── Test connection : its socket ─────────────────────────────────────────────
const tests = ref({});
/**
 * Tests a builder's socket, as a runner's.
 *
 * Args:
 *   item (object): the builder.
 */
async function test(item) {
  if (!item || tests.value[item.id]) return;
  tests.value[item.id] = t('admin.testing');
  try {
    const res = await axios.post(`/api/v2/runner/${item.id}/check`, {});
    toast.success(res.data.result);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('admin.connectionFailed')));
  } finally {
    delete tests.value[item.id];
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (authenticated.value) await loadPending();
});
</script>

<template>
  <AppSettingsPage>
    <AppAdminMulti
      v-if="authenticated"
      ref="list"
      :settings="settings"
      :apiVersion="2"
      :readOnly="!canManage"
      :busyItems="tests"
      @test="test"
    >
      <!-- the builders waiting for approval : a notice above the list, each one reviewed -->
      <template v-if="pending.length" #aboveCard>
        <div class="alert alert-warning">
          <div class="fw-bold mb-1">
            <FaIcon icon="hourglass-half" class="me-2" />{{
              t('settings.builders.waitingNotice', { count: pending.length }, pending.length)
            }}
          </div>
          <ul class="mb-0">
            <li v-for="r in pending" :key="r.id">
              <a href="#" class="fw-semibold" @click.prevent="reviewing = r">{{ r.name }}</a>
              <span class="text-body-secondary small ms-2">{{ detailsOf(r) }}</span>
            </li>
          </ul>
        </div>
      </template>
    </AppAdminMulti>
    <AppRunnerApproval
      v-if="reviewing"
      :key="reviewing.id"
      :runner="reviewing"
      @close="reviewing = null"
      @decided="decided"
    />
  </AppSettingsPage>
</template>
