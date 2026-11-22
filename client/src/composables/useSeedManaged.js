/******************************************************************/
/*                                                                */
/*  The fields the config seed manages per field (its defaults,   */
/*  logo, icon, name and links sections : one per Appearance      */
/*  page ; its mcp section : the MCP switches, by their variable) */
/*  : read only on their pages, as every seeded object is - the   */
/*  server refuses their change (server/src/lib/seedManaged.js).  */
/*  Read from the settings row (seed_managed_fields).             */
/*                                                                */
/******************************************************************/
import { ref } from 'vue';
import axios from 'axios';

/**
 * The fields the seed manages, for a page.
 *
 * Returns:
 *   object: { seeded ((...fields) => whether one of them is the seed's), loadSeedManaged
 *     (() => Promise : read them), managed (ref of their names) }.
 */
export function useSeedManaged() {
  const managed = ref([]);
  async function loadSeedManaged() {
    try {
      const res = await axios.get('/api/v2/settings/');
      const list = JSON.parse(res.data?.seed_managed_fields || '[]');
      managed.value = Array.isArray(list) ? list : [];
    } catch {
      managed.value = [];
    }
  }
  const seeded = (...fields) => fields.some((f) => managed.value.includes(f));
  return { seeded, loadSeedManaged, managed };
}
