// A server error's details are written out as text (Helpers.formatErrorDetails), never appended
// as an object : a refused launch read "The form data is not valid: [object Object]" (#1327).
import { describe, it, expect } from 'vitest';
import Helpers from '@/lib/Helpers';

const answer = (data) => ({ response: { status: 422, data } });

describe('the details of a server error', () => {
  it('an object : its keys and values, a list joined', () => {
    expect(Helpers.formatErrorDetails({ missing: ['a', 'b'], waiting: ['c'] })).toBe('missing: a, b ; waiting: c');
  });

  it('a text as it is, nothing for none, empty entries left out', () => {
    expect(Helpers.formatErrorDetails('why')).toBe('why');
    expect(Helpers.formatErrorDetails(undefined)).toBe('');
    expect(Helpers.formatErrorDetails({ missing: [], waiting: ['c'] })).toBe('waiting: c');
  });

  it('the message of a failed request never reads [object Object]', () => {
    const text = Helpers.parseAxiosResponseError(
      answer({ error: 'The form data is not valid', details: { missing: ['export_policy_existing'] } }),
    );
    expect(text).toBe('The form data is not valid: missing: export_policy_existing');
    expect(text).not.toMatch(/object Object/);
    expect(Helpers.parseAxiosResponseError(answer({ error: 'Nope', details: 'reason' }))).toBe('Nope: reason');
    expect(Helpers.parseAxiosResponseError({ message: 'Network Error' })).toBe('Network Error');
  });
});
