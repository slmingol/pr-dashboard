# PR Dashboard

A containerized pull request dashboard that integrates with your [`ghreport`](https://github.com/slmingol/ghreport) CLI tool and GitHub CLI to provide a comprehensive view of all your PRs with review tracking and management features.

## Features

### 🎯 Core Features
- **Consolidated PR View**: Display all PRs from `ghreport` output in a clean, organized interface
- **Repository Grouping**: PRs automatically grouped by repository with sticky headers
- **Review Status Tracking**: See at a glance which PRs you've already reviewed (✓ Reviewed badge)
- **Hide/Unhide PRs**: Mark PRs as hidden to reduce clutter while keeping them accessible
- **Search & Filter**: Filter by search term, PR state (Open/Closed/Merged), and hidden status
- **Statistics Dashboard**: Real-time counts for Total, Visible, Hidden, and Filtered PRs

### 💬 Review Workflow
- **Integrated Comment Modal**: Add comments and reviews with a styled textarea (no browser prompts)
- **Approve/Reject from Diff**: Review buttons directly in the diff view modal
- **Review Indicators**: 
  - ✓ **Reviewed** (green) - You approved this PR
  - ⚠️ **Changes Requested** (orange) - You requested changes
  - 💬 **Commented** (blue) - You left comments
- **Quick Actions**: Approve (✓) or Request Changes (✗) buttons on each PR card

### 🛠️ PR Operations
- View PR details, diffs, and metadata
- Checkout PR branches locally
- Add comments and submit reviews
- Approve or request changes with optional comments
- Open PRs directly in GitHub
- **Refresh Data**: Re-run ghreport to fetch latest PRs from all monitored repositories
- **Clickable PR Numbers**: Direct links to GitHub PRs from PR numbers

### 🎨 UI/UX
- **Dark/Light Mode**: Toggle between themes with 🌙/☀️ button (preference saved)
- **Compact Layout**: Single-line horizontal PR cards for maximum density
- **Toast Notifications**: Non-intrusive success/error messages
- **Keyboard Shortcuts**: Cmd/Ctrl+Enter to submit, Escape to cancel
- **Color-Coded Buttons**: Each action has a distinct color for easy identification
  - 🔵 **Details** (Blue) - View PR information
  - 🔷 **Diff** (Cyan) - Inspect code changes
  - 🟢 **Checkout** (Green) - Check out branch
  - 🟠 **Comment** (Orange) - Add comment
  - ✅ **Approve** (Green) - Positive review
  - ❌ **Reject** (Red) - Request changes
- **Smart Title Display**: Hides generic "PR #NNN" titles (ghreport does not include PR titles; all titles are generic)
- **Larger Buttons**: Improved hit targets and readability (13px font, 8px/14px padding)

## Prerequisites

- **Podman Desktop** or **Docker** installed
- **GitHub CLI** (`gh`) installed and authenticated on host
- GitHub personal access token (for container authentication)
- **subscribedRepos** environment variable (optional, for monitoring specific repositories)

**Note**: `ghreport` is automatically installed inside the container during build - no host installation required.

## Setup

### 1. Create Environment File

Create a `.env` file with your GitHub token:

```bash
echo "GH_TOKEN=$(gh auth token)" > .env
```

**Optional**: Add subscribedRepos for monitoring specific repositories:

```bash
echo 'subscribedRepos=org/repo1 org/repo2 org/repo3' >> .env
```

**Important**: The container cannot access macOS keychain, so the token must be provided via environment variable. Both `GH_TOKEN` (for gh CLI) and `GITHUB_TOKEN` (for ghreport) are automatically set from the same token value.

### 2. Configure ghreport Output Path

Edit `docker-compose.yml` if your ghreport output is not at `~/ghreport-output/ghreport.txt`:

```yaml
volumes:
  - ~/.config/gh:/root/.config/gh:ro
  - ~/ghreport-output:/data:ro  # Update this path
  - ~/.gitconfig:/root/.gitconfig:ro
```

### 3. Verify ghreport Format

The dashboard expects ghreport output in this format:

```
https://github.com/owner/repo/pull/123 author: username Age: 8 days reviewDecision: ✅ mergeable: ✅
```

**Metadata fields**:
- `author:` - PR author username
- `Age:` - Days since PR opened
- `reviewDecision:` - Review status (✅ approved, 🔍 review required)
- `mergeable:` - Merge status (✅ mergeable, ❌ conflicts)

### 4. Build and Start

```bash
cd ~/dev/projects/pr-dashboard
podman compose up -d --build
```

Or with Docker:
```bash
docker compose up -d --build
```

### 5. Access Dashboard

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Main Interface

- **Statistics Bar**: Shows Total PRs, Visible, Hidden, and Filtered counts
- **Search**: Filter PRs by title, repository name, or PR number
- **State Filter**: Show all PRs, or only Open/Closed/Merged
- **Show Hidden**: Toggle to show/hide PRs you've marked as hidden
- **Theme Toggle**: 🌙/☀️ button to switch between dark and light mode
- **Refresh Data**: 🔄 button to re-run ghreport and fetch latest PRs (takes 20-30 seconds for 100+ repos)
- **Reload**: ↻ button to reload PR list from existing ghreport.txt file (instant)

### PR Actions

Each PR card shows:
- **PR Number**: Clickable link to GitHub PR (bold, primary color)
- **Title**: Shown only if not generic (e.g., not "PR #123")
- **Metadata**: Author, age, review status, mergeable status
- **State Badge**: Current PR state (OPEN, APPROVED, REVIEW REQUIRED)
- **Review Badge**: Your review status (✓ Reviewed, ⚠️ Changes Requested, 💬 Commented)
- **Hidden Badge**: Shows when PR is marked as hidden

**Action Buttons**:
- **🙈/👁**: Hide or unhide this PR
- **Details**: View full PR information
- **Diff**: See code changes with syntax highlighting
- **Checkout**: Check out PR branch locally
- **Comment**: Add a comment to the PR
- **✓**: Approve the PR
- **✗**: Request changes
- **Open →**: Open PR on GitHub

### Review Workflow

1. Click **Diff** to view changes
2. Click **✓ Approve** or **✗ Request Changes** in the diff modal
3. Add optional/required comment in the integrated modal
4. Press `Cmd/Ctrl+Enter` to submit or `Escape` to cancel
5. Both modals close automatically after submission
6. PR list refreshes to show your new review status

### Hide/Unhide PRs

- Click **🙈** to hide a PR you don't want to see
- Hidden PRs are removed from the main view
- Check **Show Hidden** to see them again (dimmed with 50% opacity)
- Click **👁** on a hidden PR to unhide it
- Hidden status persists in browser localStorage

## Configuration

### Environment Variables

Set in `.env` file or `docker-compose.yml`:

- `GH_TOKEN` - **Required**: GitHub personal access token (for gh CLI)
- `GITHUB_TOKEN` - **Auto-set**: Same as GH_TOKEN (for ghreport authentication)
- `subscribedRepos` - **Optional**: Space-separated list of repos to monitor (e.g., "org/repo1 org/repo2"). Passed through to `ghreport` inside the container — has no effect in local dev mode.
- `NODE_ENV` - Node environment (default: `production`)
- `PORT` - Server port (default: `3000`)
- `GHREPORT_OUTPUT` - Path to ghreport file inside container (default: `/data/ghreport.txt`)

### Volume Mounts

Configured in `docker-compose.yml`:

```yaml
volumes:
  - ~/.config/gh:/root/.config/gh:ro      # GitHub CLI config (read-only)
  - ~/ghreport-output:/data:ro            # ghreport output directory (read-only)
  - ~/.gitconfig:/root/.gitconfig:ro      # Git config for checkout (read-only)
```

### Customizing the Parser

If your ghreport format differs, edit the `loadPRsFromGhReport()` function in `server.js` to match your output pattern.

## Architecture

### Container Stack
- **Base Image**: `node:18-alpine`
- **Additional Tools**: `github-cli`, `git`, `go` (for ghreport build)
- **ghreport**: Automatically installed via `go install github.com/slmingol/ghreport@latest` ([source](https://github.com/slmingol/ghreport))
- **Port**: 3000
- **Health Check**: Automatic monitoring with 30s interval

### Technology
- **Backend**: Node.js 18 + Express 4.18
- **Frontend**: Vanilla JavaScript (no build tools required)
- **Styling**: CSS with CSS variables for theming
- **Data Sources**: 
  - ghreport CLI output (primary)
  - GitHub CLI (`gh`) for API operations

### File Structure
```
pr-dashboard/
├── server.js              # Express backend with gh CLI integration
├── public/
│   ├── index.html        # Main HTML page
│   ├── app.js            # Frontend JavaScript (UI logic)
│   └── style.css         # Theming and layout styles
├── docker-compose.yml    # Container orchestration
├── Dockerfile            # Container build config
├── package.json          # Node.js dependencies
├── .env                  # Environment variables (gitignored)
└── README.md            # This file
```

## Development

### Local Development (without container)

```bash
npm install
export GH_TOKEN=$(gh auth token)
export GHREPORT_OUTPUT=/path/to/ghreport.txt
node server.js
```

Open http://localhost:3000

### Making Changes

1. Edit files in `public/` directory or `server.js`
2. Rebuild and restart:
   ```bash
   podman compose up -d --build
   ```
3. Refresh browser to see changes

### API Endpoints

- `GET /api/prs` - Fetch all PRs with review status for current user
- `GET /api/user` - Get current authenticated GitHub user
- `GET /api/pr/:owner/:repo/:number` - Get PR details
- `GET /api/pr/:owner/:repo/:number/diff` - Get PR diff
- `POST /api/pr/:owner/:repo/:number/checkout` - Checkout PR locally
- `POST /api/pr/:owner/:repo/:number/comment` - Add comment
- `POST /api/pr/:owner/:repo/:number/review` - Submit review (approve/request-changes/comment)
- `GET /api/refresh-ghreport-stream` - Re-run ghreport with SSE progress stream (used by UI)
- `POST /api/refresh-ghreport` - Re-run ghreport (legacy, no progress stream)
- `GET /api/health` - Health check

## Troubleshooting

### Authentication Issues

**Symptom**: PRs not loading, or "authentication failed" errors

**Solutions**:
- Verify `.env` file contains `GH_TOKEN=<your-token>`
- Regenerate token: `gh auth token` and update `.env`
- Check container logs: `podman logs pr-dashboard`
- Ensure `~/.config/gh` is mounted correctly

### PRs Not Loading

**Symptom**: "No pull requests found" or empty list

**Solutions**:
- Verify `ghreport.txt` exists at mounted path
- Check file format matches expected pattern
- Run `ghreport` command manually to regenerate output
- Check container logs for parsing errors: `podman logs pr-dashboard`

### Review Status Not Showing

**Symptom**: "✓ Reviewed" badge not appearing for PRs you reviewed

**Solutions**:
- Open browser console (F12) to see debug logs
- Look for: `"Current authenticated user: yourusername"`
- Check for: `"PR owner/repo#123: User yourusername review state: APPROVED"`
- Verify you have permission to access the PR repository
- 404/403 errors are silently ignored (deleted/private PRs)

### Hidden PRs Not Visible

**Symptom**: Can't see hidden PRs when "Show Hidden" is checked

**Solutions**:
- Hidden PRs should appear dimmed (50% opacity) when checkbox is checked
- Check browser console for JavaScript errors
- Clear browser localStorage: `localStorage.clear()` in console
- Refresh page and try hiding/showing again

### Container Issues

**Symptom**: Container won't start or crashes

**Solutions**:
- Check container status: `podman ps -a`
- View recent logs: `podman logs pr-dashboard --tail 50`
- Restart container: `podman compose restart`
- Rebuild from scratch:
  ```bash
  podman compose down
  podman compose up -d --build
  ```

### Diff Modal Not Closing

**Symptom**: Comment modal or diff modal stays open after review

**Solutions**:
- This was fixed in recent versions
- Rebuild container to get latest code
- Both modals should close automatically after successful review submission

## Data Persistence

### Browser Storage
- **Theme Preference**: Saved in `localStorage` as `theme` (dark/light)
- **Hidden PRs**: Saved in `localStorage` as `hiddenPRs` (array of "repo#number")

### Container Data
- No persistent data stored in container
- All PR data fetched from ghreport file on each load
- Review status fetched from GitHub API in real-time

## Performance

- **Parallel Review Fetching**: All PR review statuses fetched concurrently
- **Error Resilience**: Individual PR failures don't break entire list
- **Server-Side Review Cache**: Review statuses cached in-memory for 5 minutes; stale cache used as fallback on API errors
- **Browser Storage**: Theme and hidden PR preferences cached in localStorage

## Contributing

Contributions welcome! Please feel free to submit issues or pull requests.

## Security Notes

- The dashboard uses read-only mounts for sensitive credentials
- No credentials are stored in the container
- All git/gh operations use your host authentication

## License

MIT
