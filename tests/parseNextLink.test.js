process.env.NODE_ENV = 'test';
const { parseNextLink } = require('../server');

describe('parseNextLink', () => {
  test('null on missing header', () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('')).toBeNull();
  });

  test('extracts next path from well-formed Link header', () => {
    const header = '<https://api.github.com/repos/foo/bar/pulls?page=2>; rel="next", <https://api.github.com/repos/foo/bar/pulls?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe('/repos/foo/bar/pulls?page=2');
  });

  test('null when no next rel present', () => {
    const header = '<https://api.github.com/repos/foo/bar/pulls?page=5>; rel="last"';
    expect(parseNextLink(header)).toBeNull();
  });

  test('handles single link header with only next', () => {
    const header = '<https://api.github.com/search/issues?page=2>; rel="next"';
    expect(parseNextLink(header)).toBe('/search/issues?page=2');
  });
});
