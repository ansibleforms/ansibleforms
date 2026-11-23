// A form's fields read the repository the form is in with $(__repository__.name) and
// $(__repository__.path) : the browser injects what the server gives the form (ownRepository),
// both empty for a form in no repository, and no field may take the name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appForm = readFileSync(resolve(__dirname, '../src/components/AppForm.vue'), 'utf8');

describe('__repository__ in a form', () => {
  it("is injected from the form's ownRepository, empty without one", () => {
    expect(appForm).toContain("form.value['__repository__'] = {");
    expect(appForm).toContain("name: props.currentForm.ownRepository?.name || '',");
    expect(appForm).toContain("path: props.currentForm.ownRepository?.path || '',");
    expect(appForm).toMatch(/fieldOptions\.value\['__repository__'\] = \{\s*type: 'expression',/);
  });

  it('is a reserved name', () => {
    expect(appForm).toMatch(/const reservedNames = \[[^\]]*'__repository__'/);
  });
});
