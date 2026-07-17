.PHONY: up down build prod restart logs shell clean list

# Auto-detect podman or docker
RUNTIME := $(shell command -v podman 2>/dev/null | xargs basename 2>/dev/null || echo docker)
COMPOSE  := $(RUNTIME) compose

# Build version: clean semver on a tagged commit, base-count.sha otherwise
# Matches the logic in .github/workflows/ci.yml and release.yml
_TAG     := $(shell git tag --points-at HEAD 2>/dev/null | grep -E '^v[0-9]' | head -1)
_BASE    := $(shell node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)
_COUNT   := $(shell git rev-list --count HEAD 2>/dev/null || echo 0)
_SHA     := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_VERSION := $(if $(_TAG),$(patsubst v%,%,$(_TAG)),$(_BASE)-$(_COUNT).$(_SHA))

# ─── Help ────────────────────────────────────────────────────────────────────

list:
	@printf "Runtime: \033[36m$(RUNTIME)\033[0m\n\n"
	@printf "\033[1mDevelopment\033[0m\n"
	@printf "  \033[32mup\033[0m        Start in dev mode (live reload via override)\n"
	@printf "  \033[32mdown\033[0m      Stop and remove container\n"
	@printf "  \033[32mrestart\033[0m   Restart running container\n"
	@printf "  \033[32mlogs\033[0m      Tail container logs\n"
	@printf "  \033[32mshell\033[0m     Exec into running container\n"
	@printf "\n\033[1mProduction\033[0m\n"
	@printf "  \033[33mbuild\033[0m     Full rebuild without override mounts\n"
	@printf "  \033[33mprod\033[0m      Alias for build\n"
	@printf "\n\033[1mMaintenance\033[0m\n"
	@printf "  \033[31mclean\033[0m     Remove container and image\n"
	@printf "  \033[90mlist\033[0m      Show this help\n"

# ─── Development ─────────────────────────────────────────────────────────────

up:
	@$(COMPOSE) up -d > /dev/null 2>&1

down:
	@$(COMPOSE) down > /dev/null 2>&1

restart:
	@$(COMPOSE) restart > /dev/null 2>&1

logs:
	$(COMPOSE) logs -f

shell:
	$(RUNTIME) exec -it pr-dashboard sh

# ─── Production ──────────────────────────────────────────────────────────────

build:
	@printf "Building $(BUILD_VERSION)... "; \
	BUILD_VERSION=$(BUILD_VERSION) $(COMPOSE) -f docker-compose.yml up -d --build > /dev/null 2>&1 \
	&& printf "done.\n" || (printf "FAILED\n"; exit 1)

prod: build

# ─── Maintenance ─────────────────────────────────────────────────────────────

clean:
	$(COMPOSE) down --rmi local
