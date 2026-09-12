process.env.NODE_ENV = 'test';
const { parseCiStatus } = require('../server');

describe('parseCiStatus', () => {
  test('null on empty input', () => {
    expect(parseCiStatus(null)).toBeNull();
    expect(parseCiStatus([])).toBeNull();
  });

  test('PENDING when any check is not completed', () => {
    const runs = [
      { status: 'in_progress', conclusion: null },
      { status: 'completed', conclusion: 'success' },
    ];
    expect(parseCiStatus(runs)).toEqual({ state: 'PENDING' });
  });

  test('FAILURE when any completed check has a bad conclusion', () => {
    const runs = [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
    ];
    expect(parseCiStatus(runs)).toEqual({ state: 'FAILURE' });
  });

  test('FAILURE on timed_out conclusion', () => {
    const runs = [{ status: 'completed', conclusion: 'timed_out' }];
    expect(parseCiStatus(runs)).toEqual({ state: 'FAILURE' });
  });

  test('FAILURE on action_required conclusion', () => {
    const runs = [{ status: 'completed', conclusion: 'action_required' }];
    expect(parseCiStatus(runs)).toEqual({ state: 'FAILURE' });
  });

  test('SUCCESS when all checks pass/skip/neutral', () => {
    const runs = [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'neutral' },
    ];
    expect(parseCiStatus(runs)).toEqual({ state: 'SUCCESS' });
  });

  test('PENDING on unknown conclusion (not success/neutral/skipped/bad)', () => {
    const runs = [{ status: 'completed', conclusion: 'stale' }];
    expect(parseCiStatus(runs)).toEqual({ state: 'PENDING' });
  });
});
