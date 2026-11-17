<script setup>
/******************************************************************/
/*                                                                */
/*  A playbook's Visual tab : its plays edited field by field -   */
/*  name, hosts, become, gather facts, roles - and the tasks of   */
/*  their sections as rows ; a click on a task opens its dialog   */
/*  (name, module and its arguments, when, register, tags,        */
/*  notify, become, ignore errors). Every edit is made on the     */
/*  file's own text (config/playbookEdit.js), so its comments and */
/*  the rest stay (saved with the designer's Save). A block, and  */
/*  an argument that is a map or a list, are edited in the YAML.  */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the playbook's YAML                  */
/*      readOnly: Boolean - shown, not editable                   */
/*  @emits:                                                       */
/*      update:modelValue - the playbook, changed                 */
/*      reveal: the line to open the YAML on                      */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import {
  PLAY_SECTIONS,
  TASK_FIELDS,
  TASK_SWITCHES,
  COMMON_MODULES,
  playbookFields,
  editAddPlay,
  editPlay,
  editRoles,
  editAddTask,
  editRemoveTask,
  editMoveTask,
  editTask,
  editModule,
  editArg,
  editRenameArg,
  editRemoveArg,
  editArgsText,
} from '@/config/playbookEdit';

// each task field's icon, in front of its box as every field of the Designer
const TASK_ICONS = { when: 'code-branch', register: 'floppy-disk', tags: 'tags', notify: 'bell' };

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'reveal']);
const { t } = useI18n();

const fields = computed(() => playbookFields(props.modelValue));
const plays = computed(() => fields.value.plays || []);

/**
 * Applies an edit : the playbook as the edit leaves it, or the edit's error.
 *
 * Args:
 *   fn (function): the edit, given the text, answering the new text (or { text }).
 *
 * Returns:
 *   any: what the edit answered, null when it failed.
 */
function apply(fn) {
  if (props.readOnly) return null;
  try {
    const out = fn(props.modelValue);
    emit('update:modelValue', typeof out === 'string' ? out : out.text);
    return out;
  } catch (err) {
    toast.error(err.message);
    return null;
  }
}

// ─── a play's roles : as pills, one more typed ───
const roleToAdd = ref({});
/**
 * Adds the role typed for a play.
 *
 * Args:
 *   pi (number): the play's place.
 */
function addRole(pi) {
  const name = String(roleToAdd.value[pi] || '').trim();
  if (!name || plays.value[pi].roles.includes(name)) return;
  apply((text) => editRoles(text, pi, [...plays.value[pi].roles, name]));
  roleToAdd.value = { ...roleToAdd.value, [pi]: '' };
}

// ─── a task : its dialog ───
const open = ref(null); // { pi, section, ti }
const task = computed(() =>
  open.value ? plays.value[open.value.pi]?.sections?.[open.value.section]?.[open.value.ti] || null : null,
);
/**
 * Adds a task to a section, and opens it.
 *
 * Args:
 *   pi (number): the play's place.
 *   section (string): the section.
 */
function addTask(pi, section) {
  const out = apply((text) => editAddTask(text, pi, section));
  if (out) open.value = { pi, section, ti: out.index };
}
/**
 * Changes the open task.
 *
 * Args:
 *   fn (function): the edit, given the text and the task's place (pi, section, ti).
 */
function onTask(fn) {
  const { pi, section, ti } = open.value;
  apply((text) => fn(text, pi, section, ti));
}
function removeTask() {
  onTask((text, pi, section, ti) => editRemoveTask(text, pi, section, ti));
  open.value = null;
}
// a new argument : its name and value, typed
const newArg = ref({ key: '', value: '' });
function addArg() {
  const key = newArg.value.key.trim();
  if (!key) return;
  onTask((text, pi, section, ti) => editArg(text, pi, section, ti, key, newArg.value.value));
  newArg.value = { key: '', value: '' };
}
// the sections a play may still have
const missing = (play) => PLAY_SECTIONS.filter((k) => !play.sections[k]);
const sectionToAdd = ref({});
/**
 * Adds the section picked for a play (its first task's dialog opens), the list back to its first
 * choice.
 *
 * Args:
 *   pi (number): the play's place.
 */
