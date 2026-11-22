<script setup>
/******************************************************************/
/*                                                                */
/*  An inventory's Visual tab : its groups and their hosts as a   */
/*  tree, edited - a group or a host added (+ group, + host),     */
/*  removed ; a click on one opens its dialog, its name and the   */
/*  variables it sets in the inventory. Every edit is made on the */
/*  file's own text (config/inventoryEdit.js), so its comments    */
/*  and the rest stay (saved with the designer's Save). A dynamic */
/*  inventory (a plugin) is edited in the YAML.                   */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the inventory's YAML                 */
/*      readOnly: Boolean - shown, not editable                   */
/*  @emits:                                                       */
/*      update:modelValue - the inventory, changed                */
/*      reveal: the line to open the YAML on                      */
/*                                                                */
/******************************************************************/
import { ref, computed, watch, nextTick } from 'vue';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import { inventoryOf, inventoryRows } from '@/config/inventoryTree';
import {
  varsOf,
  editAddGroup,
  editRenameGroup,
  editRemoveGroup,
  editAddHost,
  editRenameHost,
  editRemoveHost,
  editSetVar,
  editRenameVar,
  editRemoveVar,
} from '@/config/inventoryEdit';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'reveal']);
const { t } = useI18n();

const inventory = computed(() => inventoryOf(props.modelValue));
const rows = computed(() => (inventory.value.kind === 'inventory' ? inventoryRows(inventory.value.groups) : []));
// a row's group path : its id is the path joined (all/web), a host's its group's then #host
const pathOf = (id) => id.split('/');

/**
 * Applies an edit : the inventory as the edit leaves it, or the edit's error.
 *
 * Args:
 *   fn (function): the edit, given the text, answering the new text.
 *
 * Returns:
 *   boolean: true when it applied.
 */
