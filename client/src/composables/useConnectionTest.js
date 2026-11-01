// ─── Test connection ─────────────────────────────────────────────────────────
// A record's Test connection, from its list (a row's menu) or its page : one test at a time per
// record, its answer told in a toast. What it posts to is the record's own (a database's
// /api/v2/database/<id>/check).
import { ref } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers';

/**
 * Tests a record's connection, once at a time per record.
 *
 * Args:
 *   urlOf (function): (item) => the url Test connection posts to.
 *
 * Returns:
 *   object: { tests, test } - tests the records being tested ({ <id>: 'Testing...' }, a list's
 *     busyItems), test(item) runs one.
 */
export function useConnectionTest(urlOf) {
  const { t } = useI18n();
  const tests = ref({});

  /**
   * Tests one record : its answer's message, or its error, in a toast ; a second press while it
   * runs only says so.
   *
   * Args:
   *   item (object): the record ({ id }).
   *
   * Returns:
   *   Promise<void>: settles once it answered.
   */
  async function test(item) {
    if (!item) return;
    if (tests.value[item.id]) {
      toast.warning(t('admin.testInProgress'));
      return;
    }
    try {
      tests.value[item.id] = t('admin.testing');
      const result = await axios.post(urlOf(item), {});
      toast.success(result.data.message);
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err, t('admin.connectionFailed')));
    } finally {
      delete tests.value[item.id];
    }
  }

  return { tests, test };
}
