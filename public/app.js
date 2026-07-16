let allPRs = [];
let filteredPRs = [];
let hiddenPRs = {};
let watchOnlyRepos = {};
let renderLimit = 25;
let selectedPRId = null;
let subscribedRepos = [];
let lastRefreshWallMs = null;
let lastPerfData = null;

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

// Watch-only repos: visible but review actions disabled
function loadWatchOnlyRepos() {
  const stored = localStorage.getItem('watchOnlyRepos');
  if (stored) {
    try { watchOnlyRepos = JSON.parse(stored); } catch (e) { watchOnlyRepos = {}; }
  }
}

function saveWatchOnlyRepos() {
  localStorage.setItem('watchOnlyRepos', JSON.stringify(watchOnlyRepos));
}

function toggleWatchOnlyRepo(repo) {
  if (watchOnlyRepos[repo]) {
    delete watchOnlyRepos[repo];
    showToast(`${repo} removed from watch-only`, 'info', '', 2000);
  } else {
    watchOnlyRepos[repo] = { addedAt: new Date().toISOString() };
    showToast(`${repo} set to watch-only — review actions disabled`, 'info', '', 2500);
  }
  saveWatchOnlyRepos();
  filterAndRenderPRs();
}

// Filter preference persistence
function saveFilterPrefs() {
  localStorage.setItem('filterSearch', document.getElementById('search').value);
  localStorage.setItem('filterState', document.getElementById('state-filter').value);
  localStorage.setItem('filterShowHidden', document.getElementById('show-hidden').checked);
  localStorage.setItem('filterShowDrafts', document.getElementById('show-drafts').checked);
}

function loadFilterPrefs() {
  const search = localStorage.getItem('filterSearch');
  const state = localStorage.getItem('filterState');
  const showHidden = localStorage.getItem('filterShowHidden');
  const showDrafts = localStorage.getItem('filterShowDrafts');
  if (search !== null) document.getElementById('search').value = search;
  if (state !== null) document.getElementById('state-filter').value = state;
  if (showHidden !== null) document.getElementById('show-hidden').checked = showHidden === 'true';
  document.getElementById('show-drafts').checked = showDrafts === null ? false : showDrafts === 'true';
}

