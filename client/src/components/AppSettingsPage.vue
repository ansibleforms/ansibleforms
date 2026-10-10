<script setup>
/******************************************************************/
/*                                                                */
/*  The frame of a settings page : the header, then the settings  */
/*  sidebar beside the page's own content (the default slot).     */
/*  Every page under Settings used to repeat it.                  */
/*                                                                */
/*  @props:                                                       */
/*      withSidebar: Boolean - af-with-sidebar on main (a page    */
/*        that scrolls its own pane, the logs)                    */
/*                                                                */
/******************************************************************/
defineProps({
  withSidebar: { type: Boolean, default: false },
});
</script>
<template>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout" :class="{ 'af-with-sidebar': withSidebar }">
      <AppSidebar />
      <slot></slot>
    </main>
  </div>
</template>
