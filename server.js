const express = require('express');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Cache for review statuses to handle transient API failures
const reviewCache = new Map(); // key: 'owner/repo#number', value: { status, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes (longer TTL; review submission invalidates immediately)
const CACHE_FILE = process.env.REVIEW_CACHE_FILE || '/data/review-cache.json';

// Ring buffer of the last 10 GitHub API (GraphQL batch) fetch durations (ms)
const ghFetchTimesMs = [];

app.use(express.json());
app.use(express.static('public'));

// Parse a single ghreport output line — handles two formats:
//   old: https://github.com/owner/repo/pull/N: createdAt 2024-01-01T00:00:00Z
//   new: https://github.com/owner/repo/pull/N author: login Age: N days reviewDecision: emoji mergeable: emoji
function parseGhReportLine(line) {
  const match = line.match(
    /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)(?::\s+createdAt\s+(\S+(?:\s+\S+)?))?(?:\s+author:\s+(\S+))?(?:\s+Age:\s+(\d+)\s+(days?|hours?))?/i
  );
  if (!match) return null;

  const [, owner, repo, number, createdAt, authorLogin, ageAmount, ageUnit] = match;

  let updatedAt;
  if (createdAt) {
    updatedAt = new Date(createdAt).toISOString();
  } else if (ageAmount) {
    const ms = ageUnit.toLowerCase().startsWith('day')
      ? parseInt(ageAmount) * 86400000
      : parseInt(ageAmount) * 3600000;
    updatedAt = new Date(Date.now() - ms).toISOString();
  } else {
    updatedAt = new Date().toISOString();
  }

  const repoFullName = `${owner}/${repo}`;
  return {
    id: `${repoFullName}#${number}`,
    repo: repoFullName,
    number: parseInt(number),
    title: `PR #${number}`,
    url: `https://github.com/${repoFullName}/pull/${number}`,
    state: 'OPEN',
    author: { login: authorLogin || '' },
    updatedAt,
    repository: { nameWithOwner: repoFullName },
    metadata: { age: '', reviewDecision: '', mergeable: '' }
  };
}

// Parse ghreport output
async function loadPRsFromGhReport() {
  try {
    const ghreportPath = process.env.GHREPORT_OUTPUT || '/data/ghreport.txt';
    const content = await fs.readFile(ghreportPath, 'utf-8');

    // Handle line continuations (lines starting with space are continuations)
    const rawLines = content.split('\n');
    const joinedLines = [];
    let currentLine = '';

    for (const line of rawLines) {
      if (line.startsWith(' ') && currentLine) {
        currentLine += line;
      } else {
        if (currentLine.trim()) {
          joinedLines.push(currentLine.trim());
        }
        currentLine = line;
      }
    }
    if (currentLine.trim()) {
      joinedLines.push(currentLine.trim());
    }

    return joinedLines.map(parseGhReportLine).filter(Boolean);
  } catch (error) {
    console.error('Error reading ghreport:', error.message);
    return [];
  }
}

// Fallback: try to run ghreport command directly if file doesn't exist
async function runGhReportCommand() {
  try {
    const env = await getGhreportEnv();
    const { stdout } = await execAsync('ghreport', { env });

    const rawLines = stdout.split('\n');
    const joinedLines = [];
    let currentLine = '';

    for (const line of rawLines) {
      if (line.startsWith(' ') && currentLine) {
        currentLine += line;
      } else {
        if (currentLine.trim()) {
          joinedLines.push(currentLine.trim());
        }
        currentLine = line;
      }
    }
    if (currentLine.trim()) {
      joinedLines.push(currentLine.trim());
    }

    return joinedLines.map(parseGhReportLine).filter(Boolean);
  } catch (error) {
    console.error('Error running ghreport command:', error.message);
    return [];
  }
}

