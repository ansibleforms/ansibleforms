// The header search (lib/Search.js) and the pages it offers (config/searchPages.js).
//
// The search runs over the forms list and the pages in the browser : every query word must
// match, a title match ranks first, and highlight() returns plain parts the component renders
// as text. A page shows to a user who may open its route (its meta.permission), so a result never
// leads to a page whose guard sends the user back home.
import { describe, it, expect } from 'vitest';
import Search from '@/lib/Search';
import { searchPages } from '@/config/searchPages';
import router from '@/router';

const forms = [
  { name: 'Ansible Core Form', description: 'Targets an Ansible Core playbook', categories: ['Demo'] },
  { name: 'HelloWorld', description: 'Kicks off the HelloWorld template in AWX', categories: ['Demo', 'AWX'] },
  { name: 'Cleanup jobs', description: 'Removes old ansible job logs', categories: ['Maintenance'] },
];
const pages = [{ title: 'Users', section: 'Settings', link: '/settings/users', icon: 'user' }];
const index = Search.buildIndex(forms, pages);

describe('Search.search', () => {
  it('finds nothing for a blank query', () => {
    expect(Search.search(index, '   ')).toEqual([]);
  });

  it('ranks a title match before a match in the description', () => {
    const titles = Search.search(index, 'ansible').map((r) => r.title);
    expect(titles).toEqual(['Ansible Core Form', 'Cleanup jobs']);
  });

  it('needs every word of the query, in any field', () => {
    expect(Search.search(index, 'awx hello').map((r) => r.title)).toEqual(['HelloWorld']);
    expect(Search.search(index, 'awx cleanup')).toEqual([]);
  });

  it('finds the pages, and links forms to the form page', () => {
    expect(Search.search(index, 'users')[0]).toMatchObject({ kind: 'page', to: '/settings/users' });
    expect(Search.search(index, 'hello')[0].to).toEqual({ path: '/form', query: { form: 'HelloWorld' } });
  });

  it('shows the texts that match under a result', () => {
    expect(Search.search(index, 'maintenance')[0].snippets).toEqual(['Maintenance']);
  });

  it('cuts a long text around its first match', () => {
    const long = 'word '.repeat(60) + 'needle ' + 'word '.repeat(60);
    const [r] = Search.search(Search.buildIndex([{ name: 'Long', description: long }], []), 'needle');
    expect(r.snippets[0]).toContain('needle');
    expect(r.snippets[0].length).toBeLessThan(160);
    expect(r.snippets[0].startsWith('… ')).toBe(true);
  });
});

describe('Search.highlight', () => {
  it('marks every match, whatever its case, and keeps the text whole', () => {
    const parts = Search.highlight('Ansible runs ansible', 'ANSIBLE');
    expect(parts.map((p) => p.text).join('')).toBe('Ansible runs ansible');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['Ansible', 'ansible']);
  });

  it('treats regex characters in the query as text', () => {
    const parts = Search.highlight('a (b) c', '(b)');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['(b)']);
  });
});

describe('searchPages', () => {
  const t = (key) => key;
  it('offers only pages that exist, and declares no permission of its own (the route does)', () => {
    const all = searchPages(t, new Proxy({}, { get: () => true }));
    expect(all.length).toBeGreaterThan(20);
    // a link may open a page on a part of it (?view=...) : the route is its path
    const missing = all.map((p) => p.link).filter((link) => router.resolve(link.split('?')[0]).matched.length === 0);
    expect(missing).toEqual([]);
    expect(all.some((p) => 'permission' in p)).toBe(false);
  });

  it('hides the pages the user may not open', () => {
    const links = searchPages(t, { showJobs: true }).map((p) => p.link);
    expect(links).toContain('/jobs');
    expect(links).toContain('/profile');
    expect(links).not.toContain('/settings/users');
    expect(links).not.toContain('/designer');
  });
});
