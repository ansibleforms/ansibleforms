// AppForm : what the address gives a field (?env=prod), the warnings of a validation rule the
// form engine could not compile, and the spinner of a field that fell back to its default.
//
// Like form-settle.test.js these read the component source rather than mounting it : the
// functions live inside <script setup>, so each is cut out of the source and run on its own,
// with the little state it reads given to it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import en from '../src/locales/en.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src/components/AppForm.vue'), 'utf8');

/**
 * The source of a function of AppForm, from its declaration to the next marker.
 *
 * Args:
 *   start (string): the text the function starts with ('function externalQueryValue').
 *   end (string): the text right after it.
 *
 * Returns:
 *   string: the function's source.
 */
const cut = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

//----------------------------------------------------------------
// the query string's values
//----------------------------------------------------------------

/**
 * What externalQueryValue stores for a field, given a query parameter.
 *
 * Args:
 *   item (object): the field.
 *   queryValue (string|null|Array): the parameter as the router reads it.
 *
 * Returns:
 *   object: externalData after the call ({} when nothing was stored).
 */
function stored(item, queryValue) {
  const externalData = { value: {} };
  const fn = new Function(
    'externalData',
    `${cut('function externalQueryValue', '// first time run')}
    return externalQueryValue;`,
  )(externalData);
  fn(item, queryValue);
  return externalData.value;
}

describe('the query string fills a field', () => {
  it('keeps a repeated parameter as a list on an enum of several values', () => {
    expect(stored({ name: 'env', type: 'enum', multiple: true }, ['a', 'b'])).toEqual({ env: ['a', 'b'] });
    // a bare ?env inside the list carries no value
    expect(stored({ name: 'env', type: 'enum', multiple: true }, ['a', null, 'b'])).toEqual({ env: ['a', 'b'] });
  });

  it('takes the last of a repeated parameter on any other field', () => {
    expect(stored({ name: 'env', type: 'enum' }, ['a', 'b'])).toEqual({ env: 'b' });
    expect(stored({ name: 'env', type: 'text' }, ['a', 'b', null])).toEqual({ env: 'b' });
    expect(stored({ name: 'n', type: 'number' }, ['1', '2'])).toEqual({ n: 2 });
  });

  it('stores nothing a field cannot take, so its own default applies', () => {
    expect(stored({ name: 'env', type: 'enum', multiple: true }, [null])).toEqual({});
    expect(stored({ name: 'env', type: 'text' }, null)).toEqual({});
    expect(stored({ name: 'n', type: 'number' }, 'abc')).toEqual({});
  });

  it('reads a checkbox off in every common spelling', () => {
    for (const off of ['', '0', 'no', 'false', 'OFF'])
      expect(stored({ name: 'c', type: 'checkbox' }, off)).toEqual({ c: false });
    expect(stored({ name: 'c', type: 'checkbox' }, 'yes')).toEqual({ c: true });
  });

  it('never skips the rest of the field setup', () => {
    // the setup's forEach used to return early, leaving fieldOptions[name] undefined
    const setup = cut('// initialize defaults', "fieldOptions.value[item.name]['evalDefault']");
    expect(setup).toContain('externalQueryValue(item, route.query[item.name])');
    expect(setup).not.toMatch(/\breturn\b/);
  });
});

//----------------------------------------------------------------
// the warnings of a rule the engine could not compile
//----------------------------------------------------------------

/**
 * The panel html for an engine warning, with the English messages.
 *
 * Args:
 *   message (string): the engine's warning.
 *
 * Returns:
 *   string: the html ruleWarningHtml builds.
 */
function ruleHtml(message) {
  const t = (key, params = {}) =>
    key
      .split('.')
      .reduce((o, k) => o[k], en)
      .replace(/\{(\w+)\}/g, (_m, k) => params[k]);
  return new Function(
    't',
    `${cut('function escapeWarning', '// a warning the loop can raise')}
    return ruleWarningHtml;`,
  )(t)(message);
}

