let allPRs = [];
let filteredPRs = [];
let hiddenPRs = {};
let renderLimit = 25;

function parseAgeDays(ageStr) {
  if (!ageStr) return 0;
  const daysMatch = ageStr.match(/(\d+)\s*days?/i);
  if (daysMatch) return parseInt(daysMatch[1], 10);
  const hoursMatch = ageStr.match(/(\d+)\s*hours?/i);
  if (hoursMatch) return 0;
  return 0;
}

function daysAgoFromIso(isoStr) {
  if (!isoStr) return 0;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
}

function formatUpdatedDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const days = daysAgoFromIso(isoStr);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
let previousPRIds = new Set();
let reviewStateHistory = {}; // Track review state changes for debugging

// Load hidden PRs from localStorage
function loadHiddenPRs() {
  const stored = localStorage.getItem('hiddenPRs');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      // Handle legacy format (array of strings) and convert to new format
      if (Array.isArray(parsed)) {
        hiddenPRs = {};
        parsed.forEach(prId => {
          hiddenPRs[prId] = { hiddenAt: new Date().toISOString(), updatedAt: null };
        });
        saveHiddenPRs(); // Save in new format
      } else {
        hiddenPRs = parsed;
      }
    } catch (e) {
      console.error('Error loading hidden PRs:', e);
      hiddenPRs = {};
    }
  }
  updateHiddenCount();
}

// Save hidden PRs to localStorage
function saveHiddenPRs() {
  localStorage.setItem('hiddenPRs', JSON.stringify(hiddenPRs));
  updateHiddenCount();
}

// Toggle PR hidden state
function toggleHidePR(prId, owner, repo, number) {
  if (hiddenPRs[prId]) {
    delete hiddenPRs[prId];
    showToast(`Unhidden PR #${number}`, 'info', '', 2000);
  } else {
    hiddenPRs[prId] = {
      hiddenAt: new Date().toISOString()
    };
    showToast(`Hidden PR #${number}`, 'success', '', 2000);
  }
  saveHiddenPRs();
  filterAndRenderPRs();
}

// Update hidden count badge
function updateHiddenCount() {
  const count = document.getElementById('hidden-count');
  if (count) {
    count.textContent = Object.keys(hiddenPRs).length;
  }
}

// Update statistics
function updateStats() {
  const total = allPRs.length;
  const hidden = Object.keys(hiddenPRs).length;
  const displayed = filteredPRs.length; // Actually visible on screen
  // Count PRs that match filters but might be hidden
  const matchingFilters = allPRs.filter(pr => {
    const searchTerm = document.getElementById('search').value.toLowerCase();
    const stateFilter = document.getElementById('state-filter').value;
    const matchesSearch = pr.title?.toLowerCase().includes(searchTerm) || 
                         pr.repo?.toLowerCase().includes(searchTerm) ||
                         pr.number?.toString().includes(searchTerm);
    const matchesState = stateFilter === 'all' || pr.state === stateFilter;
    return matchesSearch && matchesState;
  }).length;
  
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-visible').textContent = displayed;
  document.getElementById('stat-hidden').textContent = hidden;
  document.getElementById('stat-filtered').textContent = matchingFilters;
}

