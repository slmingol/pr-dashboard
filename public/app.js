let allPRs = [];
let filteredPRs = [];
let hiddenPRs = new Set();

// Load hidden PRs from localStorage
function loadHiddenPRs() {
  const stored = localStorage.getItem('hiddenPRs');
  if (stored) {
    hiddenPRs = new Set(JSON.parse(stored));
  }
  updateHiddenCount();
}

// Save hidden PRs to localStorage
function saveHiddenPRs() {
  localStorage.setItem('hiddenPRs', JSON.stringify([...hiddenPRs]));
  updateHiddenCount();
}

// Toggle PR hidden state
function toggleHidePR(prId, owner, repo, number) {
  if (hiddenPRs.has(prId)) {
    hiddenPRs.delete(prId);
    showToast(`Unhidden PR #${number}`, 'info', '', 2000);
  } else {
    hiddenPRs.add(prId);
    showToast(`Hidden PR #${number}`, 'success', '', 2000);
  }
  saveHiddenPRs();
  filterAndRenderPRs();
}

// Update hidden count badge
function updateHiddenCount() {
  const count = document.getElementById('hidden-count');
  if (count) {
    count.textContent = hiddenPRs.size;
  }
}

// Update statistics
function updateStats() {
  const total = allPRs.length;
  const hidden = hiddenPRs.size;
  const visible = total - hidden;
  const filtered = filteredPRs.length;
  
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-visible').textContent = visible;
  document.getElementById('stat-hidden').textContent = hidden;
  document.getElementById('stat-filtered').textContent = filtered;
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
      updateStats();
      filterAndRenderPRs();
      if (data.prs.length > 0) {
        showToast(`Loaded ${data.prs.length} pull requests`, 'success', '', 3000);
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
  
  filteredPRs = allPRs.filter(pr => {
    const matchesSearch = pr.title?.toLowerCase().includes(searchTerm) || 
                         pr.repo?.toLowerCase().includes(searchTerm) ||
                         pr.number?.toString().includes(searchTerm);
    
    const matchesState = stateFilter === 'all' || pr.state === stateFilter;
    
    const prId = `${pr.repo}#${pr.number}`;
    const isHidden = hiddenPRs.has(prId);
    const matchesHidden = showHidden || !isHidden;
    
    return matchesSearch && matchesState && matchesHidden;
  });
  
  renderPRs(filteredPRs);
  updateStats();
}

// Render PR list
function renderPRs(prs) {
  const prList = document.getElementById('pr-list');
  
  if (prs.length === 0) {
    prList.innerHTML = '<div class="loading">No pull requests found</div>';
    return;
  }
  
  prList.innerHTML = prs.map(pr => {
    const [owner, repo] = (pr.repository?.nameWithOwner || pr.repo || '').split('/');
    const number = pr.number;
    const state = pr.state || 'OPEN';
    const prId = `${pr.repo}#${number}`;
    const isHidden = hiddenPRs.has(prId);
    
    // Format metadata if available
    const metadata = pr.metadata || {};
    const metadataHtml = metadata.age ? `
      <span>⏰ ${metadata.age}</span>
      ${metadata.reviewDecision ? `<span>${metadata.reviewDecision}</span>` : ''}
      ${metadata.mergeable ? `<span>Merge: ${metadata.mergeable}</span>` : ''}
    ` : '';
    
    return `
      <div class="pr-card ${isHidden ? 'hidden' : ''}" data-owner="${owner}" data-repo="${repo}" data-number="${number}">
        <div class="pr-header">
          <div>
            <h3 class="pr-title">${pr.title || 'Untitled PR'}</h3>
            <div class="pr-meta">
              <span>📦 ${owner}/${repo}</span>
              <span>#${number}</span>
              ${pr.author?.login ? `<span>👤 ${pr.author.login}</span>` : ''}
              ${metadataHtml}
              <span class="state-badge state-${state.toLowerCase()}">${state.replace('_', ' ')}</span>
              ${isHidden ? '<span class="state-badge state-muted">HIDDEN</span>' : ''}
            </div>
          </div>
        </div>
        <div class="pr-actions">
          <button class="btn btn-small ${isHidden ? 'btn-success' : 'btn-muted'}" onclick="toggleHidePR('${prId}', '${owner}', '${repo}', '${number}')">
            ${isHidden ? '👁 Unhide' : '🙈 Hide'}
          </button>
          <button class="btn btn-small btn-primary" onclick="viewDetails('${owner}', '${repo}', '${number}')">
            View Details
          </button>
          <button class="btn btn-small btn-primary" onclick="viewDiff('${owner}', '${repo}', '${number}')">
            View Diff
          </button>
          <button class="btn btn-small btn-success" onclick="checkoutPR('${owner}', '${repo}', '${number}')">
            Checkout
          </button>
          <button class="btn btn-small btn-primary" onclick="addComment('${owner}', '${repo}', '${number}')">
            Comment
          </button>
          <button class="btn btn-small btn-success" onclick="reviewPR('${owner}', '${repo}', '${number}', 'approve')">
            ✓ Approve
          </button>
          <button class="btn btn-small btn-danger" onclick="reviewPR('${owner}', '${repo}', '${number}', 'request-changes')">
            ✗ Request Changes
          </button>
          <a href="${pr.url}" target="_blank" class="btn btn-small" style="text-decoration:none">
            Open in Browser →
          </a>
        </div>
      </div>
    `;
  }).join('');
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

// View diff
async function viewDiff(owner, repo, number) {
  try {
    const response = await fetch(`/api/pr/${owner}/${repo}/${number}/diff`);
    const data = await response.json();
    
    if (data.success) {
      const diffHtml = data.diff.split('\n').map(line => {
        let className = 'diff-line';
        if (line.startsWith('+')) className += ' diff-add';
        if (line.startsWith('-')) className += ' diff-remove';
        return `<div class="${className}">${escapeHtml(line)}</div>`;
      }).join('');
      
      showModal(`
        <h2>Diff for ${owner}/${repo} #${number}</h2>
        <div class="diff-container">${diffHtml}</div>
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
function addComment(owner, repo, number) {
  const comment = prompt(`Add comment to ${owner}/${repo} #${number}:`);
  if (!comment) return;
  
  fetch(`/api/pr/${owner}/${repo}/${number}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: comment })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showToast('Comment added successfully', 'success');
    } else {
      showToast('Failed to add comment: ' + data.error, 'error');
    }
  })
  .catch(err => showToast('Error: ' + err.message, 'error'));
}

// Review PR
function reviewPR(owner, repo, number, action) {
  const actionText = action === 'approve' ? 'Approve' : 'Request Changes';
  const comment = prompt(`${actionText} ${owner}/${repo} #${number}\n\nOptional comment:`);
  if (comment === null) return; // User cancelled
  
  fetch(`/api/pr/${owner}/${repo}/${number}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, body: comment || undefined })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      showToast('Review submitted successfully', 'success');
      fetchPRs(); // Refresh
    } else {
      showToast('Failed to submit review: ' + data.error, 'error');
    }
  })
  .catch(err => showToast('Error: ' + err.message, 'error'));
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

// Event listeners
document.getElementById('refresh-btn').addEventListener('click', fetchPRs);
document.getElementById('search').addEventListener('input', filterAndRenderPRs);
document.getElementById('state-filter').addEventListener('change', filterAndRenderPRs);
document.getElementById('show-hidden').addEventListener('change', filterAndRenderPRs);

document.querySelector('.close').addEventListener('click', hideModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') hideModal();
});

// Initial load
loadHiddenPRs();
fetchPRs();