function resetFilters() {
  document.getElementById('search').value = '';
  document.getElementById('state-filter').value = 'all';
  document.getElementById('show-hidden').checked = false;
  document.getElementById('show-drafts').checked = false;
  ['filterSearch', 'filterState', 'filterShowHidden', 'filterShowDrafts'].forEach(k => localStorage.removeItem(k));
  filterAndRenderPRs();
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
  
  const draftCount = allPRs.filter(pr => pr.isDraft).length;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-visible').textContent = displayed;
  document.getElementById('stat-hidden').textContent = hidden;
  document.getElementById('stat-filtered').textContent = matchingFilters;
  document.getElementById('stat-drafts').textContent = draftCount;
  const draftCountEl = document.getElementById('draft-count');
  if (draftCountEl) draftCountEl.textContent = draftCount;
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

function renderPerfBar() {
  if (!lastPerfData) return;
  const p = lastPerfData;
  const fmt = ms => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const total = (p.cacheHits ?? 0) + (p.cacheMisses ?? 0);
  const allCached = p.cacheMisses === 0;
  const parts = [];
  if (lastRefreshWallMs != null) parts.push(`refresh: ${fmt(lastRefreshWallMs)}`);
  if (!allCached && p.ghFetchMs != null) {
    const avgStr = p.ghSamples > 1 ? ` · avg: ${fmt(p.ghAvgMs)}` : '';
    parts.push(`GH: ${fmt(p.ghFetchMs)}${avgStr}`);
  }
  if (total > 0) parts.push(allCached ? `${total} cached` : `${p.cacheHits}/${total} cached`);
  if (p.rateInfo && p.rateInfo.listMisses != null) {
    const total = (p.rateInfo.listHits ?? 0) + (p.rateInfo.listMisses ?? 0);
    const hits = p.rateInfo.listHits ?? 0;
    parts.push(hits === total ? `${total} repos cached` : `${hits}/${total} repos cached`);
  }
  if (p.rateInfo?.rest) {
    const rl = p.rateInfo.rest;
    parts.push(`REST: ${rl.remaining?.toLocaleString()}/${rl.limit?.toLocaleString()}`);
  }
  document.getElementById('perf-bar').textContent = parts.join('  ·  ');
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

      // Update GitHub API timing display
      if (data.perf) {
        lastPerfData = data.perf;
        renderPerfBar();
      }

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
      
      // Unhide hidden PRs where the user's review was dismissed by NEW commits pushed
      // after the PR was hidden (not if allDismissed was already true when it was hidden)
      let unhiddenCount = 0;
      for (const pr of allPRs) {
        const prId = `${pr.repo}#${pr.number}`;
        const hiddenEntry = hiddenPRs[prId];
        if (hiddenEntry && pr.reviewStatus?.allDismissed) {
          const hiddenAt = hiddenEntry.hiddenAt;
          const prUpdatedAt = pr.updatedAt;
          // Only resurface if the PR was updated after it was hidden
          if (hiddenAt && prUpdatedAt && new Date(prUpdatedAt) > new Date(hiddenAt)) {
            delete hiddenPRs[prId];
            pr.isNew = true;
            unhiddenCount++;
          }
        }
      }
      if (unhiddenCount > 0) {
        saveHiddenPRs();
        showToast(`${unhiddenCount} PR${unhiddenCount > 1 ? 's' : ''} resurfaced — your review was dismissed by new commits`, 'info', 'Re-review Needed', 6000);
      }

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
  const showDrafts = document.getElementById('show-drafts').checked;

  saveFilterPrefs();
  renderLimit = 100;
  filteredPRs = allPRs.filter(pr => {
    const matchesSearch = pr.title?.toLowerCase().includes(searchTerm) ||
                         pr.repo?.toLowerCase().includes(searchTerm) ||
                         pr.number?.toString().includes(searchTerm);
    const matchesState = stateFilter === 'all' || pr.state === stateFilter;
    const prId = `${pr.repo}#${pr.number}`;
    const isHidden = hiddenPRs.hasOwnProperty(prId);
    const matchesHidden = showHidden || !isHidden;
    const matchesDraft = showDrafts || !pr.isDraft;
    return matchesSearch && matchesState && matchesHidden && matchesDraft;
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
    const isWatchOnly = watchOnlyRepos.hasOwnProperty(repo);
    html += `
      <div class="repo-group">
        <div class="repo-header${isWatchOnly ? ' repo-watch-only' : ''}">
          <h2 class="repo-name">📦 ${repo}</h2>
          <span class="repo-count">${countLabel}</span>
          ${isWatchOnly ? '<span class="state-badge state-watch">WATCH</span>' : ''}
          <button class="btn btn-small ${isWatchOnly ? 'btn-info' : 'btn-muted'}" onclick="toggleWatchOnlyRepo('${repo}')" title="${isWatchOnly ? 'Remove watch-only — re-enable review actions' : 'Set as watch-only — disable review actions for this repo'}">
            ${isWatchOnly ? '👁 Watching' : '👁'}
          </button>
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
      const cacheAgeMin = reviewStatus.cachedAt ? Math.round((Date.now() - reviewStatus.cachedAt) / 60000) : null;
      const cacheInfo = cacheAgeMin !== null ? ` (fetched ${cacheAgeMin}m ago)` : '';
      let reviewBadge = '';
      if (reviewStatus.hasReviewed) {
        const staleIndicator = reviewStatus.stale ? ' stale' : '';
        if (reviewStatus.state === 'APPROVED') {
          reviewBadge = `<span class="state-badge state-success" title="You approved this PR${cacheInfo}${staleIndicator}">✓ Reviewed${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        } else if (reviewStatus.state === 'CHANGES_REQUESTED') {
          reviewBadge = `<span class="state-badge state-warning" title="You requested changes${cacheInfo}${staleIndicator}">⚠️ Changes Requested${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        } else if (reviewStatus.state === 'COMMENTED') {
          reviewBadge = `<span class="state-badge state-info" title="You commented${cacheInfo}${staleIndicator}">💬 Commented${reviewStatus.stale ? ' ⚠️' : ''}</span>`;
        }
      } else if (reviewStatus.allDismissed) {
        reviewBadge = '<span class="state-badge state-muted" title="Your previous review was dismissed due to new changes">🔄 Review Dismissed</span>';
      } else if (reviewStatus.error && !reviewStatus.stale) {
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
              ${pr.isDraft ? '<span class="state-badge state-draft" title="This is a draft PR">DRAFT</span>' : ''}
              ${pr.isNew ? '<span class="state-badge state-info" title="New since last refresh">✨ NEW</span>' : ''}
              ${isStale ? `<span class="state-badge state-stale" title="${ageDays} days old">STALE</span>` : ''}
              ${isHidden ? '<span class="state-badge state-muted">HIDDEN</span>' : ''}
            </div>
            <div class="pr-actions">
              <button class="btn btn-small ${isHidden ? 'btn-success' : 'btn-muted'}" onclick="toggleHidePR('${prId}', '${owner}', '${repoName}', '${number}')" title="${isHidden ? 'Unhide this PR from the list' : 'Hide this PR from the list'}">
                ${isHidden ? '👁' : '🙈'}
              </button>
              <button class="btn btn-small btn-primary" onclick="viewDetails('${owner}', '${repoName}', '${number}')" title="View PR description and details">Details</button>
              <button class="btn btn-small btn-info" onclick="viewDiff('${owner}', '${repoName}', '${number}')" title="View code changes">Diff</button>
              ${!isWatchOnly ? `
              <button class="btn btn-small btn-success" onclick="checkoutPR('${owner}', '${repoName}', '${number}')" title="Checkout this PR branch locally">Checkout</button>
              <button class="btn btn-small btn-warning" onclick="addComment('${owner}', '${repoName}', '${number}')" title="Add a comment to this PR">Comment</button>
              <button class="btn btn-small btn-success" onclick="reviewPR('${owner}', '${repoName}', '${number}', 'approve')" title="Approve this PR">✓</button>
              <button class="btn btn-small btn-danger" onclick="reviewPR('${owner}', '${repoName}', '${number}', 'request-changes')" title="Request changes on this PR">✗</button>
              ` : ''}
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
    const nextBatch = Math.min(50, remaining);
    html += `<div class="show-more-container">
      <button class="btn btn-muted" onclick="showMorePRs()">Show ${nextBatch} more (${remaining} remaining)</button>
    </div>`;
  }

  prList.innerHTML = html;
  reapplySelection();
}

function showMorePRs() {
  renderLimit += 50;
  renderPRs(filteredPRs, document.getElementById('show-hidden').checked);
}

// View PR details
async function viewDetails(owner, repo, number) {
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}`);
    const data = await response.json();
    
    if (data.success) {
      const pr = data.pr;
      showModalWithHeader(escapeHtml(pr.title), `
        <p style="margin:0 0 0.5rem"><strong>Author:</strong> ${escapeHtml(pr.author?.login || 'Unknown')}
          &nbsp;·&nbsp; <strong>State:</strong> ${pr.state}
          &nbsp;·&nbsp; <a href="${pr.url}" target="_blank" style="color:var(--primary)">${pr.url}</a></p>
        <hr style="border:none;border-top:1px solid var(--border);margin:0.75rem 0">
        <div style="background:var(--bg-deeper);padding:1rem;border-radius:var(--radius-sm);white-space:pre-wrap;font-size:0.875rem;line-height:1.6">
          ${escapeHtml(pr.body || 'No description provided')}
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

function parseDiffStats(diffText) {
  const lines = diffText.split('\n');
  let files = 0, additions = 0, deletions = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}

function parseFilenameFromDiff(diffLine) {
  // diffLine: "diff --git a/foo/bar.js b/foo/bar.js"
  const m = diffLine.match(/^diff --git a\/.+ b\/(.+)$/);
  return m ? m[1] : diffLine;
}

function renderUnifiedDiff(diffText) {
  const lines = diffText.split('\n');
  const parts = [];
  let leftLine = 1, rightLine = 1;
  let pendingFile = null, pendingFileType = null;

  function flushFile() {
    if (pendingFile === null) return;
    const typeClass = pendingFileType === 'new' ? ' diff-fh-new' : pendingFileType === 'del' ? ' diff-fh-del' : '';
    const badge = pendingFileType === 'new'
      ? '<span class="diff-file-badge diff-file-badge-added">added</span>'
      : pendingFileType === 'del'
        ? '<span class="diff-file-badge diff-file-badge-deleted">deleted</span>'
        : '';
    parts.push(`<div class="diff-file-sep${typeClass}"><span class="diff-filename">${escapeHtml(pendingFile)}</span>${badge}</div>`);
    pendingFile = null;
    pendingFileType = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flushFile();
      pendingFile = parseFilenameFromDiff(line);
      pendingFileType = null;
    } else if (line.startsWith('new file')) {
      pendingFileType = 'new';
    } else if (line.startsWith('deleted file')) {
      pendingFileType = 'del';
    } else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
               line.startsWith('similarity') || line.startsWith('rename') ||
               line.startsWith('old mode') || line.startsWith('new mode')) {
      // skip metadata
    } else if (line.startsWith('Binary')) {
      flushFile();
      parts.push('<div class="diff-binary">Binary file — not shown</div>');
    } else if (line.startsWith('@@')) {
      flushFile();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) {
        leftLine = parseInt(m[1], 10);
        rightLine = parseInt(m[2], 10);
        const range = escapeHtml(line.match(/^(@@ [^@]+ @@)/)[1]);
        const ctx = escapeHtml(m[3]);
        parts.push(`<div class="diff-hunk-bar"><span class="diff-hunk-range">${range}</span><span class="diff-hunk-ctx">${ctx}</span></div>`);
      } else {
        parts.push(`<div class="diff-hunk-bar"><span class="diff-hunk-range">${escapeHtml(line)}</span></div>`);
      }
    } else if (line === '\\ No newline at end of file') {
      parts.push('<div class="diff-no-newline">\\ No newline at end of file</div>');
    } else if (line.startsWith('+')) {
      flushFile();
      parts.push(`<div class="diff-line diff-add"><span class="diff-ln diff-ln-empty"></span><span class="diff-ln">${rightLine++}</span><span class="diff-sign">+</span><span class="diff-code">${escapeHtml(line.slice(1))}</span></div>`);
    } else if (line.startsWith('-')) {
      flushFile();
      parts.push(`<div class="diff-line diff-remove"><span class="diff-ln">${leftLine++}</span><span class="diff-ln diff-ln-empty"></span><span class="diff-sign">-</span><span class="diff-code">${escapeHtml(line.slice(1))}</span></div>`);
    } else if (line.startsWith(' ')) {
      flushFile();
      parts.push(`<div class="diff-line diff-ctx"><span class="diff-ln">${leftLine++}</span><span class="diff-ln">${rightLine++}</span><span class="diff-sign"> </span><span class="diff-code">${escapeHtml(line.slice(1))}</span></div>`);
    }
  }
  flushFile();
  return parts.length ? parts.join('') : '<div class="diff-empty">No changes</div>';
}

function buildSideBySideDiff(diffText) {
  const lines = diffText.split('\n');
  const rows = [];
  let i = 0;
  let leftLine = 1, rightLine = 1;
  let pendingFile = null, pendingFileType = null;

  function flushFile() {
    if (pendingFile === null) return;
    rows.push({ type: 'file', filename: pendingFile, fileType: pendingFileType });
    pendingFile = null;
    pendingFileType = null;
    leftLine = 1;
    rightLine = 1;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flushFile();
      pendingFile = parseFilenameFromDiff(line);
      pendingFileType = null;
      i++;
    } else if (line.startsWith('new file')) {
      pendingFileType = 'new';
      i++;
    } else if (line.startsWith('deleted file')) {
      pendingFileType = 'del';
      i++;
    } else if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
               line.startsWith('similarity') || line.startsWith('rename') ||
               line.startsWith('old mode') || line.startsWith('new mode')) {
      i++;
    } else if (line.startsWith('Binary')) {
      flushFile();
      rows.push({ type: 'binary' });
      i++;
    } else if (line.startsWith('@@')) {
      flushFile();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { leftLine = parseInt(m[1], 10); rightLine = parseInt(m[2], 10); }
      rows.push({ type: 'hunk', content: line });
      i++;
    } else if (line.startsWith('-') || line.startsWith('+')) {
      flushFile();
      const removed = [], added = [];
      while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
        if (lines[i].startsWith('-')) removed.push({ content: lines[i].slice(1), ln: leftLine++ });
        else added.push({ content: lines[i].slice(1), ln: rightLine++ });
        i++;
      }
      const maxLen = Math.max(removed.length, added.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          type: 'change',
          left: j < removed.length ? removed[j].content : null, leftLn: j < removed.length ? removed[j].ln : null,
          right: j < added.length ? added[j].content : null, rightLn: j < added.length ? added[j].ln : null,
        });
      }
    } else if (line.startsWith(' ')) {
      flushFile();
      rows.push({ type: 'context', content: line.slice(1), leftLn: leftLine++, rightLn: rightLine++ });
      i++;
    } else {
      i++;
    }
  }
  flushFile();
  return rows;
}

function renderSideBySideHtml(rows) {
  const ln = (n, cls) => `<td class="diff-split-ln${cls ? ' ' + cls : ''}">${n !== null ? n : ''}</td>`;
  return '<table class="diff-table"><colgroup><col class="diff-split-ln-col"><col><col class="diff-split-ln-col"><col></colgroup>' + rows.map(row => {
    if (row.type === 'file') {
      const badge = row.fileType === 'new'
        ? '<span class="diff-file-badge diff-file-badge-added">added</span>'
        : row.fileType === 'del'
          ? '<span class="diff-file-badge diff-file-badge-deleted">deleted</span>'
          : '';
      return `<tr class="diff-file-sep-row"><td colspan="4"><span class="diff-filename">${escapeHtml(row.filename)}</span>${badge}</td></tr>`;
    }
    if (row.type === 'binary') return `<tr><td colspan="4" class="diff-binary">Binary file — not shown</td></tr>`;
    if (row.type === 'hunk') return `<tr class="diff-hunk-header"><td class="diff-split-ln diff-split-ln-hunk"></td><td colspan="2">${escapeHtml(row.content)}</td><td class="diff-split-ln diff-split-ln-hunk"></td></tr>`;
    if (row.type === 'context') {
      const c = escapeHtml(row.content);
      return `<tr>${ln(row.leftLn, '')}<td class="diff-split-context">${c}</td>${ln(row.rightLn, '')}<td class="diff-split-context">${c}</td></tr>`;
    }
    if (row.type === 'change') {
      const leftCode = row.left !== null ? escapeHtml(row.left) : '';
      const rightCode = row.right !== null ? escapeHtml(row.right) : '';
      const leftLnCls = row.left !== null ? 'diff-split-ln-remove' : 'diff-split-ln-empty';
      const rightLnCls = row.right !== null ? 'diff-split-ln-add' : 'diff-split-ln-empty';
      const leftCls = row.left !== null ? 'diff-split-remove' : 'diff-split-empty';
      const rightCls = row.right !== null ? 'diff-split-add' : 'diff-split-empty';
      return `<tr>${ln(row.leftLn, leftLnCls)}<td class="${leftCls}">${leftCode}</td>${ln(row.rightLn, rightLnCls)}<td class="${rightCls}">${rightCode}</td></tr>`;
    }
    return '';
  }).join('') + '</table>';
}

const EXT_TO_LANG = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', scala: 'scala', cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  tf: 'hcl', hcl: 'hcl',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'ini',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
  md: 'markdown', sql: 'sql', php: 'php', swift: 'swift', r: 'r',
  lua: 'lua', ex: 'elixir', exs: 'elixir', hs: 'haskell',
};

function detectDiffLang(diffText) {
  const m = diffText.match(/^diff --git a\/.+?\.(\w+)\s/m);
  if (!m) return null;
  return EXT_TO_LANG[m[1].toLowerCase()] || null;
}

function applySyntaxHighlighting(diffText) {
  if (!window.hljs) return;
  const lang = detectDiffLang(diffText);
  if (!lang) return;
  const opts = { language: lang, ignoreIllegals: true };
  document.querySelectorAll('#diff-unified-view .diff-code').forEach(el => {
    try { el.innerHTML = hljs.highlight(el.textContent, opts).value; } catch (_) {}
  });
  document.querySelectorAll('#diff-split-view td.diff-split-context, #diff-split-view td.diff-split-remove, #diff-split-view td.diff-split-add').forEach(el => {
    try { el.innerHTML = hljs.highlight(el.textContent, opts).value; } catch (_) {}
  });
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
  localStorage.setItem('diffView', view);
}

// View diff
async function viewDiff(owner, repo, number) {
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/diff`);
    const data = await response.json();

    if (data.success) {
      const stats = parseDiffStats(data.diff);
      const unifiedHtml = renderUnifiedDiff(data.diff);
      const splitHtml = renderSideBySideHtml(buildSideBySideDiff(data.diff));

      const isWatchOnly = watchOnlyRepos.hasOwnProperty(`${owner}/${repo}`);
      const actionsHtml = isWatchOnly ? '' : `
        <button class="btn btn-small btn-approve" onclick="approvePRFromDiff('${owner}', '${repo}', '${number}')" title="Approve this PR immediately without a comment">&#10003; Approve</button>
        <button class="btn btn-small btn-approve-comment" onclick="approvePRFromDiffWithComment('${owner}', '${repo}', '${number}')" title="Approve this PR and add an optional comment">&#10003; Approve + Comment</button>
        <button class="btn btn-small btn-request-changes" onclick="requestChangesFromDiff('${owner}', '${repo}', '${number}')" title="Request changes on this PR (comment required)">&#10007; Request Changes</button>`;

      showModal(`
        <div class="diff-header-bar">
          <div class="diff-header-left">
            <span class="diff-header-repo">${escapeHtml(owner)}/${escapeHtml(repo)}</span>
            <span class="diff-header-num">#${number}</span>
            <div class="diff-header-stats">
              <span class="diff-stat-files">${stats.files} file${stats.files !== 1 ? 's' : ''}</span>
              <span class="diff-stat-add">+${stats.additions}</span>
              <span class="diff-stat-del">-${stats.deletions}</span>
            </div>
            <div class="diff-view-toggle">
              <button id="diff-view-unified" class="btn btn-small btn-primary" onclick="switchDiffView('unified')">Unified</button>
              <button id="diff-view-split" class="btn btn-small btn-muted" onclick="switchDiffView('split')">Split</button>
            </div>
          </div>
          <div class="diff-header-right">
            ${actionsHtml}
            <button class="btn btn-small btn-muted diff-close-btn" onclick="hideModal()" title="Close">&times;</button>
          </div>
        </div>
        <div class="diff-scroll-area">
          <div id="diff-unified-view" class="diff-container">${unifiedHtml}</div>
          <div id="diff-split-view" class="diff-container" style="display:none">${splitHtml}</div>
        </div>
        ${actionsHtml ? `<div class="diff-footer-bar">${actionsHtml}</div>` : ''}
      `);
      document.querySelector('#modal .modal-content').classList.add('modal-diff');
      const savedView = localStorage.getItem('diffView') || 'unified';
      switchDiffView(savedView);
      applySyntaxHighlighting(data.diff);
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

function showModalWithHeader(title, body, { subtitle = '', rightHtml = '', maxWidth = '' } = {}) {
  showModal(`
    <div class="modal-header-bar">
      <div class="modal-header-left">
        <span class="modal-header-title">${title}</span>
        ${subtitle ? `<span class="modal-header-sub">${subtitle}</span>` : ''}
      </div>
      <div class="modal-header-right">
        ${rightHtml}
        <button class="btn btn-small btn-muted modal-close-btn" onclick="hideModal()" title="Close">&times;</button>
      </div>
    </div>
    <div class="modal-scroll-area">${body}</div>
  `);
  const mc = document.querySelector('#modal .modal-content');
  mc.classList.add('modal-panel');
  mc.style.maxWidth = maxWidth || '';
}

function hideModal() {
  document.getElementById('modal').classList.add('hidden');
  const mc = document.querySelector('#modal .modal-content');
  mc.classList.remove('modal-diff');
  mc.classList.remove('modal-panel');
  mc.style.maxWidth = '';
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
  const wallStart = performance.now();

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
        setTimeout(async () => {
          await fetchPRs();
          lastRefreshWallMs = Math.round(performance.now() - wallStart);
          renderPerfBar(); // re-render with the now-correct wall time
          progressContainer.classList.add('hidden');
          btn.disabled = false;
          btn.textContent = originalText;
        }, 0);
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

// ─── Keyboard navigation ──────────────────────────────────────────────────────

function selectedCard() {
  return document.querySelector('#pr-list .pr-card.pr-selected');
}

function reapplySelection() {
  if (!selectedPRId) return;
  const [ownerRepo, number] = selectedPRId.split('#');
  const [owner, repo] = ownerRepo.split('/');
  const card = document.querySelector(
    `#pr-list .pr-card[data-owner="${owner}"][data-repo="${repo}"][data-number="${number}"]`
  );
  if (card) card.classList.add('pr-selected');
  else selectedPRId = null;
}

function navigateSelection(delta) {
  const cards = Array.from(document.querySelectorAll('#pr-list .pr-card'));
  if (cards.length === 0) return;
  const current = selectedCard();
  const currentIndex = current ? cards.indexOf(current) : -1;
  const newIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + delta));
  cards.forEach(c => c.classList.remove('pr-selected'));
  const next = cards[newIndex];
  next.classList.add('pr-selected');
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  selectedPRId = `${next.dataset.owner}/${next.dataset.repo}#${next.dataset.number}`;
}

function diffSelected() {
  const c = selectedCard();
  if (c) viewDiff(c.dataset.owner, c.dataset.repo, c.dataset.number);
}

function detailsSelected() {
  const c = selectedCard();
  if (c) viewDetails(c.dataset.owner, c.dataset.repo, c.dataset.number);
}

function approveSelected() {
  const c = selectedCard();
  if (!c || watchOnlyRepos[`${c.dataset.owner}/${c.dataset.repo}`]) return;
  reviewPR(c.dataset.owner, c.dataset.repo, c.dataset.number, 'approve');
}

function requestChangesSelected() {
  const c = selectedCard();
  if (!c || watchOnlyRepos[`${c.dataset.owner}/${c.dataset.repo}`]) return;
  reviewPR(c.dataset.owner, c.dataset.repo, c.dataset.number, 'request-changes');
}

function commentSelected() {
  const c = selectedCard();
  if (!c || watchOnlyRepos[`${c.dataset.owner}/${c.dataset.repo}`]) return;
  addComment(c.dataset.owner, c.dataset.repo, c.dataset.number);
}

function hideSelected() {
  const c = selectedCard();
  if (c) toggleHidePR(
    `${c.dataset.owner}/${c.dataset.repo}#${c.dataset.number}`,
    c.dataset.owner, c.dataset.repo, c.dataset.number
  );
}

function openSelected() {
  const c = selectedCard();
  if (c) window.open(`https://github.com/${c.dataset.owner}/${c.dataset.repo}/pull/${c.dataset.number}`, '_blank');
}

function showKeyboardHelp() {
  const bindings = [
    ['j / k',  'Select next / previous PR'],
    ['d',      'View diff'],
    ['Enter',  'View details'],
    ['a',      'Approve PR'],
    ['x',      'Request changes'],
    ['c',      'Comment on PR'],
    ['h',      'Hide / unhide PR'],
    ['o',      'Open PR in GitHub'],
    ['r',      'Reload PR list'],
    ['R',      'Refresh data from GitHub'],
    ['/',      'Focus search'],
    ['?',      'Show this help'],
    ['Esc',    'Close modal'],
  ];
  showModalWithHeader('Keyboard Shortcuts', `
    <table style="width:100%;border-collapse:collapse">
      ${bindings.map(([key, desc]) => `
        <tr style="border-top:1px solid var(--border)">
          <td style="padding:0.4rem 2rem 0.4rem 0;white-space:nowrap"><kbd>${key}</kbd></td>
          <td style="padding:0.4rem 0;color:var(--text-muted);font-size:0.875rem">${desc}</td>
        </tr>
      `).join('')}
    </table>
  `, { maxWidth: '480px' });
}

function showPerfHelp() {
  const fields = [
    ['refresh: Xs',        'Wall-clock time for the complete Refresh Data cycle — from button click to dashboard update. Includes the GitHub fetch, progress streaming, and page re-render.'],
    ['GH: Xs',             'Time spent fetching review statuses from the GitHub REST API for PRs that were not in the local review cache. Only appears when at least one PR was a cache miss.'],
    ['avg: Xs',            'Rolling average of the last 10 GH review fetch durations. Useful for spotting whether API latency is trending up between refreshes.'],
    ['N/M cached',         'Review status cache: N PRs had a valid cached status and required no GitHub call. M is the total number of PRs. A 304 Not Modified response keeps the cached value and costs no quota.'],
    ['N/M repos cached',   'PR list ETag cache: N repos returned 304 Not Modified, meaning their open-PR list is unchanged since the last refresh. Those repos cost zero rate-limit quota. M is the total number of watched repos.'],
    ['REST: N/5,000',      'GitHub REST API rate limit remaining in the current hourly window. Resets every hour. The /rate_limit endpoint and ETag 304 responses are exempt and do not count against this total.'],
  ];
  showModalWithHeader('Performance Bar', `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;color:var(--text-muted);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;padding:0 1.5rem 0.5rem 0;white-space:nowrap">Field</th>
          <th style="text-align:left;color:var(--text-muted);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;padding:0 0 0.5rem">What it measures</th>
        </tr>
      </thead>
      <tbody>
        ${fields.map(([field, desc]) => `
          <tr style="border-top:1px solid var(--border)">
            <td style="padding:0.6rem 1.5rem 0.6rem 0;white-space:nowrap;vertical-align:top">
              <code style="background:var(--surface-hover);padding:0.15rem 0.4rem;border-radius:4px;font-size:0.8rem;color:var(--yellow)">${field}</code>
            </td>
            <td style="padding:0.6rem 0;color:var(--text-muted);font-size:0.85rem;line-height:1.5;vertical-align:top">${desc}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `, { subtitle: 'Displayed below the header after each load or refresh.' });
}

// ─── Theme toggle ─────────────────────────────────────────────────────────────

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
document.getElementById('keyboard-help-btn').addEventListener('click', showKeyboardHelp);
document.getElementById('perf-bar').addEventListener('click', () => { if (lastPerfData) showPerfHelp(); });
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('refresh-ghreport-btn').addEventListener('click', refreshGhReport);
document.getElementById('refresh-btn').addEventListener('click', fetchPRs);
document.getElementById('search').addEventListener('input', filterAndRenderPRs);
document.getElementById('state-filter').addEventListener('change', filterAndRenderPRs);
document.getElementById('show-hidden').addEventListener('change', filterAndRenderPRs);
document.getElementById('show-drafts').addEventListener('change', filterAndRenderPRs);
document.getElementById('reset-filters-btn').addEventListener('click', resetFilters);

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
  const modal = document.getElementById('modal');
  const commentModal = document.getElementById('comment-modal');
  const modalOpen = !modal.classList.contains('hidden');
  const commentModalOpen = !commentModal.classList.contains('hidden');

  if (e.key === 'Escape') {
    if (commentModalOpen) cancelCommentModal();
    else if (modalOpen) hideModal();
    return;
  }

  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || modalOpen || commentModalOpen) return;

  switch (e.key) {
    case 'j': navigateSelection(1); break;
    case 'k': navigateSelection(-1); break;
    case 'd': diffSelected(); break;
    case 'Enter': detailsSelected(); break;
    case 'a': approveSelected(); break;
    case 'x': requestChangesSelected(); break;
    case 'c': commentSelected(); break;
    case 'h': hideSelected(); break;
    case 'o': openSelected(); break;
    case 'r': fetchPRs(); break;
    case 'R': refreshGhReport(); break;
    case '/': e.preventDefault(); document.getElementById('search').focus(); break;
    case '?': showKeyboardHelp(); break;
  }
});

async function loadVersion() {
  try {
    const res = await fetch('/api/version');
    const { version } = await res.json();
    document.getElementById('app-version').textContent = `v${version}`;
  } catch (_) {}
}

async function loadRepos() {
  try {
    const res = await fetch('/api/repos');
    const data = await res.json();
    if (data.success) {
      subscribedRepos = data.repos;
      document.getElementById('stat-repos').textContent = subscribedRepos.length;
    }
  } catch (_) {}
}

function showReposModal() {
  if (!subscribedRepos.length) return;

  const prCounts = {};
  for (const pr of allPRs) prCounts[pr.repo] = (prCounts[pr.repo] || 0) + 1;

  const rows = subscribedRepos.map(r => {
    const slash = r.indexOf('/');
    return { full: r, org: r.slice(0, slash), name: r.slice(slash + 1), prs: prCounts[r] || 0, watchOnly: watchOnlyRepos.hasOwnProperty(r) };
  });

  let sortCol = 'org';
  let sortAsc = true;

  const thStyle = 'padding:0.4rem 0.6rem;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);cursor:pointer;user-select:none;white-space:nowrap';
  const thStyleC = thStyle + ';text-align:center';

  showModalWithHeader('Watched Repos', `
    <table id="repos-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="border-bottom:2px solid var(--border);position:sticky;top:0;background:var(--surface)">
          <th data-col="org" style="${thStyle}">Org</th>
          <th data-col="name" style="${thStyle}">Repo</th>
          <th data-col="prs" style="${thStyleC}">Open PRs</th>
          <th data-col="watchOnly" style="${thStyleC}">Watch-only</th>
        </tr>
      </thead>
      <tbody id="repos-tbody"></tbody>
    </table>
  `, {
    rightHtml: `
      <span id="repo-modal-count" class="modal-header-sub"></span>
      <input id="repo-search" type="text" placeholder="Filter repos…" autocomplete="off"
        style="padding:0.35rem 0.65rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-deeper);color:var(--text);font-size:0.875rem;width:180px">
    `,
  });

  const tdStyle = 'padding:0.35rem 0.6rem;border-bottom:1px solid var(--border);font-size:0.85rem';
  const tdStyleC = tdStyle + ';text-align:center';

  function renderRows(data) {
    document.getElementById('repo-modal-count').textContent = `(${data.length} of ${rows.length})`;
    document.getElementById('repos-tbody').innerHTML = data.map(r => `
      <tr style="transition:background 0.1s" onmouseover="this.style.background='var(--surface-hover)'" onmouseout="this.style.background=''">
        <td style="${tdStyle};color:var(--text-muted)">${r.org}</td>
        <td style="${tdStyle}"><a href="https://github.com/${r.full}" target="_blank" style="color:var(--primary);text-decoration:none">${r.name}</a></td>
        <td style="${tdStyleC}">${r.prs > 0 ? `<span class="state-badge state-info">${r.prs}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td style="${tdStyleC}">${r.watchOnly ? '<span class="state-badge state-watch">WATCH</span>' : ''}</td>
      </tr>
    `).join('');
  }

  function sorted(data) {
    return [...data].sort((a, b) => {
      let av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'boolean') av = av ? 1 : 0, bv = bv ? 1 : 0;
      if (typeof av === 'number') return sortAsc ? av - bv : bv - av;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  function filtered(term) {
    const t = term.toLowerCase();
    return t ? rows.filter(r => r.org.toLowerCase().includes(t) || r.name.toLowerCase().includes(t)) : rows;
  }

  function refresh() {
    const term = document.getElementById('repo-search')?.value || '';
    renderRows(sorted(filtered(term)));
    // Update header sort indicators
    document.querySelectorAll('#repos-table th[data-col]').forEach(th => {
      const col = th.dataset.col;
      th.textContent = th.textContent.replace(/ [▲▼]$/, '');
      if (col === sortCol) th.textContent += sortAsc ? ' ▲' : ' ▼';
    });
  }

  refresh();

  document.getElementById('repo-search').addEventListener('input', refresh);
  document.getElementById('repo-search').focus();

  document.querySelectorAll('#repos-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = true; }
      refresh();
    });
  });
}

document.getElementById('repos-stat').addEventListener('click', showReposModal);

// ── Analytics panel ───────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (ms < 3600000)  return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}

function computeAnalytics(prs) {
  const now = Date.now();
  const activity = { APPROVED: 0, CHANGES_REQUESTED: 0, COMMENTED: 0, pending: 0 };
  const byRepo = {};
  const ageBuckets = { '<1d': 0, '1-3d': 0, '3-7d': 0, '>1w': 0 };
  const responseTimes = [];

  for (const pr of prs) {
    if (pr.state !== 'OPEN' && pr.state !== 'open') continue;

    const rs = pr.reviewStatus;
    if (rs?.hasReviewed && rs.state) activity[rs.state] = (activity[rs.state] || 0) + 1;
    else activity.pending++;

    const repo = pr.repo || pr.repository?.nameWithOwner || '';
    if (!byRepo[repo]) byRepo[repo] = { total: 0, reviewed: 0 };
    byRepo[repo].total++;
    if (rs?.hasReviewed) byRepo[repo].reviewed++;

    const ageDays = pr.updatedAt ? (now - new Date(pr.updatedAt)) / 86400000 : 0;
    if      (ageDays < 1)  ageBuckets['<1d']++;
    else if (ageDays < 3)  ageBuckets['1-3d']++;
    else if (ageDays < 7)  ageBuckets['3-7d']++;
    else                   ageBuckets['>1w']++;

    // Review response time: PR created → review submitted (last 90 days only)
    const cutoff = now - 45 * 86400000;
    if (rs?.hasReviewed && rs.submittedAt && pr.createdAt && new Date(pr.createdAt) >= cutoff) {
      const ms = new Date(rs.submittedAt) - new Date(pr.createdAt);
      if (ms > 0) responseTimes.push({ ms, repo, title: pr.title, number: pr.number });
    }
  }

  const avgResponseMs = responseTimes.length
    ? responseTimes.reduce((s, r) => s + r.ms, 0) / responseTimes.length
    : null;

  return { activity, byRepo, ageBuckets, responseTimes, avgResponseMs };
}

function renderAnalyticsPanel() {
  const openPRs = allPRs.filter(p => p.state === 'OPEN' || p.state === 'open');
  const { activity, byRepo, ageBuckets, responseTimes, avgResponseMs } = computeAnalytics(openPRs);

  // Activity
  const activityEl = document.getElementById('analytics-activity');
  const actRows = [
    { label: 'Approved',           value: activity.APPROVED,           color: 'var(--success)' },
    { label: 'Changes requested',  value: activity.CHANGES_REQUESTED,  color: 'var(--danger)'  },
    { label: 'Commented',          value: activity.COMMENTED,          color: 'var(--warning)'  },
    { label: 'Pending your review',value: activity.pending,            color: 'var(--primary)'  },
  ];
  activityEl.innerHTML = actRows.map(r => `
    <div class="analytics-stat-row">
      <span class="analytics-stat-label" style="color:${r.color}">${r.label}</span>
      <span class="analytics-stat-value">${r.value}</span>
    </div>`).join('');

  // Age distribution
  const ageEl = document.getElementById('analytics-age');
  const maxAge = Math.max(...Object.values(ageBuckets), 1);
  ageEl.innerHTML = Object.entries(ageBuckets).map(([label, count]) => `
    <div class="analytics-bar-row">
      <span class="analytics-bar-label">${label}</span>
      <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${Math.round(count / maxAge * 100)}%"></div></div>
      <span class="analytics-bar-count">${count}</span>
    </div>`).join('');

  // Response time
  const rtEl = document.getElementById('analytics-activity');
  if (avgResponseMs != null) {
    rtEl.insertAdjacentHTML('beforeend', `
      <div class="analytics-stat-row" style="margin-top:0.5rem;border-top:1px solid var(--border);padding-top:0.5rem">
        <span class="analytics-stat-label">Avg response time</span>
        <span class="analytics-stat-value" style="color:var(--yellow)">${fmtDuration(avgResponseMs)}</span>
      </div>
      <div class="analytics-stat-row">
        <span class="analytics-stat-label">Reviews with timing</span>
        <span class="analytics-stat-value">${responseTimes.length}</span>
      </div>`);
  }

  // Repos table (top 10 by PR count)
  const reposEl = document.getElementById('analytics-repos');
  const sorted = Object.entries(byRepo).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  const maxPRs = Math.max(...sorted.map(([, v]) => v.total), 1);
  reposEl.innerHTML = `
    <table class="analytics-repo-table">
      <thead><tr><th>Repo</th><th>Open PRs</th><th>Reviewed</th><th>Pending</th></tr></thead>
      <tbody>${sorted.map(([repo, v]) => `
        <tr>
          <td>${repo.split('/')[1] || repo}</td>
          <td>${v.total}</td>
          <td style="color:var(--success)">${v.reviewed}</td>
          <td style="color:var(--warning)">${v.total - v.reviewed}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

document.getElementById('analytics-btn').addEventListener('click', () => {
  const panel = document.getElementById('analytics-panel');
  const isHidden = panel.classList.toggle('hidden');
  if (!isHidden) renderAnalyticsPanel();
});

// Initial load
loadTheme();
loadHiddenPRs();
loadWatchOnlyRepos();
loadFilterPrefs();
fetchPRs();
loadVersion();
loadRepos();
