/******************************************************************/
/*                                                                */
/*  A playbook job's structured events, for the hosts-and-tasks   */
/*  panel (components/AppJobEvents.vue) : read with the job,      */
/*  shown on demand. A job's page and the form's output use it.   */
/*  A playbook run on an RTE has them, and a job run on AWX, AAP  */
/*  or Ascender (an awx job, read from AWX's job events).         */
/*                                                                */
/******************************************************************/
import { ref } from 'vue';
import axios from 'axios';

// the job types that have events : a playbook on an RTE, a job on AWX, AAP or Ascender (awx)
const EVENT_JOB_TYPES = new Set(['ansible', 'awx']);

/**
 * The events of the job shown, and whether their panel is open.
 *
 * Returns:
 *   { jobEvents: Ref<object[]>, showEvents: Ref<boolean>, loadEvents: function }:
 *     loadEvents(id, jobType) reads them again ; another job starts with none and the panel closed.
 */
export function useJobEvents() {
  const jobEvents = ref([]);
  const showEvents = ref(false);
  let eventsOf = null;

  /**
   * Reads a job's events (a playbook job's, or an awx job's : AWX, AAP, Ascender).
   *
   * Args:
   *   id (number): the job.
   *   jobType (string): its type ; none but ansible and awx have events.
   */
  async function loadEvents(id, jobType) {
    if (eventsOf !== id) {
      eventsOf = id;
      jobEvents.value = [];
      showEvents.value = false;
    }
    if (!id || (jobType && !EVENT_JOB_TYPES.has(jobType))) return;
    try {
      const res = await axios.get(`/api/v2/job/${id}/events`);
      if (eventsOf === id) jobEvents.value = res.data?.records || [];
    } catch {
      // none, or an older server : no panel
    }
  }

  return { jobEvents, showEvents, loadEvents };
}

export default useJobEvents;
