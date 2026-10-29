<script setup>
import { ref, reactive, computed, provide, watch, onMounted, onBeforeUnmount } from 'vue';
import { jobTypeName, hasArtifacts } from '@/lib/jobTypes';
import { useNodeOutput } from '@/composables/useNodeOutput';
import { useJobEvents } from '@/composables/useJobEvents';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { toast } from 'vue-sonner';
import Profile from '@/lib/Profile';
import Form from '@/lib/Form';
import { useAppStore } from '@/stores/app';
import Helpers from '@/lib/Helpers';
import axios from 'axios';
import State from '@/lib/State';
import Navigate from '@/lib/Navigate';
import TokenStorage from '@/lib/TokenStorage';
import { formsPath, formFromPath, formPath, slugOf } from '@/lib/formsPath';
import { renderMarkdown } from '@/lib/markdown';
import YAML from 'yaml';
import { useFollowOutput } from '@/composables/useFollowOutput';
import Time from '@/lib/Time';

// use
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const store = useAppStore();

// refs
const key = ref(0); // key to force rerender
const authenticated = ref(false); // flag to show/hide form, only show if authenticated, otherwise redirect to login (is automatically done by the router)
const currentForm = ref(null); // holds the current form
const formConfig = ref({}); // holds the form configuration
const constants = ref({}); // holds the constants
const formLoaded = ref(false); // flag to know if form is loaded
const mainForm = ref(null); // the non-wizard AppForm, for its awaitStable gate
const formNotFound = ref(false); // flag to know if form is not found
// why it could not be loaded, when we know : shown instead of the generic message so a
// 403 does not read as "this form does not exist"
const loadError = ref('');
// consecutive failed job polls ; reset on every success so only a sustained outage stops
// the chain, not a single blip
const pollFailures = ref(0);
const filterOutput = ref(true); // flag to show/hide filter output

// ---------------------------------------------------------------------------
// Nested subform editor stack
//
// Each entry represents a subform currently being edited as a tab:
//   { id, title, subform, snapshot, onSave }
// - `snapshot` is a deep clone of the row at the time the tab was opened
//   and is passed to <AppForm :initialData>. The edited value comes back via
//   the `@save` event and is forwarded to the list field's `onSave` callback.
// - Parent tabs are rendered disabled so the user cannot skip over an
//   in-progress edit; use Save or × to come back to them.
// ---------------------------------------------------------------------------
// Edit stack for nested subform editing.
//
// Each entry represents a subform currently being edited:
//   { id, title, subtitle, subform, snapshot, draft, onSave }
// - `snapshot` is a deep clone of the row at the time editing began and is
//   passed to <AppForm :initialData>. The edited value comes back via the
//   `@save` event and is forwarded to the list field's `onSave` callback.
// - While the stack is non-empty, the main form is hidden and the deepest
//   subform in the stack takes its place (title / help / breadcrumbs all
//   switch to the active entry). Earlier entries remain mounted (v-show)
//   so their drafts are preserved when the user goes deeper and back.
// - AppListField components call `pushEdit(...)` (injected) to open a new
//   level at any nesting depth; closing a level also removes its descendants.
// ---------------------------------------------------------------------------
const editStack = reactive([]);
let nextEditId = 1;

// The deepest (currently visible) subform entry, or undefined when the main
// form is shown. Drives the title, breadcrumbs and help block in the template.
const activeEntry = computed(() => editStack[editStack.length - 1]);

function pushEdit({ title, subtitle, subform, row, parentData, onSave }) {
  const id = `edit-${nextEditId++}`;
  const snapshot = row ? JSON.parse(JSON.stringify(row)) : {};
  const entry = reactive({
    id,
    title,
    subtitle,
    subform,
    snapshot,
    parentData: parentData ? Helpers.safeDeepClone(parentData) : null,
    draft: {},
    onSave,
  });
  editStack.push(entry);
  return id;
}

function popEdit(id) {
  const idx = editStack.findIndex((e) => e.id === id);
  if (idx < 0) return;
  // Remove the target entry and anything pushed on top of it.
  editStack.splice(idx, editStack.length - idx);
}

function saveEdit(id, value) {
  const entry = editStack.find((e) => e.id === id);
  if (!entry) return;
  try {
    entry.onSave?.(value);
  } finally {
    popEdit(id);
  }
}

provide('formEditStack', {
  push: pushEdit,
  pop: popEdit,
});

// ---------------------------------------------------------------------------
// Wizard mode
//
// When a form has a `wizard:` array, we render a sequence of subforms as
// steps. Each step is an <AppForm mode="wizard"> with its own draft and
// validation. Cross-step references work through `__parent__.<stepname>.field`
// (the wizard injects every prior step's raw draft under its namespace).
//
// State:
//   wizardSteps      : computed array of resolved steps with metadata
//   wizardIndex      : currently visible step index
//   wizardDrafts     : reactive { stepName: rawDraft }
//   wizardVisibility : { stepName: { fieldName: bool } } (from each step)
//   wizardSkipped    : reactive { stepName: true } when user pressed Skip
//   wizardRefs       : refs to each AppForm so we can call validateForm()
// ---------------------------------------------------------------------------
const wizardIndex = ref(0);
const wizardDrafts = reactive({});
const wizardVisibility = reactive({});
const wizardSkipped = reactive({});
// Set only after a step's validateForm() returned true. Drives the green
// “done” badge in the stepper and gates final submit.
const wizardCompleted = reactive({});
// Plain object map of stepName -> AppForm component instance (filled by
// the template ref callback). Not reactive — we only ever read it from
// click handlers, never from templates/computeds.
const wizardRefs = { value: {} };

function setWizardRef(stepName, el) {
  if (!stepName) return;
  if (el) wizardRefs.value[stepName] = el;
  else delete wizardRefs.value[stepName];
}

const wizardActive = computed(() => Array.isArray(currentForm.value?.wizard) && currentForm.value.wizard.length > 0);

// Resolve each step definition: subform lookup, step namespace (`name`
// defaults to subform name), title, defaultModel, etc. The summary step
// is appended automatically — authors don't declare it in YAML, and its
// title is always taken from the active locale (language-agnostic).
const wizardSteps = computed(() => {
  if (!wizardActive.value) return [];
  const subforms = currentForm.value?.subforms || [];
  // Skip any author-declared summary entries; we always append our own.
  const inputSteps = currentForm.value.wizard.filter((raw) => !raw?.summary);
  const steps = inputSteps.map((raw, i) => {
    const sub = subforms.find((s) => s.name === raw.subform);
    const stepName = raw.name || raw.subform;
    return {
      index: i,
      name: stepName,
      title: raw.title || sub?.description || stepName,
      help: raw.help || sub?.help || '',
      showHelp: raw.showHelp === true || sub?.showHelp === true,
      defaultModel: raw.defaultModel || '',
      when: raw.when || '',
      optional: raw.optional === true,
      subform: sub,
      subformName: raw.subform,
    };
  });
  // Append the synthetic summary step. Title comes from i18n so it's
  // always shown in the user's language.
  steps.push({
    index: steps.length,
    name: '__summary__',
    title: t('form.summary'),
    isSummary: true,
  });
  return steps;
});

// Evaluate `when:` for a step against the current wizard state.
// Returns true when there's no `when:` (always show) or when the expression
// evaluates truthy. Falsy/error -> step is hidden.
// Supports `$(__parent__.<stepname>.<field>)` placeholders, mirroring how
// regular expressions resolve inside subform fields.
function evalWhen(expr) {
  if (!expr || typeof expr !== 'string') return true;
  try {
    // Build a context object that mirrors what a subform field would see:
    //   __parent__.<stepname>.<field>
    const context = { __parent__: {} };
    Object.keys(wizardDrafts).forEach((k) => {
      context.__parent__[k] = wizardDrafts[k];
    });
    // Replace every $(path) placeholder with the JS literal value.
    const replaced = expr.replace(/\$\(([^)]+)\)/g, (_, path) => {
      const v = Helpers.replacePlaceholders(path, context);
      if (v === undefined) return 'undefined';
      return JSON.stringify(v);
    });
    // Dynamic evaluation is by design here : a `when` is an author-written
    // JS expression coming from config.yaml, not from end user input.
    return !!new Function(`return (${replaced});`)();
  } catch (e) {
    // Hide the step on evaluation failure; this matches how expression
    // fields silently degrade until their inputs are resolvable.
    return false;
  }
}

function isWizardStepVisible(step) {
  if (!step) return false;
  if (step.isSummary) return true;
  if (step.optional && wizardSkipped[step.name]) return false;
  if (!evalWhen(step.when)) return false;
  return true;
}

// __parent__ data injected into each step's AppForm. We expose every
// step's raw draft under its namespace, so a field in step "network"
// can reference $(__parent__.basics.kind) -> raw value from step "basics".
//
// varsFiles data (currentForm.vars) is spread in flat, top-level, so a step
// can reach it via $(__parent__.someVarsKey). For a non-wizard form this
// comes for free : __parent__ there is the root AppForm's own form.value,
// and that root form is mounted and injects its own .vars into itself. A
// wizard-active root form never mounts an AppForm at all, so nothing ever
// does that injection - this is the substitute. Step namespaces are spread
// after, so a step name always wins over a same-named vars key.
const wizardParentData = computed(() => {
  const out = { ...(currentForm.value?.vars || {}) };
  for (const step of wizardSteps.value) {
    if (step.isSummary) continue;
    out[step.name] = wizardDrafts[step.name] || {};
  }
  return out;
});

// Per-step output: fields shaped by buildFormOutput, then wrapped under
// the step's `defaultModel` prefix. Honours per-field `model`/`output`.
function buildWizardStepOutput(step) {
  if (!step?.subform?.fields) return {};
  const visMap = wizardVisibility[step.name] || {};
  return Helpers.buildWizardStepOutput(step.subform.fields, wizardDrafts[step.name] || {}, step.defaultModel || '', {
    isVisible: (item) => !!visMap[item.name],
    subforms: currentForm.value?.subforms || [],
  });
}

// Merged wizard extravars: deep-merge of every visible step's output, in
// declaration order. Hidden / skipped steps contribute nothing.
const wizardMergedOutput = computed(() => {
  if (!wizardActive.value) return {};
  let merged = {};
  for (const step of wizardSteps.value) {
    if (step.isSummary) continue;
    if (!isWizardStepVisible(step)) continue;
    merged = Helpers.deepMerge(merged, buildWizardStepOutput(step));
  }
  return merged;
});

const activeWizardStep = computed(() => wizardSteps.value[wizardIndex.value] || null);

// Navigation
function wizardGoTo(index) {
  if (index < 0 || index >= wizardSteps.value.length) return;
  // When jumping forward, validate the current step first (fail-closed).
  // Jumping backwards is always allowed.
  if (index > wizardIndex.value) {
    const step = activeWizardStep.value;
    if (step && !step.isSummary && !wizardSkipped[step.name]) {
      const ref = wizardRefs.value[step.name];
      if (!ref || typeof ref.validateForm !== 'function') {
        // Can't validate → don't advance.
        return;
      }
      if (!ref.validateForm()) return;
      wizardCompleted[step.name] = true;
    }
  }
  wizardIndex.value = index;
}
function wizardBack() {
  // walk backwards skipping hidden steps
  for (let i = wizardIndex.value - 1; i >= 0; i--) {
    if (isWizardStepVisible(wizardSteps.value[i])) {
      wizardIndex.value = i;
      return;
    }
  }
}
function wizardNext() {
  const step = activeWizardStep.value;
  if (!step) return;
  // Validate the current step before advancing (summary steps have no form).
  if (!step.isSummary) {
    const ref = wizardRefs.value[step.name];
    // Fail-closed: if the ref isn't available, don't silently advance.
    if (!ref || typeof ref.validateForm !== 'function') {
      toast.warning(t('form.invalidData'));
      return;
    }
    if (!ref.validateForm()) return;
    wizardCompleted[step.name] = true;
    // Re-entering an optional step clears any prior skip mark.
    if (wizardSkipped[step.name]) delete wizardSkipped[step.name];
  } else {
    wizardCompleted[step.name] = true;
  }
  // walk forwards skipping hidden steps
  for (let i = wizardIndex.value + 1; i < wizardSteps.value.length; i++) {
    if (isWizardStepVisible(wizardSteps.value[i])) {
      wizardIndex.value = i;
      return;
    }
  }
}
function wizardSkipCurrent() {
  const step = activeWizardStep.value;
  if (!step || !step.optional) return;
  wizardSkipped[step.name] = true;
  // Skipping clears any prior completion mark.
  delete wizardCompleted[step.name];
  // walk forwards to next visible step
  for (let i = wizardIndex.value + 1; i < wizardSteps.value.length; i++) {
    if (isWizardStepVisible(wizardSteps.value[i])) {
      wizardIndex.value = i;
      return;
    }
  }
}

