// lib/formsPath.js : the forms list's addresses, /forms/all and /forms/<category>, and the
// category an address names, read back against the forms config's categories.
import { describe, it, expect } from 'vitest';
import { categorySlug, formsPath, categoryFromPath } from '../src/lib/formsPath.js';

const categories = [
  { name: 'Default' },
  { name: 'Expressions', items: [{ name: 'Test1' }] },
  { name: 'Network Ops', items: [{ name: 'Café Débâcle' }] },
];

describe('the forms list addresses', () => {
  it('name a category in lower case, its words joined by a dash', () => {
    expect(categorySlug('Network Ops')).toBe('network-ops');
    expect(categorySlug('Café Débâcle')).toBe('cafe-debacle');
    expect(categorySlug('  A/B & C  ')).toBe('a-b-c');
  });

  it('are /forms/all for every form, and a sub category under its parent', () => {
    expect(formsPath('')).toBe('/forms/all');
    expect(formsPath('Expressions')).toBe('/forms/expressions');
    expect(formsPath('Expressions/Test1')).toBe('/forms/expressions/test1');
  });

  it('read back to the category, by the names of the config', () => {
    expect(categoryFromPath('expressions/test1', categories)).toBe('Expressions/Test1');
    expect(categoryFromPath(['network-ops', 'cafe-debacle'], categories)).toBe('Network Ops/Café Débâcle');
    expect(categoryFromPath('all', categories)).toBe('');
    expect(categoryFromPath('', categories)).toBe('');
  });

  it('name no category for an address none has', () => {
    expect(categoryFromPath('missing', categories)).toBeNull();
    expect(categoryFromPath('expressions/missing', categories)).toBeNull();
  });

  it('go there and back for every category', () => {
    for (const path of ['Default', 'Expressions/Test1', 'Network Ops/Café Débâcle']) {
      expect(categoryFromPath(formsPath(path).slice('/forms/'.length), categories)).toBe(path);
    }
  });
});