// Toast notification system
function showToast(message, type = 'info', title = '', duration = 5000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ'
  };
  
  const titles = {
    success: title || 'Success',
    error: title || 'Error',
    warning: title || 'Warning',
    info: title || 'Info'
  };
  
  toast.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
  
  container.appendChild(toast);
  
  if (duration > 0) {
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// Fetch PRs from API
async function fetchPRs() {
  showLoading(true);
  hideError();
  
  try {
    const response = await fetch('/api/prs');
    const data = await response.json();
    
    if (data.success) {
      allPRs = data.prs;
      
      // Track review state changes for debugging
      allPRs.forEach(pr => {
        const prId = `${pr.repo}#${pr.number}`;
        const currentReviewState = pr.reviewStatus?.state || 'NONE';
        const hasReviewed = pr.reviewStatus?.hasReviewed || false;
        const allDismissed = pr.reviewStatus?.allDismissed || false;
        
        if (reviewStateHistory[prId]) {
          const prevState = reviewStateHistory[prId];
          if (prevState.state !== currentReviewState || prevState.hasReviewed !== hasReviewed) {
            console.warn(`⚠️ Review state changed for ${prId}:`);
            console.warn(`  Previous: hasReviewed=${prevState.hasReviewed}, state=${prevState.state}`);
            console.warn(`  Current:  hasReviewed=${hasReviewed}, state=${currentReviewState}, allDismissed=${allDismissed}`);
            console.warn(`  PR updatedAt: ${pr.updatedAt}`);
          }
        }
        
        reviewStateHistory[prId] = {
          state: currentReviewState,
          hasReviewed: hasReviewed,
          allDismissed: allDismissed,
          updatedAt: pr.updatedAt,
          lastChecked: new Date().toISOString()
        };
      });
      
      // Detect new PRs since last refresh
      const currentPRIds = new Set(allPRs.map(pr => `${pr.repo}#${pr.number}`));
      
      // Mark new PRs (PRs that weren't in the previous set)
      let newPRCount = 0;
      allPRs.forEach(pr => {
        const prId = `${pr.repo}#${pr.number}`;
        if (previousPRIds.size > 0 && !previousPRIds.has(prId)) {
          pr.isNew = true;
          newPRCount++;
        } else if (!pr.isNew) { // Don't overwrite if already marked as new from unhiding
          pr.isNew = false;
        }
      });
      
      // Update previousPRIds for next comparison
      previousPRIds = currentPRIds;
      
      // Clean up hiddenPRs - remove any PRs that no longer exist
      const cleanedHiddenPRs = {};
      for (const prId of Object.keys(hiddenPRs)) {
        if (currentPRIds.has(prId)) {
          cleanedHiddenPRs[prId] = hiddenPRs[prId];
        }
      }
      
      // Update hiddenPRs if we removed stale entries
      if (Object.keys(cleanedHiddenPRs).length !== Object.keys(hiddenPRs).length) {
        hiddenPRs = cleanedHiddenPRs;
        localStorage.setItem('hiddenPRs', JSON.stringify(hiddenPRs));
      }
      
      updateStats();
      filterAndRenderPRs();
      if (data.prs.length > 0) {
        const message = newPRCount > 0 
          ? `Loaded ${data.prs.length} pull requests (${newPRCount} new)` 
          : `Loaded ${data.prs.length} pull requests`;
        showToast(message, 'success', '', 3000);
      }
    } else {
      showToast(data.error || 'Failed to fetch PRs', 'error');
      showError(data.error || 'Failed to fetch PRs');
    }
  } catch (error) {
    showToast('Network error: ' + error.message, 'error');
    showError('Network error: ' + error.message);
  } finally {
    showLoading(false);
  }
}

// Filter PRs based on search and state
function filterAndRenderPRs() {
  const searchTerm = document.getElementById('search').value.toLowerCase();
  const stateFilter = document.getElementById('state-filter').value;
  const showHidden = document.getElementById('show-hidden').checked;
  
  renderLimit = 25;
  filteredPRs = allPRs.filter(pr => {
    const matchesSearch = pr.title?.toLowerCase().includes(searchTerm) || 
                         pr.repo?.toLowerCase().includes(searchTerm) ||
                         pr.number?.toString().includes(searchTerm);
    
    const matchesState = stateFilter === 'all' || pr.state === stateFilter;
    
    const prId = `${pr.repo}#${pr.number}`;
    const isHidden = hiddenPRs.hasOwnProperty(prId);
    const matchesHidden = showHidden || !isHidden;
    
    return matchesSearch && matchesState && matchesHidden;
  });
  
  renderPRs(filteredPRs, showHidden);
  updateStats();
}

// Render PR list
function renderPRs(prs, showHidden = false) {
  const prList = document.getElementById('pr-list');
  
  if (prs.length === 0) {
    prList.innerHTML = '<div class="loading">No pull requests found</div>';
    return;
  }
  
  // Group PRs by repository
  const grouped = {};
  prs.forEach(pr => {
    const repo = pr.repo || pr.repository?.nameWithOwner || 'Unknown';
    if (!grouped[repo]) {
      grouped[repo] = [];
    }
    grouped[repo].push(pr);
  });
  
  // Sort repositories alphabetically and sort PRs within each repo by number (descending)
  const sortedRepos = Object.keys(grouped).sort();
  sortedRepos.forEach(repo => {
    grouped[repo].sort((a, b) => b.number - a.number);
  });
  
  // Render grouped PRs up to renderLimit
  let html = '';
  let renderedCount = 0;
  for (const repo of sortedRepos) {
    if (renderedCount >= renderLimit) break;
    const repoPRs = grouped[repo];
    const prsToRender = repoPRs.slice(0, renderLimit - renderedCount);
    const countLabel = prsToRender.length < repoPRs.length
      ? `${prsToRender.length}/${repoPRs.length} PRs`
      : `${repoPRs.length} PR${repoPRs.length !== 1 ? 's' : ''}`;
    html += `
      <div class="repo-group">
        <div class="repo-header">
          <h2 class="repo-name">📦 ${repo}</h2>
          <span class="repo-count">${countLabel}</span>
        </div>
        <div class="repo-prs">
    `;
    
    prsToRender.forEach(pr => {
      renderedCount++;
      const [owner, repoName] = (pr.repository?.nameWithOwner || pr.repo || '').split('/');
      const number = pr.number;
      const state = pr.state || 'OPEN';
      const prId = `${pr.repo}#${number}`;
      const isHidden = hiddenPRs.hasOwnProperty(prId);
      
      // Format metadata if available
      const metadata = pr.metadata || {};
      const age = metadata.age || '';
      const reviewDecision = metadata.reviewDecision || '';
      const mergeable = metadata.mergeable || '';
      
      // Format review status
      const reviewStatus = pr.reviewStatus || {};
      let reviewBadge = '';
      if (reviewStatus.hasReviewed) {
        const staleIndicator = reviewStatus.stale ? ' (cached)' : '';
        if (reviewStatus.state === 'APPROVED') {
          reviewBadge = `<span class="state-badge state-success" title="You approved this PR${staleIndicator}">✓ Reviewed${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        } else if (reviewStatus.state === 'CHANGES_REQUESTED') {
          reviewBadge = `<span class="state-badge state-warning" title="You requested changes${staleIndicator}">⚠️ Changes Requested${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        } else if (reviewStatus.state === 'COMMENTED') {
          reviewBadge = `<span class="state-badge state-info" title="You commented${staleIndicator}">💬 Commented${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        }
      } else if (reviewStatus.allDismissed) {
        // Show when all reviews were dismissed (usually due to new commits)
        reviewBadge = '<span class="state-badge state-muted" title="Your previous review was dismissed due to new changes">🔄 Review Dismissed</span>';
      } else if (reviewStatus.error && !reviewStatus.stale) {
        // Show when we couldn't fetch review status and have no cache
        reviewBadge = '<span class="state-badge state-muted" title="Could not fetch review status - may need to refresh">❓ Review Status Unknown</span>';
      }
      
      // Check if title is just generic "PR #X" format
      const genericTitle = `PR #${number}`;
      const hasRealTitle = pr.title && pr.title !== genericTitle && pr.title !== 'Untitled PR';

      const ageDays = parseAgeDays(age) || daysAgoFromIso(pr.updatedAt);
      const isStale = !isHidden && ageDays >= 365;
      const updatedLabel = age ? age : formatUpdatedDate(pr.updatedAt);

      html += `
        <div class="pr-card ${isHidden && showHidden ? 'pr-hidden-dimmed' : ''} ${pr.isNew ? 'pr-new' : ''} ${isStale ? 'pr-stale' : ''}" data-owner="${owner}" data-repo="${repoName}" data-number="${number}">
          <div class="pr-main">
            <div class="pr-info">
              <a href="${pr.url}" target="_blank" class="pr-number" title="Open PR in GitHub">#${number}</a>
              ${hasRealTitle ? `<span class="pr-title">${pr.title}</span>` : ''}
              <span class="pr-meta-inline">
                ${pr.author?.login ? `👤 ${pr.author.login}` : ''}
                ${updatedLabel ? `• 📅 ${updatedLabel}` : ''}
                ${reviewDecision ? `• ${reviewDecision}` : ''}
                ${mergeable ? `• ${mergeable}` : pr.metadata ? '• ❓' : ''}
              </span>
              <span class="state-badge state-${state.toLowerCase()}">${state.replace('_', ' ')}</span>
              ${reviewBadge}
              ${pr.isNew ? '<span class="state-badge state-info" title="New since last refresh">✨ NEW</span>' : ''}
              ${isStale ? `<span class="state-badge state-stale" title="${ageDays} days old">STALE</span>` : ''}
              ${isHidden ? '<span class="state-badge state-muted">HIDDEN</span>' : ''}
            </div>
            <div class="pr-actions">
              <button class="btn btn-small ${isHidden ? 'btn-success' : 'btn-muted'}" onclick="toggleHidePR('${prId}', '${owner}', '${repoName}', '${number}')" title="${isHidden ? 'Unhide this PR from the list' : 'Hide this PR from the list'}">
                ${isHidden ? '👁' : '🙈'}
              </button>
              <button class="btn btn-small btn-primary" onclick="viewDetails('${owner}', '${repoName}', '${number}')" title="View PR description and details">Details</button>
              <button class="btn btn-small btn-info" onclick="viewDiff('${owner}', '${repoName}', '${number}')" title="View code changes and review">Diff</button>
              <button class="btn btn-small btn-success" onclick="checkoutPR('${owner}', '${repoName}', '${number}')" title="Checkout this PR branch locally">Checkout</button>
              <button class="btn btn-small btn-warning" onclick="addComment('${owner}', '${repoName}', '${number}')" title="Add a comment to this PR">Comment</button>
              <button class="btn btn-small btn-success" onclick="reviewPR('${owner}', '${repoName}', '${number}', 'approve')" title="Approve this PR">✓</button>
              <button class="btn btn-small btn-danger" onclick="reviewPR('${owner}', '${repoName}', '${number}', 'request-changes')" title="Request changes on this PR">✗</button>
              <a href="${pr.url}" target="_blank" class="btn btn-small btn-muted" title="Open PR in GitHub">Open →</a>
            </div>
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  }

  const remaining = prs.length - renderedCount;
  if (remaining > 0) {
    const nextBatch = Math.min(25, remaining);
    html += `<div class="show-more-container">
      <button class="btn btn-muted" onclick="showMorePRs()">Show ${nextBatch} more (${remaining} remaining)</button>
    </div>`;
  }

  prList.innerHTML = html;
}

function showMorePRs() {
  renderLimit += 25;
  renderPRs(filteredPRs, document.getElementById('show-hidden').checked);
}

// View PR details
async function viewDetails(owner, repo, number) {
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}`);
    const data = await response.json();
    
    if (data.success) {
      const pr = data.pr;
      showModal(`
        <h2>${pr.title}</h2>
        <p><strong>State:</strong> ${pr.state}</p>
        <p><strong>Author:</strong> ${pr.author?.login || 'Unknown'}</p>
        <p><strong>URL:</strong> <a href="${pr.url}" target="_blank">${pr.url}</a></p>
        <h3>Description:</h3>
        <div style="background: var(--bg); padding: 1rem; border-radius: 0.375rem; white-space: pre-wrap;">
          ${pr.body || 'No description provided'}
        </div>
      `);
    } else {
      const errorMsg = data.error || 'Unknown error';
      if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
        showToast(`PR #${number} not found. It may have been deleted or the number is incorrect.`, 'error', 'PR Not Found');
      } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
        showToast('Access denied. You may not have permission to view this PR.', 'error', 'Access Denied');
      } else {
        showToast('Failed to fetch PR details: ' + errorMsg, 'error');
      }
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

function buildSideBySideDiff(diffText) {
  const lines = diffText.split('\n');
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') ||
        line.startsWith('new mode') || line.startsWith('Binary') || line.startsWith('similarity') || line.startsWith('rename')) {
      rows.push({ type: 'header', content: line });
      i++;
    } else if (line.startsWith('@@')) {
      rows.push({ type: 'hunk', content: line });
      i++;
    } else if (line.startsWith('-') || line.startsWith('+')) {
      const removed = [];
      const added = [];
      while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
        if (lines[i].startsWith('-')) removed.push(lines[i].slice(1));
        else added.push(lines[i].slice(1));
        i++;
      }
      const maxLen = Math.max(removed.length, added.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({ type: 'change', left: j < removed.length ? removed[j] : null, right: j < added.length ? added[j] : null });
      }
    } else if (line.startsWith(' ')) {
      rows.push({ type: 'context', content: line.slice(1) });
      i++;
    } else {
      i++;
    }
  }
  return rows;
}

function renderSideBySideHtml(rows) {
  return '<table class="diff-table">' + rows.map(row => {
    if (row.type === 'header') return `<tr class="diff-file-header"><td colspan="2">${escapeHtml(row.content)}</td></tr>`;
    if (row.type === 'hunk') return `<tr class="diff-hunk-header"><td colspan="2">${escapeHtml(row.content)}</td></tr>`;
    if (row.type === 'context') {
      const c = escapeHtml(row.content);
      return `<tr><td class="diff-split-context">${c}</td><td class="diff-split-context">${c}</td></tr>`;
    }
    if (row.type === 'change') {
      const leftClass = row.left !== null ? 'diff-split-remove' : 'diff-split-empty';
      const rightClass = row.right !== null ? 'diff-split-add' : 'diff-split-empty';
      return `<tr><td class="${leftClass}">${row.left !== null ? escapeHtml(row.left) : ''}</td><td class="${rightClass}">${row.right !== null ? escapeHtml(row.right) : ''}</td></tr>`;
    }
    return '';
  }).join('') + '</table>';
}

function switchDiffView(view) {
  const unifiedView = document.getElementById('diff-unified-view');
  const splitView = document.getElementById('diff-split-view');
  const unifiedBtn = document.getElementById('diff-view-unified');
  const splitBtn = document.getElementById('diff-view-split');
  if (view === 'unified') {
    unifiedView.style.display = '';
    splitView.style.display = 'none';
    unifiedBtn.className = 'btn btn-small btn-primary';
    splitBtn.className = 'btn btn-small btn-muted';
  } else {
    unifiedView.style.display = 'none';
    splitView.style.display = '';
    unifiedBtn.className = 'btn btn-small btn-muted';
    splitBtn.className = 'btn btn-small btn-primary';
  }
}

// View diff
async function viewDiff(owner, repo, number) {
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/diff`);
    const data = await response.json();

    if (data.success) {
      const diffHtml = data.diff.split('\n').map(line => {
        let className = 'diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) className += ' diff-add';
        if (line.startsWith('-') && !line.startsWith('---')) className += ' diff-remove';
        return `<div class="${className}">${escapeHtml(line)}</div>`;
      }).join('');

      const splitHtml = renderSideBySideHtml(buildSideBySideDiff(data.diff));

      const buttonsHtml = `<div class="diff-actions">
        <button class="btn btn-success" onclick="approvePRFromDiff('${owner}', '${repo}', '${number}')" title="Approve this PR immediately without a comment">&#10003; Approve</button>
        <button class="btn btn-success" onclick="approvePRFromDiffWithComment('${owner}', '${repo}', '${number}')" title="Approve this PR and add an optional comment">&#10003; Approve + Comment</button>
        <button class="btn btn-danger" onclick="requestChangesFromDiff('${owner}', '${repo}', '${number}')" title="Request changes on this PR (comment required)">&#10007; Request Changes</button>
      </div>`;

      showModal(`
        <h2>Diff for ${owner}/${repo} #${number}</h2>
        ${buttonsHtml}
        <div class="diff-view-toggle">
          <button id="diff-view-unified" class="btn btn-small btn-primary" onclick="switchDiffView('unified')">Unified</button>
          <button id="diff-view-split" class="btn btn-small btn-muted" onclick="switchDiffView('split')">Split</button>
        </div>
        <div id="diff-unified-view" class="diff-container">${diffHtml}</div>
        <div id="diff-split-view" class="diff-container" style="display:none">${splitHtml}</div>
        ${buttonsHtml}
      `);
    } else {
      const errorMsg = data.error || 'Unknown error';
      if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
        showToast(`PR #${number} not found. It may have been deleted or the number is incorrect.`, 'error', 'PR Not Found');
      } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
        showToast('Access denied. You may not have permission to view this PR.', 'error', 'Access Denied');
      } else {
        showToast('Failed to fetch diff: ' + errorMsg, 'error');
      }
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// Checkout PR
async function checkoutPR(owner, repo, number) {
  if (!confirm(`Checkout PR #${number} from ${owner}/${repo}?`)) return;
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/checkout`, {
      method: 'POST'
    });
    const data = await response.json();
    const errorMsg = data.error || 'Unknown error';
      if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
        showToast(`PR #${number} not found. It may have been deleted or merged.`, 'error', 'PR Not Found');
      } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
        showToast('Access denied. Check your GitHub authentication.', 'error', 'Access Denied');
      } else {
        showToast('Failed to checkout PR: ' + errorMsg, 'error');
      }
    if (data.success) {
      showToast('PR checked out successfully', 'success');
      if (data.output) {
        console.log('Checkout output:', data.output);
      }
    } else {
      showToast('Failed to checkout PR: ' + data.error, 'error');
    }
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
}

