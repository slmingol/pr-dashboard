.PHONY: up down build prod restart logs shell clean list

# Auto-detect podman or docker
RUNTIME := $(shell command -v podman 2>/dev/null | xargs basename 2>/dev/null || echo docker)
COMPOSE  := $(RUNTIME) compose

list:
	@echo "Runtime: $(RUNTIME)"
	@echo ""
	@echo "  up       Dev mode (live reload via override)"
	@echo "  down     Stop and remove container"
	@echo "  build    Production rebuild (no override)"
	@echo "  prod     Alias for build"
	@echo "  restart  Restart running container"
	@echo "  logs     Tail container logs"
	@echo "  shell    Exec into container"
	@echo "  clean    Remove container and image"

# Dev: live-reload via docker-compose.override.yml (mounts server.js, public/, package.json)
up:
	$(COMPOSE) up -d

# Stop and remove container
down:
	$(COMPOSE) down

# Production: full rebuild, no override mounts
build:
	$(COMPOSE) -f docker-compose.yml up -d --build

# Alias for build
prod: build

# Restart running container
restart:
	$(COMPOSE) restart

# Tail container logs
logs:
	$(COMPOSE) logs -f

# Shell into running container
shell:
	$(RUNTIME) exec -it pr-dashboard sh

# Remove container and image
clean:
	$(COMPOSE) down --rmi local
