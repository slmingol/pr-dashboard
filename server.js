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
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.use(express.json());
app.use(express.static('public'));

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
        // Continuation line - append to current
        currentLine += line;
      } else {
        // New line - save previous and start new
        if (currentLine.trim()) {
          joinedLines.push(currentLine.trim());
        }
        currentLine = line;
      }
    }
    // Don't forget the last line
    if (currentLine.trim()) {
      joinedLines.push(currentLine.trim());
    }
    
    // Parse ghreport format: https://github.com/owner/repo/pull/123 author: username Age: X days reviewDecision: ... mergeable: ...
    const prs = joinedLines.map((line) => {
      const match = line.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\s+author:\s+(\S+)\s+Age:\s+(.+?)\s+reviewDecision:\s*([^\s]*)\s*mergeable:\s*(.*)/);
      if (match) {
        const [, owner, repo, number, author, age, reviewDecision, mergeable] = match;
        const repoFullName = `${owner}/${repo}`;
        
        // Map review decision emoji to state
        let state = 'OPEN';
        if (reviewDecision.includes('✅')) {
          state = 'APPROVED';
        } else if (reviewDecision.includes('🔍')) {
          state = 'REVIEW_REQUIRED';
        }
        
        return {
          id: `${repoFullName}#${number}`,
          repo: repoFullName,
          number: parseInt(number),
          title: `PR #${number}`, // ghreport doesn't include title, we'll fetch it if needed
          url: `https://github.com/${repoFullName}/pull/${number}`,
          state,
          author: { login: author },
          updatedAt: new Date().toISOString(),
          repository: { nameWithOwner: repoFullName },
          metadata: {
            age: age.trim(),
            reviewDecision: reviewDecision.trim(),
            mergeable: mergeable?.trim() || ''
          }
        };
      }
      return null;
    }).filter(Boolean);
    
    return prs;
  } catch (error) {
    console.error('Error reading ghreport:', error.message);
    return [];
  }
}

// Fallback: try to run ghreport command directly if file doesn't exist
async function runGhReportCommand() {
  try {
    const { stdout } = await execAsync('ghreport');
    
    // Handle line continuations (lines starting with space are continuations)
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
    
    // Parse ghreport format: https://github.com/owner/repo/pull/123 author: username Age: X days reviewDecision: ... mergeable: ...
    const prs = joinedLines.map((line) => {
      const match = line.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\s+author:\s+(\S+)\s+Age:\s+(.+?)\s+reviewDecision:\s*([^\s]*)\s*mergeable:\s*(.*)/);
      if (match) {
        const [, owner, repo, number, author, age, reviewDecision, mergeable] = match;
        const repoFullName = `${owner}/${repo}`;
        
        // Map review decision emoji to state
        let state = 'OPEN';
        if (reviewDecision.includes('✅')) {
          state = 'APPROVED';
        } else if (reviewDecision.includes('🔍')) {
          state = 'REVIEW_REQUIRED';
        }
        
        return {
          id: `${repoFullName}#${number}`,
          repo: repoFullName,
          number: parseInt(number),
          title: `PR #${number}`,
          url: `https://github.com/${repoFullName}/pull/${number}`,
          state,
          author: { login: author },
          updatedAt: new Date().toISOString(),
          repository: { nameWithOwner: repoFullName },
          metadata: {
            age: age.trim(),
            reviewDecision: reviewDecision.trim(),
            mergeable: mergeable?.trim() || ''
          }
        };
      }
      return null;
    }).filter(Boolean);
    return prs;
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

// Check if current user has reviewed a PR and get updatedAt (with caching and retry)
async function checkUserReview(owner, repo, number, username, retries = 2) {
  const cacheKey = `${owner}/${repo}#${number}`;
  
  // Check cache first
  const cached = reviewCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`PR ${cacheKey}: Using cached review status (age: ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
    return cached.status;
  }
  
  try {
    const { stdout } = await execAsync(
      `gh pr view ${number} --repo ${owner}/${repo} --json reviews,updatedAt`,
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
      
      if (userReviews.length > 0) {
        const latestReview = userReviews[0];
        console.log(`PR ${owner}/${repo}#${number}: Using review state: ${latestReview.state} from ${latestReview.submittedAt}`);
        result = {
          hasReviewed: true,
          state: latestReview.state, // APPROVED, CHANGES_REQUESTED, COMMENTED
          submittedAt: latestReview.submittedAt,
          updatedAt: data.updatedAt
        };
      } else if (allUserReviews.length > 0) {
        // All reviews were dismissed - treat as not reviewed
        console.log(`PR ${owner}/${repo}#${number}: All reviews by ${username} were dismissed`);
        result = { hasReviewed: false, updatedAt: data.updatedAt, allDismissed: true };
      } else {
        result = { hasReviewed: false, updatedAt: data.updatedAt };
      }
    } else {
      result = { hasReviewed: false, updatedAt: data.updatedAt };
    }
    
    // Cache successful result
    reviewCache.set(cacheKey, { status: result, timestamp: Date.now() });
    return result;
    
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
      return { ...cached.status, stale: true };
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
          // Update the PR's updatedAt with the actual value from GitHub
          if (reviewStatus.updatedAt) {
            pr.updatedAt = reviewStatus.updatedAt;
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
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendProgress = (percent, message) => {
    res.write(`data: ${JSON.stringify({ progress: percent, message })}\n\n`);
  };
  
  try {
    sendProgress(0, 'Starting ghreport...');
    
    // Start ghreport command
    const startTime = Date.now();
    sendProgress(10, 'Querying GitHub API...');
    
    // Use spawn to capture output as it comes
    const ghreport = spawn('ghreport');
    
    let stdout = '';
    let stderr = '';
    let progressPercent = 10;
    
    // Simulate progress based on time (since ghreport doesn't report actual progress)
    const progressInterval = setInterval(() => {
      if (progressPercent < 90) {
        progressPercent += Math.random() * 15;
        if (progressPercent > 90) progressPercent = 90;
        sendProgress(Math.floor(progressPercent), 'Fetching PRs from repositories...');
      }
    }, 1000);
    
    ghreport.stdout.on('data', (data) => {
      stdout += data.toString();
      // Count lines received so far for more accurate progress
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
        sendProgress(100, 'Error');
        res.write(`data: ${JSON.stringify({ 
          error: true, 
          message: `ghreport exited with code ${code}: ${stderr}` 
        })}\n\n`);
        res.end();
        return;
      }
      
      sendProgress(95, 'Processing results...');
      
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
      
      sendProgress(100, `Completed! Found ${lineCount} PRs.`);
      res.write(`data: ${JSON.stringify({ 
        success: true, 
        prCount: lineCount,
        complete: true
      })}\n\n`);
      res.end();
    });
    
  } catch (error) {
    console.error('ghreport command failed:', error.message);
    res.write(`data: ${JSON.stringify({ 
      error: true, 
      message: error.message 
    })}\n\n`);
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
