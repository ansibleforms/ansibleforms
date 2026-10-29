// A repository's page (pages/admin/repository.vue) at an address whose number no repository has
// (/settings/repositories/99) : it says there is no such repository. It used to ask the api for
// the repository of an empty name, which is the repositories' list's own address, and showed the
// list's first record in its place, with Save, Delete, Pull and Push live on it.
//
// The page's resolveName and load are read from its source and run on a stand-in api, so the
// test sees what the page asks for and what it shows, without mounting the whole page.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ref, computed } from 'vue';
import { withoutComments, blocksOf } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '../src/pages/admin/repository.vue'), 'utf8');
const script = withoutComments(blocksOf(page, 'script').join('\n'), '/*', '*/');
// the whole file without its comments : a template's nested templates end its block early
const template = withoutComments(page);

/**
 * The source of one of the page's async functions, from its keyword to its closing brace (the
 * first line that is a lone brace).
 *
 * Args:
 *   name (string): the function's name.
 *
 * Returns:
 *   string: its source.
 */
function functionSource(name) {
  const start = script.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in repository.vue`);
  const end = script.indexOf('\n}\n', start);
  return script.slice(start, end + 2);
}

// the repositories the stand-in api knows : the first has the number 1
const REPOSITORIES = [
  { id: 1, name: 'first', branch: 'main', uri: 'https://example.com/first.git' },
  { id: 2, name: 'second', branch: 'main', uri: 'https://example.com/second.git' },
];

/**
 * Runs the page's load for the number in the address, on a stand-in api : the list's address
 * answers every repository, a repository's address the one of that name (404 for any other).
 *
 * Args:
 *   id (string): the number in the address.
 *
 * Returns:
 *   Promise<object>: { asked, repo, loaded } : the addresses asked for, the repository shown,
 *   whether the page finished loading.
 */
async function openPage(id) {
  const asked = [];
  const axios = {
    get: async (url) => {
      asked.push(url);
      if (url === '/api/v2/repository/') return { data: { records: REPOSITORIES } };
      if (url === '/api/v2/credential/') return { data: { records: [] } };
      const name = decodeURIComponent(url.replace('/api/v2/repository/', ''));
      const record = REPOSITORIES.find((r) => r.name === name);
      if (!record) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { data: { records: [record] } };
    },
  };
  const scope = {
    axios,
    TokenStorage: { getAuthentication: () => ({}) },
    repoId: computed(() => id),
    repoName: ref(''),
    repo: ref(null),
    edit: ref(null),
    others: ref([]),
    credentials: ref([]),
    loaded: ref(false),
    editable: (record) => ({ ...record }),
  };
  const run = new Function(
    ...Object.keys(scope),
    `${functionSource('resolveName')}\n${functionSource('load')}\nreturn load();`,
  );
  await run(...Object.values(scope));
  return { asked, repo: scope.repo.value, loaded: scope.loaded.value };
}

describe("a repository's page", () => {
  it('shows the repository its number names', async () => {
    const { repo, loaded } = await openPage('2');
    expect(loaded).toBe(true);
    expect(repo.name).toBe('second');
  });

  it('shows no repository for a number none has, never the first of the list', async () => {
    const { asked, repo, loaded } = await openPage('99');
    expect(loaded).toBe(true);
    expect(repo).toBeNull();
    // the list is read once, to find the name ; never asked for as the repository itself
    expect(asked.filter((url) => url === '/api/v2/repository/')).toHaveLength(1);
    expect(asked.every((url) => !/^\/api\/v2\/repository\/[^/]/.test(url))).toBe(true);
  });

  it('says there is no repository with that number', () => {
    expect(template).toMatch(/t\('settings\.repositories\.notFound', \{ id: repoId \}\)/);
  });
});