// Get current authenticated user
async function getCurrentUser() {
  try {
    const { stdout } = await execAsync('gh api user --jq .login');
    return stdout.trim();
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

async function getGhreportEnv() {
  const { repos, source } = await getSubscribedRepos();
  if (repos.length > 0) {
    console.log(`ghreport: using ${repos.length} repos from ${source}`);
    return { ...process.env, subscribedRepos: repos.join(' ') };
  }
  return process.env;
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

// ─── GraphQL batch review fetch ───────────────────────────────────────────────

async function fetchReviewStatusBatch(prs, username) {
  if (prs.length === 0) return {};

  // Group by repo so we emit one repository() block per repo
  const byRepo = {};
  for (const pr of prs) {
    if (!byRepo[pr.repo]) byRepo[pr.repo] = [];
    byRepo[pr.repo].push(pr.number);
  }

  const repos = Object.keys(byRepo);
  const repoAliasMap = {}; // r0 -> 'owner/repo'
  repos.forEach((repo, i) => { repoAliasMap[`r${i}`] = repo; });

  const prFields = `title isDraft state updatedAt reviewDecision author { login } reviews(last: 20) { nodes { author { login } state submittedAt } }`;
  const repoBlocks = repos.map((repo, i) => {
    const [owner, name] = repo.split('/');
    const prBlocks = byRepo[repo].map(n => `p${n}: pullRequest(number: ${n}) { ${prFields} }`).join(' ');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${prBlocks} }`;
  });

  const query = `{ ${repoBlocks.join(' ')} }`;
  const tmpFile = path.join('/tmp', `pr-dashboard-gql-${Date.now()}.graphql`);

  try {
    await fs.writeFile(tmpFile, query);
    const { stdout } = await execAsync(`gh api graphql -f query=@${tmpFile}`, { timeout: 45000 });
    const result = JSON.parse(stdout);

    if (result.errors?.length) {
      console.warn('GraphQL batch warnings:', result.errors.map(e => e.message).join('; '));
    }

    const out = {};
    for (const [repoAlias, repoData] of Object.entries(result.data || {})) {
      const repo = repoAliasMap[repoAlias];
      if (!repoData) continue;
      for (const [prAlias, prData] of Object.entries(repoData)) {
        if (!prData) continue;
        const number = parseInt(prAlias.slice(1));
        out[`${repo}#${number}`] = prData;
      }
    }
    console.log(`GraphQL batch: fetched ${Object.keys(out).length}/${prs.length} PRs in one call`);
    return out;
  } catch (err) {
    console.error('GraphQL batch fetch failed, will fall back to individual calls:', err.message);
    return {};
  } finally {
    fs.unlink(tmpFile).catch(() => {});
  }
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
    // Try ghreport file first, then try running ghreport command
    let prs = await loadPRsFromGhReport();
    
    if (prs.length === 0) {
      prs = await runGhReportCommand();
    }
    
    // Get current user and check reviews
    const currentUser = await getCurrentUser();
    console.log(`Current authenticated user: ${currentUser}`);
    
    let hitCount = 0, missCount = 0, ghFetchMs = 0;

    if (currentUser) {
      const now = Date.now();

      // Split PRs into cache hits and misses
      const hits = {};
      const misses = [];
      for (const pr of prs) {
        const key = `${pr.repo}#${pr.number}`;
        const cached = reviewCache.get(key);
        if (cached && (now - cached.timestamp) < CACHE_TTL) {
          hits[key] = { ...cached.status, cachedAt: cached.timestamp };
        } else {
          misses.push(pr);
        }
      }
      hitCount = Object.keys(hits).length;
      missCount = misses.length;
      console.log(`Review cache: ${hitCount} hits, ${missCount} misses`);

      // Fetch all misses in a single GraphQL call
      const ghFetchStart = Date.now();
      const batchData = await fetchReviewStatusBatch(misses, currentUser);
      const batchTimestamp = Date.now();
      ghFetchMs = misses.length > 0 ? batchTimestamp - ghFetchStart : 0;

      // For any PR the batch didn't return (deleted/private), fall back to individual call
      const stillMissing = misses.filter(pr => !batchData[`${pr.repo}#${pr.number}`]);
      if (stillMissing.length > 0) {
        console.log(`Falling back to individual calls for ${stillMissing.length} PRs`);
        await Promise.all(stillMissing.map(async pr => {
          const [owner, repo] = pr.repo.split('/');
          try {
            const status = await checkUserReview(owner, repo, pr.number, currentUser);
            batchData[`${pr.repo}#${pr.number}`] = null; // sentinel — already cached by checkUserReview
            hits[`${pr.repo}#${pr.number}`] = status;
          } catch (_) {}
        }));
      }

      // Store batch results in cache
      for (const [key, data] of Object.entries(batchData)) {
        if (!data) continue;
        const [ownerRepo, num] = key.split('#');
        const status = processReviewData(data, currentUser);
        reviewCache.set(key, { status, timestamp: batchTimestamp });
        hits[key] = { ...status, cachedAt: batchTimestamp };
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
    
    // Invalidate cache for this PR so next fetch gets fresh status
    const cacheKey = `${owner}/${repo}#${number}`;
    reviewCache.delete(cacheKey);
    console.log(`Invalidated cache for ${cacheKey}`);
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error(`Review command failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/version', (req, res) => {
  const { version } = require('./package.json');
  res.json({ version });
});

// SSE endpoint for ghreport refresh with progress tracking
app.get('/api/refresh-ghreport-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendProgress = (percent, message) => sendEvent({ progress: percent, message });

  let progressInterval = null;
  let ghreportProcess = null;

  req.on('close', () => {
    clearInterval(progressInterval);
    if (ghreportProcess) ghreportProcess.kill();
  });

  try {
    sendProgress(0, 'Starting ghreport...');
    sendProgress(10, 'Querying GitHub API...');

    const ghreportEnv = await getGhreportEnv();
    const ghreport = spawn('ghreport', [], { env: ghreportEnv });
    ghreportProcess = ghreport;

    let stdout = '';
    let stderr = '';
    let progressPercent = 10;

    progressInterval = setInterval(() => {
      if (progressPercent < 90) {
        progressPercent += Math.random() * 15;
        if (progressPercent > 90) progressPercent = 90;
        sendProgress(Math.floor(progressPercent), 'Fetching PRs from repositories...');
      }
    }, 1000);

    ghreport.on('error', (err) => {
      clearInterval(progressInterval);
      console.error('ghreport spawn error:', err.message);
      sendEvent({ error: true, message: `Failed to start ghreport: ${err.message}` });
      res.end();
    });

    ghreport.stdout.on('data', (data) => {
      stdout += data.toString();
      const currentLines = stdout.split('\n').filter(l => l.trim()).length;
      if (currentLines > 0) {
        sendProgress(Math.floor(progressPercent), `Found ${currentLines} PRs so far...`);
      }
    });

    ghreport.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ghreport.on('close', async (code) => {
      clearInterval(progressInterval);

      if (code !== 0) {
        const errDetail = (stderr || stdout || '(no output)').trim();
        sendEvent({ error: true, message: `ghreport exited with code ${code}: ${errDetail}` });
        res.end();
        return;
      }

      sendProgress(95, 'Processing results...');

      const outputPath = process.env.GHREPORT_OUTPUT;
      if (outputPath) {
        try {
          await fs.writeFile(outputPath, stdout, 'utf-8');
          console.log(`Updated ghreport output file: ${outputPath}`);
        } catch (writeError) {
          console.error(`Failed to write to ${outputPath}:`, writeError.message);
        }
      }

      const lineCount = stdout.split('\n').filter(line => line.trim()).length;
      console.log(`ghreport completed. Found ${lineCount} PRs`);

      sendProgress(100, `Completed! Found ${lineCount} PRs.`);
      // Send complete but don't call res.end() — client closes the EventSource,
      // which triggers req 'close' above for cleanup. Calling res.end() here races
      // with the browser draining the last SSE message, causing spurious onerror.
      sendEvent({ success: true, prCount: lineCount, complete: true });
    });

  } catch (error) {
    console.error('ghreport command failed:', error.message);
    sendEvent({ error: true, message: error.message });
    res.end();
  }
});

// Legacy POST endpoint for compatibility
app.post('/api/refresh-ghreport', async (req, res) => {
  try {
    console.log('Running ghreport command...');
    const { stdout, stderr } = await execAsync('ghreport');
    
    if (stderr) {
      console.log('ghreport stderr:', stderr);
    }
    
    // Optionally write to file if GHREPORT_OUTPUT is set
    const outputPath = process.env.GHREPORT_OUTPUT;
    if (outputPath) {
      try {
        await fs.writeFile(outputPath, stdout, 'utf-8');
        console.log(`Updated ghreport output file: ${outputPath}`);
      } catch (writeError) {
        console.error(`Failed to write to ${outputPath}:`, writeError.message);
      }
    }
    
    const lineCount = stdout.split('\n').filter(line => line.trim()).length;
    console.log(`ghreport completed. Found ${lineCount} PRs`);
    
    res.json({ 
      success: true, 
      message: `Refreshed PR data. Found ${lineCount} PRs.`,
      prCount: lineCount
    });
  } catch (error) {
    console.error('ghreport command failed:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      message: 'Failed to run ghreport. Make sure it is installed and in PATH.'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PR Dashboard running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  loadCacheFromDisk();
});
