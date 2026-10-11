/******************************************************************/
/*                                                                */
/*  useRouteTab : a page's tab kept in its address, its last part */
/*  (/settings/sso/providers, /settings/users/1/groups), as every */
/*  place in the app is ; its route ends in /:tab? (the router).  */
/*                                                                */
/*  The tab shown follows the url and the url follows the tab : a */
/*  link or a bookmark opens a tab, the title's steps link to     */
/*  theirs, and Back returns to the tab before. The first tab has */
/*  no part of its own, so a page's plain address still opens it. */
/*                                                                */
/******************************************************************/
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/**
 * A tab kept in the url.
 *
 * Args:
 *   firstTab (string|Function): the tab shown without ?tab (a function when it depends on the
 *     page, as the settings pages').
 *   isTab (Function): whether a key is one of the page's tabs (an unknown ?tab opens the first).
 *
 * Returns:
 *   object: { activeTab (a ref : set it to change the tab), tabLink (key) => the route of a tab }.
 */
export function useRouteTab(firstTab, isTab = () => true) {
  const route = useRoute();
  const router = useRouter();
  const first = () => (typeof firstTab === 'function' ? firstTab() : firstTab);
  // ------------------------------------------------------------------
  // the tab the url names, when it is one of the page's ; else the first
  // ------------------------------------------------------------------
  const fromRoute = () => {
    const key = route.params?.tab ? String(route.params.tab) : '';
    return key && isTab(key) ? key : first();
  };
  const activeTab = ref(fromRoute());

  /**
   * The route of a tab : this page, its tab as the last part of the address (none for the first
   * tab).
   *
   * Args:
   *   key (string): the tab.
   *
   * Returns:
   *   object: a route location.
   */
  const tabLink = (key) => {
    const params = { ...route.params };
    if (key && key !== first()) params.tab = key;
    else delete params.tab;
    return { name: route.name, params, query: route.query };
  };

  // ------------------------------------------------------------------
  // the url changed (a link, Back) : its tab ; the tab changed : the url
  // ------------------------------------------------------------------
  watch(
    () => route.path,
    () => {
      activeTab.value = fromRoute();
    },
  );
  watch(activeTab, (key) => {
    const want = key && key !== first() ? key : undefined;
    if ((route.params?.tab || undefined) !== want) router.replace(tabLink(key));
  });
  // a tab the page does not have (or the first tab's own name) : the page's plain address
  if (route.params?.tab && fromRoute() === first()) router.replace(tabLink(first()));
  return { activeTab, tabLink };
}
