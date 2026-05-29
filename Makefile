.PHONY: up down build prod restart logs shell clean

# Dev: live-reload via docker-compose.override.yml (mounts server.js, public/, package.json)
up:
	docker compose up -d

# Stop and remove container
down:
	docker compose down

# Production: full rebuild, no override mounts
build:
	docker compose -f docker-compose.yml up -d --build

# Alias for build
prod: build

# Restart running container (picks up override mount changes)
restart:
	docker compose restart

# Tail container logs
logs:
	docker compose logs -f

# Shell into running container
shell:
	docker exec -it pr-dashboard sh

# Remove container and image
clean:
	docker compose down --rmi local