// Returns the index of the last *non-summary* visible step. Used to know
// whether to render Next or Submit.
const wizardLastInputIndex = computed(() => {
  let last = -1;
  wizardSteps.value.forEach((s, i) => {
    if (!s.isSummary && isWizardStepVisible(s)) last = i;
  });
  return last;
});

const wizardHasSummary = computed(() => wizardSteps.value.some((s) => s.isSummary));

// Rows shown in the summary step body: one entry per non-summary step
// with its visual status (ok / skipped / hidden / pending) so the user
// sees at a glance what was done and what wasn't.
const wizardSummaryRows = computed(() => {
  return wizardSteps.value
    .filter((s) => !s.isSummary)
    .map((s) => {
      let status, statusLabel;
      if (!isWizardStepVisible(s) && !wizardSkipped[s.name]) {
        status = 'hidden';
        statusLabel = t('form.wizardSummaryHidden');
      } else if (wizardSkipped[s.name]) {
        status = 'skipped';
        statusLabel = t('form.wizardSummarySkipped');
      } else if (wizardCompleted[s.name]) {
        status = 'ok';
        statusLabel = t('form.wizardSummaryOk');
      } else {
        status = 'pending';
        statusLabel = t('form.wizardSummaryPending');
      }
      return { name: s.name, title: s.title, index: s.index, status, statusLabel };
    });
});

// Submit from the wizard: build merged extravars, then route through the
// existing launch path. File fields inside wizard steps are not supported
// in v1 — they would need a multi-step upload flow.
/**
 * Every visible non-summary step is either completed or explicitly skipped.
 *
 * This lived inside wizardSubmit, so it ran for the direct Submit only. Schedule, Run
 * later and Store went through handleWizardSubmitAction, whose own validation is a no-op
 * on the summary step (`if (step && !step.isSummary)`) - so from the summary you could
 * persist a RECURRING SCHEDULE whose extra_vars came from a wizard whose steps had never
 * been filled in, and it then fired unattended against the playbook. The regular form
 * validates for every action; the wizard now does too.
 */
function wizardStepsComplete() {
  for (const s of wizardSteps.value) {
    if (s.isSummary) continue;
    if (!isWizardStepVisible(s)) continue;
    if (wizardSkipped[s.name]) continue;
    if (!wizardCompleted[s.name]) {
      toast.warning(t('form.invalidData'));
      // Jump back to the offending step so the user can fix it.
      wizardIndex.value = s.index;
      return false;
    }
  }
  return true;
}

function wizardSubmit() {
  // Validate active step if it's not the summary
  const step = activeWizardStep.value;
  if (step && !step.isSummary) {
    const ref = wizardRefs.value[step.name];
    if (!ref || typeof ref.validateForm !== 'function') {
      toast.warning(t('form.invalidData'));
      return;
    }
    if (!ref.validateForm()) return;
    wizardCompleted[step.name] = true;
  }
  if (!wizardStepsComplete()) return;
  // For wizard submit we bypass file-upload (none expected in v1)
  status.value = 'initializing';
  const postdata = {
    files: {},
    extravars: Helpers.deepClone(wizardMergedOutput.value) || {},
    formName: currentForm.value.name,
    rawFormData: getWizardRawFormData(),
    credentials: {},
  };
  if (enableVerbose.value) {
    postdata.extravars.__verbose__ = true;
  }
  // Collect credentials from steps: any field with asCredential=true.
  for (const s of wizardSteps.value) {
    if (s.isSummary || !s.subform?.fields) continue;
    if (!isWizardStepVisible(s)) continue;
    const draft = wizardDrafts[s.name] || {};
    s.subform.fields
      .filter((f) => f.asCredential === true)
      .forEach((f) => {
        postdata.credentials[f.name] = draft[f.name];
      });
  }
  launchForm(postdata);
}

// Submit dropdown actions for the wizard's final step (mirrors AppForm's
// submitActions list so the user gets the same Schedule / Run later / Store
// options as on a regular form).
const wizardSubmitActions = computed(() => [
  {
    key: 'schedule',
    label: t('form.scheduleRecurring'),
    icon: 'calendar-plus',
    roleOption: 'allowScheduledJobs',
  },
  {
    key: 'run-later',
    label: t('form.runLaterOneTime'),
    icon: 'clock',
    roleOption: 'allowPlannedJobs',
    divider: true,
  },
  {
    key: 'store',
    label: t('form.store'),
    icon: 'file-export',
    roleOption: 'allowStoredJobs',
  },
]);

// Route the wizard's final-step submit dropdown actions. Validates the
// active step (if not the summary) and ensures formdata mirrors the merged
// wizard output before opening schedule/store offcanvases.
function handleWizardSubmitAction(action) {
  // Refuse while a run is already under way. The button is only disabled for
  // 'initializing'/'submitting', but launchForm sets status to 'running' within
  // milliseconds - so it re-enabled itself immediately and stayed enabled for the whole
  // job. A second click launched a SECOND Ansible job and overwrote timeout.value, which
  // orphaned the first poll chain: nothing could clear it any more, so it kept polling
  // and writing job/status every 2s after the user had navigated away, with the output
  // pane alternating between the two jobs.
  if (status.value !== '') return;
  const step = activeWizardStep.value;
  if (step && !step.isSummary) {
    const ref = wizardRefs.value[step.name];
    if (ref && typeof ref.validateForm === 'function') {
      if (!ref.validateForm()) return;
    }
  }
  // Every action, not just 'submit' : schedule/run-later/store used to skip this
  if (!wizardStepsComplete()) return;
  // Make sure formdata reflects merged wizard output for downstream consumers.
  generateJsonOutput();
  // a preview (the designer's) runs nothing
  if (isPreview.value) {
    toast.info(t('designer.previewNotRun'));
    return;
  }
  switch (action) {
    case 'submit':
      wizardSubmit();
      break;
    case 'schedule':
      openScheduleOffcanvas('schedule');
      break;
    case 'run-later':
      openScheduleOffcanvas('run-later');
      break;
    case 'store':
      storeCtx.value = buildMainStoreCtx();
      openStoreOffcanvas();
      break;
  }
}

// a preview of the designer's form (?preview=1) : its submit runs nothing ; embedded in the
// designer's Preview tab (?embed=1), without the app's header and menu
const isPreview = computed(() => !!route.query.preview);
const isEmbedded = computed(() => !!route.query.embed);
const hideForm = ref(false); // possible action to hide form onsubmit for example
const formdata = ref({}); // the eventual object sent to the api in the correct hierarchy
const showExtraVars = ref(false); // flag to show/hide extravars
// a playbook job's structured events (AppJobEvents) : read with the job, shown on demand
const { jobEvents, showEvents, loadEvents } = useJobEvents();
// the run's artifacts shown over its output (its toolbar's Show artifacts)
const showRunArtifacts = ref(false);
const job = ref({}); // holds the job data
const message = ref(''); // holds the message of the job
const error = ref(''); // holds the error of the job
const viewAsYaml = ref(true); // flag to show extravars as yaml
const subjob = ref({}); // output of last subjob
const form = ref({}); // the form data mapped to the form -> hold the real data
const visibility = ref({}); // holds which fields are visiable or not
const timeout = ref(undefined); // determines how long we should show the result of run
const enableVerbose = ref(false); // flag to enable verbose mode
const jobId = ref(undefined); // holds the current jobid
const abortTriggered = ref(false); // flag abort is triggered,
const pauseJsonOutput = ref(false); // flag to pause jsonoutput interval
const fileProgress = ref({}); // holds the progress of file uploads
const status = ref(''); // status of form
const initialFormData = ref({}); // holds initial data for pre-filling the form

// Schedule off-canvas state
const showScheduleOffcanvas = ref(false);
const scheduleAction = ref('schedule'); // 'schedule' or 'run-later'
const scheduleForm = ref({
  name: '',
  one_time_run: false,
  cron: '',
  run_at: null,
});
const scheduleSubmitting = ref(false);

// Store off-canvas state
const showStoreOffcanvas = ref(false);
const storeForm = ref({
  name: '',
  description: '',
  expires_at: null,
  shared: false,
});
const storeSubmitting = ref(false);

// Load off-canvas state
const showLoadOffcanvas = ref(false);
const storedJobs = ref([]);
const loadSubmitting = ref(false);

// Context describing what to store / what to load into. Set just before
// opening the store or load off-canvas so a single dialog is reused by both
// the main form and any active subform tab. Shape:
//   { scope: 'form' | 'subform',
//     formName: string,       // used as stored_jobs.form_name
//     title: string,          // displayed in the off-canvas header
//     getData: () => object,  // payload to serialise on Save
//     onLoad: (parsed) => void // applies a loaded record
//     sharing: boolean,       // the form lets its stored jobs be shared (allowStoredJobSharing)
//   }
const storeCtx = ref(null);

// the Store dialog's Share switch : the allowStoredJobsShare role option, on a form that does not
// turn sharing off
const canShareStored = computed(
  () =>
    !!store.profile?.options?.allowStoredJobsShare &&
    (storeCtx.value
      ? storeCtx.value.sharing
      : !!currentForm.value && currentForm.value.allowStoredJobSharing !== false),
);
// the caller, as the owner of a stored job is written : another user's in the Load list is shared
const storedJobOwner = computed(() => `${store.profile?.type || 'local'}/${store.profile?.username}`);

function buildMainStoreCtx() {
  return {
    scope: 'form',
    formName: currentForm.value.name,
    title: currentForm.value.name,
    sharing: currentForm.value?.allowStoredJobSharing !== false,
    getData: () => {
      // Wizard forms persist per-step drafts (without password values)
      // instead of merged extravars. That makes load-from-store
      // round-trippable into the wizard UI without trying to split a
      // flattened tree back into step buckets.
      if (wizardActive.value) {
        return { ...getWizardRawFormData(), completed: { ...wizardCompleted } };
      }
      return getFilteredRawFormData();
    },
    onLoad: (parsed) => {
      // Wizard load: restore per-step drafts and skip/completion marks.
      // Backwards compatible: if the stored blob is a flat object
      // (legacy or non-wizard form), fall back to initialFormData.
      if (wizardActive.value && parsed && parsed.__wizard__ === true) {
        Object.keys(wizardDrafts).forEach((k) => delete wizardDrafts[k]);
        Object.keys(wizardSkipped).forEach((k) => delete wizardSkipped[k]);
        Object.keys(wizardCompleted).forEach((k) => delete wizardCompleted[k]);
        Object.keys(wizardVisibility).forEach((k) => delete wizardVisibility[k]);
        const drafts = parsed.drafts || {};
        for (const step of wizardSteps.value) {
          if (step.isSummary) continue;
          wizardDrafts[step.name] = drafts[step.name] ? Helpers.deepClone(drafts[step.name]) : {};
        }
        if (parsed.skipped) Object.assign(wizardSkipped, parsed.skipped);
        if (parsed.completed) Object.assign(wizardCompleted, parsed.completed);
        wizardIndex.value = 0;
        key.value++;
        return;
      }
      initialFormData.value = parsed;
      key.value++;
    },
  };
}

/******************************** */
// computed
/******************************** */

// Build the output object for a subform draft, using the shared helper.
// `model`, `output`, `outputObject`, `valueColumn` on the subform's
// fields are all honoured, and nested list fields recurse through their
// own subform definitions.
function buildSubformOutput(entry) {
  if (!entry?.subform?.fields) return {};
  return Helpers.buildFormOutput(entry.subform.fields, entry.draft || {}, {
    subforms: currentForm.value.subforms || [],
  });
}

