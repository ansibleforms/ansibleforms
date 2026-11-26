// The designer's toolbar : every action a section may offer, with its icon and its title, in
// one order - so the same action looks the same and stands in the same place in every section
// (Categories, Constants, Forms, Inventories, Playbooks, Vars files). A section says which
// actions it has and what they do (AppDesignerToolbar draws them) ; never an icon of its own.

/**
 * The actions, in the order the toolbar shows them : the file, saving it, editing its text,
 * its content, then leaving it as it was.
 *
 * Each : icon (Font Awesome), title (a locale key ; a section may give its own words, as
 * "New inventory" for New file).
 */
export const DESIGNER_ACTIONS = {
  // the file
  newFile: { icon: 'file-circle-plus', title: 'designer.newFile' },
  import: { icon: 'file-import', title: 'designer.import' },
  loadRepository: { icon: 'cloud-arrow-down', title: 'designer.loadRepository' },
  // saving it : checked, written locally, pushed to its repository, or an earlier one restored
  validate: { icon: 'check', title: 'designer.validate' },
  save: { icon: 'save', title: 'designer.save' },
  push: { icon: 'fab,git', title: 'designer.saveRepository' },
  restore: { icon: 'trash-arrow-up', title: 'designer.restore' },
  // editing its text (the YAML tab)
  undo: { icon: 'rotate-left', title: 'designer.undo' },
  redo: { icon: 'rotate-right', title: 'designer.redo' },
  cut: { icon: 'scissors', title: 'designer.cut' },
  copy: { icon: 'copy', title: 'designer.copy' },
  paste: { icon: 'paste', title: 'designer.paste' },
  format: { icon: 'indent', title: 'designer.format' },
  find: { icon: 'magnifying-glass', title: 'designer.findReplace' },
  diff: { icon: 'right-left', title: 'designer.diff' },
  // its content : a row added, the rows edited ; a form's own
  add: { icon: 'plus', title: 'designer.add' },
  // a variable added to the vars file open (its Visual tab) : apart from add, which in the
  // inventories is a new inventory
  addVar: { icon: 'square-plus', title: 'designer.files.addKey' },
  edit: { icon: 'pencil', title: 'designer.edit' },
  formSettings: { icon: 'pencil', title: 'designer.formSettings' },
  icon: { icon: 'icons', title: 'designer.chooseIcon' },
  tileColor: { icon: 'palette', title: 'designer.chooseBackground' },
  image: { icon: 'image', title: 'designer.chooseImage' },
  categories: { icon: 'folder-tree', title: 'designer.assignCategories' },
  roles: { icon: 'user-shield', title: 'designer.assignRoles' },
  insertConstant: { icon: 'sliders-h', title: 'designer.insertConstant' },
  fieldProperties: { icon: 'list-check', title: 'designer.fieldProperties' },
  // leaving it : read again, taken away, or back as it was saved
  reload: { icon: 'arrows-rotate', title: 'designer.files.reload' },
  download: { icon: 'download', title: 'designer.download' },
  revert: { icon: 'clock-rotate-left', title: 'designer.revert' },
  // an RTE image's YAML : a part of it set or added in a dialog, as a form's icon or roles
  rteArch: { icon: 'server', title: 'designer.rte.setArch' },
  rtePython: { icon: 'fab,python', title: 'designer.rte.setPython' },
  rteCore: { icon: 'microchip', title: 'designer.rte.setCore' },
  rteCollection: { icon: 'box-open', title: 'designer.rte.addCollection' },
  rtePythonPackages: { icon: 'cubes', title: 'designer.rte.addPythonPackages' },
  rteOsPackages: { icon: 'boxes-stacked', title: 'designer.rte.addOsPackages' },
  rteRegistry: { icon: 'warehouse', title: 'designer.rte.setRegistry' },
  rteSigning: { icon: 'signature', title: 'designer.rte.setSigning' },
  // a runtime environment : built on a builder (removed with the explorer's ×, as every section's items)
  build: { icon: 'hammer', title: 'designer.rte.build' },
};

/** The order of the actions : their keys as DESIGNER_ACTIONS lists them. */
export const ACTION_ORDER = Object.keys(DESIGNER_ACTIONS);

/**
 * The buttons a toolbar draws : the actions a section offers that show, in the standard order,
 * each with its icon and its title.
 *
 * Args:
 *   actions (object[]): { key (of DESIGNER_ACTIONS), run, disabled, show (default true), title
 *     (words of its own, optional), color (orange for a push waiting, optional) }.
 *   t (function): the translation function.
 *
 * Returns:
 *   object[]: { key, icon, title, run, disabled, color }.
 *
 * Raises:
 *   Error: an action that is not one of DESIGNER_ACTIONS - a section never draws its own.
 */
export function toolbarButtons(actions, t) {
  return (actions || [])
    .filter((a) => a && a.show !== false)
    .map((a) => {
      const def = DESIGNER_ACTIONS[a.key];
      if (!def) throw new Error(`Unknown designer action '${a.key}'`);
      return {
        key: a.key,
        icon: def.icon,
        title: a.title || t(def.title),
        run: a.run,
        disabled: !!a.disabled,
        color: a.color || null,
      };
    })
    .sort((a, b) => ACTION_ORDER.indexOf(a.key) - ACTION_ORDER.indexOf(b.key));
}