function pickSection(pi) {
  const section = sectionToAdd.value[pi];
  sectionToAdd.value = { ...sectionToAdd.value, [pi]: undefined };
  if (section) addTask(pi, section);
}
</script>
<template>
  <div class="af-pbe">
    <div v-if="fields.kind === 'invalid'" class="alert alert-warning d-flex align-items-center gap-2">
      <FaIcon icon="triangle-exclamation" />
      <span class="flex-grow-1">{{ t('designer.files.visualInvalid', { error: fields.error }) }}</span>
      <BsButton icon="code" @click="emit('reveal', fields.line)">{{ t('designer.files.showInYaml') }}</BsButton>
    </div>
    <template v-else>
      <div v-for="(play, pi) in plays" :key="pi" class="af-pbe-play">
        <!-- the playbook it imports : in the YAML -->
        <div v-if="play.kind !== 'play'" class="d-flex align-items-center gap-2">
          <FaIcon icon="file-import" class="text-secondary" />
          <span class="fw-semibold flex-grow-1">{{
            play.kind === 'import' ? t('playbookOutline.import', { name: play.name }) : t('playbookEditor.other')
          }}</span>
          <BsButton icon="code" @click="emit('reveal', play.line)">{{ t('designer.files.showInYaml') }}</BsButton>
        </div>
        <template v-else>
          <div class="d-flex align-items-center mb-2">
            <span class="fw-bold flex-grow-1"
              ><FaIcon icon="play" class="me-2 text-success" />{{ t('playbookEditor.play', { n: pi + 1 }) }}</span
            >
          </div>
          <div class="row g-3 mb-3">
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('playbookEditor.name') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
                <input
                  class="form-control"
                  :value="play.name"
                  :disabled="readOnly"
                  @change="apply((text) => editPlay(text, pi, 'name', $event.target.value.trim()))"
                />
              </div>
            </div>
            <!-- its hosts on a line of their own, under its name -->
            <div class="w-100 m-0"></div>
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('playbookEditor.hosts') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="server" /></span>
                <input
                  class="form-control"
                  :class="{ 'is-invalid': !play.hosts }"
                  :value="play.hosts"
                  :disabled="readOnly"
                  spellcheck="false"
                  @change="apply((text) => editPlay(text, pi, 'hosts', $event.target.value.trim()))"
                />
              </div>
              <div class="form-text">{{ t('playbookEditor.hostsHelp') }}</div>
            </div>
          </div>
          <!-- become, gather facts : a line each, titled as a field is -->
          <div v-for="key in ['become', 'gather_facts']" :key="key" class="mb-3">
            <label class="form-label fw-bold" :for="`pb-${key}-${pi}`">{{
              key === 'become' ? t('playbookEditor.become') : t('playbookEditor.gatherFacts')
            }}</label>
            <div class="form-check form-switch">
              <input
                :id="`pb-${key}-${pi}`"
                class="form-check-input"
                type="checkbox"
                :checked="play[key]"
                :disabled="readOnly"
                @change="apply((text) => editPlay(text, pi, key, $event.target.checked))"
              />
              <label class="form-check-label" :for="`pb-${key}-${pi}`">{{ t('playbookEditor.enable') }}</label>
            </div>
          </div>
          <!-- its roles : pills to remove, one more typed -->
          <label class="form-label fw-bold">{{ t('playbookOutline.sections.roles') }}</label>
          <div v-if="play.rolesEditable" class="mb-3">
            <!-- none yet : said, as the other empty lists -->
            <div v-if="!play.roles.length" class="text-body-secondary fst-italic mb-2">
              {{ t('playbookEditor.noRoles') }}
            </div>
            <!-- the roles it has, as pills to remove -->
            <div v-else class="d-flex flex-wrap align-items-center gap-2 mb-2">
              <span v-for="r in play.roles" :key="r" class="badge rounded-pill af-pbe-role">
                <FaIcon icon="cubes" class="me-1" />{{ r }}
                <button
                  v-if="!readOnly"
                  type="button"
                  class="btn-close btn-close-sm ms-1"
                  :aria-label="t('playbookEditor.removeRole')"
                  @click="
                    apply((text) =>
                      editRoles(
                        text,
                        pi,
                        play.roles.filter((x) => x !== r),
                      ),
                    )
                  "
                ></button>
              </span>
            </div>
            <!-- one more : typed with its icon in front, as every field, Add role on a line of its own under it -->
            <template v-if="!readOnly">
              <div class="input-group af-pbe-role-input">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="cubes" /></span>
                <input
                  v-model="roleToAdd[pi]"
                  class="form-control"
                  :placeholder="t('playbookEditor.role')"
                  spellcheck="false"
                  @keyup.enter="addRole(pi)"
                />
              </div>
              <div class="mt-2">
                <BsButton icon="plus" @click="addRole(pi)">{{ t('playbookEditor.addRole') }}</BsButton>
              </div>
            </template>
          </div>
          <div v-else class="d-flex align-items-center gap-2 mb-3">
            <span class="text-body-secondary">{{ play.roles.join(', ') }}</span>
            <BsButton icon="code" @click="emit('reveal', play.line)">{{ t('designer.files.showInYaml') }}</BsButton>
          </div>
          <!-- its sections : the tasks as rows -->
          <div v-for="section in Object.keys(play.sections)" :key="section" class="mb-3">
            <div class="d-flex align-items-center mb-2">
              <label class="form-label fw-bold mb-0 flex-grow-1">{{ t(`playbookOutline.sections.${section}`) }}</label>
              <BsButton v-if="!readOnly" icon="plus" @click="addTask(pi, section)">{{
                t('playbookEditor.addTask')
              }}</BsButton>
            </div>
            <ul class="list-group">
              <li
                v-for="(tk, ti) in play.sections[section]"
                :key="ti"
                class="list-group-item af-pbe-task"
                :class="{ 'af-pbe-block': tk.kind === 'block' }"
                role="button"
                @click="tk.kind === 'block' ? emit('reveal', tk.line) : (open = { pi, section, ti })"
              >
                <FaIcon :icon="tk.kind === 'block' ? 'layer-group' : 'list-check'" class="text-secondary" />
                <span class="flex-grow-1" :class="{ 'fst-italic text-body-secondary': !tk.name }">{{
                  tk.name || (tk.kind === 'block' ? t('playbookOutline.sections.block') : tk.module || '?')
                }}</span>
                <span v-if="tk.kind === 'block'" class="small text-body-secondary">{{
                  t('playbookEditor.blockInYaml')
                }}</span>
                <span v-else-if="tk.module" class="badge af-pbe-module">{{ tk.module }}</span>
                <template v-if="!readOnly">
                  <!-- move it, remove it : as the constants' rows -->
                  <div class="btn-group" role="group" @click.stop>
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="ti > 0 ? 'btn-outline-primary' : 'btn-outline-secondary'"
                      :disabled="ti === 0"
                      :title="t('playbookEditor.up')"
                      @click="apply((text) => editMoveTask(text, pi, section, ti, -1))"
                    >
                      <FaIcon icon="arrow-up" />
                    </button>
                    <button
                      type="button"
                      class="btn af-row-btn"
                      :class="ti < play.sections[section].length - 1 ? 'btn-outline-primary' : 'btn-outline-secondary'"
                      :disabled="ti === play.sections[section].length - 1"
                      :title="t('playbookEditor.down')"
                      @click="apply((text) => editMoveTask(text, pi, section, ti, 1))"
                    >
                      <FaIcon icon="arrow-down" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="btn af-row-btn btn-outline-danger"
                    :title="t('playbookEditor.removeTask')"
                    @click.stop="apply((text) => editRemoveTask(text, pi, section, ti))"
                  >
                    <FaIcon icon="trash" />
                  </button>
                </template>
              </li>
              <li v-if="!play.sections[section].length" class="list-group-item text-muted">
                {{ t('playbookEditor.noTask') }}
              </li>
            </ul>
          </div>
          <!-- a section it does not have yet -->
          <div v-if="!readOnly && missing(play).length" class="d-flex gap-2 align-items-center">
            <!-- picked is added, as a node's credential : no button to press after the choice -->
            <div class="input-group af-pbe-section-select">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="layer-group" /></span>
              <select v-model="sectionToAdd[pi]" class="form-select" @change="pickSection(pi)">
                <option :value="undefined">{{ t('playbookEditor.addSection') }}...</option>
                <option v-for="k in missing(play)" :key="k" :value="k">{{ t(`playbookOutline.sections.${k}`) }}</option>
              </select>
            </div>
          </div>
        </template>
      </div>
      <BsButton v-if="!readOnly" icon="plus" class="mt-1" @click="apply((text) => editAddPlay(text))">{{
        t('playbookEditor.addPlay')
      }}</BsButton>

      <!-- a task : its dialog -->
      <BsModal v-if="task" size="lg" icon="list-check" :footerClose="false" @close="open = null">
        <template #title>{{ task.name || t('playbookEditor.task') }}</template>
        <template #default>
          <div class="row g-3 mb-3">
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('playbookEditor.name') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="font" /></span>
                <input
                  class="form-control"
                  :value="task.name"
                  :disabled="readOnly"
                  @change="onTask((x, p, s, i) => editTask(x, p, s, i, 'name', $event.target.value.trim()))"
                />
              </div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('playbookEditor.module') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="puzzle-piece" /></span>
                <input
                  class="form-control font-monospace"
                  list="af-pbe-modules"
                  :value="task.module"
                  :disabled="readOnly"
                  spellcheck="false"
                  @change="onTask((x, p, s, i) => editModule(x, p, s, i, $event.target.value.trim()))"
                />
              </div>
              <datalist id="af-pbe-modules">
                <option v-for="m in COMMON_MODULES" :key="m" :value="m" />
              </datalist>
            </div>
          </div>
          <!-- its arguments : a line (free form), or its key / value pairs -->
          <label class="form-label fw-bold">{{ t('playbookEditor.arguments') }}</label>
          <div v-if="task.args === 'text'" class="input-group mb-3">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="terminal" /></span>
            <input
              class="form-control font-monospace"
              :value="task.argsText"
              :disabled="readOnly"
              spellcheck="false"
              @change="onTask((x, p, s, i) => editArgsText(x, p, s, i, $event.target.value))"
            />
          </div>
          <template v-else>
            <div v-for="pa in task.params" :key="pa.key" class="d-flex gap-2 mb-2">
              <div class="input-group af-pbe-arg-key">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
                <input
                  class="form-control font-monospace"
                  :value="pa.key"
                  :disabled="readOnly"
                  spellcheck="false"
                  @change="onTask((x, p, s, i) => editRenameArg(x, p, s, i, pa.key, $event.target.value.trim()))"
                />
              </div>
              <div v-if="!pa.complex" class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="pen" /></span>
                <input
                  class="form-control"
                  :value="pa.value"
                  :disabled="readOnly"
                  spellcheck="false"
                  @change="onTask((x, p, s, i) => editArg(x, p, s, i, pa.key, $event.target.value))"
                />
              </div>
              <button
                v-else
                type="button"
                class="btn btn-outline-secondary flex-grow-1 text-start"
                @click="emit('reveal', task.line)"
              >
                {{ t('playbookEditor.complexArg') }}
              </button>
              <BsButton
                v-if="!readOnly"
                icon="xmark"
                colorClass="danger"
                :isIconButton="true"
                :title="t('playbookEditor.removeArg')"
                @click="onTask((x, p, s, i) => editRemoveArg(x, p, s, i, pa.key))"
              />
            </div>
            <div v-if="!readOnly" class="d-flex gap-2 mb-3">
              <div class="input-group af-pbe-arg-key">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
                <input
                  v-model="newArg.key"
                  class="form-control font-monospace"
                  :placeholder="t('playbookEditor.argName')"
                  spellcheck="false"
                />
              </div>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="pen" /></span>
                <input
                  v-model="newArg.value"
                  class="form-control"
                  :placeholder="t('playbookEditor.argValue')"
                  spellcheck="false"
                  @keyup.enter="addArg()"
                />
              </div>
              <BsButton icon="plus" :title="t('playbookEditor.addArg')" @click="addArg()" />
            </div>
          </template>
          <!-- when it runs, what it keeps, its tags and the handlers it notifies -->
          <div class="row g-3 mb-3">
            <div v-for="key in TASK_FIELDS.filter((k) => !TASK_SWITCHES.includes(k))" :key="key" class="col-md-6">
              <label class="form-label fw-bold">{{ t(`playbookEditor.fields.${key}`) }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"
                  ><FaIcon :fixedwidth="true" :icon="TASK_ICONS[key]"
                /></span>
                <input
                  class="form-control"
                  :class="{ 'font-monospace': key === 'when' || key === 'register' }"
                  :value="task[key]"
                  :disabled="readOnly"
                  spellcheck="false"
                  @change="onTask((x, p, s, i) => editTask(x, p, s, i, key, $event.target.value.trim()))"
                />
              </div>
            </div>
          </div>
          <div class="d-flex flex-wrap gap-4">
            <div v-for="key in TASK_SWITCHES" :key="key" class="form-check form-switch">
              <input
                :id="`pb-task-${key}`"
                class="form-check-input"
                type="checkbox"
                :checked="task[key] === 'true'"
                :disabled="readOnly"
                @change="onTask((x, p, s, i) => editTask(x, p, s, i, key, $event.target.checked))"
              />
              <label class="form-check-label" :for="`pb-task-${key}`">{{ t(`playbookEditor.fields.${key}`) }}</label>
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton icon="code" @click="emit('reveal', task.line)">{{ t('designer.files.showInYaml') }}</BsButton>
          <BsButton v-if="!readOnly" icon="trash" @click="removeTask()">{{ t('playbookEditor.removeTask') }}</BsButton>
          <BsButton icon="times" @click="open = null">{{ t('common.close') }}</BsButton>
        </template>
      </BsModal>
    </template>
  </div>
</template>
<style scoped lang="scss">
.af-pbe-play + .af-pbe-play {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--af-field-border, var(--bs-border-color));
}
.af-pbe-play {
  margin-bottom: 1rem;
}
.af-pbe-task {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  &:hover {
    background: var(--af-row-hover-bg);
  }
}
.af-pbe-module {
  background: var(--bs-secondary-bg);
  color: var(--bs-body-color);
  border: 1px solid var(--bs-border-color);
  font-family: var(--bs-font-monospace);
  font-weight: 400;
}
.af-pbe-role {
  display: inline-flex;
  align-items: center;
  background: var(--bs-secondary-bg);
  color: var(--bs-body-color);
  border: 1px solid var(--bs-border-color);
  font-weight: 500;
  padding: 0.4rem 0.6rem;
}
.btn-close-sm {
  font-size: 0.55rem;
}
.af-pbe-role-input {
  max-width: 20rem;
}
.af-pbe-section-select {
  max-width: 14rem;
}
.af-pbe-arg-key {
  max-width: 13rem;
}
</style>
