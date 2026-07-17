const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const execAsync = promisify(exec);
const app = express();

// Simple concurrency limiter (no external deps)
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const run = () => {
    while (active < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn().then(v => { active--; resolve(v); run(); })
          .catch(e => { active--; reject(e); run(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); run(); });
}

// GitHub REST API GET with ETag support (GraphQL endpoint does not support ETags)
function githubGet(apiPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pr-dashboard',
          ...extraHeaders,
        },
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode,
          etag: res.headers['etag'] || null,
          rateRemaining: parseInt(res.headers['x-ratelimit-remaining'] ?? '-1'),
          body,
        }));
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('GitHub API timeout')));
    req.end();
  });
}
const PORT = process.env.PORT || 3000;

// Map a REST API PR object to our internal shape
function mapRestPR(repo, pr) {
  return {
    id: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: 'OPEN',
    isDraft: pr.draft || false,
    author: { login: pr.user?.login || '' },
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    reviewDecision: null,
    repository: { nameWithOwner: repo },
    metadata: { age: '', reviewDecision: '', mergeable: '' },
  };
}

// Per-repo ETag cache for the open-PR list (REST GET supports conditional requests; GraphQL does not)
const prListEtagCache = new Map(); // repo → { etag, prs, pageCount }

// Fetch open PRs for one repo via REST with ETag support.
// 304 Not Modified = free (exempt from rate limiting); only repos with changes cost quota.
async function fetchRepoPRsRest(repo) {
  const [owner, name] = repo.split('/');
  const cached = prListEtagCache.get(repo);

  // Send If-None-Match only for single-page repos; multi-page repos have per-page ETags
  // which don't cover the full list, so we skip the optimisation and always re-fetch.
  const etag = (cached?.pageCount === 1 && cached.etag) ? cached.etag : null;
  const result = await githubGet(
    `/repos/${owner}/${name}/pulls?state=open&per_page=100`,
    etag ? { 'If-None-Match': etag } : {}
  );

  if (result.status === 304 && cached) {
    return { prs: cached.prs, fromCache: true };
  }

  if (result.status !== 200) return { prs: [], fromCache: false };

  const page1 = JSON.parse(result.body);
  let prs = page1.map(pr => mapRestPR(repo, pr));
  let pageCount = 1;

  if (page1.length === 100) {
    let pageNum = 2;
    for (;;) {
      const next = await githubGet(
        `/repos/${owner}/${name}/pulls?state=open&per_page=100&page=${pageNum}`
      );
      if (next.status !== 200) break;
      const data = JSON.parse(next.body);
      if (!data.length) break;
      prs = prs.concat(data.map(pr => mapRestPR(repo, pr)));
      pageCount++;
      if (data.length < 100) break;
      pageNum++;
    }
  }

  prListEtagCache.set(repo, { etag: result.etag || null, prs, pageCount });
  return { prs, fromCache: false };
}

// Fetch all open PRs across all repos concurrently (10 parallel REST requests)
async function fetchAllOpenPRsFromGitHub(repos, onProgress) {
  const limit = pLimit(10);
  let done = 0;
  let listHits = 0, listMisses = 0;

  const results = await Promise.all(
    repos.map(repo => limit(async () => {
      try {
        const { prs, fromCache } = await fetchRepoPRsRest(repo);
        if (fromCache) listHits++; else listMisses++;
        if (onProgress) onProgress(++done, repos.length);
        return prs;
      } catch (err) {
        console.error(`REST fetch error for ${repo}: ${err.message}`);
        listMisses++;
        if (onProgress) onProgress(++done, repos.length);
        return [];
      }
    }))
  );

  return { prs: results.flat(), listHits, listMisses };
}

// In-memory PR list cache (avoids re-fetching on every /api/prs hit during a session)
const prListCache = { prs: null, fetchedAt: 0, rateInfo: null };
const PR_LIST_TTL = 5 * 60 * 1000;

// Cache for review statuses to handle transient API failures
const reviewCache = new Map(); // key: 'owner/repo#number', value: { status, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes (longer TTL; review submission invalidates immediately)
const CACHE_FILE = process.env.REVIEW_CACHE_FILE || '/data/review-cache.json';

// Ring buffer of the last 10 GitHub API (review-status REST batch) fetch durations (ms)
const ghFetchTimesMs = [];

app.use(express.json());
app.use(express.static('public'));