// When editing a subform, the right-hand "Extravars" panel switches to show
// the draft of the active subform instead of the main-form output. Outside
// subform editing this is just `formdata`. In wizard mode the panel shows
// the current step's contribution (or the merged result on the summary).
const displayedOutput = computed(() => {
  if (activeEntry.value) return buildSubformOutput(activeEntry.value);
  if (wizardActive.value) {
    const step = activeWizardStep.value;
    if (step?.isSummary) return wizardMergedOutput.value;
    if (step?.subform?.fields) return buildWizardStepOutput(step);
    return wizardMergedOutput.value;
  }
  return formdata.value;
});
const displayedOutputYaml = computed(() => {
  // Mask password-typed fields for display only - the underlying formdata
  // still carries the real values for submission / store / download.
  let fields;
  if (activeEntry.value) {
    fields = activeEntry.value.subform?.fields;
  } else if (wizardActive.value) {
    const step = activeWizardStep.value;
    fields = step?.subform?.fields;
    // For the summary step / merged view, build a synthetic field list
    // covering every visible step so password masking still finds them.
    if (!fields) {
      const all = [];
      for (const s of wizardSteps.value) {
        if (s.isSummary || !s.subform?.fields) continue;
        if (!isWizardStepVisible(s)) continue;
        // Prefix each field's model with the step's defaultModel so masking
        // walks the right paths in the merged tree.
        s.subform.fields.forEach((f) => {
          const prefix = s.defaultModel ? s.defaultModel.replace(/^\.+|\.+$/g, '') : '';
          const apply = (m) =>
            typeof m === 'string' ? (m.startsWith('/') ? m.slice(1) : prefix ? `${prefix}.${m}` : m) : m;
          let nextModel;
          if (Array.isArray(f.model)) nextModel = f.model.map(apply);
          else if (typeof f.model === 'string') nextModel = apply(f.model);
          else nextModel = prefix ? `${prefix}.${f.name}` : f.name;
          all.push({ ...f, model: nextModel });
        });
      }
      fields = all;
    }
  } else {
    fields = currentForm.value?.fields;
  }
  const subforms = currentForm.value?.subforms || [];
  const masked = Array.isArray(fields)
    ? Helpers.maskPasswordsForDisplay(displayedOutput.value, fields, subforms)
    : displayedOutput.value;
  return YAML.stringify(masked);
});
// a Rundeck form calls what it sends its payload ; the others, Ansible's word, extravars
const saysPayload = computed(() => currentForm.value?.type === 'rundeck');
// a Jenkins job's values go as its build's parameters
const saysParameters = computed(() => currentForm.value?.type === 'jenkins');
const displayedOutputTitle = computed(() => {
  if (activeEntry.value) return `${t('form.subformOutput')} - ${activeEntry.value.title}`;
  if (wizardActive.value) {
    const step = activeWizardStep.value;
    if (step?.isSummary)
      return t(saysPayload.value ? 'form.payload' : saysParameters.value ? 'form.parameters' : 'form.extraVars');
    return `${t('form.subformOutput')} - ${step?.title || ''}`;
  }
  return t(saysPayload.value ? 'form.payload' : saysParameters.value ? 'form.parameters' : 'form.extraVars');
});

