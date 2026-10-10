/******************************************************************/
/*                                                                */
/*  The forms list's addresses : every form at /forms/all, the    */
/*  forms of a category at /forms/<category>, a sub category      */
/*  under its parent - /forms/demo, /forms/expressions/test1. A   */
/*  category is named in the address as a page would be : lower   */
/*  case, words joined by a dash ('Network Ops' is network-ops),  */
/*  and read back against the categories of the forms config.     */
/*                                                                */
/******************************************************************/

// the forms list's own name for every form, never a category's
export const ALL_FORMS = 'all';

/**
 * A category's name as it reads in an address.
 *
 * Args:
 *   name (string): the category's name ('Network Ops').
 *
 * Returns:
 *   string: lower case, every run of other characters a dash, none at either end
 *     ('network-ops').
 */
export function categorySlug(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The forms list's address for a category.
 *
 * Args:
 *   category (string): the category's path of names ('Expressions/Test1') ; empty, every form.
 *
 * Returns:
 *   string: /forms/all, or /forms/<slug>/<slug>...
 */
export function formsPath(category) {
  if (!category) return `/forms/${ALL_FORMS}`;
  return '/forms/' + category.split('/').map(categorySlug).join('/');
}

/**
 * The category an address names, by the names of the forms config.
 *
 * Args:
 *   slugs (string|string[]): the address after /forms/ ('expressions/test1'), or its parts.
 *   categories (Array): the config's categories, each { name, items } (items : its subs).
 *
 * Returns:
 *   string|null: the category's path of names ('Expressions/Test1') ; '' for every form
 *     (/forms/all, or nothing) ; null when no category has that address.
 */
export function categoryFromPath(slugs, categories) {
  const parts = (Array.isArray(slugs) ? slugs : String(slugs || '').split('/')).filter(Boolean);
  if (!parts.length || (parts.length === 1 && parts[0] === ALL_FORMS)) return '';
  const names = [];
  let level = categories || [];
  for (const part of parts) {
    const found = level.find((c) => categorySlug(c.name) === part);
    if (!found) return null;
    names.push(found.name);
    level = found.items || [];
  }
  return names.join('/');
}
