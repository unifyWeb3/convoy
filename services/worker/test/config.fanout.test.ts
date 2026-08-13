import { describe, expect, it } from 'vitest';

import { executeFanout } from '../src/config.js';

describe('canonical execution fanout', () => {
  it('defaults to one', () => {
    expect(executeFanout({})).toBe(1);
  });

  it('honours an explicit measurement/rehearsal override', () => {
    expect(executeFanout({ CONVOY_EXECUTE_FANOUT: '4' })).toBe(4);
  });
});
