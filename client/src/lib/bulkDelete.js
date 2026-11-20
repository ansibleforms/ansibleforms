/******************************************************************/
/*                                                                */
/*  Delete for the rows ticked in a record page's tab table (a    */
/*  user's jobs, stored jobs, schedules ; a runner's jobs) : asks */
/*  first, as the lists' Delete, then deletes each one and says   */
/*  how it went.                                                  */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';
import { askConfirm } from '@/lib/confirmPrompt';

/**
 * Deletes records one by one after asking ; a failure is said, the others still go.
 *
 * Args:
 *   t (Function): the translator.
 *   urls (string[]): the api address of each record to delete.
 *
 * Returns:
 *   Promise<boolean>: true when it was asked and done (to read the table again), false when
 *     the question was turned down or there was nothing to delete.
 */
export async function deleteRecords(t, urls) {
  if (!urls.length) return false;
  const question = t('settings.common.bulkDeleteConfirm', { count: urls.length }, urls.length);
  if (!(await askConfirm(question, { title: t('common.delete'), icon: 'trash' }))) return false;
  const results = await Promise.allSettled(urls.map((url) => axios.delete(url)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast.error(Helpers.parseAxiosResponseError(failed[0].reason, t('common.delete')));
  if (failed.length < results.length)
    toast.success(t('settings.common.countDeleted', { n: results.length - failed.length }));
  return true;
}
