const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Parse ghreport output (customize based on your ghreport format)
async function loadPRsFromGhReport() {
  try {
    const ghreportPath = process.env.GHREPORT_OUTPUT || '/data/ghreport.txt';
    const content = await fs.readFile(ghreportPath, 'utf-8');
    
    // Parse ghreport output - adjust based on your actual format
    // This is a placeholder parser
    const lines = content.split('\n').filter(line => line.trim());
    const prs = lines.map((line, index) => {
      // Example format: "owner/repo#123 - PR Title"
      const match = line.match(/(.+?)#(\d+)\s*-\s*(.+)/);
      if (match) {
        return {
          id: `${match[1]}#${match[2]}`,
          repo: match[1],
          number: match[2],
          title: match[3],
          url: `https://github.com/${match[1]}/pull/${match[2]}`
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

// Fetch PRs using gh CLI directly (searches across all repos)
async function fetchPRsWithGh() {
  try {
    // Use gh pr status to get PRs across all repos (created by, assigned, review requested, or mentioned)
    const { stdout } = await execAsync('gh pr status --json createdBy,needsReview,reviewRequests');
    const status = JSON.parse(stdout);
    
    // Combine all PR categories
    const allPRs = [
      ...(status.createdBy || []),
      ...(status.needsReview || []),
      ...(status.reviewRequests || [])
    ];
    
    // Deduplicate by URL
    const seen = new Set();
    const uniquePRs = allPRs.filter(pr => {
      if (seen.has(pr.url)) return false;
      seen.add(pr.url);
      return true;
    });
    
    // Transform to match expected format
    return uniquePRs.map(pr => {
      // Extract repo from URL (format: https://github.com/owner/repo/pull/123)
      let repo = '';
      if (pr.url) {
        const match = pr.url.match(/github\.com\/([^\/]+\/[^\/]+)\/pull/);
        if (match) {
          repo = match[1];
        }
      }
      
      return {
        number: pr.number,
        title: pr.title || pr.headRefName || 'Untitled',
        url: pr.url,
        state: pr.state || pr.isDraft ? 'DRAFT' : 'OPEN',
        repo,
        repository: { nameWithOwner: repo },
        author: pr.author || { login: 'unknown' },
        updatedAt: pr.updatedAt || new Date().toISOString()
      };
    });
  } catch (error) {
    console.error('Error fetching with gh:', error.message);
    throw error;
  }
}

// API Endpoints
app.get('/api/prs', async (req, res) => {
  try {
    // Try ghreport first, fallback to gh CLI
    let prs = await loadPRsFromGhReport();
    
    if (prs.length === 0) {
      prs = await fetchPRsWithGh();
    }
    
    res.json({ success: true, prs });
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
    
    const { stdout } = await execAsync(cmd);
    res.json({ success: true, output: stdout });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PR Dashboard running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