// Add comment
async function addComment(owner, repo, number) {
  const comment = await showCommentModal(
    `Add comment to ${owner}/${repo} #${number}`,
    'Add your comment here...',
    true
  );
  
  if (!comment) {
    hideCommentModal();
    return;
  }
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment })
    });
    const data = await response.json();
    
    if (data.success) {
      hideCommentModal();
      showToast('Comment added successfully', 'success');
    } else {
      hideCommentModal();
      showToast('Failed to add comment: ' + data.error, 'error');
    }
  } catch (error) {
    hideCommentModal();
    showToast('Error: ' + error.message, 'error');
  }
}

// Review PR
async function reviewPR(owner, repo, number, action) {
  const actionText = action === 'approve' ? 'Approve' : 'Request Changes';
  const required = action === 'request-changes';
  
  const comment = await showCommentModal(
    `${actionText} ${owner}/${repo} #${number}`,
    required ? 'Comment (required for requesting changes)' : 'Optional comment',
    required
  );
  
  if (comment === null) {
    hideCommentModal();
    return; // User cancelled
  }
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, body: comment || undefined })
    });
    const data = await response.json();
    
    if (data.success) {
      hideCommentModal();
      showToast('Review submitted successfully', 'success');
      // Wait a moment for GitHub API to update, then refresh
      setTimeout(() => fetchPRs(), 1000);
    } else {
      hideCommentModal();
      showToast('Failed to submit review: ' + data.error, 'error');
    }
  } catch (error) {
    hideCommentModal();
    showToast('Error: ' + error.message, 'error');
  }
}