// Get current authenticated user (cached — identity doesn't change mid-session)
let _cachedUser = null;
let _cachedUserAt = 0;
async function getCurrentUser() {
  if (_cachedUser && (Date.now() - _cachedUserAt) < 10 * 60 * 1000) return _cachedUser;
  try {
    const { stdout } = await execAsync('gh api user --jq .login');
    _cachedUser = stdout.trim();
    _cachedUserAt = Date.now();
    return _cachedUser;
  } catch (error) {
    console.error('Error getting current user:', error.message);
    return null;
  }
}

// Read subscribedRepos list from ghreport config.yaml or env var.
async function getSubscribedRepos() {
  const configPath = process.env.GHREPORT_CONFIG || '/root/.config/ghreport/config.yaml';
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const repos = [];
    let inSection = false;
    for (const line of content.split('\n')) {
      if (/^subscribedRepos:/.test(line)) { inSection = true; continue; }
      if (inSection) {
        const m = line.match(/^\s+-\s+(\S+)/);
        if (m) { repos.push(m[1]); continue; }
        if (/^\S/.test(line)) break;
      }
    }
    if (repos.length > 0) return { repos, source: configPath };
  } catch (_) { /* fall through */ }

  // Fall back to env var
  const envRepos = (process.env.subscribedRepos || '').split(/\s+/).filter(Boolean);
  if (envRepos.length > 0) return { repos: envRepos, source: 'env' };
  return { repos: [], source: null };
}

// ─── Persistent cache ────────────────────────────────────────────────────────

async function loadCacheFromDisk() {
  try {
    const content = await fs.readFile(CACHE_FILE, 'utf-8');
    const entries = JSON.parse(content);
    let loaded = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.timestamp && (Date.now() - entry.timestamp) < CACHE_TTL) {
        reviewCache.set(key, entry);
        loaded++;
      }
    }
    console.log(`Review cache: loaded ${loaded} valid entries from ${CACHE_FILE}`);
  } catch (_) { /* cache file missing or corrupt — start fresh */ }
}

async function saveCacheToDisk() {
  try {
    const entries = Object.fromEntries(reviewCache.entries());
    await fs.writeFile(CACHE_FILE, JSON.stringify(entries));
  } catch (err) {
    console.warn('Could not save review cache to disk:', err.message);
  }
}

// ─── Review data processing ───────────────────────────────────────────────────

function processReviewData(data, username) {
  const prMeta = {
    title: data.title,
    author: data.author,
    state: data.state,
    reviewDecision: data.reviewDecision,
    isDraft: data.isDraft || false,
  };

  const reviews = data.reviews?.nodes || data.reviews || [];
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { hasReviewed: false, updatedAt: data.updatedAt, prMeta };
  }

  const allUserReviews = reviews.filter(r => r.author?.login === username);
  const activeReviews = allUserReviews
    .filter(r => r.state !== 'DISMISSED')
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  if (activeReviews.length > 0) {
    const latest = activeReviews[0];
    return { hasReviewed: true, state: latest.state, submittedAt: latest.submittedAt, updatedAt: data.updatedAt, prMeta };
  } else if (allUserReviews.length > 0) {
    return { hasReviewed: false, updatedAt: data.updatedAt, allDismissed: true, prMeta };
  }
  return { hasReviewed: false, updatedAt: data.updatedAt, prMeta };
}

// ─── REST + ETag per-PR review fetch ─────────────────────────────────────────
// Replaces the GraphQL batch. ETags allow 304 Not Modified responses which cost
// zero primary rate-limit points when PR/review data is unchanged.

