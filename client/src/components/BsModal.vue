<script setup>
/******************************************/
/*                                        */
/*  Bootstrap modal component             */
/*                                        */
/*  @props:                               */
/*      icon: String - the icon before    */
/*         the title, every modal has one */
/*         : the icon of the action that  */
/*         opened it (tests/modal-icons)  */
/*      iconClass: String - a class on    */
/*         that icon (text-warning ...)   */
/*      size: String                      */
/*      blur: Boolean - the page behind   */
/*         blurred, not only darkened (the */
/*         disclaimer : read it first)    */
/*      dialogClass: String - a class on  */
/*         the dialog box itself          */
/*        'sm' | 'md' | 'lg' | 'xl'        */
/*        'md' is Bootstrap's default      */
/*        width (no modal-* class).        */
/*        Defaults to 'xl', which is what  */
/*        every modal was hard-coded to.   */
/*      footerClose: Boolean - the Close  */
/*         button in the footer (default  */
/*         true) ; false when the footer  */
/*         holds the choices and the      */
/*         header's cross closes          */
/*                                        */
/*  @slots:                               */
/*      title: String                     */
/*      top: above the content, out of    */
/*         its scroll (a wizard's steps)  */
/*      default: String                   */
/*      footer: String                    */
/*                                        */
/*  @emit:                                */
/*      close: Event                      */
/*                                        */
/******************************************/

import { getCurrentInstance, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { backdropPress } from '@/lib/backdropPress';

// INIT

const { t } = useI18n();
const { uid } = getCurrentInstance();
const emit = defineEmits(['close']);
const props = defineProps({
  icon: { type: String, default: '' },
  iconClass: { type: String, default: '' },
  size: { type: String, default: 'xl' },
  dialogClass: { type: String, default: '' },
  footerClose: { type: Boolean, default: true },
  closable: { type: Boolean, default: true },
  blur: { type: Boolean, default: false },
});

// Bootstrap has modal-sm/-lg/-xl but no modal-md : the default width is the
// absence of a class, so 'md' must not emit one.
const sizeClass = computed(() => (props.size && props.size !== 'md' ? `modal-${props.size}` : ''));

// METHODS

// a press on the backdrop closes the modal : one that starts inside it (selecting text, a
// drag) and ends outside does not (lib/backdropPress.js)
const press = backdropPress((target) => target?.id == uid);

function backdropClick(e) {
  if (press.closes(e) && props.closable) {
    emit('close');
  }
}
</script>

<template>
  <div
    @mousedown="press.down"
    @click="backdropClick"
    :id="uid"
    class="modal fade show d-block"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    data-bs-keyboard="true"
    aria-hidden="true"
    data-bs-backdrop="static"
  >
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable" :class="[sizeClass, dialogClass]">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">
            <FaIcon v-if="icon" :icon="icon" class="me-2" :class="iconClass" /><slot name="title"></slot>
          </h5>
          <button
            v-if="closable"
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            :aria-label="t('common.close')"
            @click="emit('close')"
          ></button>
        </div>
        <!-- above the content, out of its scroll : the scrollbar starts under it -->
        <div v-if="$slots.top" class="af-modal-top">
          <slot name="top"></slot>
        </div>
        <div class="modal-body">
          <slot></slot>
        </div>
        <div class="modal-footer">
          <slot name="footer"></slot>
          <BsButton v-if="footerClose" icon="times" @click="emit('close')">{{ t('common.close') }}</BsButton>
        </div>
      </div>
    </div>
  </div>
  <div class="modal-backdrop fade show" :class="{ 'af-backdrop-blur': blur }"></div>
</template>
<style scoped>
/* as the body's padding, its bottom half : the content's own top padding parts the two */
.af-modal-top {
  flex-shrink: 0;
  padding: var(--bs-modal-padding) var(--bs-modal-padding) calc(var(--bs-modal-padding) / 2);
}
/* the page behind blurred : nothing of it can be read until the dialog is answered */
.af-backdrop-blur {
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  /* opaque, its colour see-through instead : Bootstrap's half opacity halved the blur too */
  opacity: 1 !important;
  background-color: rgba(var(--bs-black-rgb), 0.35);
}
</style>
