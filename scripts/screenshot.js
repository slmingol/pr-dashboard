#!/usr/bin/env node
// Generates README screenshots via headless Chrome with fake data injected.
// Usage: node scripts/screenshot.js

const puppeteer = require('/Users/smingolelli/.npm/_npx/7d92d9a2d2ccc630/node_modules/puppeteer');
const path = require('path');

const OUT = path.join(__dirname, '../docs/screenshots');
const BASE = 'http://localhost:3000';

const FAKE_PRS = [
  {
    id: 'acme-corp/platform#183', repo: 'acme-corp/platform', number: 183,
    title: 'Add analytics pipeline with warehouse integration', url: '#',
    state: 'OPEN', isDraft: false,
    author: { login: 'jsmith' },
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    reviewDecision: 'APPROVED',
    repository: { nameWithOwner: 'acme-corp/platform' },
    metadata: { age: '2d', reviewDecision: 'APPROVED', mergeable: '' },
    ciStatus: { state: 'SUCCESS' },
    reviewStatus: { hasReviewed: true, state: 'APPROVED' },
  },
  {
    id: 'acme-corp/platform#179', repo: 'acme-corp/platform', number: 179,
    title: 'Refactor plugin loader to support lazy-loaded modules', url: '#',
    state: 'OPEN', isDraft: false,
    author: { login: 'arao' },
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 7200000).toISOString(),
    reviewDecision: 'CHANGES_REQUESTED',
    repository: { nameWithOwner: 'acme-corp/platform' },
    metadata: { age: '5d', reviewDecision: 'CHANGES_REQUESTED', mergeable: '' },
    ciStatus: { state: 'SUCCESS' },
    reviewStatus: { hasReviewed: false },
  },
  {
    id: 'acme-corp/api-gateway#412', repo: 'acme-corp/api-gateway', number: 412,
    title: 'Fix rate limit retry logic in upstream HTTP client', url: '#',
    state: 'OPEN', isDraft: false,
    author: { login: 'mchen' },
    createdAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
    reviewDecision: null,
    repository: { nameWithOwner: 'acme-corp/api-gateway' },
    metadata: { age: '1d', reviewDecision: '', mergeable: '' },
    ciStatus: { state: 'FAILURE' },
    reviewStatus: { hasReviewed: false },
  },
  {
    id: 'acme-corp/api-gateway#408', repo: 'acme-corp/api-gateway', number: 408,
    title: 'Add ETag caching to resource list endpoints', url: '#',
    state: 'OPEN', isDraft: false,
    author: { login: 'tpatel' },
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 5400000).toISOString(),
    reviewDecision: 'APPROVED',
    repository: { nameWithOwner: 'acme-corp/api-gateway' },
    metadata: { age: '3d', reviewDecision: 'APPROVED', mergeable: '' },
    ciStatus: { state: 'SUCCESS' },
    reviewStatus: { hasReviewed: false },
  },
  {
    id: 'acme-corp/infra#89', repo: 'acme-corp/infra', number: 89,
    title: 'Bump node base image to 20-alpine for security patches', url: '#',
    state: 'OPEN', isDraft: false,
    author: { login: 'dlee' },
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
    reviewDecision: null,
    repository: { nameWithOwner: 'acme-corp/infra' },
    metadata: { age: '7d', reviewDecision: '', mergeable: '' },
    mergeableState: 'dirty',
    ciStatus: { state: 'PENDING' },
    reviewStatus: { hasReviewed: false },
  },
  {
    id: 'acme-corp/infra#87', repo: 'acme-corp/infra', number: 87,
    title: 'Update Helm chart tolerations for spot instance nodes', url: '#',
    state: 'OPEN', isDraft: true,
    author: { login: 'rwalker' },
    createdAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    reviewDecision: null,
    repository: { nameWithOwner: 'acme-corp/infra' },
    metadata: { age: '4d', reviewDecision: '', mergeable: '' },
    reviewStatus: { hasReviewed: false },
  },
];

