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
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

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

// Read subscribedRepos from ghreport config.yaml, falling back to the env var.
// The container binary reads subscribedRepos from env; the config file is the
// canonical list (mounted from host), so prefer it when present.
async function getGhreportEnv() {
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
        if (/^\S/.test(line)) break; // next top-level key
      }
    }
    if (repos.length > 0) {
      console.log(`ghreport: using ${repos.length} repos from ${configPath}`);
      return { ...process.env, subscribedRepos: repos.join(' ') };
    }
  } catch (_) { /* config not present, fall through */ }
  return process.env;
}

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
    
    if (currentUser) {
      // Check reviews in parallel for better performance, but handle errors gracefully
      const reviewPromises = prs.map(async (pr) => {
        try {
          const [owner, repo] = pr.repo.split('/');
          const reviewStatus = await checkUserReview(owner, repo, pr.number, currentUser);
          if (reviewStatus.updatedAt) pr.updatedAt = reviewStatus.updatedAt;
          if (reviewStatus.prMeta) {
            if (reviewStatus.prMeta.title) pr.title = reviewStatus.prMeta.title;
            if (reviewStatus.prMeta.author) pr.author = reviewStatus.prMeta.author;
            if (reviewStatus.prMeta.state) pr.state = reviewStatus.prMeta.state;
          if (reviewStatus.prMeta.isDraft !== undefined) pr.isDraft = reviewStatus.prMeta.isDraft;
          }
          return { ...pr, reviewStatus };
        } catch (error) {
          console.error(`Failed to check review for PR ${pr.repo}#${pr.number}:`, error.message);
          return { ...pr, reviewStatus: { hasReviewed: false, updatedAt: null } };
        }
      });
      
      prs = await Promise.all(reviewPromises);
    }
    
    res.json({ success: true, prs, currentUser });
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
});
