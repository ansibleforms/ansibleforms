/******************************************************************/
/*                                                                */
/*  The branding fields the config seed manages (its branding     */
/*  section : the name, the links and the Designer's, the         */
/*  defaults, the language, the logo, the icon) : read only on    */
/*  the Appearance pages, as every seeded object is - the server  */
/*  refuses their change (server/src/lib/brandingManaged.js). Read */
/*  from the settings row (branding_managed).                     */
/*                                                                */
/******************************************************************/
import { ref } from 'vue';
import axios from 'axios';

/**
 * The branding fields the seed manages, for a page.
 *
 * Returns:
 *   object: { seeded ((...fields) => whether one of them is the seed's), loadBrandingSeed
 *     (() => Promise : read them), managed (ref of their names) }.
 */
export function useBrandingSeed() {
  const managed = ref([]);
  async function loadBrandingSeed() {
    try {
      const res = await axios.get('/api/v2/settings/');
      const list = JSON.parse(res.data?.branding_managed || '[]');
      managed.value = Array.isArray(list) ? list : [];
    } catch {
      managed.value = [];
    }
  }
  const seeded = (...fields) => fields.some((f) => managed.value.includes(f));
  return { seeded, loadBrandingSeed, managed };
}