function apply(fn) {
  if (props.readOnly) return false;
  try {
    emit('update:modelValue', fn(props.modelValue));
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

// what is folded : a group's id ; its rows hidden
const folded = ref(new Set());
const shown = computed(() =>
  rows.value.filter((r) => ![...folded.value].some((f) => r.id.startsWith(`${f}/`) || r.id.startsWith(`${f}#`))),
);
function toggle(id) {
  const next = new Set(folded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  folded.value = next;
}

// ─── a name asked : a new group (at the top, or a child), a new host ───
const naming = ref(null); // { kind : 'group' | 'host', parent (a group's path, or null), name }
/**
 * Asks the name of a new group or host.
 *
 * Args:
 *   kind (string): 'group' or 'host'.
 *   parent (string[]|null): the group it goes in ; null : at the top (a group).
 */
function askName(kind, parent) {
  naming.value = { kind, parent, name: '' };
}
/** Adds what the name was asked for. */
function addNamed() {
  const n = naming.value;
  const name = n.name.trim();
  if (!name) return;
  const ok =
    n.kind === 'group'
      ? apply((text) => editAddGroup(text, n.parent, name))
      : apply((text) => editAddHost(text, n.parent, name));
  if (ok) naming.value = null;
}
// a new group at the top : under all, when the inventory starts with all (as most do)
const topParent = computed(() => (inventory.value.keys?.includes('all') ? ['all'] : null));

// ─── a group or a host : its dialog ───
const open = ref(null); // { type : 'group' | 'host', path, host }
const target = computed(() => (open.value ? { path: open.value.path, host: open.value.host } : null));
const openName = computed(() => (open.value ? (open.value.host ?? open.value.path[open.value.path.length - 1]) : ''));
const vars = computed(() => (target.value ? varsOf(props.modelValue, target.value) : []));
/**
 * Renames the open group or host ; the dialog follows it.
 *
 * Args:
 *   name (string): its new name.
 */
function rename(name) {
  const o = open.value;
  if (!name || name === openName.value) return;
  if (o.host) {
    if (apply((text) => editRenameHost(text, o.path, o.host, name))) open.value = { ...o, host: name };
  } else if (apply((text) => editRenameGroup(text, o.path, name))) {
    open.value = { ...o, path: [...o.path.slice(0, -1), name] };
  }
}
function removeOpen() {
  const o = open.value;
  if (o.host) apply((text) => editRemoveHost(text, o.path, o.host));
  else apply((text) => editRemoveGroup(text, o.path));
  open.value = null;
}
// a new variable : no empty row when the dialog opens ; Add variable adds a row of a name and a
// value, saved once it has a name and the row is left (or Enter), removed again with its x
const newVar = ref(null);
const newVarRow = ref(null);
watch(
  () => !!open.value,
  (isOpen) => {
    if (isOpen) newVar.value = null;
  },
);
/**
 * Adds the row of a new variable, its name focused ; a row still without a name is focused again.
 */
async function startVar() {
  if (!newVar.value) newVar.value = { key: '', value: '' };
  await nextTick();
  newVarRow.value?.querySelector('input')?.focus();
}
/**
 * Saves the new variable when it has a name ; its row then joins the others.
 */
function addVar() {
  const key = newVar.value?.key.trim();
  if (!key) return;
  if (apply((text) => editSetVar(text, target.value, key, newVar.value.value))) newVar.value = null;
}
/**
 * Leaving the new row (not moving between its own name and value) saves it.
 *
 * Args:
 *   event (FocusEvent): the focusout of the row.
 */
function leaveVar(event) {
  if (newVarRow.value?.contains(event.relatedTarget)) return;
  addVar();
}
</script>
<template>
  <div>
    <div v-if="inventory.kind === 'invalid'" class="alert alert-warning d-flex align-items-center gap-2">
      <FaIcon icon="triangle-exclamation" />
      <span class="flex-grow-1">{{ t('designer.files.visualInvalid', { error: inventory.error }) }}</span>
      <BsButton icon="code" @click="emit('reveal', inventory.line)">{{ t('designer.files.showInYaml') }}</BsButton>
    </div>
    <!-- a dynamic inventory : its plugin reads the hosts when the playbook runs -->
    <div v-else-if="inventory.kind === 'plugin'" class="alert alert-info d-flex align-items-center gap-2">
      <FaIcon icon="plug" />
      <span class="flex-grow-1">{{ t('designer.files.inventoryPlugin', { plugin: inventory.plugin }) }}</span>
      <BsButton icon="code" @click="emit('reveal', inventory.line)">{{ t('designer.files.showInYaml') }}</BsButton>
    </div>
    <template v-else>
      <div class="d-flex align-items-center mb-2">
        <span class="fw-bold flex-grow-1">{{ t('inventoryEditor.groupsAndHosts') }}</span>
        <BsButton v-if="!readOnly" icon="plus" @click="askName('group', topParent)">{{
          t('inventoryEditor.addGroup')
        }}</BsButton>
      </div>
      <div v-if="!rows.length" class="text-muted">{{ t('designer.files.inventoryEmpty') }}</div>
      <ul v-else class="list-group">
        <li
          v-for="row in shown"
          :key="row.id"
          class="list-group-item af-ie-row"
          role="button"
          :style="{ paddingLeft: row.depth * 1.5 + 0.75 + 'rem' }"
          @click="
            open =
              row.type === 'group'
                ? { type: 'group', path: pathOf(row.id) }
                : { type: 'host', path: pathOf(row.parent), host: row.name }
          "
        >
          <span
            v-if="row.type === 'group'"
            class="af-ie-caret"
            :class="{ invisible: !row.count }"
            @click.stop="toggle(row.id)"
            ><FaIcon :icon="folded.has(row.id) ? 'caret-right' : 'caret-down'"
          /></span>
          <span v-else class="af-ie-caret"></span>
          <FaIcon
            :icon="row.type === 'group' ? (folded.has(row.id) ? 'folder' : 'folder-open') : 'server'"
            :class="row.type === 'group' ? 'af-ie-folder' : 'text-secondary'"
          />
          <span :class="{ 'fw-semibold': row.type === 'group' }">{{ row.name }}</span>
          <!-- its variables' count beside its name ; the row's buttons stay on the right -->
          <span v-if="row.vars" class="badge af-ie-badge">{{ t('designer.files.varsCount', row.vars) }}</span>
          <span class="flex-grow-1"></span>
          <template v-if="!readOnly">
            <div v-if="row.type === 'group'" class="btn-group" role="group" @click.stop>
              <button
                type="button"
                class="btn af-row-btn btn-outline-primary"
                :title="t('inventoryEditor.addHost')"
                @click="askName('host', pathOf(row.id))"
              >
                <FaIcon icon="server" />
              </button>
              <button
                type="button"
                class="btn af-row-btn btn-outline-primary"
                :title="t('inventoryEditor.addChild')"
                @click="askName('group', pathOf(row.id))"
              >
                <FaIcon icon="folder-plus" />
              </button>
            </div>
            <button
              type="button"
              class="btn af-row-btn btn-outline-danger"
              :title="row.type === 'group' ? t('inventoryEditor.removeGroup') : t('inventoryEditor.removeHost')"
              @click.stop="
                row.type === 'group'
                  ? apply((text) => editRemoveGroup(text, pathOf(row.id)))
                  : apply((text) => editRemoveHost(text, pathOf(row.parent), row.name))
              "
            >
              <FaIcon icon="trash" />
            </button>
          </template>
        </li>
      </ul>
    </template>

    <!-- a new group or host : its name -->
    <BsModal
      v-if="naming"
      size="md"
      :icon="naming.kind === 'group' ? 'folder-plus' : 'server'"
      :footerClose="false"
      @close="naming = null"
    >
      <template #title>{{
        naming.kind === 'group' ? t('inventoryEditor.newGroup') : t('inventoryEditor.newHost')
      }}</template>
      <template #default>
        <div v-if="naming.parent" class="form-text mb-2">
          {{ t('inventoryEditor.in', { group: naming.parent.join(' / ') }) }}
        </div>
        <label class="form-label fw-bold">{{ t('inventoryEditor.name') }}</label>
        <div class="input-group">
          <span class="input-group-text text-gray-500"
            ><FaIcon :fixedwidth="true" :icon="naming.kind === 'group' ? 'folder' : 'server'"
          /></span>
          <input
            v-model="naming.name"
            class="form-control"
            spellcheck="false"
            :placeholder="naming.kind === 'group' ? 'webservers' : 'web1.example.com'"
            @keyup.enter="addNamed()"
          />
        </div>
      </template>
      <template #footer>
        <BsButton icon="check" :disabled="!naming.name.trim()" @click="addNamed()">{{
          t('workflowEditor.create')
        }}</BsButton>
        <BsButton icon="times" @click="naming = null">{{ t('common.close') }}</BsButton>
      </template>
    </BsModal>

    <!-- a group or a host : its name and its variables -->
    <BsModal
      v-if="open"
      size="lg"
      :icon="open.host ? 'server' : 'folder-open'"
      :footerClose="false"
      @close="open = null"
    >
      <template #title>{{
        open.host ? t('inventoryEditor.host', { name: openName }) : t('inventoryEditor.group', { name: openName })
      }}</template>
      <template #default>
        <label class="form-label fw-bold">{{ t('inventoryEditor.name') }}</label>
        <div class="input-group mb-3 af-ie-half">
          <span class="input-group-text text-gray-500"
            ><FaIcon :fixedwidth="true" :icon="open.host ? 'server' : 'folder'"
          /></span>
          <input
            class="form-control"
            :value="openName"
            :disabled="readOnly"
            spellcheck="false"
            @change="rename($event.target.value.trim())"
          />
        </div>
        <label class="form-label fw-bold">{{ t('inventoryEditor.variables') }}</label>
        <div v-for="v in vars" :key="v.key" class="d-flex gap-2 mb-2">
          <div class="input-group af-ie-key">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
            <input
              class="form-control font-monospace"
              :value="v.key"
              :disabled="readOnly"
              spellcheck="false"
              @change="apply((text) => editRenameVar(text, target, v.key, $event.target.value.trim()))"
            />
          </div>
          <div v-if="!v.complex" class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="pen" /></span>
            <input
              class="form-control"
              :value="v.value"
              :disabled="readOnly"
              spellcheck="false"
              @change="apply((text) => editSetVar(text, target, v.key, $event.target.value))"
            />
          </div>
          <button
            v-else
            type="button"
            class="btn btn-outline-secondary flex-grow-1 text-start"
            @click="emit('reveal', null)"
          >
            {{ t('playbookEditor.complexArg') }}
          </button>
          <BsButton
            v-if="!readOnly"
            icon="xmark"
            colorClass="danger"
            :isIconButton="true"
            :title="t('inventoryEditor.removeVar')"
            @click="apply((text) => editRemoveVar(text, target, v.key))"
          />
        </div>
        <div v-if="!vars.length && !newVar" class="text-muted small mb-2">
          {{ t('inventoryEditor.noVar') }}
        </div>
        <!-- the new variable's row, once Add variable is clicked -->
        <div v-if="newVar && !readOnly" ref="newVarRow" class="d-flex gap-2 mb-2" @focusout="leaveVar">
          <div class="input-group af-ie-key">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
            <input
              v-model="newVar.key"
              class="form-control font-monospace"
              :placeholder="t('inventoryEditor.varName')"
              spellcheck="false"
              @keyup.enter="addVar()"
            />
          </div>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="pen" /></span>
            <input
              v-model="newVar.value"
              class="form-control"
              :placeholder="t('playbookEditor.argValue')"
              spellcheck="false"
              @keyup.enter="addVar()"
            />
          </div>
          <BsButton
            icon="xmark"
            colorClass="danger"
            :isIconButton="true"
            :title="t('inventoryEditor.removeVar')"
            @mousedown.prevent
            @click="newVar = null"
          />
        </div>
        <div v-if="!readOnly">
          <BsButton icon="plus" @click="startVar()">{{ t('inventoryEditor.addVar') }}</BsButton>
        </div>
        <div class="form-text mt-3">{{ t('inventoryEditor.varsHint') }}</div>
      </template>
      <template #footer>
        <BsButton v-if="!readOnly" icon="trash" @click="removeOpen()">{{
          open.host ? t('inventoryEditor.removeHost') : t('inventoryEditor.removeGroup')
        }}</BsButton>
        <BsButton icon="times" @click="open = null">{{ t('common.close') }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>
<style scoped lang="scss">
.af-ie-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  &:hover {
    background: var(--af-row-hover-bg);
  }
}
.af-ie-caret {
  display: inline-block;
  width: 1rem;
  text-align: center;
  color: var(--bs-secondary-color);
}
/* a folder is folder yellow in every theme, as the explorer's */
.af-ie-folder {
  color: #f0b429;
}
.af-ie-badge {
  background: var(--bs-secondary-bg);
  color: var(--bs-body-color);
  border: 1px solid var(--bs-border-color);
  font-weight: 500;
}
.af-ie-key {
  max-width: 13rem;
}
.af-ie-half {
  max-width: 50%;
}
@media (max-width: 767px) {
  .af-ie-half {
    max-width: 100%;
  }
}
</style>
