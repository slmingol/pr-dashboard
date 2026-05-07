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

// Parse ghreport output
async function loadPRsFromGhReport() {
  try {
    const ghreportPath = process.env.GHREPORT_OUTPUT || '/data/ghreport.txt';
    const content = await fs.readFile(ghreportPath, 'utf-8');
    
    // Parse ghreport format: https://github.com/owner/repo/pull/123 author: username Age: X days reviewDecision: ... mergeable: ...
    const lines = content.split('\n').filter(line => line.trim());
    const prs = lines.map((line) => {
      const match = line.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\s+author:\s+(\S+)\s+Age:\s+([^r]+)\s*reviewDecision:\s*([^\s]*)\s*mergeable:\s*(.+)?/);
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
    
    // Parse ghreport format: https://github.com/owner/repo/pull/123 author: username Age: X days reviewDecision: ... mergeable: ...
    const lines = stdout.split('\n').filter(line => line.trim());
    const prs = lines.map((line) => {
      const match = line.match(/https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)\s+author:\s+(\S+)\s+Age:\s+([^r]+)\s*reviewDecision:\s*([^\s]*)\s*mergeable:\s*(.+)?/);
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

// API Endpoints
app.get('/api/prs', async (req, res) => {
  try {
    // Try ghreport file first, then try running ghreport command
    let prs = await loadPRsFromGhReport();
    
    if (prs.length === 0) {
      prs = await runGhReportCommand();
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
