let allPRs = [];
let filteredPRs = [];

// Fetch PRs from API
async function fetchPRs() {
  showLoading(true);
  hideError();
  
  try {
    const response = await fetch('/api/prs');
    const data = await response.json();
    
    if (data.success) {
      allPRs = data.prs;
      filterAndRenderPRs();
    } else {
      showError(data.error || 'Failed to fetch PRs');
    }
  } catch (error) {
    showError('Network error: ' + error.message);
  } finally {
    showLoading(false);
  }
}

// Filter PRs based on search and state
function filterAndRenderPRs() {
  const searchTerm = document.getElementById('search').value.toLowerCase();
  const stateFilter = document.getElementById('state-filter').value;
  
  filteredPRs = allPRs.filter(pr => {
    const matchesSearch = pr.title?.toLowerCase().includes(searchTerm) || 
                         pr.repo?.toLowerCase().includes(searchTerm) ||
                         pr.number?.toString().includes(searchTerm);
    
    const matchesState = stateFilter === 'all' || pr.state === stateFilter;
    
    return matchesSearch && matchesState;
  });
  
  renderPRs(filteredPRs);
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
    
    // Format metadata if available
    const metadata = pr.metadata || {};
    const metadataHtml = metadata.age ? `
      <span>⏰ ${metadata.age}</span>
      ${metadata.reviewDecision ? `<span>${metadata.reviewDecision}</span>` : ''}
      ${metadata.mergeable ? `<span>Merge: ${metadata.mergeable}</span>` : ''}
    ` : '';
    
    return `
      <div class="pr-card" data-owner="${owner}" data-repo="${repo}" data-number="${number}">
        <div class="pr-header">
          <div>
            <h3 class="pr-title">${pr.title || 'Untitled PR'}</h3>
            <div class="pr-meta">
              <span>📦 ${owner}/${repo}</span>
              <span>#${number}</span>
              ${pr.author?.login ? `<span>👤 ${pr.author.login}</span>` : ''}
              ${metadataHtml}
              <span class="state-badge state-${state.toLowerCase()}">${state.replace('_', ' ')}</span>
            </div>
          </div>
        </div>
        <div class="pr-actions">
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
      alert('Failed to fetch PR details: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
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
      alert('Failed to fetch diff: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
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
    
    if (data.success) {
      alert('PR checked out successfully!\n\n' + data.output);
    } else {
      alert('Failed to checkout PR: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
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
      alert('Comment added successfully!');
    } else {
      alert('Failed to add comment: ' + data.error);
    }
  })
  .catch(err => alert('Error: ' + err.message));
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
      alert('Review submitted successfully!');
      fetchPRs(); // Refresh
    } else {
      alert('Failed to submit review: ' + data.error);
    }
  })
  .catch(err => alert('Error: ' + err.message));
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

document.querySelector('.close').addEventListener('click', hideModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') hideModal();
});

// Initial load
fetchPRs();