// Approve PR from diff view
async function approvePRFromDiff(owner, repo, number) {
  console.log(`Starting approval for ${owner}/${repo}#${number}`);
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' })
    });
    const data = await response.json();
    
    console.log('Review response:', data);
    
    if (data.success) {
      console.log('Closing modal');
      hideModal(); // Close diff modal
      // Small delay to ensure modal is fully closed before showing toast
      setTimeout(() => {
        showToast(`✓ Approved PR #${number}`, 'success', 'Review Submitted');
        // Wait for GitHub API to update, then refresh
        setTimeout(() => fetchPRs(), 1000);
      }, 50);
    } else {
      console.error('Review failed:', data.error);
      showToast('Failed to approve: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Review error:', error);
    showToast('Error: ' + error.message, 'error');
  }
}

// Approve PR from diff view with comment
async function approvePRFromDiffWithComment(owner, repo, number) {
  console.log(`Starting approval with comment for ${owner}/${repo}#${number}`);
  
  const comment = await showCommentModal(
    `Approve ${owner}/${repo} #${number}`,
    'Optional comment',
    false
  );
  
  if (comment === null) {
    console.log('User cancelled approval');
    hideCommentModal();
    return; // User cancelled
  }
  
  console.log(`Comment provided: "${comment}"`);
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', body: comment || undefined })
    });
    const data = await response.json();
    
    console.log('Review response:', data);
    
    if (data.success) {
      console.log('Closing modals');
      hideCommentModal(); // Close comment modal
      hideModal(); // Close diff modal
      // Small delay to ensure modals are fully closed before showing toast
      setTimeout(() => {
        showToast(`✓ Approved PR #${number}`, 'success', 'Review Submitted');
        // Wait for GitHub API to update, then refresh
        setTimeout(() => fetchPRs(), 1000);
      }, 50);
    } else {
      console.error('Review failed:', data.error);
      hideCommentModal();
      showToast('Failed to approve: ' + data.error, 'error');
    }
  } catch (error) {
    console.error('Review error:', error);
    hideCommentModal();
    showToast('Error: ' + error.message, 'error');
  }
}