// filter job output
const filteredJobOutput = computed(() => {
  if (!filterOutput.value) return job.value.output?.replace(/\r\n/g, '<br>') || '';
  return (
    job.value.output
      ?.replace(/<span class='low[^<]*<\/span>/g, '')
      .replace(/\r\n/g, '<br>')
      .replace(/(<br>\s*){3,}/gi, '<br><br>') || ''
  );
});

// ─── the output panel (as the job's page) ─────────────────────────────────────
// the outputs (the job's, and a multistep's current step) : the toolbar folds them all
const mainOutput = ref(null);
// a workflow node's output, opened from the graph (composables/useNodeOutput.js), as on the job's page
const { nodeShown, openNodeOutput } = useNodeOutput(mainOutput);
const subOutput = ref(null);

/**
 * Folds every section of the output, or unfolds them all when all are folded.
 */
function toggleFoldAll() {
  const expand = mainOutput.value?.allFolded;
  for (const out of [mainOutput.value, subOutput.value]) {
    if (out) expand ? out.expandAll() : out.collapseAll();
  }
}

// the output's lines, beside its title
const outputLines = computed(() => {
  const text = filteredJobOutput.value || '';
  return text
    ? text
        .replace(/<br\s*\/?>/gi, '\n')
        .trimEnd()
        .split('\n').length
    : 0;
});

// the job's own section's title : the AWX job template, else the playbook, else the form
const outputTitle = computed(() =>
  job.value?.job_type == 'awx' ? job.value.target : job.value?.extravars?.__playbook__ || job.value?.form || '',
);

/**
 * Copies the output as it reads on screen (the filter applied or not), as its plain text.
 */
function copyOutput() {
  const html = filteredJobOutput.value.replace(/<br\s*\/?>/gi, '\n');
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  clip(text, true);
}

// filter subjob output
const filteredSubJobOutput = computed(() => {
  if (!filterOutput.value) return subjob.value.output?.replace(/\r\n/g, '<br>') || '';
  return (
    subjob.value.output
      ?.replace(/<span class='low[^<]*<\/span>/g, '')
      .replace(/\r\n/g, '<br>')
      .replace(/(<br>\s*){3,}/gi, '<br><br>') || ''
  );
});

// a running job's output followed down as it comes in, while the reader is at its end
const outputPanel = ref(null);
const {
  paused: outputPaused,
  newLines: outputNewLines,
  jumpToEnd: jumpToOutputEnd,
} = useFollowOutput(
  outputPanel,
  () => (filteredJobOutput.value?.length || 0) + (filteredSubJobOutput.value?.length || 0),
  () => status.value === 'running',
);

const formStatus = computed(() => {
  if (status.value == 'running') {
    return {
      label: t('form.running'),
      color: 'primary',
      icon: 'spinner',
      disabled: true,
      reload: false,
      abort: true,
    };
  } else if (status.value == 'success') {
    return {
      label: t('form.finished'),
      color: 'success',
      icon: 'check',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'failed') {
    return {
      label: t('form.failed'),
      color: 'danger',
      icon: 'exclamation-triangle',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'warning') {
    return {
      label: t('form.finishedWithWarning'),
      color: 'warning',
      icon: 'exclamation-triangle',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'approve') {
    return {
      label: t('form.waitingForApproval'),
      color: 'warning',
      icon: 'spinner',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'abandoned') {
    return {
      label: t('form.abandoned'),
      color: 'warning',
      icon: 'exclamation-triangle',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'rejected') {
    return {
      label: t('form.rejected'),
      color: 'warning',
      icon: 'exclamation-triangle',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'aborted') {
    return {
      label: t('form.aborted'),
      color: 'warning',
      icon: 'exclamation-triangle',
      disabled: false,
      reload: true,
      abort: false,
    };
  } else if (status.value == 'initializing') {
    return {
      label: t('form.initializing'),
      color: 'primary',
      icon: 'spinner',
      disabled: true,
      reload: false,
      abort: false,
    };
  } else if (status.value == 'stabilizing') {
    return {
      label: t('form.stabilizingForm'),
      color: 'primary',
      icon: 'spinner',
      disabled: true,
      reload: false,
      abort: false,
    };
  } else if (status.value == 'submitting') {
    return {
      label: t('form.submittingForm'),
      color: 'primary',
      icon: 'spinner',
      disabled: true,
      reload: false,
      abort: false,
    };
  } else {
    return {
      label: t('form.pending'),
      color: 'secondary',
      icon: 'spinner',
      disabled: false,
      reload: false,
      abort: false,
    };
  }
});

/******************************** */
// methods
/******************************** */

async function reloadForm(reset = true) {
  if (reset) {
    resetResult();
  }
  // Close every subform being edited : the form is drawn anew below (key++), and an entry
  // left on the stack hid the fresh form behind a subform editor whose onSave wrote into
  // the list field of a form instance that no longer exists.
  editStack.splice(0);
  await loadFormSafely();
  key.value++;
}

// The load chain's token, as pollSeq is for the job poll : each load carries the value it
// started with and checks it after every await. Switching forms quickly (the menu, the
// search, Back) started a second load while the first was in flight, and whichever answered
// LAST was drawn - the page could show the form the user had already left, under the new
// address. Only the newest load may write anything.
let loadSeq = 0;

/**
 * Loads the form of the address, its failure shown instead of thrown. Form.load throws on
 * every non-200 (403 for a form the roles no longer grant, 404, 500 for a config error) : the
 * page then shows its explanation and a toast, rather than an unhandled rejection that left
 * it on the loader. The previous failure is forgotten first, so a form that loads after one
 * that did not is drawn.
 */
async function loadFormSafely() {
  const seq = ++loadSeq;
  formNotFound.value = false;
  loadError.value = '';
  try {
    await loadForm(seq);
  } catch (err) {
    // a newer load owns the page now : this one's failure is not about the form shown
    if (seq !== loadSeq) return;
    formNotFound.value = true;
    loadError.value = Helpers.parseAxiosResponseError(err, t('form.formNotFoundMsg'));
    toast.error(loadError.value);
  }
}

// ─── the forms menu (the Forms page's categories, in the left column) ─────────────────────

/**
 * The category browsed on the Forms page this session ('' for All Forms), or null when none was.
 *
 * Returns:
 *   string|null: the category.
 */
function browsedCategory() {
  try {
    return sessionStorage.getItem('af_forms_category');
  } catch (e) {
    return null;
  }
}

// the categories highlighted : every one the form is in (Default when it names none)
const menuCategories = computed(() =>
  currentForm.value?.categories?.length ? currentForm.value.categories : ['Default'],
);

/**
 * Opens the Forms page on a category of the menu.
 *
 * Args:
 *   category (string): the category ; empty for All Forms.
 */
function openCategory(category) {
  router.push(formsPath(category));
}

// ─── finding a field (the search box of the title line) ─────────────────────────────────────
// The fields whose name has the text typed are highlighted, and the page brought to the first ;
// Enter goes to the next. Only the fields shown are searched (a wizard's step, a subform being
// edited) : the others can not be scrolled to.
const formArea = ref(null);
const fieldSearch = ref('');
const fieldMatches = ref([]);
const fieldMatchIndex = ref(-1);
// the field names AppForm draws (af-field-label) ; the match ignores case
const FIELD_LABELS = '.af-field-label';
let fieldSearchTimer = null;

/**
 * Highlights the field names that have the text searched, and brings the page to one of them.
 *
 * Args:
 *   index (number): which match to bring into view (0 : the first).
 */
function findFields(index = 0) {
  const area = formArea.value;
  for (const el of area?.querySelectorAll('.af-field-hit') || [])
    el.classList.remove('af-field-hit', 'af-field-hit-current');
  const q = fieldSearch.value.trim().toLowerCase();
  fieldMatches.value = [];
  fieldMatchIndex.value = -1;
  if (!q || !area) return;
  const hits = [...area.querySelectorAll(FIELD_LABELS)].filter(
    (el) => el.offsetParent !== null && el.textContent.toLowerCase().includes(q),
  );
  for (const el of hits) el.classList.add('af-field-hit');
  fieldMatches.value = hits;
  if (hits.length) showFieldMatch(index % hits.length);
}

/**
 * Brings one match into view, marked as the current one.
 *
 * Args:
 *   index (number): the match.
 */
function showFieldMatch(index) {
  const hits = fieldMatches.value;
  hits[fieldMatchIndex.value]?.classList.remove('af-field-hit-current');
  fieldMatchIndex.value = index;
  hits[index].classList.add('af-field-hit-current');
  hits[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Enter : the next match, the first again after the last
function nextFieldMatch() {
  if (!fieldMatches.value.length) return findFields(0);
  showFieldMatch((fieldMatchIndex.value + 1) % fieldMatches.value.length);
}

// searched as it is typed, once the typing pauses
watch(fieldSearch, () => {
  clearTimeout(fieldSearchTimer);
  fieldSearchTimer = setTimeout(() => findFields(0), 200);
});

function toggleShowExtraVars() {
  showExtraVars.value = !showExtraVars.value;
  // Generate JSON immediately when opening extravars panel to avoid delay
  if (showExtraVars.value) {
    generateJsonOutput();
  }
}

// Timers scheduled by onSuccess/onFailure actions. They are tracked so onBeforeUnmount
// can cancel them: their ids used to be discarded, and `router` stays functional after
// the component is gone - so a form with `onSuccess: [{home: 30}]` yanked the user off
// whatever page they had navigated to 30 seconds later, and `clear`/`reload` ran a
// Form.load and wrote to dead refs on a destroyed component.
const actionTimers = ref([]);
function laterInThisForm(fn, seconds) {
  actionTimers.value.push(setTimeout(fn, seconds * 1000));
}

// do action after form submit
function doAction(a, jobid) {
  const action = Object.keys(a)[0];
  const value = a[action];
  var wait;
  var form = '';
  if (typeof value == 'string') {
    var tmp = value.split(/,(.*)/s);
    wait = parseInt(tmp[0]);
    form = tmp[1];
  } else {
    wait = parseInt(value);
  }
  if (action == 'clear') {
    laterInThisForm(() => {
      reloadForm(false);
    }, wait);
  }
  if (action == 'home') {
    laterInThisForm(() => {
      Navigate.toHome(router);
    }, wait);
  }
  if (action == 'load') {
    laterInThisForm(() => {
      // the form's own address (/form/<slug>), the job that ran passed on : a field named
      // __previous_jobid__ in that form gets it from the query (AppForm.vue). Another form's
      // address reloads through the watch on the slug ; this same form is loaded again here.
      const sameForm = slugOf(form) === slugOf(route.params.slug);
      router
        .push({ path: formPath(form), query: { __previous_jobid__: jobid } })
        .then(() => {
          if (sameForm) reloadForm();
        })
        .catch(() => {});
    }, wait);
  }
  if (action == 'reload') {
    laterInThisForm(() => {
      reloadForm();
    }, wait);
  }
  if (action == 'hide') {
    laterInThisForm(() => {
      hideForm.value = true;
    }, wait);
  }
  if (action == 'show') {
    laterInThisForm(() => {
      hideForm.value = false;
    }, wait);
  }
}

// when the form component triggers a change
// we can regenerate the json output
// for this we need to know which fields are visible
// so we the child passes the visibility information
function formChanged(formObjectData) {
  visibility.value = formObjectData.visibility;
  generateJsonOutput();
}

// Per-wizard-step change handler: stores visibility under the step's name
// so wizardMergedOutput can respect per-step `visible:` rules.
function wizardStepChanged(stepName, formObjectData) {
  wizardVisibility[stepName] = formObjectData.visibility || {};
}

/**
 * A wizard's raw form data : every step's draft, without its password and constant fields,
 * and the steps the user skipped. The server checks each shown step against its subform
 * from these (launch validation), and a stored wizard is restored from them.
 *
 * Returns:
 *   object: { __wizard__: true, drafts: { step: values }, skipped: { step: true } }.
 */
function getWizardRawFormData() {
  const drafts = {};
  for (const step of wizardSteps.value) {
    if (step.isSummary || !step.subform?.fields) continue;
    const src = wizardDrafts[step.name] || {};
    const clean = {};
    step.subform.fields.forEach((f) => {
      if (f.type === 'password' || f.type === 'constant') return;
      if (f.name in src) clean[f.name] = Helpers.deepClone(src[f.name]);
    });
    drafts[step.name] = clean;
  }
  return { __wizard__: true, drafts, skipped: { ...wizardSkipped } };
}

// Get filtered raw form data (excludes constants and passwords)
function getFilteredRawFormData() {
  if (wizardActive.value) return getWizardRawFormData();
  const rawFormData = {};
  (currentForm.value.fields || []).forEach((field) => {
    const fieldName = field.name;

    // Skip if field value not in form
    if (!(fieldName in form.value)) return;

    // Skip constants (loaded from config, not user input)
    if (field.type === 'constant') return;

    // Skip password fields for security
    if (field.type === 'password') return;

    // No name-based exclusion : only the form's own declared fields are walked, so a field
    // named server, database or metadata is user input like any other. Skipping those names
    // dropped them from the rawFormData the server validates the launch with (validateLaunch)
    // - the same rule as server/src/lib/formEngine/output.js filterRawFormData.

    // Include this field
    rawFormData[fieldName] = form.value[fieldName];
  });
  return rawFormData;
}

// generate the form json output
function generateJsonOutput(filedata = {}) {
  if (wizardActive.value) {
    // In wizard mode the canonical output lives in wizardMergedOutput;
    // we just mirror it into formdata so downstream consumers (download,
    // copy, schedule) keep working unchanged.
    formdata.value = Helpers.deepClone(wizardMergedOutput.value) || {};
    return;
  }
  try {
    formdata.value = Helpers.buildFormOutput(currentForm.value.fields || [], form.value, {
      isVisible: (item) => !!visibility.value[item.name],
      overrides: filedata,
      subforms: currentForm.value.subforms || [],
    });
  } catch (err) {
    toast.error(t('form.outputFailed', { error: err.message || err.toString() }));
  }
}

// upload a file
async function uploadFile(fieldname, file) {
  // toast.info(`Start uploading ${file.name}`);
  var uploadFormData = new FormData();
  uploadFormData.append('file', file);
  const config = {
    ...TokenStorage.getAuthenticationMultipart(),
    onUploadProgress: (progressEvent) => {
      fileProgress.value[fieldname] = Math.round((progressEvent.loaded / progressEvent.total) * 100);
      if (fileProgress.value[fieldname] == 100) {
        toast.success(t('form.fileUploaded', { name: file.name }));
        setTimeout(() => {
          fileProgress.value[fieldname] = undefined;
        }, 2000);
      }
    },
  };
  const result = await axios.post(`/api/v2/job/upload/`, uploadFormData, config);
  return result.data;
}

async function submitForm(formObjectData) {
  var postdata = {};
  postdata.files = {};

  // the visibility data is passed from the AppForm component
  // we need it to know which fields are visible and which are not
  visibility.value = formObjectData.visibility;

  currentForm.value.fields
    ?.filter((f) => f.type == 'file' && form.value[f.name]?.name)
    .forEach((f) => {
      postdata.files[f.name] = form.value[f.name];
    });

  try {
    const fileKeys = Object.keys(postdata.files);
    const uploadPromises = fileKeys.map(async (key) => {
      try {
        var result = await uploadFile(key, postdata.files[key]);
        postdata.files[key] = result;
      } catch (e) {
        console.log(e);
        throw new Error('Failed uploading files', { cause: e });
      }
    });
    await Promise.all(uploadPromises);
  } catch (err) {
    toast.error(err.toString());
    resetResult();
    throw new Error('Failed uploading files', { cause: err });
  }

  pauseJsonOutput.value = true;
  generateJsonOutput(postdata.files);
  postdata.extravars = formdata.value;
  if (enableVerbose.value) {
    postdata.extravars.__verbose__ = true;
  }
  postdata.formName = currentForm.value.name;
  // Store raw form data for potential re-use (exclude sensitive/irrelevant fields)
  postdata.rawFormData = getFilteredRawFormData();
  console.log('Submitting with rawFormData:', Object.keys(postdata.rawFormData));
  postdata.credentials = {};
  currentForm.value.fields
    ?.filter((f) => f.asCredential == true)
    .forEach((f) => {
      postdata.credentials[f.name] = formdata.value[f.name];
    });
  launchForm(postdata);
}

// copy to clipboard
// (Helpers.copyToClipboard : one copy for the whole app, its promise rejecting when nothing
// was copied, so the success toast only says what really happened)
async function clip(v, doNotStringify = false, asYaml = false) {
  try {
    const text = doNotStringify ? v : asYaml ? YAML.stringify(v) : JSON.stringify(v, null, 2);
    await Helpers.copyToClipboard(text);
    toast.success(t('common.copied'));
  } catch (err) {
    toast.error(t('common.copyFailed', { error: String(err?.message || err) }));
  }
}

// The poll chain's token : each run's chain carries the value it started with, and checks it
// after every await. Clearing the timeout alone did not stop a chain whose getJob request was
// in flight at that moment : its answer came back after the reset (or after the page was left)
// and scheduled the next poll anyway, writing job and status on a form that had moved on.
// Bumping the token (a reset, a new run, the page unmounted) ends every older chain.
let pollSeq = 0;

// reset result
function resetResult() {
  pollSeq++;
  clearTimeout(timeout.value);
  status.value = '';
  message.value = '';
  error.value = '';
  subjob.value = {};
  job.value = {};
}

// Handle submit action from AppForm component
async function handleSubmitAction({ action, visibility: formVisibility }) {
  // Refuse while a run is already under way (the same guard the wizard path has) : a
  // double click on Submit emitted twice before the button hid, and both calls went on to
  // await the form and launch - two jobs from one click.
  if (status.value !== '') return;
  visibility.value = formVisibility;
  // a preview (the designer's) runs nothing : submit, schedule, run later and store alike
  if (isPreview.value) {
    toast.info(t('designer.previewNotRun'));
    return;
  }

  switch (action) {
    case 'submit':
      // Main submit action - trigger form submission
      // set synchronously, so a second call returns at the guard above
      status.value = 'stabilizing';
      // Wait for every dynamic field to settle first. This is the ONLY submit gate. AppForm computes this (canSubmit)
      // and even emits a "submit" event when it flips, but that event is not declared and
      // nothing listens to it - so submitForm used to run the instant the button was
      // pressed and a slow query/expression field was read while still undefined, sending
      // the job a missing or stale extravar with no sign anything was wrong.
      if (mainForm.value?.awaitStable && !(await mainForm.value.awaitStable())) {
        toast.warning(t('form.tooLongToEvaluate'));
        // and which fields held it up (exposed refs are unwrapped on the instance)
        if (mainForm.value.unevaluatedFieldsWarning) toast.warning(mainForm.value.unevaluatedFieldsWarning);
        status.value = '';
        return;
      }
      submitForm({ visibility: formVisibility });
      break;
    case 'schedule':
      openScheduleOffcanvas('schedule');
      break;
    case 'run-later':
      openScheduleOffcanvas('run-later');
      break;
    case 'store':
      storeCtx.value = buildMainStoreCtx();
      openStoreOffcanvas();
      break;
  }
}

// Open schedule off-canvas
function openScheduleOffcanvas(action = 'schedule') {
  // a preview (the designer's) runs nothing, stores nothing, schedules nothing
  if (isPreview.value) {
    toast.info(t('designer.previewNotRun'));
    return;
  }
  scheduleAction.value = action;

  // Reset schedule form with appropriate defaults
  if (action === 'schedule') {
    scheduleForm.value = {
      name: '',
      one_time_run: false,
      cron: '0 0 * * *', // Default: daily at midnight
      run_at: null,
    };
  } else {
    // run-later
    scheduleForm.value = {
      name: '',
      one_time_run: true,
      cron: '',
      run_at: null,
    };
  }

  showScheduleOffcanvas.value = true;
}

// Close schedule off-canvas
function closeScheduleOffcanvas() {
  showScheduleOffcanvas.value = false;
  scheduleSubmitting.value = false;
}

// Create schedule via API
async function createSchedule() {
  // Simple validation
  if (!scheduleForm.value.name) {
    toast.warning(t('form.nameRequired'));
    return;
  }

  // Ensure type is set based on action
  scheduleForm.value.one_time_run = scheduleAction.value === 'run-later';

  if (!scheduleForm.value.one_time_run && !scheduleForm.value.cron) {
    toast.warning(t('form.cronRequired'));
    return;
  }

  if (scheduleForm.value.one_time_run && !scheduleForm.value.run_at) {
    toast.warning(t('form.runAtRequired'));
    return;
  }

  scheduleSubmitting.value = true;

  try {
    // Use the existing formdata which is already modelled by generateJsonOutput
    generateJsonOutput();

    const scheduleData = {
      name: scheduleForm.value.name,
      one_time_run: scheduleForm.value.one_time_run,
      form: currentForm.value.name,
      extra_vars: YAML.stringify(formdata.value),
      // the raw field values : a planned run is checked by the launch validation when it is
      // planned and when it fires, as a launch from here is
      raw_form_data: getFilteredRawFormData(),
      // "Run later" plans one run of this form as the signed-in user, admin or not ; only
      // "Schedule" makes a schedule that runs as the Schedule Service (#1063)
      planned: scheduleAction.value === 'run-later',
    };

    // Add type-specific fields
    if (!scheduleForm.value.one_time_run) {
      scheduleData.cron = scheduleForm.value.cron;
    } else {
      scheduleData.run_at = scheduleForm.value.run_at;
    }

    await axios.post('/api/v2/schedule', scheduleData);

    const successMessage =
      scheduleAction.value === 'schedule'
        ? t('form.scheduleCreated', { name: scheduleForm.value.name })
        : t('form.jobScheduled', { name: scheduleForm.value.name });
    toast.success(successMessage);
    closeScheduleOffcanvas();
  } catch (error) {
    console.error('Error creating schedule:', error);
    // the server answers { error } (and perhaps details) : read as every other page does
    toast.error(Helpers.parseAxiosResponseError(error, t('form.scheduleCreateFailed')));
  } finally {
    scheduleSubmitting.value = false;
  }
}

// Store off-canvas functions
function openStoreOffcanvas() {
  // a preview (the designer's) runs nothing, stores nothing, schedules nothing
  if (isPreview.value) {
    toast.info(t('designer.previewNotRun'));
    return;
  }
  // Reset store form
  storeForm.value = {
    name: '',
    description: '',
    expires_at: null,
    shared: false,
  };

  showStoreOffcanvas.value = true;
}

function closeStoreOffcanvas() {
  showStoreOffcanvas.value = false;
  storeSubmitting.value = false;
}

async function createStoredJob() {
  // Simple validation
  if (!storeForm.value.name) {
    toast.warning(t('form.nameRequired'));
    return;
  }

  const ctx = storeCtx.value || buildMainStoreCtx();
  storeSubmitting.value = true;

  try {
    const storedJobData = {
      name: storeForm.value.name,
      description: storeForm.value.description || '',
      form_name: ctx.formName,
      form_data: JSON.stringify(ctx.getData()),
      expires_at: storeForm.value.expires_at || null,
      visibility: canShareStored.value && storeForm.value.shared ? 'shared' : 'private',
    };

    await axios.post('/api/v2/stored-jobs', storedJobData);

    toast.success(t('form.formDataSaved', { name: storeForm.value.name }));
    closeStoreOffcanvas();
  } catch (error) {
    console.error('Error storing job:', error);
    if (error.response?.status === 409) {
      toast.error(t('form.savedFormExists'));
    } else {
      toast.error(Helpers.parseAxiosResponseError(error, t('form.formDataSaveFailed')));
    }
  } finally {
    storeSubmitting.value = false;
  }
}

// Load off-canvas functions
async function openLoadOffcanvas() {
  // If called from the main-form toolbar button there's no active context yet;
  // assume main-form scope.
  if (!storeCtx.value) storeCtx.value = buildMainStoreCtx();
  const ctx = storeCtx.value;
  showLoadOffcanvas.value = true;
  loadSubmitting.value = true;

  try {
    const response = await axios.get(`/api/v2/stored-jobs?form_name=${encodeURIComponent(ctx.formName)}`);
    storedJobs.value = response.data.records || [];
  } catch (error) {
    console.error('Error fetching stored jobs:', error);
    toast.error(Helpers.parseAxiosResponseError(error, t('form.savedFormsLoadFailed')));
    storedJobs.value = [];
  } finally {
    loadSubmitting.value = false;
  }
}

function closeLoadOffcanvas() {
  showLoadOffcanvas.value = false;
}

async function loadStoredJob(storedJob) {
  try {
    loadSubmitting.value = true;

    const parsedData = JSON.parse(storedJob.form_data);
    const ctx = storeCtx.value || buildMainStoreCtx();
    ctx.onLoad(parsedData);

    closeLoadOffcanvas();
    toast.success(t('form.storedJobLoaded', { name: storedJob.name }));
  } catch (error) {
    console.error('Error loading stored job:', error);
    toast.error(t('form.formDataLoadFailed'));
  } finally {
    loadSubmitting.value = false;
  }
}

// Triggered by store / load actions inside a subform's Save dropdown.
// `value` is the current in-progress draft emitted by AppForm so we can
// snapshot partial edits without forcing validation.
function handleSubformAction(entry, { action, value }) {
  storeCtx.value = {
    scope: 'subform',
    formName: entry.subform.name,
    title: entry.subform.description || entry.subform.name,
    sharing: entry.subform.allowStoredJobSharing !== false,
    getData: () => value,
    onLoad: (parsed) => {
      entry.snapshot = parsed;
      entry.reloadKey = (entry.reloadKey || 0) + 1;
    },
  };
  if (action === 'store') openStoreOffcanvas();
  else if (action === 'load') openLoadOffcanvas();
}

// trigger a job abort
async function abortJob(id) {
  // no id yet : the job is still being created
  if (!id) return;
  toast.warning(t('form.abortingJob', { id }));
  try {
    const result = await axios.post(`/api/v2/job/${id}/abort`, {});
    if (result.status == 200) {
      abortTriggered.value = true;
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('form.failedToAbort')));
  }
}
// download a job
async function download(id) {
  try {
    await Helpers.downloadFile(`/api/v2/job/${id}/download`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}
// get job output
// seq : the poll chain's token (pollSeq) ; a chain whose token is no longer current stops
async function getJob(id, final, seq = pollSeq) {
  try {
    // get the job result
    const result = await axios.get(`/api/v2/job/${id}`);
    // reset, relaunched or left while the request was in flight : this chain is over
    if (seq !== pollSeq) return;
    pollFailures.value = 0; // a poll got through : forget earlier blips
    // store the job result
    job.value = result.data;
    status.value = job.value.status;
    loadEvents(id, job.value.job_type);
    // multistep and subjobs ?
    if (job.value.job_type == 'multistep' && job.value.subjobs.length > 0) {
      const lastsubjob = job.value.subjobs.slice(-1)[0];
      try {
        const subjobresult = await axios.get(`/api/v2/job/${lastsubjob}`);
        if (seq !== pollSeq) return;
        subjob.value = subjobresult.data;
      } catch (e) {
        console.error('Error getting job: ' + lastsubjob);
      }
    }
    // if the job is not final, we need to keep checking
    if (!['success', 'error', 'failed', 'warning', 'rejected', 'abandoned', 'aborted'].includes(status.value)) {
      // try again
      if (status.value == 'approve') {
        State.refreshApprovals(); // refresh approvals if needed
      }
      timeout.value = setTimeout(async () => await getJob(id, false, seq), 2000);
    } else {
      // the job seems finished
      if (!final) {
        // have we done a final result check?
        // 1 final check
        timeout.value = setTimeout(async () => await getJob(id, true, seq), 2000);
      } else {
        // any frontend actions to do?
        if (currentForm.value.onFinish) {
          currentForm.value.onFinish.forEach((action) => doAction(action, id));
        }
        if (status.value == 'success' && currentForm.value.onSuccess) {
          currentForm.value.onSuccess.forEach((action) => doAction(action, id));
        }
        if (status.value == 'failed' && currentForm.value.onFailure) {
          currentForm.value.onFailure.forEach((action) => doAction(action, id));
        }
        if (status.value == 'aborted' && currentForm.value.onAbort) {
          currentForm.value.onAbort.forEach((action) => doAction(action, id));
        }
        abortTriggered.value = false;
        message.value = Helpers.getJobMessageByStatus(status.value);
        if (status.value == 'success') {
          toast.success(message.value);
        } else if (status.value == 'failed') {
          toast.error(message.value);
        } else {
          toast.warning(message.value);
        }
        clearTimeout(timeout.value);
        State.refreshApprovals(); // refresh approvals if needed
      }
    }
  } catch (err) {
    // an older chain's failure says nothing : the form moved on
    if (seq !== pollSeq) return;
    console.log('error getting job ' + err.toString());
    toast.error(t('form.failedToGetJob'));

    // optional chaining : on a network failure err.response is undefined, so this threw a
    // TypeError from inside the catch itself, killing the poll chain with an unhandled
    // rejection. launchForm and openLoadOffcanvas already use err.response?.status.
    if (err.response?.status != 401) {
      // Retry rather than ending the chain. This branch scheduled nothing, so a single
      // failed poll - a VPN reconnect, a laptop resume, a server restart - stopped the
      // polling for good while the job was still running. And "error" has no case in
      // formStatus, so it fell through to the "Pending" label with no spinner and no
      // abort button: the only way out was closing the output or reloading the page.
      pollFailures.value++;
      if (pollFailures.value < 5) {
        timeout.value = setTimeout(async () => await getJob(id, false, seq), 2000);
      } else {
        message.value = t('form.jobReadFailed') + '\n\n' + err.toString();
        status.value = 'error';
      }
    }
  }
}

// execute the form
async function launchForm(postdata) {
  // a preview (the designer's) runs nothing, stores nothing, schedules nothing
  if (isPreview.value) {
    toast.info(t('designer.previewNotRun'));
    return;
  }
  message.value = t('form.connecting');
  status.value = '';
  // the previous job is done with : until the server answers with the new id, the abort
  // button must not point at it (an abort clicked during the launch went to the old job)
  jobId.value = undefined;
  abortTriggered.value = false;
  // a new run : its own poll chain, any older one ended
  const seq = ++pollSeq;
  try {
    status.value = 'running';
    const result = await axios.post(`/api/v2/job/`, postdata);
    // reset or left while the launch was answered : nothing to follow on this page
    if (seq !== pollSeq) return;
    jobId.value = result.data.id;
    if (currentForm.value.onSubmit) {
      currentForm.value.onSubmit.forEach((action) => {
        doAction(action, jobId.value);
      });
    }
    timeout.value = setTimeout(async () => await getJob(jobId.value, false, seq), 2000);
  } catch (err) {
    if (seq !== pollSeq) return;
    status.value = 'failed';
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to invoke job launch'));
    if (err.response?.status != 401) {
      resetResult();
    }
  } finally {
    // also after an early return above : the json output never stays paused
    pauseJsonOutput.value = false;
  }
}

/**
 * The form an address names : /form/<its name as an address> (lib/formsPath.js), read back
 * against the forms the user may open.
 *
 * Args:
 *   slug (string): the address after /form/.
 *
 * Returns:
 *   Promise<string|null>: the form's name, or null when the user has no form of that address.
 */
async function formNameOf(slug) {
  return formFromPath(slug, (await Form.list())?.forms);
}

/**
 * Loads the form of the address into the page.
 *
 * Args:
 *   seq (number): this load's token (loadSeq) ; once a newer load started, this one stops at
 *     its next await without writing anything.
 *
 * Raises:
 *   Error: Form.load's failure (loadFormSafely shows it).
 */
async function loadForm(seq = loadSeq) {
  // a newer load started while this one was waiting : drop this one's results
  const stale = () => seq !== loadSeq;
  const slug = route.params.slug;
  if (!slug) {
    console.error('No form name provided in the URL');
    formNotFound.value = true;
    return;
  }
  // a preview carries the designer's copy of the form, perhaps not saved yet : its name is only
  // needed when that copy is missing
  const formName = await formNameOf(slug);
  if (stale()) return;
  if (!formName && !route.query.preview) {
    console.error('No form with the address ' + slug);
    formNotFound.value = true;
    return;
  }
  if (route.query.preview) {
    const previewPayload = sessionStorage.getItem('designer-preview');
    let previewLoaded = false;
    if (previewPayload) {
      sessionStorage.removeItem('designer-preview');
      try {
        const { form, constants: previewConstants, subforms } = JSON.parse(previewPayload);
        const parsed = YAML.parse(form);
        // a comment-only / '---' buffer parses to null : that is not a form, and
        // wrapping it in forms:[null] would leave the page on the loader forever
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.error('Preview payload does not hold a form object');
          formNotFound.value = true;
          return;
        }
        // the designer resolves the subforms referenced by list/yaml fields and
        // wizard steps (the server does that on the normal path), otherwise a
        // wizard renders no steps and list fields render no columns
        if (Array.isArray(subforms) && !parsed.subforms) {
          parsed.subforms = subforms;
        }
        formConfig.value = { forms: [parsed], constants: previewConstants || {} };
        previewLoaded = true;
      } catch (e) {
        console.error('Failed to parse preview payload', e);
      }
    }
    if (!previewLoaded) {
      if (!formName) {
        formNotFound.value = true;
        return;
      }
      const loaded = await Form.load(formName);
      if (stale()) return;
      formConfig.value = loaded;
    }
  } else {
    const loaded = await Form.load(formName);
    if (stale()) return;
    formConfig.value = loaded;
  }
  if (formConfig.value.forms.length == 0) {
    console.error('No forms found in the configuration for form: ' + formName);
    formNotFound.value = true;
    return;
  } else {
    // Check for pre-fill data from query params BEFORE setting currentForm
    initialFormData.value = {};
    if (route.query.prefillJobId) {
      try {
        console.log('Loading pre-fill data from job:', route.query.prefillJobId);
        const result = await axios.get(`/api/v2/job/${route.query.prefillJobId}/rawformdata`);
        if (stale()) return;
        if (result.data) {
          initialFormData.value = result.data;
          toast.info(t('form.prefilled', { id: route.query.prefillJobId }));
        } else {
          console.log('No data in result:', result.data);
        }
      } catch (err) {
        if (stale()) return;
        console.error('Failed to load pre-fill data:', err);

        // the server's own words when it sent some ({ error }), else what its status means
        let errorMessage = t('form.prefillFailed');
        if (err.response?.data?.error) {
          errorMessage = Helpers.parseAxiosResponseError(err, errorMessage);
        } else if (err.response?.status === 404) {
          errorMessage = t('form.prefillNotFound');
        } else if (err.response?.status === 403) {
          errorMessage = t('form.prefillForbidden');
        } else if (err.response?.status === 400) {
          errorMessage = t('form.prefillMismatch');
        }

        toast.error(errorMessage);
      }
    }

    constants.value = formConfig.value.constants;

    // Now set currentForm which will trigger component rendering
    currentForm.value = formConfig.value.forms[0];
    formLoaded.value = true;

    // Initialize wizard drafts so v-model bindings have a stable target.
    if (Array.isArray(currentForm.value?.wizard)) {
      wizardIndex.value = 0;
      Object.keys(wizardDrafts).forEach((k) => delete wizardDrafts[k]);
      Object.keys(wizardVisibility).forEach((k) => delete wizardVisibility[k]);
      Object.keys(wizardSkipped).forEach((k) => delete wizardSkipped[k]);
      Object.keys(wizardCompleted).forEach((k) => delete wizardCompleted[k]);
      wizardRefs.value = {};
      currentForm.value.wizard.forEach((raw) => {
        if (raw?.summary) return;
        const stepName = raw.name || raw.subform;
        if (stepName) wizardDrafts[stepName] = {};
      });
    }

    // Relaunched with prefill (?prefillJobId=<id>) : a wizard job stored its step drafts,
    // restored into the steps as a stored wizard is
    if (wizardActive.value && initialFormData.value?.__wizard__ === true) {
      buildMainStoreCtx().onLoad(initialFormData.value);
      initialFormData.value = {};
    }

    // Opened from a stored job's page (?storedJob=<id>) : its values filled in, as the form's
    // own Load button does - a wizard's per-step drafts too
    if (route.query.storedJob) {
      try {
        const res = await axios.get(`/api/v2/stored-jobs/${encodeURIComponent(route.query.storedJob)}`);
        if (stale()) return;
        const stored = res.data?.records ? res.data.records[0] : res.data;
        if (stored?.form_data) {
          buildMainStoreCtx().onLoad(JSON.parse(stored.form_data));
          toast.success(t('form.storedJobLoaded', { name: stored.name }));
        }
      } catch (err) {
        if (stale()) return;
        toast.error(Helpers.parseAxiosResponseError(err, t('form.storedJobLoadFailed')));
      }
    }
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
  // A failed load used to leave the page on the bare spinner for ever: Form.load throws
  // on every non-200 (403 for a form your roles no longer grant, 404, 500 for a config
  // error) and nothing caught it, so currentForm stayed null and formNotFound stayed
  // false - the one branch that renders an explanation was never reached. The user got a
  // spinner, no toast, and only an unhandled rejection in devtools.
  await loadFormSafely();
  resetResult();
});

// another form's address (a form opened from this one's menu, the search) : that form
watch(
  () => route.params.slug,
  async (newForm, oldForm) => {
    if (newForm && newForm !== oldForm) {
      // the previous form is not drawn while this one loads (nor stays when this one fails)
      currentForm.value = null;
      formLoaded.value = false;
      // nor are its values carried over : AppForm fills form in place, so a field the new
      // form shares by name started from the old form's value (subforms close in reloadForm)
      form.value = {};
      await reloadForm();
    }
  },
);

onBeforeUnmount(() => {
  // the poll chain ends too, also one whose request is in flight
  pollSeq++;
  clearTimeout(timeout.value);
  // the onSuccess/onFailure timers too : otherwise they navigate the router, or reload a
  // form, on a component that no longer exists
  for (const id of actionTimers.value) clearTimeout(id);
  actionTimers.value = [];
});
</script>

<template>
  <AppNav v-if="!isEmbedded" />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <!-- the forms menu of the Forms page : the form's categories highlighted (the category
           browsed while the form loads) ; a category goes back to the Forms page on it -->
      <AppFormsMenu
        v-if="!isEmbedded"
        class="d-none d-md-block"
        :currentCategory="browsedCategory()"
        :formCategories="currentForm ? menuCategories : null"
        @select="openCategory"
      />
      <div v-if="authenticated && currentForm" class="section container-fluid w-100 mt-3">
        <div v-show="!hideForm" ref="formArea">
          <!-- BREADCRUMBS (only when editing a subform) -->
          <nav v-if="activeEntry" aria-label="breadcrumb">
            <ol class="breadcrumb mb-2">
              <li class="breadcrumb-item">{{ currentForm.name }}</li>
              <li v-for="e in editStack.slice(0, -1)" :key="'crumb-' + e.id" class="breadcrumb-item">{{ e.title }}</li>
              <li class="breadcrumb-item active fw-bold" aria-current="page">{{ activeEntry.title }}</li>
            </ol>
          </nav>

          <!-- TITLE : the form's (a subform's while editing one), its help in the info popover,
               its buttons at the right ; the divider under it, as on the other pages -->
          <div class="d-flex flex-wrap align-items-center border-bottom mb-3 pb-3 af-page-head">
            <h3 class="mb-0 me-3">
              <!-- the section first, as every page's title (lib/sections.js) : Forms › the form -->
              <router-link :to="formsPath('')" class="af-crumb-link"
                ><span class="me-2"><FaIcon icon="rectangle-list" /></span>{{ t('nav.forms') }}</router-link
              ><span class="mx-2 text-body-secondary af-crumb-separator"><FaIcon icon="chevron-right" /></span>
              {{ activeEntry ? activeEntry.subtitle || activeEntry.title : currentForm.name }}
              <AppInfoPopover
                v-if="activeEntry ? activeEntry.subform?.help : currentForm.help"
                :key="activeEntry ? 'help-' + activeEntry.id : 'help-form'"
                :text="activeEntry ? activeEntry.subform.help : currentForm.help"
                markdown
                placement="bottom"
                :label="t('form.showHelp')"
              />
            </h3>
            <!-- its controls under it, as every page's : the search at the left (it finds a field
                 and highlights its name), the buttons at the right -->
            <div class="af-title-controls af-form-controls">
              <BsSearch
                v-model="fieldSearch"
                :placeholder="t('form.findField')"
                :title="t('form.findFieldHint')"
                @keydown.enter.prevent="nextFieldMatch()"
              />
              <div class="af-header-buttons">
                <!-- a subform being edited : back to the form, load its values, its output -->
                <template v-if="activeEntry">
                  <BsButton cssClass="text-nowrap" icon="arrow-left" @click="popEdit(activeEntry.id)">
                    {{ t('form.back') }}
                  </BsButton>
                  <BsButton
                    v-if="store.profile.options?.allowStoredJobs"
                    cssClass="text-nowrap"
                    icon="file-import"
                    @click="handleSubformAction(activeEntry, { action: 'load', value: activeEntry.draft })"
                  >
                    {{ t('form.loadFromStore') }}
                  </BsButton>
                  <BsButton
                    v-if="store.profile.options?.showExtraVars"
                    cssClass="text-nowrap"
                    cssClassToggle="text-nowrap"
                    icon="eye"
                    iconToggle="eye-slash"
                    :toggle="showExtraVars"
                    @click="toggleShowExtraVars()"
                  >
                    {{ t('form.showOutput') }}<template #toggle>{{ t('form.hideOutput') }}</template>
                  </BsButton>
                </template>
                <!-- the form (or its wizard) : its extravars, reload, load its values (verbose : on the
                   form's toolbar row, under the divider) -->
                <template v-else>
                  <BsButton
                    v-if="store.profile.options?.showExtraVars"
                    cssClass="text-nowrap"
                    cssClassToggle="text-nowrap"
                    icon="eye"
                    iconToggle="eye-slash"
                    :toggle="showExtraVars"
                    @click="toggleShowExtraVars()"
                    >{{
                      t(
                        saysPayload
                          ? 'form.showPayload'
                          : saysParameters
                            ? 'form.showParameters'
                            : 'form.showExtravars',
                      )
                    }}<template #toggle>{{
                      t(
                        saysPayload
                          ? 'form.hidePayload'
                          : saysParameters
                            ? 'form.hideParameters'
                            : 'form.hideExtravars',
                      )
                    }}</template>
                  </BsButton>
                  <BsButton v-if="!isEmbedded" cssClass="text-nowrap" icon="redo" @click="reloadForm">
                    {{ t('form.reloadForm') }}
                  </BsButton>
                  <BsButton
                    v-if="store.profile.options?.allowStoredJobs"
                    cssClass="text-nowrap"
                    icon="file-import"
                    @click="
                      storeCtx = buildMainStoreCtx();
                      openLoadOffcanvas();
                    "
                  >
                    {{ t('form.loadFromStore') }}
                  </BsButton>
                </template>
              </div>
            </div>
          </div>
          <!-- the extravars the form makes (a subform's or a wizard step's while on one) : a card
               under the divider, over the form's toolbar row - JSON or YAML, copy, close -->
          <div v-if="showExtraVars" class="af-output-panel af-form-extravars">
            <div class="af-data-head">
              <span class="af-data-title">
                <FaIcon icon="eye" />
                {{ displayedOutputTitle }}
              </span>
              <div class="af-data-tools">
                <div class="af-segmented" role="group">
                  <button
                    type="button"
                    class="af-tool-btn"
                    :class="{ active: !viewAsYaml }"
                    @click="viewAsYaml = false"
                  >
                    JSON
                  </button>
                  <button type="button" class="af-tool-btn" :class="{ active: viewAsYaml }" @click="viewAsYaml = true">
                    YAML
                  </button>
                </div>
                <button type="button" class="af-tool-btn" @click="clip(displayedOutput, false, viewAsYaml)">
                  <FaIcon icon="copy" />{{ t('jobs.copy') }}
                </button>
                <button
                  type="button"
                  class="af-tool-btn af-tool-icon"
                  :aria-label="t('common.close')"
                  @click="toggleShowExtraVars()"
                >
                  <FaIcon icon="xmark" />
                </button>
              </div>
            </div>
            <div class="af-data-body">
              <VueJsonPretty v-if="!viewAsYaml" :data="displayedOutput" />
              <pre
                v-else
                v-highlightjs
              ><code language="yaml" style="border:none;padding:0;background:none">{{ displayedOutputYaml }}</code></pre>
            </div>
          </div>
          <div class="row">
            <div class="col">
              <!-- WIZARD: stepper + per-step AppForm. Mounted instead of the
                   main form when currentForm.wizard is present. -->
              <div v-if="wizardActive && !activeEntry" class="mb-3">
                <!-- Per-step AppForm (or summary view) -->
                <template v-for="(step, idx) in wizardSteps" :key="step.name + ':' + key">
                  <div v-show="idx === wizardIndex">
                    <!-- Step help -->
                    <div v-if="step.help && step.showHelp" class="alert alert-light" role="alert">
                      <!-- sanitized : the help is form-provided markdown (lib/markdown.js) -->
                      <div v-html="renderMarkdown(step.help)"></div>
                    </div>

                    <!-- Regular subform step: stepper is injected into the
                         AppForm's #toolbarbuttons slot so it lands on the
                         same row as the show-hidden-fields / spinner icons. -->
                    <AppForm
                      v-if="!step.isSummary && step.subform"
                      mode="wizard"
                      :ref="(el) => setWizardRef(step.name, el)"
                      :currentForm="step.subform"
                      :constants="constants"
                      :subforms="currentForm?.subforms || []"
                      :rootFormName="currentForm?.name || ''"
                      :parentData="wizardParentData"
                      :showExtraVars="showExtraVars"
                      :initialData="wizardDrafts[step.name] || {}"
                      v-model="wizardDrafts[step.name]"
                      @change="(d) => wizardStepChanged(step.name, d)"
                    >
                      <template #toolbarbuttons>
                        <ol class="ansibleforms-wizard-stepper d-flex flex-wrap align-items-center list-unstyled mb-0">
                          <template v-for="(s, i) in wizardSteps" :key="'sb-' + s.name">
                            <li
                              v-if="isWizardStepVisible(s) || wizardSkipped[s.name]"
                              class="wizard-step d-flex align-items-center"
                              :class="{ active: i === wizardIndex }"
                            >
                              <button
                                type="button"
                                class="wizard-step-btn"
                                :title="s.title"
                                :class="[
                                  i === wizardIndex
                                    ? 'is-current'
                                    : wizardSkipped[s.name]
                                      ? 'is-skipped'
                                      : wizardCompleted[s.name]
                                        ? 'is-done'
                                        : 'is-pending',
                                ]"
                                @click="wizardGoTo(i)"
                              >
                                <i v-if="wizardSkipped[s.name]" class="fa fa-forward"></i>
                                <i v-else-if="s.isSummary" class="fa fa-list-check"></i>
                                <i v-else-if="wizardCompleted[s.name]" class="fa fa-check"></i>
                                <span v-else>{{ i + 1 }}</span>
                              </button>
                              <span class="wizard-step-label ms-2 small">{{ s.title }}</span>
                              <span v-if="i < wizardSteps.length - 1" class="wizard-step-connector"></span>
                            </li>
                          </template>
                        </ol>
                        <BsInputCheckboxRaw
                          v-if="store.profile.options?.allowVerboseMode"
                          v-model="enableVerbose"
                          :label="'verbose'"
                          cssClass="d-inline-block mb-0 ms-3"
                        />
                      </template>
                    </AppForm>

                    <!-- Missing subform reference -->
                    <div v-else-if="!step.isSummary && !step.subform" class="alert alert-danger">
                      {{ t('form.wizardMissingSubform') || 'Wizard step references unknown subform' }}:
                      <strong>{{ step.subformName }}</strong>
                    </div>

                    <!-- Summary step: synthetic toolbar row (so the stepper
                         still appears in the same place as it does for
                         regular steps) + per-step status overview body. -->
                    <div v-else-if="step.isSummary">
                      <div class="d-flex justify-content-between align-items-center mb-3">
                        <ol class="ansibleforms-wizard-stepper d-flex flex-wrap align-items-center list-unstyled mb-0">
                          <template v-for="(s, i) in wizardSteps" :key="'sm-' + s.name">
                            <li
                              v-if="isWizardStepVisible(s) || wizardSkipped[s.name]"
                              class="wizard-step d-flex align-items-center"
                              :class="{ active: i === wizardIndex }"
                            >
                              <button
                                type="button"
                                class="wizard-step-btn"
                                :title="s.title"
                                :class="[
                                  i === wizardIndex
                                    ? 'is-current'
                                    : wizardSkipped[s.name]
                                      ? 'is-skipped'
                                      : wizardCompleted[s.name]
                                        ? 'is-done'
                                        : 'is-pending',
                                ]"
                                @click="wizardGoTo(i)"
                              >
                                <i v-if="wizardSkipped[s.name]" class="fa fa-forward"></i>
                                <i v-else-if="s.isSummary" class="fa fa-list-check"></i>
                                <i v-else-if="wizardCompleted[s.name]" class="fa fa-check"></i>
                                <span v-else>{{ i + 1 }}</span>
                              </button>
                              <span class="wizard-step-label ms-2 small">{{ s.title }}</span>
                              <span v-if="i < wizardSteps.length - 1" class="wizard-step-connector"></span>
                            </li>
                          </template>
                        </ol>
                        <div></div>
                      </div>
                      <p class="text-muted">{{ t('form.wizardSummaryDescription') }}</p>
                      <ul class="list-group">
                        <li
                          v-for="s in wizardSummaryRows"
                          :key="'sum-' + s.name"
                          class="list-group-item d-flex justify-content-between align-items-center"
                          :class="{ 'list-group-item-action': s.status !== 'hidden' }"
                          :role="s.status !== 'hidden' ? 'button' : null"
                          @click="s.status !== 'hidden' && wizardGoTo(s.index)"
                        >
                          <span>
                            <i
                              class="fa me-2"
                              :class="{
                                'fa-check text-success': s.status === 'ok',
                                'fa-forward text-warning': s.status === 'skipped',
                                'fa-eye-slash text-muted': s.status === 'hidden',
                                'fa-circle-exclamation text-danger': s.status === 'pending',
                              }"
                            ></i>
                            <strong>{{ s.title }}</strong>
                            <small class="text-muted ms-2">{{ s.statusLabel }}</small>
                          </span>
                          <i v-if="s.status !== 'hidden'" class="fa fa-pen text-muted"></i>
                        </li>
                      </ul>
                    </div>
                  </div>
                </template>

                <!-- Navigation footer : hidden while a run's result shows (its own bar under it) -->
                <div v-if="status === ''" class="d-flex justify-content-between align-items-center mt-3">
                  <div>
                    <BsButton v-if="wizardIndex > 0" icon="arrow-left" colorClass="secondary" @click="wizardBack">
                      {{ t('form.back') || 'Back' }}
                    </BsButton>
                  </div>
                  <div class="d-flex gap-2">
                    <BsButton
                      v-if="activeWizardStep?.optional && !activeWizardStep?.isSummary"
                      icon="forward"
                      colorClass="warning"
                      @click="wizardSkipCurrent"
                    >
                      {{ t('form.skip') || 'Skip' }}
                    </BsButton>
                    <BsButton
                      v-if="wizardIndex < wizardLastInputIndex || (wizardHasSummary && !activeWizardStep?.isSummary)"
                      icon="arrow-right"
                      colorClass="primary"
                      @click="wizardNext"
                    >
                      {{ t('form.next') || 'Next' }}
                    </BsButton>
                    <BsDropdownButton
                      v-else
                      :icon="status === 'initializing' || status === 'submitting' ? 'spinner' : 'circle-play'"
                      :label="t('form.submit')"
                      colorClass="primary"
                      :actions="wizardSubmitActions"
                      :disabled="status !== ''"
                      @click="handleWizardSubmitAction('submit')"
                      @action="handleWizardSubmitAction"
                    />
                  </div>
                </div>
              </div>

              <!-- MAIN FORM: mounted always, hidden while editing a subform or running a wizard -->
              <AppForm
                v-if="!wizardActive"
                ref="mainForm"
                v-show="!activeEntry"
                :key="key"
                @change="formChanged"
                :currentForm="currentForm"
                :constants="constants"
                :showExtraVars="showExtraVars"
                :fileProgress="fileProgress"
                :initialData="initialFormData"
                v-model="form"
                :subforms="currentForm?.subforms || []"
                v-model:status="status"
                @submit-action="handleSubmitAction"
              >
                <!-- verbose : on the toolbar row's left, the show-hidden-fields icon at its right -->
                <template #toolbarbuttons>
                  <BsInputCheckboxRaw
                    v-if="store.profile.options?.allowVerboseMode"
                    v-model="enableVerbose"
                    :label="'verbose'"
                    cssClass="d-inline-block mb-0"
                  />
                </template>
              </AppForm>

              <!-- SUBFORMS: one AppForm per stacked edit, only the deepest is visible. -->
              <!-- Kept mounted (v-show) so draft state survives when going deeper and back. -->
              <template v-for="(entry, i) in editStack" :key="entry.id + ':' + (entry.reloadKey || 0)">
                <AppForm
                  v-show="i === editStack.length - 1"
                  mode="subform"
                  :currentForm="entry.subform"
                  :constants="constants"
                  :subforms="currentForm?.subforms || []"
                  :rootFormName="currentForm?.name || ''"
                  :initialData="entry.snapshot"
                  :parentData="entry.parentData"
                  v-model="entry.draft"
                  @save="(val) => saveEdit(entry.id, val)"
                  @cancel="popEdit(entry.id)"
                  @submit-action="(e) => handleSubformAction(entry, e)"
                >
                </AppForm>
              </template>
            </div>
          </div>
        </div>
        <!-- the job run from the form : its status and its output, under the form, in the form's
             column (the menu beside it) ; the form itself hidden when it asks (hideForm) -->
        <div v-if="status != ''" ref="outputPanel" class="af-form-result">
          <!-- awx workflow graph (only for awx workflow jobs) -->
          <div class="row" v-if="job.awx_workflow?.nodes?.length">
            <div class="col">
              <AppAwxWorkflow :workflow="job.awx_workflow" :product="jobTypeName(job)" @node="openNodeOutput" />
            </div>
          </div>
          <!-- the job's output, as its page shows it : a panel, its toolbar on top - fold all and the
               line count at the left, the filter and what to do with it at the right -->
          <div class="af-output-panel">
            <div class="af-output-toolbar">
              <div class="af-output-label">
                <button
                  v-if="mainOutput"
                  type="button"
                  class="af-tool-btn af-tool-icon"
                  :title="mainOutput.allFolded ? t('jobs.expandAll') : t('jobs.collapseAll')"
                  :aria-label="mainOutput.allFolded ? t('jobs.expandAll') : t('jobs.collapseAll')"
                  @click="toggleFoldAll"
                >
                  <FaIcon :icon="mainOutput.allFolded ? 'angles-down' : 'angles-up'" />
                </button>
                <FaIcon icon="terminal" />
                <span>{{ t('jobs.output') }}</span>
                <span class="af-output-count">{{ t('jobs.lines', { count: outputLines }) }}</span>
              </div>
              <div class="af-output-actions">
                <!-- the failed tasks (else the error lines) : each click the next one -->
                <AppOutputFailures :output="mainOutput" :jobId="jobId" />
                <!-- what the run gave back (set_stats), as on the job's page -->
                <button
                  v-if="store.profile.options?.showArtifacts && hasArtifacts(job)"
                  type="button"
                  class="af-tool-btn"
                  :class="{ active: showRunArtifacts }"
                  @click="showRunArtifacts = !showRunArtifacts"
                >
                  <FaIcon :icon="showRunArtifacts ? 'square-poll-horizontal' : 'square-poll-vertical'" />
                  {{ showRunArtifacts ? t('jobs.hideArtifacts') : t('jobs.showArtifacts') }}
                </button>
                <button
                  type="button"
                  class="af-tool-btn"
                  :class="{ active: filterOutput }"
                  @click="filterOutput = !filterOutput"
                >
                  <FaIcon :icon="filterOutput ? 'filter-circle-xmark' : 'filter'" />
                  {{ filterOutput ? t('jobs.removeFilter') : t('jobs.applyFilter') }}
                </button>
                <!-- a playbook's hosts and tasks, from its structured events, as on the job's page -->
                <button
                  v-if="jobEvents.length"
                  type="button"
                  class="af-tool-btn"
                  :class="{ active: showEvents }"
                  @click="showEvents = !showEvents"
                >
                  <FaIcon icon="table-cells" />{{ t('jobs.events.button') }}
                </button>
                <span class="af-tool-sep" />
                <button type="button" class="af-tool-btn" @click="copyOutput">
                  <FaIcon icon="copy" />{{ t('jobs.copyOutput') }}
                </button>
                <button type="button" class="af-tool-btn" :disabled="!jobId" @click="download(jobId)">
                  <FaIcon icon="download" />{{ t('jobs.downloadOutput') }}
                </button>
                <router-link v-if="jobId" class="af-tool-btn text-decoration-none" :to="`/jobs/${jobId}`">
                  <FaIcon icon="arrow-up-right-from-square" />{{ t('jobs.openJob') }}
                </router-link>
              </div>
            </div>
            <!-- the run's artifacts, over its output -->
            <AppOutputData
              v-if="showRunArtifacts"
              :title="t('jobs.artifacts')"
              icon="square-poll-vertical"
              :value="job.awx_artifacts ?? {}"
              @copy="(value, asYaml) => clip(value, false, asYaml)"
              @close="showRunArtifacts = false"
            />
            <!-- the hosts and tasks, over its output -->
            <AppJobEvents v-if="showEvents && jobEvents.length" :events="jobEvents" @close="showEvents = false" />
            <div class="row g-0 af-output-body">
              <div class="col">
                <AppAnsibleOutput
                  ref="mainOutput"
                  :output="filteredJobOutput"
                  :jobLog="job.job_log"
                  :workflow="job.awx_workflow"
                  :title="outputTitle"
                  :jobId="job.id"
                  :events="jobEvents"
                  :copyLabel="t('jobs.copy')"
                  numbered
                  @copy="(text) => clip(text, true)"
                >
                  <template #title>
                    <h3 v-if="job.job_type == 'multistep' && subjob?.output" class="af-job-title">
                      {{ t('form.mainJob') }} {{ t('jobs.jobIdNote', { id: job.id }) }}
                      <AppStatusPill :status="job.status" />
                    </h3>
                  </template>
                </AppAnsibleOutput>
              </div>
              <div class="col" v-if="subjob.output">
                <AppAnsibleOutput
                  ref="subOutput"
                  :output="filteredSubJobOutput"
                  :jobLog="subjob.job_log"
                  :jobId="subjob.id"
                  :copyLabel="t('jobs.copy')"
                  numbered
                  @copy="(text) => clip(text, true)"
                >
                  <template #title>
                    <h3 class="af-job-title">
                      {{ t('form.currentStep') }} {{ t('jobs.jobIdNote', { id: subjob.id }) }}
                      <AppStatusPill :status="subjob.status" />
                    </h3>
                  </template>
                </AppAnsibleOutput>
              </div>
            </div>
            <!-- scrolled up while it runs : back to its end, following again ; above the bar of
                 Abort that sticks to the window's bottom under it -->
            <AppFollowButton
              :show="outputPaused"
              :new-lines="outputNewLines"
              bottom="5.75rem"
              @click="jumpToOutputEnd"
            />
          </div>

          <!-- the run's status and its actions : under the output, held at the window's bottom while
               the output scrolls under it - Abort while it runs, Close output once it ended -->
          <div class="af-form-actions">
            <button
              type="button"
              class="btn text-white flex-fill"
              :class="'btn-' + formStatus.color"
              @click="resetResult()"
              :disabled="formStatus.disabled"
            >
              <FaIcon :icon="formStatus.icon"></FaIcon><span class="ms-3">{{ formStatus.label }}</span>
            </button>
            <button
              v-if="formStatus.abort && jobId && !abortTriggered && (currentForm.abortable || true)"
              type="button"
              class="btn btn-danger text-white flex-fill"
              @click="abortJob(jobId)"
            >
              <FaIcon icon="stop"></FaIcon><span class="ms-3">{{ t('form.abort') }}</span>
            </button>
            <BsButton v-if="!formStatus.disabled" icon="arrow-up" cssClass="text-nowrap" @click="resetResult()">{{
              t('form.closeOutput')
            }}</BsButton>
          </div>
        </div>
      </div>
      <!-- the form loading : its title and its fields as grey placeholders (lib/pageSkeleton.js) -->
      <AppPageSkeleton v-else-if="!formNotFound" />
      <!-- not found : the page's title and its divider, as a form's, then why on one line -->
      <div v-else class="section container-fluid w-100 mt-3">
        <div class="d-flex flex-wrap align-items-center border-bottom mb-3 pb-3 af-page-head">
          <h3 class="mb-0 me-3">
            <router-link :to="formsPath('')" class="af-crumb-link"
              ><span class="me-2"><FaIcon icon="rectangle-list" /></span>{{ t('nav.forms') }}</router-link
            ><span class="mx-2 text-body-secondary af-crumb-separator"><FaIcon icon="chevron-right" /></span>
            {{ t('form.formNotFound') }}
          </h3>
        </div>
        <div class="alert alert-danger d-flex align-items-center gap-2" role="alert">
          <FaIcon icon="triangle-exclamation" />
          <span>{{ loadError || t('form.formNotFoundMsg') }}</span>
        </div>
      </div>
      <!-- the output of a run, long : up to the page's top, down to its end, over the bar held at the
           window's bottom (Running, Abort, Close output) -->
      <AppScrollButtons v-if="status != ''" overBar />
      <!-- a workflow node's output, opened from the graph : over the full screen too -->
      <AppNodeOutputDialog
        :shown="nodeShown"
        :workflow="job.awx_workflow"
        :jobId="jobId"
        :product="jobTypeName(job)"
        @close="nodeShown = null"
        @copy="(text) => clip(text, true)"
      />
    </main>
  </div>

  <!-- SCHEDULE OFF-CANVAS -->
  <BsOffCanvas
    :show="showScheduleOffcanvas"
    :title="scheduleAction === 'schedule' ? t('form.createSchedule') : t('form.runLater')"
    :icon="scheduleAction === 'schedule' ? 'calendar-plus' : 'clock'"
    @close="closeScheduleOffcanvas"
  >
    <template #default>
      <div class="mb-3">
        <label class="form-label">{{ t('form.scheduleName') }} <span class="text-danger">*</span></label>
        <input
          type="text"
          class="form-control"
          v-model="scheduleForm.name"
          :placeholder="scheduleAction === 'schedule' ? 'e.g., Daily Backup' : 'e.g., Maintenance Window'"
          :disabled="scheduleSubmitting"
        />
        <small class="form-text text-muted"
          >A descriptive name for this {{ scheduleAction === 'schedule' ? 'schedule' : 'job' }}</small
        >
      </div>

      <div class="mb-3" v-if="scheduleAction === 'schedule'">
        <label class="form-label">{{ t('form.cronExpression') }} <span class="text-danger">*</span></label>
        <!-- the same editor as a schedule's : presets, the next runs, and the scheduler's zone -->
        <BsCron v-model="scheduleForm.cron" icon="stopwatch" />
      </div>

      <div class="mb-3" v-if="scheduleAction === 'run-later'">
        <label class="form-label">{{ t('form.runAt') }} <span class="text-danger">*</span></label>
        <!-- the same picker as a schedule's and an announcement's (its time in the user's zone, sent
             as UTC) -->
        <BsDateTime
          v-model="scheduleForm.run_at"
          icon="calendar"
          dateType="datetime"
          :convertToUtc="true"
          teleport
          :disabled="scheduleSubmitting"
        />
        <small class="form-text text-muted">Select the date and time to run this job once</small>
      </div>
    </template>
    <template #actions>
      <button class="btn btn-primary" @click="createSchedule" :disabled="scheduleSubmitting">
        <FaIcon :icon="scheduleSubmitting ? 'spinner' : 'save'" :spin="scheduleSubmitting" />
        <span class="ms-2">{{
          scheduleSubmitting
            ? t('form.creating')
            : scheduleAction === 'schedule'
              ? t('form.createSchedule')
              : t('form.scheduleJob')
        }}</span>
      </button>
    </template>
  </BsOffCanvas>

  <!-- STORE OFF-CANVAS -->
  <BsOffCanvas
    :show="showStoreOffcanvas"
    :title="storeCtx ? `${t('form.save')} ${storeCtx.title}` : t('form.saveFormData')"
    icon="file-export"
    @close="closeStoreOffcanvas"
  >
    <template #default>
      <div class="mb-3">
        <label class="form-label">{{ t('form.scheduleName') }} <span class="text-danger">*</span></label>
        <input
          type="text"
          class="form-control"
          v-model="storeForm.name"
          placeholder="e.g., Production Config"
          :disabled="storeSubmitting"
        />
      </div>

      <div class="mb-3">
        <label class="form-label">{{ t('form.description') }}</label>
        <textarea
          class="form-control"
          rows="3"
          v-model="storeForm.description"
          placeholder=""
          :disabled="storeSubmitting"
        />
      </div>

      <div class="mb-3">
        <label class="form-label">{{ t('form.expiresAt') }}</label>
        <BsDateTime
          v-model="storeForm.expires_at"
          icon="calendar"
          dateType="datetime"
          :convertToUtc="true"
          teleport
          :disabled="storeSubmitting"
        />
      </div>

      <!-- shared : the users with allowStoredJobsViewAll can load it too ; it stays yours -->
      <div v-if="canShareStored" class="mb-3">
        <div class="form-check form-switch">
          <input
            id="af-store-shared"
            v-model="storeForm.shared"
            class="form-check-input"
            type="checkbox"
            role="switch"
            :disabled="storeSubmitting"
          />
          <label class="form-check-label" for="af-store-shared">{{ t('form.shareStoredJob') }}</label>
        </div>
        <div class="form-text">{{ t('form.shareStoredJobHelp') }}</div>
      </div>
    </template>
    <template #actions>
      <button class="btn btn-primary" @click="createStoredJob" :disabled="storeSubmitting">
        <FaIcon :icon="storeSubmitting ? 'spinner' : 'save'" :spin="storeSubmitting" />
        <span class="ms-2">{{ storeSubmitting ? t('form.saving') : t('form.save') }}</span>
      </button>
    </template>
  </BsOffCanvas>

  <!-- LOAD OFF-CANVAS : a short list (or its empty message), at the medium width -->
  <BsOffCanvas
    size="md"
    :show="showLoadOffcanvas"
    :title="storeCtx ? `${t('form.loadFromStore')} - ${storeCtx.title}` : t('form.loadSavedForm')"
    icon="file-import"
    @close="closeLoadOffcanvas"
  >
    <template #default>
      <div v-if="loadSubmitting" class="text-center py-4">
        <FaIcon icon="spinner" spin size="2x" />
        <p class="mt-2">{{ t('form.loadingSavedForms') }}</p>
      </div>

      <div v-else-if="storedJobs.length === 0" class="text-center py-4 text-muted">
        <FaIcon icon="inbox" size="3x" class="mb-3" />
        <p>{{ t('form.noSavedForms') }}</p>
      </div>

      <div v-else class="list-group">
        <a
          v-for="job in storedJobs"
          :key="job.id"
          href="#"
          class="list-group-item list-group-item-action"
          @click.prevent="loadStoredJob(job)"
        >
          <div class="d-flex w-100 justify-content-between align-items-start">
            <div>
              <h6 class="mb-1">
                {{ job.name }}
                <!-- another user's, shared with the caller : whose it is -->
                <span v-if="job.username !== storedJobOwner" class="badge text-bg-secondary ms-1 fw-normal">
                  <FaIcon icon="user" class="me-1" />{{ job.username }}
                </span>
                <!-- the caller's own, shared with others -->
                <span v-else-if="job.visibility === 'shared'" class="badge text-bg-info ms-1 fw-normal">
                  <FaIcon icon="share-nodes" class="me-1" />{{ t('form.storedJobShared') }}
                </span>
              </h6>
              <p v-if="job.description" class="mb-1 small text-muted">{{ job.description }}</p>
              <small class="text-muted">
                {{ t('form.created') }}: {{ Time.format(job.created_at) }}
                <span v-if="job.expires_at"> • {{ t('form.expires') }}: {{ Time.format(job.expires_at) }}</span>
              </small>
            </div>
          </div>
        </a>
      </div>
    </template>
  </BsOffCanvas>
</template>
<style scoped lang="scss">
/* the amber of a text found in a page (styles/_find.scss) */
@use '@/styles/find' as *;
/* the form's extravars : a card under the divider, as far over the toolbar row as the
   divider is over it */
.af-form-extravars {
  margin-bottom: 1rem;
}
/* the job run from the form : under the form, its output then its bar */
.af-form-result {
  margin-top: 1rem;
}
/* the run's status and actions : held at the bottom of the window while the output scrolls,
   on the page's background so the output passes under it */
.af-form-actions {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  gap: 1rem;
  padding: 1rem 0 1.5rem;
  background: var(--bs-body-bg);
}
/* the form's controls under its title, 16px under it as the other pages' */
.af-form-controls {
  margin-top: 1rem;
}
/* a field whose name has the text searched : marked as the browser marks a found text, the one
   in view outlined */
:deep(.af-field-hit) {
  background-color: $af-find-highlight;
  border-radius: 0.2rem;
  padding: 0 0.25rem;
  /* the name only, not the row : the field's own buttons stay at the right */
  flex-grow: 0 !important;
  margin-right: auto;
}
:deep(.af-field-hit-current) {
  outline: 2px solid var(--bs-primary);
  outline-offset: 1px;
}
.badge.status {
  font-size: 0.75rem;
}

// Compact stepper used in the wizard's toolbar row. Sits inline with
// AppForm's right-side icon-buttons (spinner, show hidden, warnings).
.ansibleforms-wizard-stepper {
  .wizard-step:not(:last-child) .wizard-step-label {
    margin-right: 0.25rem;
  }

  .wizard-step-btn {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
    line-height: 1;
    border: 1px solid transparent;
    background: var(--bs-body-bg, #fff);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      border-color 0.15s ease;

    &.is-current {
      background: var(--bs-primary, #0d6efd);
      color: #fff;
      border-color: var(--bs-primary, #0d6efd);
      box-shadow: 0 0 0 0.15rem rgba(13, 110, 253, 0.25);
    }

    &.is-done {
      background: var(--bs-success, #198754);
      color: #fff;
      border-color: var(--bs-success, #198754);
    }

    &.is-skipped {
      background: transparent;
      color: var(--bs-warning, #ffc107);
      border-color: var(--bs-warning, #ffc107);
    }

    &.is-pending {
      background: transparent;
      color: var(--bs-secondary, #6c757d);
      border-color: var(--bs-secondary, #6c757d);
    }
  }

  .wizard-step-label {
    color: var(--bs-secondary, #6c757d);
    white-space: nowrap;
  }

  .wizard-step.active .wizard-step-label {
    color: var(--bs-body-color);
    font-weight: 600;
  }

  .wizard-step-connector {
    display: inline-block;
    width: 1rem;
    height: 1px;
    background: var(--bs-border-color, #dee2e6);
    margin: 0 0.25rem;
  }
}
</style>
