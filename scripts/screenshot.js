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

async function injectFakeData(page) {
  // evaluateOnNewDocument runs before any page scripts, surviving page.goto()
  await page.evaluateOnNewDocument((prs, repos, perf) => {
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
      return origFetch(url, opts);
    };
  }, FAKE_PRS, FAKE_REPOS, FAKE_PERF);
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
    // Trigger fetch with fake data
    await page.evaluate(() => window.fetchPRs && window.fetchPRs());
    await wait(1200);
    // Dismiss any toast
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