describe('a validation rule the engine could not compile', () => {
  it('is escaped in the warnings panel', () => {
    const html = ruleHtml(
      "Field 'x': the regex '<img src=x onerror=alert(1)>(' is not valid (Unterminated group); the rule is ignored.",
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;(');
    expect(html).toContain('Unterminated group');
    // translated : the English key's own words
    expect(html).toContain('&#39;x&#39; has a regex that is not valid');
  });

  it('translates the regex shape warning', () => {
    const html = ruleHtml(
      'Field \'<b>y</b>\': regex must be given as { expression: "...", description: "..." }; the rule is ignored.',
    );
    expect(html).toContain('&lt;b&gt;y&lt;/b&gt;');
    expect(html).toContain('A regex must be given as an expression with a description.');
  });

  it('shows any other warning escaped, as it is', () => {
    expect(ruleHtml('<script>x</script>')).toBe('<span class="text-warning">&lt;script&gt;x&lt;/script&gt;</span>');
  });

  it('reaches the panel through ruleWarningHtml only', () => {
    expect(src).toContain('warn: (w) => warnings.value.push(ruleWarningHtml(w))');
  });
});

//----------------------------------------------------------------
// a field that fell back to its default
//----------------------------------------------------------------

describe('a field settled on its default stops spinning', () => {
  it('counts the default status as settled, like an error', () => {
    const lists = src.match(/\[[^\]]*'fixed', 'variable'[^\]]*\]\.includes\(dynamicFieldStatus\[field\.name\]\)/g);
    expect(lists.length).toBe(2);
    lists.forEach((l) => expect(l).toContain("'default'"));
  });
});

//----------------------------------------------------------------
// a plain field reset while the form is restored (#1261)
//----------------------------------------------------------------

/**
 * The restore state after resetField ran on a field during initialisation, with the real
 * isPrefillPending, applyPrefill and resetField of AppForm.
 *
 * Args:
 *   isDynamic (boolean): whether the field has a query or an expression.
 *
 * Returns:
 *   object: { applied, value } of the field 'node_count'.
 */
function afterReset(isDynamic) {
  const ref = (value) => ({ value });
  const state = {
    isInitializing: ref(true),
    prefillValues: ref({ node_count: 3 }),
    prefillApplied: ref({ node_count: true }),
    prefillFlagged: ref({}),
    prefillApplyCount: ref({}),
    protectedFields: ref({}),
    progressCounter: ref(0),
    fieldOptions: ref({ node_count: { isDynamic } }),
    form: ref({ node_count: 3 }),
    defaults: ref({}),
  };
  const fns = new Function(
    ...Object.keys(state),
    `const toRaw = (v) => v;
    const t = (k) => k;
    const MAX_PREFILL_APPLIES = 5;
    const flagPrefill = (name, reason) => { prefillFlagged.value[name] = reason; };
    const prefillMatchesOptions = () => true;
    const setFieldStatus = () => {}; // a no-op on a plain field, as the real one is
    const bumpFieldGeneration = () => {};
    // initiateDefaults hands the restored value back as the default while initialising
    const initiateDefaults = (name) => { defaults.value[name] = prefillValues.value[name]; };
    ${cut('function isPrefillPending', '// give up on restoring')}
    ${cut('function applyPrefill(', '//------')}
    ${cut('function resetField', '// reset number field')}
    return { resetField };`,
  )(...Object.values(state));
  fns.resetField('node_count');
  return { applied: !!state.prefillApplied.value.node_count, value: state.form.value.node_count };
}

describe('a plain field reset while the form is restored', () => {
  it('is restored again at once : the loop never would, and it was reported as never produced', () => {
    expect(afterReset(false)).toEqual({ applied: true, value: 3 });
  });

  it('a field with a query or an expression is still left to the loop', () => {
    expect(afterReset(true)).toEqual({ applied: false, value: 3 });
  });
});
