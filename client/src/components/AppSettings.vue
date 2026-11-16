<script setup>
/******************************************************************/
/*                                                                */
/*  App AnsibleForms Settings component                           */
/*  Template wrapper for a page section                           */
/*                                                                */
/*  @props:                                                       */
/*      icon: String                                              */
/*      title: String                                             */
/*      description: String - what the page is for, in a popover  */
/*                   behind an info icon after the title          */
/*      crumbs: Array of { title, icon, to } - a title in steps,  */
/*              each a link when it has a route (to) ; a title of */
/*              one step links to the page itself ; a step whose  */
/*              title is null is not known yet (a record's name   */
/*              while it loads) : a grey bar (AppSkeleton)        */
/*                                                                */
/*  Every title starts with the page's section, as the header     */
/*  names it (lib/sections.js) : Jobs › Running, Settings ›       */
/*  Users › admin. A page whose steps already start with it does  */
/*  not get it twice.                                             */
/*      bare: Boolean - the content without the card around it    */
/*                                                                */
/*  @slots:                                                       */
/*      default       the card body                               */
/*      tabs          tabs above the card                         */
/*      feedback      status text next to the title               */
/*      footer        free content directly under the card        */
/*  A table's pager in the card (AppTablePager, a record page's   */
/*  tab) moves under the card, as a list's : provided as          */
/*  'afPagerTo', its place right under the card. Its controls     */
/*  (the filter, the columns, the export) move to the title line, */
/*  as a list's : provided as 'afToolbarTo'.                      */
/*      actions       the page's buttons, top right               */
/*      headerActions view controls, next to the title            */
/*                                                                */
/*  BUTTON PLACEMENT STANDARD                                     */
/*  Every action button belongs in #actions : Save, Upload,       */
/*  Remove, Test and 'New <x>' alike. They sit at the top right   */
/*  corner of the page, on the title line, after the controls of  */
/*  #headerActions - those decide WHAT the card shows (search,    */
/*  filters, columns), the buttons act on it.                     */
/*                                                                */
/******************************************************************/
import { computed, provide, useId } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { sectionOf } from '@/lib/sections';
import { settingsSection } from '@/lib/settingsMenu';

// a title of one step links to the page itself : its plain address, without a tab or a filter
const route = useRoute();
const { t } = useI18n();

// under the card : where the pager of a table in it goes (AppTablePager), as a list's
const pagerId = `af-card-pager-${useId()}`;
provide('afPagerTo', `#${pagerId}`);
// on the title line : where the controls of a table in it go (AppLinkedTable), as a list's
const toolbarId = `af-card-tools-${useId()}`;
provide('afToolbarTo', `#${toolbarId}`);

const props = defineProps({
  icon: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  // a title in steps, each with its own icon (the forms page's sub categories :
  // Expressions › Test1) ; when given, it is shown instead of icon + title
  crumbs: {
    type: Array,
    default: () => [],
  },
  // the content without the card around it, for a page that lays out cards of its own
  bare: {
    type: Boolean,
    default: false,
  },
});

// the title's steps : the page's section first, then its own (its crumbs, or its title) ; a
// settings page also names its part of the settings menu (Settings › Appearance › Defaults), a
// step without an icon or a link, as the menu shows it
const steps = computed(() => {
  const own = props.crumbs.length ? props.crumbs : [{ title: props.title, icon: props.icon, to: route.path }];
  const section = sectionOf(route.path, t);
  const all = !section || own[0]?.title === section.title ? own : [section, ...own];
  const part = section && all[0]?.title === section.title ? settingsSection(route.path, t) : null;
  if (!part || all[1]?.title === part.title) return all;
  return [all[0], part, ...all.slice(1)];
});
</script>
<template>
  <section class="section w-100" :class="{ 'mt-3': title }">
    <div class="container-fluid">
      <div v-if="title" class="d-flex align-items-center border-bottom mb-3 pb-3 af-title-line">
        <h3 v-if="steps.length > 1" :aria-label="steps.map((c) => c.title ?? '').join(' › ')">
          <template v-for="(c, i) in steps" :key="i">
            <span v-if="i > 0" class="mx-2 text-body-secondary af-crumb-separator"
              ><FaIcon icon="chevron-right"
            /></span>
            <!-- a step with a route : a link, in the title's own look -->
            <!-- a step not known yet (a record's name while it loads) : a grey bar in its place, after
                 its icon when it has one -->
            <template v-if="c.title == null"
              ><span v-if="c.icon" class="me-2"><FaIcon :icon="c.icon" /></span><AppSkeleton shape="inline" width="6em"
            /></template>
            <router-link v-else-if="c.to" :to="c.to" class="af-crumb-link"
              ><span v-if="c.icon" class="me-2"><FaIcon :icon="c.icon" /></span>{{ c.title }}</router-link
            >
            <template v-else
              ><span v-if="c.icon" class="me-2"><FaIcon :icon="c.icon" /></span>{{ c.title }}</template
            >
          </template>
          <AppInfoPopover v-if="description" :text="description" />
        </h3>
        <h3 v-else>
          <router-link :to="route.path" class="af-crumb-link"
            ><span class="me-2"> <FaIcon :icon="icon" /> </span>{{ title }}</router-link
          >
          <AppInfoPopover v-if="description" :text="description" />
        </h3>
        <slot name="feedback"></slot>
        <!-- the view controls, then the page's buttons : a row of their own under the title, on
             every page and screen (a long title or a short one, a wide screen or a narrow one),
             the search at its left, the buttons at its right ; one box that wraps as a whole, so
             on a narrow screen every control lines up on the same rows rather than each group
             wrapping on its own (styles/bootstrap-override.scss, .af-title-controls) -->
        <div v-if="$slots.headerActions || $slots.actions" class="af-title-controls">
          <!-- the controls of a table in the card (AppLinkedTable), first as a list's search -->
          <div :id="toolbarId" class="af-title-flow"></div>
          <slot name="headerActions"></slot>
          <div v-if="$slots.actions" class="af-header-buttons">
            <slot name="actions"></slot>
          </div>
        </div>
      </div>
      <!-- a card of the page's own above its card (the runners waiting for approval) -->
      <slot name="aboveCard"></slot>
      <slot name="tabs"></slot>
      <!-- the 16px under the last card (the margin the designer also gives its card) -->
      <div v-if="!bare" class="card af-page-end" :class="{ 'tab-card-flush-card': $slots.tabs }">
        <div class="card-body">
          <slot></slot>
        </div>
      </div>
      <div v-else class="af-bare-content"><slot></slot></div>
      <!-- a table's pager in the card, under it (AppTablePager) -->
      <div :id="pagerId"></div>
      <slot name="footer"></slot>
    </div>
  </section>
</template>
<style scoped>
/* the page title never wraps (its icon above the word) : the actions next to it give way */
h3 {
  white-space: nowrap;
}
/* without the page's card, the content's own cards end the page : leave the same 16px under
   the last one as under the designer's card and the forms tiles */
.af-bare-content {
  padding-bottom: 1rem;
}
/* 16px under the card, instead of it touching the bottom of the window */
.af-page-end {
  margin-bottom: 1rem;
}
/* the buttons after the view controls : the same gap as between those ; a button's own
   leading margin (ms-3, from when they sat under the card) is replaced by it */
.tab-card-flush-card {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
</style>