async function fetchReviewStatusRest(prs, username) {
  if (prs.length === 0) return { results: {}, restErrors: new Set() };

  const limit = pLimit(8);
  const results = {};
  const restErrors = new Set(); // keys that failed — callers should use gh fallback
  let fetched = 0, notModified = 0, errors = 0;

  await Promise.all(prs.map(pr => limit(async () => {
    const [owner, repo] = pr.repo.split('/');
    const key = `${pr.repo}#${pr.number}`;
    const cached = reviewCache.get(key); // may be stale — that's why it's a miss

    try {
      const prHeaders  = cached?.prEtag      ? { 'If-None-Match': cached.prEtag }      : {};
      const rvHeaders  = cached?.reviewsEtag ? { 'If-None-Match': cached.reviewsEtag } : {};

      const [prRes, rvRes] = await Promise.all([
        githubGet(`/repos/${owner}/${repo}/pulls/${pr.number}`, prHeaders),
        githubGet(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=50`, rvHeaders),
      ]);

      if (prRes.status === 304 && rvRes.status === 304) {
        // Nothing changed — refresh TTL so cache stays warm
        if (cached) reviewCache.set(key, { ...cached, timestamp: Date.now() });
        notModified++;
        return;
      }

      const rawPr = prRes.status === 200
        ? (() => { const d = JSON.parse(prRes.body); return { title: d.title, user: d.user, state: d.state, draft: d.draft, merged: d.merged, updated_at: d.updated_at, created_at: d.created_at, review_decision: d.review_decision }; })()
        : cached?.rawPr;
      const rawReviews = rvRes.status === 200
        ? JSON.parse(rvRes.body).map(r => ({ user: r.user, state: r.state, submitted_at: r.submitted_at }))
        : (cached?.rawReviews || []);

      if (!rawPr) { errors++; restErrors.add(key); return; }

      const prMeta = {
        title: rawPr.title,
        author: { login: rawPr.user?.login },
        state: rawPr.merged ? 'MERGED' : (rawPr.state === 'closed' ? 'CLOSED' : 'OPEN'),
        reviewDecision: rawPr.review_decision || null,
        isDraft: rawPr.draft || false,
        createdAt: rawPr.created_at || null,
      };

      const allUserReviews = rawReviews.filter(r => r.user?.login === username);
      const activeReviews = allUserReviews
        .filter(r => r.state !== 'DISMISSED')
        .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

      let status;
      if (activeReviews.length > 0) {
        const latest = activeReviews[0];
        status = { hasReviewed: true, state: latest.state, submittedAt: latest.submitted_at, updatedAt: rawPr.updated_at, prMeta };
      } else if (allUserReviews.length > 0) {
        status = { hasReviewed: false, updatedAt: rawPr.updated_at, allDismissed: true, prMeta };
      } else {
        status = { hasReviewed: false, updatedAt: rawPr.updated_at, prMeta };
      }

      reviewCache.set(key, {
        status,
        timestamp: Date.now(),
        prEtag:      prRes.etag ?? cached?.prEtag,
        reviewsEtag: rvRes.etag ?? cached?.reviewsEtag,
        rawPr,
        rawReviews,
      });
      results[key] = status;
      fetched++;
    } catch (err) {
      console.error(`REST fetch error for ${key}: ${err.message}`);
      errors++;
      restErrors.add(key);
    }
  })));

  console.log(`REST+ETag: ${fetched} fetched, ${notModified} not-modified (304), ${errors} errors — ${prs.length} misses total`);
  return { results, restErrors };
}

// ─── Per-PR review check (used for post-submit refresh and stale fallback) ────

// Check if current user has reviewed a PR and get updatedAt (with caching and retry)
async function checkUserReview(owner, repo, number, username, retries = 2) {
  const cacheKey = `${owner}/${repo}#${number}`;

  // Check cache first
  const cached = reviewCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`PR ${cacheKey}: Using cached review status (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
    return { ...cached.status, cachedAt: cached.timestamp };
  }
  
  try {
    const { stdout } = await execAsync(
      `gh pr view ${number} --repo ${owner}/${repo} --json reviews,updatedAt,title,author,state,reviewDecision,isDraft`,
      { timeout: 10000 } // 10 second timeout
    );
    const data = JSON.parse(stdout);
    
    let result;
    
    if (data.reviews && Array.isArray(data.reviews) && data.reviews.length > 0) {
      // Find the most recent NON-DISMISSED review by this user
      const userReviews = data.reviews
        .filter(r => r.author && r.author.login && r.author.login === username)
        .filter(r => r.state !== 'DISMISSED') // Exclude dismissed reviews
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      
      // Log all reviews for debugging
      const allUserReviews = data.reviews.filter(r => r.author && r.author.login && r.author.login === username);
      if (allUserReviews.length > 0) {
        console.log(`PR ${owner}/${repo}#${number}: All reviews by ${username}:`, 
          allUserReviews.map(r => `${r.state} (${r.submittedAt})`).join(', '));
      }
      
      const prMeta = { title: data.title, author: data.author, state: data.state, reviewDecision: data.reviewDecision, isDraft: data.isDraft || false };

      if (userReviews.length > 0) {
        const latestReview = userReviews[0];
        console.log(`PR ${owner}/${repo}#${number}: Using review state: ${latestReview.state} from ${latestReview.submittedAt}`);
        result = {
          hasReviewed: true,
          state: latestReview.state, // APPROVED, CHANGES_REQUESTED, COMMENTED
          submittedAt: latestReview.submittedAt,
          updatedAt: data.updatedAt,
          prMeta
        };
      } else if (allUserReviews.length > 0) {
        // All reviews were dismissed - treat as not reviewed
        console.log(`PR ${owner}/${repo}#${number}: All reviews by ${username} were dismissed`);
        result = { hasReviewed: false, updatedAt: data.updatedAt, allDismissed: true, prMeta };
      } else {
        result = { hasReviewed: false, updatedAt: data.updatedAt, prMeta };
      }
    } else {
      const prMeta = { title: data.title, author: data.author, state: data.state, reviewDecision: data.reviewDecision, isDraft: data.isDraft || false };
      result = { hasReviewed: false, updatedAt: data.updatedAt, prMeta };
    }
    
    // Cache successful result
    const now = Date.now();
    reviewCache.set(cacheKey, { status: result, timestamp: now });
    return { ...result, cachedAt: now };
    
  } catch (error) {
    // Handle different error types
    if (error.message.includes('404') || error.message.includes('403') || error.message.includes('Not Found')) {
      const result = { hasReviewed: false, updatedAt: null };
      reviewCache.set(cacheKey, { status: result, timestamp: Date.now() });
      return result;
    }
    
    // Connection errors - retry with exponential backoff
    if ((error.message.includes('connection refused') || error.message.includes('ECONNREFUSED') || 
         error.message.includes('timeout')) && retries > 0) {
      const delay = (3 - retries) * 1000; // 1s, 2s
      console.log(`PR ${cacheKey}: Connection error, retrying in ${delay}ms (${retries} retries left)...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return checkUserReview(owner, repo, number, username, retries - 1);
    }
    
    // If we have cached data (even if expired), use it as fallback
    if (cached) {
      console.warn(`PR ${cacheKey}: Using stale cache due to error (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
      return { ...cached.status, stale: true, cachedAt: cached.timestamp };
    }
    
    console.error(`Error checking review for PR ${owner}/${repo}#${number}:`, error.message);
    return { hasReviewed: false, updatedAt: null, error: true };
  }
}

// API Endpoints
app.get('/api/repos', async (req, res) => {
  try {
    const { repos, source } = await getSubscribedRepos();
    res.json({ success: true, repos: repos.sort(), source });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/user', async (req, res) => {
  try {
    const username = await getCurrentUser();
    res.json({ success: true, username });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/prs', async (req, res) => {
  try {
    let prs;
    const forceReviewRefresh = req.query.force === '1';

    // Prefer in-memory cache (populated by the SSE refresh)
    if (prListCache.prs && (Date.now() - prListCache.fetchedAt) < PR_LIST_TTL) {
      prs = prListCache.prs;
    } else {
      const { repos } = await getSubscribedRepos();
      if (repos.length > 0) {
        const result = await fetchAllOpenPRsFromGitHub(repos, null);
        prs = result.prs;
        prListCache.prs = prs;
        prListCache.fetchedAt = Date.now();
        if (prListCache.rateInfo) {
          prListCache.rateInfo.listHits = result.listHits;
          prListCache.rateInfo.listMisses = result.listMisses;
        }
      }
    }
    
    // Get current user and check reviews
    const currentUser = await getCurrentUser();
    console.log(`Current authenticated user: ${currentUser}`);
    
    let hitCount = 0, missCount = 0, ghFetchMs = 0;

    if (currentUser) {
      const now = Date.now();

      // Split PRs into cache hits and misses.
      // forceReviewRefresh treats everything as a miss so ETags still run but stale
      // data is never served — picks up reviews submitted directly on GitHub.
      const hits = {};
      const misses = [];
      for (const pr of prs) {
        const key = `${pr.repo}#${pr.number}`;
        const cached = reviewCache.get(key);
        if (!forceReviewRefresh && cached && (now - cached.timestamp) < CACHE_TTL) {
          hits[key] = { ...cached.status, cachedAt: cached.timestamp };
        } else {
          misses.push(pr);
        }
      }
      hitCount = Object.keys(hits).length;
      missCount = misses.length;
      console.log(`Review cache: ${hitCount} hits, ${missCount} misses`);

      // Fetch misses via REST+ETag (parallel, concurrency-limited)
      const ghFetchStart = Date.now();
      let restErrors = new Set();
      if (misses.length > 0) {
        ({ restErrors } = await fetchReviewStatusRest(misses, currentUser));
        ghFetchMs = Date.now() - ghFetchStart;
      }

      // Rebuild hits from cache (REST fetch updated it for both 200 and 304 cases)
      for (const pr of misses) {
        const key = `${pr.repo}#${pr.number}`;
        const cached = reviewCache.get(key);
        if (cached?.status) hits[key] = { ...cached.status, cachedAt: cached.timestamp };
      }

      // For anything still not resolved (no REST result and no cache): fall back to
      // gh pr view which goes through the gh CLI and bypasses direct-HTTPS issues.
      const stillMissing = misses.filter(pr => !hits[`${pr.repo}#${pr.number}`]);
      if (stillMissing.length > 0) {
        console.log(`Falling back to gh pr view for ${stillMissing.length} PRs`);
        await Promise.all(stillMissing.map(async pr => {
          const [owner, repo] = pr.repo.split('/');
          const key = `${pr.repo}#${pr.number}`;
          try {
            const status = await checkUserReview(owner, repo, pr.number, currentUser);
            hits[key] = status;
          } catch (_) {}
        }));
      }

      // Save updated cache to disk (non-blocking)
      if (misses.length > 0) {
        saveCacheToDisk();
        ghFetchTimesMs.push(ghFetchMs);
        if (ghFetchTimesMs.length > 10) ghFetchTimesMs.shift();
      }

      // Apply review statuses to PRs
      prs = prs.map(pr => {
        const key = `${pr.repo}#${pr.number}`;
        const reviewStatus = hits[key] || { hasReviewed: false };
        if (reviewStatus.updatedAt) pr.updatedAt = reviewStatus.updatedAt;
        if (reviewStatus.prMeta) {
          if (reviewStatus.prMeta.title) pr.title = reviewStatus.prMeta.title;
          if (reviewStatus.prMeta.author) pr.author = reviewStatus.prMeta.author;
          if (reviewStatus.prMeta.state) pr.state = reviewStatus.prMeta.state;
          if (reviewStatus.prMeta.isDraft !== undefined) pr.isDraft = reviewStatus.prMeta.isDraft;
          if (reviewStatus.prMeta.createdAt) pr.createdAt = reviewStatus.prMeta.createdAt;
        }
        return { ...pr, reviewStatus };
      });
    }
    
    const ghAvgMs = ghFetchTimesMs.length > 0
      ? Math.round(ghFetchTimesMs.reduce((a, b) => a + b, 0) / ghFetchTimesMs.length)
      : null;
    res.json({
      success: true, prs, currentUser,
      perf: {
        ghFetchMs: missCount > 0 ? ghFetchMs : null,
        ghAvgMs,
        ghSamples: ghFetchTimesMs.length,
        cacheHits: hitCount,
        cacheMisses: missCount,
        rateInfo: prListCache.rateInfo || null,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pr/:owner/:repo/:number', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { stdout } = await execAsync(
      `gh pr view ${number} --repo ${owner}/${repo} --json title,body,state,author,url,commits,reviews,statusCheckRollup`
    );
    res.json({ success: true, pr: JSON.parse(stdout) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pr/:owner/:repo/:number/diff', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { stdout } = await execAsync(`gh pr diff ${number} --repo ${owner}/${repo}`);
    res.json({ success: true, diff: stdout });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pr/:owner/:repo/:number/checkout', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { stdout, stderr } = await execAsync(`gh pr checkout ${number} --repo ${owner}/${repo}`);
    res.json({ success: true, output: stdout || stderr });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pr/:owner/:repo/:number/comment', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { body } = req.body;
    
    if (!body) {
      return res.status(400).json({ success: false, error: 'Comment body required' });
    }
    
    const { stdout } = await execAsync(
      `gh pr comment ${number} --repo ${owner}/${repo} --body ${JSON.stringify(body)}`
    );
    res.json({ success: true, output: stdout });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pr/:owner/:repo/:number/review', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { action, body } = req.body; // action: approve, request-changes, comment
    
    if (!action || !['approve', 'request-changes', 'comment'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Valid action required' });
    }
    
    let cmd = `gh pr review ${number} --repo ${owner}/${repo} --${action}`;
    if (body) {
      cmd += ` --body ${JSON.stringify(body)}`;
    }
    
    console.log(`Executing review command: ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd);
    console.log(`Review command output: ${stdout}`);
    if (stderr) console.log(`Review command stderr: ${stderr}`);

    // Update cache immediately with the known new state — avoids a gh pr view
    // round-trip on the next fetch for repos that can't reach GitHub directly.
    const cacheKey = `${owner}/${repo}#${number}`;
    const existing = reviewCache.get(cacheKey);
    const stateMap = { approve: 'APPROVED', 'request-changes': 'CHANGES_REQUESTED', comment: 'COMMENTED' };
    const newStatus = {
      hasReviewed: action !== 'comment' ? true : (existing?.status?.hasReviewed || false),
      state: stateMap[action],
      submittedAt: new Date().toISOString(),
      updatedAt: existing?.status?.updatedAt || null,
      prMeta: existing?.status?.prMeta || null,
    };
    reviewCache.set(cacheKey, { status: newStatus, timestamp: Date.now(), prEtag: existing?.prEtag || null, reviewsEtag: null, rawPr: existing?.rawPr || null, rawReviews: null });
    console.log(`Updated cache for ${cacheKey} with state ${newStatus.state}`);

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error(`Review command failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/metrics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'metrics.html'));
});

app.get('/api/rate-limit', async (req, res) => {
  try {
    const rl = await githubGet('/rate_limit');
    if (rl.status !== 200) return res.status(rl.status).json({ success: false });
    const data = JSON.parse(rl.body);
    res.json({ success: true, resources: data.resources, cached: prListCache.rateInfo || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/version', (req, res) => {
  const version = process.env.APP_VERSION || require('./package.json').version;
  res.json({ version });
});

// SSE endpoint for PR list refresh — now uses concurrent GraphQL instead of ghreport binary
app.get('/api/refresh-ghreport-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendProgress = (percent, message) => sendEvent({ progress: percent, message });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { repos } = await getSubscribedRepos();
    if (repos.length === 0) {
      sendEvent({ error: true, message: 'No repos configured in ghreport config.' });
      res.end();
      return;
    }

    sendProgress(2, `Querying ${repos.length} repos via GitHub GraphQL...`);

    const { prs, listHits, listMisses } = await fetchAllOpenPRsFromGitHub(repos, (done, total) => {
      if (!aborted) {
        const pct = Math.round(2 + (done / total) * 93);
        sendProgress(pct, `${done}/${total} repos fetched...`);
      }
    });

    if (aborted) return;

    // Fetch REST rate limits (exempt from rate limiting itself)
    let restRL = null;
    try {
      const rl = await githubGet('/rate_limit');
      if (rl.status === 200) restRL = JSON.parse(rl.body)?.resources?.core ?? null;
    } catch (_) {}

    // Update in-memory cache
    prListCache.prs = prs;
    prListCache.fetchedAt = Date.now();
    prListCache.rateInfo = { listHits, listMisses, rest: restRL, fetchedAt: Date.now() };

    // Write ghreport-format file for any external tooling that reads it
    const outputPath = process.env.GHREPORT_OUTPUT;
    if (outputPath) {
      const content = prs.map(pr =>
        `${pr.url}: createdAt ${new Date(pr.createdAt).toISOString()}`
      ).join('\n') + '\n';
      await fs.writeFile(outputPath, content, 'utf-8').catch(e =>
        console.warn('Could not write ghreport output file:', e.message)
      );
    }

    console.log(`PR list fetch complete. Found ${prs.length} open PRs across ${repos.length} repos (${listHits} cached / ${listMisses} fetched).`);
    sendProgress(100, `Complete! Found ${prs.length} open PRs (${listHits}/${repos.length} repos unchanged).`);
    sendEvent({ success: true, prCount: prs.length, complete: true });

  } catch (error) {
    console.error('GitHub GraphQL fetch failed:', error.message);
    sendEvent({ error: true, message: error.message });
    res.end();
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`PR Dashboard running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  loadCacheFromDisk();
});
