// The designer's sections and the tabs each one has, by its address (/designer/<section>/<tab>).
// One list for the router (an address of a section or a tab that does not exist is not found) and
// for the designer (which tabs it shows).

/** Each section's tabs : its YAML always, its Visual and its Preview when it has them. */
export const DESIGNER_TABS = {
  categories: ['yaml', 'visual', 'preview'],
  // the constants as a table (Visual), each with its reference and the forms using it (Preview)
  constants: ['yaml', 'visual', 'preview'],
  forms: ['yaml', 'visual', 'preview'],
  // an inventory's groups and hosts edited (Visual), shown as a tree (Preview) ; its vars files'
  // variables edited, shown with how a playbook reads them
  inventories: ['yaml', 'visual', 'preview'],
  // a playbook : its YAML, its plays and tasks as fields (Visual), its outline (Preview)
  playbooks: ['yaml', 'visual', 'preview'],
  // a vars file's variables edited (Visual), shown with how a playbook reads them (Preview)
  varsfiles: ['yaml', 'visual', 'preview'],
  // a workflow as its graph (the Visual tab), and a dry run of it (the Preview tab)
  workflows: ['yaml', 'visual', 'preview'],
  // an RTE image's fields (Visual), its entry (YAML), the Dockerfile it builds (Preview)
  rteimages: ['yaml', 'visual', 'preview'],
};

/** Every tab a section may have. */
const EDITORS = ['yaml', 'visual', 'preview'];

/**
 * Whether a designer address names what the designer has : a section of it, a tab of that
 * section, nothing more ; a form in the forms section (/designer/forms/<form>/<tab>).
 *
 * Args:
 *   params (object): the route's params - view (the section), item, editor.
 *
 * Returns:
 *   boolean: false for an address to answer as not found.
 */
export function designerAddressExists({ view, item, editor } = {}) {
  if (!view) return !item && !editor;
  const tabs = DESIGNER_TABS[view];
  if (!tabs) return false;
  if (view === 'forms') {
    // /designer/forms/<tab>, or /designer/forms/<form>[/<tab>]
    if (item && EDITORS.includes(item)) return !editor && tabs.includes(item);
    return !editor || tabs.includes(editor);
  }
  if (editor) return false;
  return !item || tabs.includes(item);
}