// Request changes from diff view
async function requestChangesFromDiff(owner, repo, number) {
  const comment = await showCommentModal(
    `Request changes for ${owner}/${repo} #${number}`,
    'Comment (required)',
    true
  );
  
  if (!comment) {
    hideCommentModal();
    return;
  }
  
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request-changes', body: comment })
    });
    const data = await response.json();
    
    if (data.success) {
      // Close modals first, then show feedback
      hideCommentModal(); // Close comment modal
      hideModal(); // Close diff modal
      // Small delay to ensure modals are fully closed before showing toast
      setTimeout(() => {
        showToast(`✗ Requested changes on PR #${number}`, 'success', 'Review Submitted');
        // Wait for GitHub API to update, then refresh
        setTimeout(() => fetchPRs(), 1000);
      }, 50);
    } else {
      hideCommentModal();
      showToast('Failed to request changes: ' + data.error, 'error');
    }
  } catch (error) {
    hideCommentModal();
    showToast('Error: ' + error.message, 'error');
  }
}

// Modal functions
function showModal(content) {
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = content;
  modal.classList.remove('hidden');
}

function hideModal() {
  document.getElementById('modal').classList.add('hidden');
}

// Comment modal functions
let commentModalCallback = null;

function showCommentModal(title, placeholder = 'Add your comment here...', required = false) {
  return new Promise((resolve, reject) => {
    const modal = document.getElementById('comment-modal');
    const modalTitle = document.getElementById('comment-modal-title');
    const input = document.getElementById('comment-input');
    const submitBtn = document.getElementById('comment-submit');
    
    modalTitle.textContent = title;
    input.placeholder = placeholder;
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();
    
    commentModalCallback = { resolve, reject, required };
  });
}

