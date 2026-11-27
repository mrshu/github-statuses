# Makefile for github-statuses

# Variables
IMAGE_NAME := github-statuses-service
IMAGE_TAG ?= latest
FULL_IMAGE_NAME := $(IMAGE_NAME):$(IMAGE_TAG)

.PHONY: help build run clean up down logs venv install dev site extract test format format-check lint lint-fix ready

# Generate help information from comments
help: ## Display this help information
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build the Docker image (server/app.py's live FastAPI service)
	@echo "Building Docker image $(FULL_IMAGE_NAME)..."
	docker build -t $(FULL_IMAGE_NAME) .

run: build ## Build and run the Docker image locally
	@echo "Running Docker container from $(FULL_IMAGE_NAME)..."
	docker run --rm -p 8000:8000 $(FULL_IMAGE_NAME)

clean: ## Remove the built Docker image
	@echo "Removing Docker image $(FULL_IMAGE_NAME)..."
	docker rmi $(FULL_IMAGE_NAME) || true

# Detect which docker-compose command to use
DOCKER_COMPOSE := $(shell if command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; elif docker compose version >/dev/null 2>&1; then echo "docker compose"; else echo "echo 'Error: docker-compose not found' >&2 && exit 1"; fi)

up: ## Start the live server with docker-compose
	@echo "Starting services with docker-compose..."
	$(DOCKER_COMPOSE) up -d --build

down: ## Stop the docker-compose services
	@echo "Stopping services with docker-compose..."
	$(DOCKER_COMPOSE) down

logs: ## Follow logs from docker-compose services
	@echo "Following logs from services..."
	$(DOCKER_COMPOSE) logs -f

venv: ## Create a virtual environment with uv
	@echo "Creating virtual environment with uv..."
	uv venv

install: ## Install dependencies with uv (see README's Prerequisites section)
	@echo "Installing dependencies with uv..."
	uv sync

dev: ## Run the live FastAPI server locally with auto-reload
	@echo "Starting live server on http://localhost:8000 ..."
	uv run uvicorn server.app:app --reload --port 8000

site: ## Serve the static site (parsed/ + site/), no build step needed
	@echo "Serving static site -- open http://localhost:8000/site/ ..."
	python3 -m http.server 8000

extract: ## Run the incident extractor across all history (see README Quick start)
	@echo "Running the incident extractor..."
	uv run python scripts/extract_incidents.py --out out

test: ## Run the unittest test suite
	@echo "Running test suite..."
	uv run python -m unittest discover -s tests

format: ## Format code with ruff
	@echo "Formatting code with ruff..."
	uv run ruff format .

format-check: ## Check code formatting with ruff (no changes made)
	@echo "Checking code formatting with ruff..."
	uv run ruff format --check .

lint: ## Run ruff lint checks
	@echo "Running ruff lint checks..."
	uv run ruff check .

lint-fix: ## Run ruff lint checks and automatically fix issues
	@echo "Running ruff lint checks with automatic fixes..."
	uv run ruff check . --fix

ready: format-check lint test ## Verify code is ready for commit (checks formatting, lint, runs tests)
	@echo ""
	@echo "Code verification complete -- formatting OK, lint OK, all tests passed."
