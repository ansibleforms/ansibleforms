// The designer's views, as its left menu lists them : their name (in the address, slugged), label,
// description and icon. The designer shows them (pages/designer.vue) ; the start-up screen draws
// its menu with them before the designer runs (AppLoadingScreen).

/**
 * The designer's views, in their own order (the menu sorts them by label).
 *
 * Args:
 *   t (Function): vue-i18n's translate function.
 *
 * Returns:
 *   Array: [{ name, label(), description(), icon }].
 */
export function designerViews(t) {
  return [
    {
      name: 'Categories',
      label: () => t('sidebar.categories'),
      description: () => t('settings.settingsPage.categoriesDescription'),
      icon: 'folder-tree',
    },
    {
      name: 'Constants',
      label: () => t('sidebar.constants'),
      description: () => t('settings.settingsPage.constantsDescription'),
      icon: 'sliders-h',
    },
    {
      name: 'Forms',
      label: () => t('nav.forms'),
      description: () => t('designer.formsDescription'),
      icon: 'far,rectangle-list',
    }, // the header's Forms icon, outlined : the solid one is a dark blob at menu size
    // the sections still to build : an empty text area each for now, nothing saved
    {
      // a file of code
      name: 'Playbooks',
      label: () => t('designer.playbooks'),
      description: () => t('designer.playbooksDescription'),
      icon: 'file-code',
    },
    {
      // groups and hosts, as a tree
      name: 'Inventories',
      label: () => t('designer.inventories'),
      description: () => t('designer.inventoriesDescription'),
      icon: 'sitemap',
    },
    {
      // the YAML files a form loads (varsFiles)
      name: 'VarsFiles',
      label: () => t('designer.varsFiles'),
      description: () => t('designer.varsFilesDescription'),
      icon: 'file-lines',
    },
    {
      name: 'RteImages',
      label: () => t('designer.rte.imagesLabel'),
      description: () => t('designer.rte.imagesDescription'),
      icon: 'cubes',
    },
    {
      // nodes joined by lines, as AWX draws a workflow
      name: 'Workflows',
      label: () => t('designer.workflows'),
      description: () => t('designer.workflowsDescription'),
      icon: 'diagram-project',
    },
  ];
}

export default { designerViews };
