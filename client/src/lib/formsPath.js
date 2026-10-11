/******************************************************************/
/*                                                                */
/*  The forms' addresses : every form at /forms/all, the forms of */
/*  a category at /forms/<category>, a sub category under its     */
/*  parent - /forms/demo, /forms/expressions/test1 - and a form   */
/*  at /form/<form>, whatever category it is opened from (a form  */
/*  may be in several, or in none). A name is written in the      */
/*  address as a page's would be : lower case, words joined by a  */
/*  dash ('Network Ops' is network-ops), and read back against    */
/*  the names of the forms config.                                */
/*                                                                */
/******************************************************************/

// the forms list's own name for every form, never a category's
export const ALL_FORMS = 'all';

/**
 * A category's or a form's name as it reads in an address.
 *
 * Args:
 *   name (string): the name ('Network Ops').
 *
 * Returns:
 *   string: lower case, every run of other characters a dash, none at either end
 *     ('network-ops').
 */
export function slugOf(name) {
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
  return '/forms/' + category.split('/').map(slugOf).join('/');
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
    const found = level.find((c) => slugOf(c.name) === part);
    if (!found) return null;
    names.push(found.name);
    level = found.items || [];
  }
  return names.join('/');
}

/**
 * A form's address.
 *
 * Args:
 *   name (string): the form's name ('Approval demo').
 *
 * Returns:
 *   string: /form/<its name in the address> (/form/approval-demo).
 */
export function formPath(name) {
  return `/form/${slugOf(name)}`;
}

/**
 * The form an address names, by the names of the forms the user may open.
 *
 * Args:
 *   slug (string): the address after /form/ ('approval-demo').
 *   forms (Array): the forms, each { name } (the forms list, /api/v2/config/formlist).
 *
 * Returns:
 *   string|null: the form's name ('Approval demo'), its exact name first when two forms
 *     read the same in an address ('Test 1', 'test-1') ; null when no form has it.
 */
export function formFromPath(slug, forms) {
  const named = (forms || []).filter((f) => slugOf(f.name) === slug);
  if (!named.length) return null;
  return (named.find((f) => f.name === slug) || named[0]).name;
}
