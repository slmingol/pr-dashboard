# PR Dashboard

A containerized web dashboard for managing GitHub Pull Requests using the GitHub CLI (`gh`).

## Features

- 🔍 View all PRs from your `ghreport` output
- 📊 Filter by state (Open/Closed/Merged) and search
- 👁️ View PR details and diffs
- 📝 Add comments
- ✅ Approve or request changes
- 🔄 Checkout PRs locally
- 🌐 Open PRs in browser

## Prerequisites

- Docker and Docker Compose installed
- GitHub CLI (`gh`) authenticated on your host machine
- `ghreport` tool (or compatible PR list output)

## Setup

### 1. Configure ghreport Output Path

Edit `docker-compose.yml` and update the volume mount to point to your ghreport output:

```yaml
volumes:
  - /path/to/your/ghreport-output:/data:ro
```

### 2. Configure ghreport Output File

The dashboard expects a file at `/data/ghreport.txt` inside the container. You can customize this by setting the `GHREPORT_OUTPUT` environment variable in `docker-compose.yml`.

**Expected format** (customize `server.js` parser if different):
```
owner/repo#123 - PR Title Here
owner/repo#456 - Another PR Title
```

### 3. Build and Run

```bash
cd ~/dev/projects/pr-dashboard
docker-compose up -d
```

### 4. Access Dashboard

Open http://localhost:3000 in your browser.

## Usage

### View PRs
- PRs are loaded automatically on page load
- Click "Refresh" to reload from ghreport output

### Actions
- **View Details**: See PR description, author, state
- **View Diff**: See code changes inline
- **Checkout**: Checkout PR branch locally (requires git config mounted)
- **Comment**: Add a comment to the PR
- **Approve**: Submit an approving review
- **Request Changes**: Submit a review requesting changes
- **Open in Browser**: Open PR on GitHub

## Configuration

### Using gh CLI directly (fallback)

If no ghreport output is found, the dashboard falls back to using `gh pr list` directly. This requires the `gh` CLI to be properly authenticated.

### Volume Mounts

- `~/.config/gh`: GitHub CLI authentication (required)
- `~/ghreport-output`: Your ghreport output directory
- `~/.gitconfig`: Git config (optional, for checkout)
- `~/.ssh`: SSH keys (optional, for private repos)

### Environment Variables

- `PORT`: Server port (default: 3000)
- `GHREPORT_OUTPUT`: Path to ghreport output file inside container
- `NODE_ENV`: Node environment (production/development)

## Development

Run locally without Docker:

```bash
npm install
node server.js
```

Access at http://localhost:3000

## Customizing ghreport Parser

Edit the `loadPRsFromGhReport()` function in `server.js` to match your ghreport output format.

## Troubleshooting

**No PRs showing:**
- Check ghreport output path is correct
- Verify gh CLI is authenticated: `docker exec pr-dashboard gh auth status`
- Check logs: `docker-compose logs -f`

**Checkout fails:**
- Ensure git config and SSH keys are mounted
- Verify repository access

**Authentication errors:**
- Verify `~/.config/gh` is mounted correctly
- Re-authenticate gh CLI on host: `gh auth login`

## Security Notes

- The dashboard uses read-only mounts for sensitive credentials
- No credentials are stored in the container
- All git/gh operations use your host authentication

## License

MIT