const FAKE_REPOS = [
  'acme-corp/platform', 'acme-corp/api-gateway', 'acme-corp/infra',
  'acme-corp/auth-service', 'acme-corp/billing', 'acme-corp/data-pipeline',
  'acme-corp/deploy', 'acme-corp/docs', 'acme-corp/frontend',
  'acme-corp/identity', 'acme-corp/jobs', 'acme-corp/kafka-consumers',
  'acme-corp/metrics', 'acme-corp/notifications', 'acme-corp/portal',
  'acme-corp/reporting', 'acme-corp/search', 'acme-corp/storage',
  'acme-corp/webhooks', 'acme-corp/worker',
];

const FAKE_PERF = {
  totalMs: 7200, ghMs: 2100, avgMs: 850,
  cacheHits: 120, cacheTotal: 135,
  rateInfo: { listHits: 122, listMisses: 4, rest: { remaining: 4979, limit: 5000 } },
};

const FAKE_TEAM = ['jsmith', 'mchen', 'dlee'];

// Multi-file unified diff for the diff modal screenshot
const FAKE_DIFF = `diff --git a/src/pipeline/analytics.js b/src/pipeline/analytics.js
index a1b2c3d..e4f5a6b 100644
--- a/src/pipeline/analytics.js
+++ b/src/pipeline/analytics.js
@@ -12,6 +12,18 @@ const { connect } = require('./warehouse');

 class AnalyticsPipeline {
   constructor(config) {
+    this.batchSize = config.batchSize || 500;
+    this.flushInterval = config.flushInterval || 5000;
+    this._queue = [];
+    this._timer = null;
+  }
+
+  start() {
+    this._timer = setInterval(() => this.flush(), this.flushInterval);
+    this._timer.unref();
+    return this;
+  }
+
+  async flush() {
+    if (!this._queue.length) return;
+    const batch = this._queue.splice(0, this.batchSize);
+    await this.warehouse.insert('events', batch);
   }

   async push(event) {
diff --git a/src/pipeline/warehouse.js b/src/pipeline/warehouse.js
index b2c3d4e..f6a7b8c 100644
--- a/src/pipeline/warehouse.js
+++ b/src/pipeline/warehouse.js
@@ -1,10 +1,22 @@
 const { Pool } = require('pg');

-let pool = null;
+const DEFAULT_POOL_SIZE = 10;
+let pool = null;

-function connect(config) {
-  pool = new Pool(config);
+function connect(config = {}) {
+  pool = new Pool({
+    ...config,
+    max: config.max || DEFAULT_POOL_SIZE,
+    idleTimeoutMillis: 30000,
+    connectionTimeoutMillis: 5000,
+  });
+  pool.on('error', (err) => {
+    console.error('Idle client error', err);
+  });
   return pool;
 }

+async function insert(table, rows) {
+  const client = await pool.connect();
+  try {
+    const cols = Object.keys(rows[0]).join(', ');
+    const vals = rows.map((r, i) =>
+      '(' + Object.keys(r).map((_, j) => '$' + (i * Object.keys(r).length + j + 1)).join(', ') + ')'
+    ).join(', ');
+    await client.query(\`INSERT INTO \${table} (\${cols}) VALUES \${vals}\`, rows.flatMap(Object.values));
+  } finally {
+    client.release();
+  }
+}
+
-module.exports = { connect };
+module.exports = { connect, insert };
diff --git a/tests/pipeline.test.js b/tests/pipeline.test.js
index c3d4e5f..a8b9c0d 100644
--- a/tests/pipeline.test.js
+++ b/tests/pipeline.test.js
@@ -0,0 +1,28 @@
+const { AnalyticsPipeline } = require('../src/pipeline/analytics');
+
+describe('AnalyticsPipeline', () => {
+  let pipeline;
+  beforeEach(() => {
+    pipeline = new AnalyticsPipeline({ batchSize: 2, flushInterval: 100 });
+    pipeline.warehouse = { insert: jest.fn().mockResolvedValue() };
+  });
+
+  test('batches events and flushes', async () => {
+    pipeline.push({ type: 'click', ts: Date.now() });
+    pipeline.push({ type: 'view', ts: Date.now() });
+    await pipeline.flush();
+    expect(pipeline.warehouse.insert).toHaveBeenCalledTimes(1);
+    expect(pipeline.warehouse.insert.mock.calls[0][1]).toHaveLength(2);
+  });
+
+  test('no-op flush on empty queue', async () => {
+    await pipeline.flush();
+    expect(pipeline.warehouse.insert).not.toHaveBeenCalled();
+  });
+});
`;

