process.env.NODE_ENV = 'test';
process.env.GH_TOKEN = 'test-token';
const request = require('supertest');
const { app } = require('../server');

describe('API routes', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  test('GET /api/version returns version string', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  test('GET /api/rate-limit returns rl data', async () => {
    const res = await request(app).get('/api/rate-limit');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.fromHeaders).toBe(true);
  });

  test('GET /api/prs returns success shape', async () => {
    const res = await request(app).get('/api/prs');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.prs)).toBe(true);
  });

  test('GET /api/repos returns success shape', async () => {
    const res = await request(app).get('/api/repos');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.repos)).toBe(true);
  });

  test('unknown route returns 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
  });

  test('cross-origin request is denied', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'localhost:3000')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  test('same-origin request passes CORS', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'localhost:3000')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
  });
});