function hideCommentModal() {
  const modal = document.getElementById('comment-modal');
  const input = document.getElementById('comment-input');
  
  modal.classList.add('hidden');
  input.value = ''; // Clear the textarea
  commentModalCallback = null;
}

function submitCommentModal() {
  const input = document.getElementById('comment-input');
  const comment = input.value.trim();
  
  if (commentModalCallback) {
    if (commentModalCallback.required && !comment) {
      showToast('Comment is required', 'warning');
      return;
    }
    
    // Resolve with the comment string (empty string "" is valid for optional comments)
    // Only null indicates cancellation
    commentModalCallback.resolve(comment);
    // Don't hide modal here - let calling function handle it after API success
    commentModalCallback = null;
  }
}

function cancelCommentModal() {
  if (commentModalCallback) {
    commentModalCallback.resolve(null);
    hideCommentModal();
  }
}

// Utility functions
function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

function showError(message) {
  const errorEl = document.getElementById('error');
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error').classList.add('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Refresh ghreport data
async function refreshGhReport() {
  const btn = document.getElementById('refresh-ghreport-btn');
  const progressContainer = document.getElementById('refresh-progress');
  const progressFill = document.querySelector('.progress-fill');
  const progressText = document.querySelector('.progress-text');
  const originalText = btn.textContent;
  
  try {
    btn.disabled = true;
    btn.textContent = '⏳ Running...';
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Starting...';
    
    // Use EventSource for Server-Sent Events
    const eventSource = new EventSource('/api/refresh-ghreport-stream');
    let refreshCompleted = false;

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        showToast(`Failed to refresh: ${data.message}`, 'error', 'Refresh Failed');
        eventSource.close();
        progressContainer.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      if (data.progress !== undefined) {
        progressFill.style.width = `${data.progress}%`;
        if (data.message) {
          progressText.textContent = data.message;
        }
      }

      if (data.complete) {
        refreshCompleted = true;
        eventSource.close();
        showToast(`✓ Refreshed PR data. Found ${data.prCount} PRs.`, 'success', 'Data Refreshed');
        // Automatically reload the PR list after successful refresh
        setTimeout(() => {
          fetchPRs();
          progressContainer.classList.add('hidden');
          btn.disabled = false;
          btn.textContent = originalText;
        }, 500);
      }
    };

    eventSource.onerror = (error) => {
      if (refreshCompleted) return;
      console.error('EventSource error:', error);
      eventSource.close();
      showToast('Connection error during refresh', 'error', 'Network Error');
      progressContainer.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = originalText;
    };
    
  } catch (error) {
    showToast(`Error refreshing data: ${error.message}`, 'error', 'Network Error');
    progressContainer.classList.add('hidden');
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Theme toggle functionality
function toggleTheme() {
  const root = document.documentElement;
  const themeToggle = document.getElementById('theme-toggle');
  const isLight = root.classList.contains('light-mode');
  
  if (isLight) {
    root.classList.remove('light-mode');
    themeToggle.textContent = '🌙';
    localStorage.setItem('theme', 'dark');
  } else {
    root.classList.add('light-mode');
    themeToggle.textContent = '☀️';
    localStorage.setItem('theme', 'light');
  }
}

// Load saved theme
function loadTheme() {
  const savedTheme = localStorage.getItem('theme');
  const themeToggle = document.getElementById('theme-toggle');
  
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
    themeToggle.textContent = '☀️';
  } else {
    themeToggle.textContent = '🌙';
  }
}

// Event listeners
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('refresh-ghreport-btn').addEventListener('click', refreshGhReport);
document.getElementById('refresh-btn').addEventListener('click', fetchPRs);
document.getElementById('search').addEventListener('input', filterAndRenderPRs);
document.getElementById('state-filter').addEventListener('change', filterAndRenderPRs);
document.getElementById('show-hidden').addEventListener('change', filterAndRenderPRs);

document.querySelector('.close').addEventListener('click', hideModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') hideModal();
});

// Comment modal event listeners
document.querySelector('.close-comment').addEventListener('click', cancelCommentModal);
document.getElementById('comment-cancel').addEventListener('click', cancelCommentModal);
document.getElementById('comment-submit').addEventListener('click', submitCommentModal);
document.getElementById('comment-modal').addEventListener('click', (e) => {
  if (e.target.id === 'comment-modal') cancelCommentModal();
});
document.getElementById('comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    submitCommentModal();
  } else if (e.key === 'Escape') {
    cancelCommentModal();
  }
});

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('modal');
    const commentModal = document.getElementById('comment-modal');
    
    // Close modals in priority order (comment modal first if open)
    if (!commentModal.classList.contains('hidden')) {
      cancelCommentModal();
    } else if (!modal.classList.contains('hidden')) {
      hideModal();
    }
  }
});

async function loadVersion() {
  try {
    const res = await fetch('/api/version');
    const { version } = await res.json();
    document.getElementById('app-version').textContent = `v${version}`;
  } catch (_) {}
}

// Initial load
loadTheme();
loadHiddenPRs();
fetchPRs();
loadVersion();