async function injectFakeData(page) {
  await page.evaluateOnNewDocument((prs, repos, perf, team, diff) => {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (url === '/api/prs' || url.startsWith('/api/prs?')) {
        return new Response(JSON.stringify({
          success: true,
          prs,
          user: 'jdoe',
          perf,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/repos') {
        return new Response(JSON.stringify({ success: true, repos }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/team-members') {
        return new Response(JSON.stringify({ success: true, members: team }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url && url.includes('/diff')) {
        return new Response(JSON.stringify({ success: true, diff }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return origFetch(url, opts);
    };
  }, FAKE_PRS, FAKE_REPOS, FAKE_PERF, FAKE_TEAM, FAKE_DIFF);
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    // ── Main dashboard ──────────────────────────────────────────────────────
    console.log('main-dashboard...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await injectFakeData(page);
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.fetchPRs && window.fetchPRs());
    await wait(1200);
    await page.evaluate(() => {
      document.querySelectorAll('.toast').forEach(t => t.remove());
    });
    await wait(300);
    await page.screenshot({ path: `${OUT}/main-dashboard.png`, fullPage: false });

    // ── Stats bar ───────────────────────────────────────────────────────────
    console.log('stats-bar...');
    const statsEl = await page.$('#stats');
    if (statsEl) await statsEl.screenshot({ path: `${OUT}/stats-bar.png` });

    // ── Filters bar ─────────────────────────────────────────────────────────
    console.log('filters-bar...');
    const filtersEl = await page.$('#filters');
    if (filtersEl) await filtersEl.screenshot({ path: `${OUT}/filters-bar.png` });

    // ── CI Pass filter active ────────────────────────────────────────────────
    console.log('filters-ci-pass...');
    await page.evaluate(() => {
      const cb = document.getElementById('filter-ci-pass');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(400);
    const filtersCiEl = await page.$('#filters');
    if (filtersCiEl) await filtersCiEl.screenshot({ path: `${OUT}/filters-ci-pass.png` });
    await page.screenshot({ path: `${OUT}/ci-pass-filtered.png`, fullPage: false });
    await page.evaluate(() => {
      const cb = document.getElementById('filter-ci-pass');
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(200);

    // ── Diff modal (multi-file with file nav) ────────────────────────────────
    console.log('diff-modal...');
    await page.evaluate(() => {
      window.viewDiff('acme-corp', 'platform', '183');
    });
    await wait(800);
    await page.screenshot({ path: `${OUT}/diff-modal.png`, fullPage: false });
    await page.keyboard.press('Escape');
    await wait(200);

    // ── Keyboard shortcuts modal ─────────────────────────────────────────────
    console.log('keyboard-shortcuts...');
    await page.keyboard.press('?');
    await wait(400);
    await page.screenshot({ path: `${OUT}/keyboard-shortcuts.png`, fullPage: false });
    await page.keyboard.press('Escape');
    await wait(200);

    // ── Repos modal ──────────────────────────────────────────────────────────
    console.log('repos-modal...');
    await page.click('#repos-stat');
    await wait(500);
    await page.screenshot({ path: `${OUT}/repos-modal.png`, fullPage: false });

    // ── Repos modal with search ───────────────────────────────────────────────
    console.log('repos-modal-search...');
    await page.type('#repo-search', 'infra');
    await wait(300);
    await page.screenshot({ path: `${OUT}/repos-modal-search.png`, fullPage: false });

    console.log('Done. Screenshots saved to docs/screenshots/');
  } finally {
    await browser.close();
  }
})();
