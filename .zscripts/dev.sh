#!/bin/bash

set -uo pipefail

# 获取脚本所在目录（.zscripts）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step_start() {
	local step_name="$1"
	echo "=========================================="
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting: $step_name"
	echo "=========================================="
	export STEP_START_TIME
	STEP_START_TIME=$(date +%s)
}

log_step_end() {
	local step_name="${1:-Unknown step}"
	local end_time
	end_time=$(date +%s)
	local duration=$((end_time - STEP_START_TIME))
	echo "=========================================="
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] Completed: $step_name"
	echo "[LOG] Step: $step_name | Duration: ${duration}s"
	echo "=========================================="
	echo ""
}

start_mini_services() {
	local mini_services_dir="$PROJECT_DIR/mini-services"
	local started_count=0

	log_step_start "Starting mini-services"
	if [ ! -d "$mini_services_dir" ]; then
		echo "Mini-services directory not found, skipping..."
		log_step_end "Starting mini-services"
		return 0
	fi

	echo "Found mini-services directory, scanning for sub-services..."

	for service_dir in "$mini_services_dir"/*; do
		if [ ! -d "$service_dir" ]; then
			continue
		fi

		local service_name
		service_name=$(basename "$service_dir")
		echo "Checking service: $service_name"

		if [ ! -f "$service_dir/package.json" ]; then
			echo "[$service_name] No package.json found, skipping..."
			continue
		fi

		if ! grep -q '"dev"' "$service_dir/package.json"; then
			echo "[$service_name] No dev script found, skipping..."
			continue
		fi

		echo "Starting $service_name in background..."
		(
			cd "$service_dir"
			echo "[$service_name] Installing dependencies..."
			bun install 2>&1 || true
			echo "[$service_name] Running bun run dev..."
			exec bun run dev
		) >"$PROJECT_DIR/.zscripts/mini-service-${service_name}.log" 2>&1 &

		local service_pid=$!
		echo "[$service_name] Started in background (PID: $service_pid)"
		echo "[$service_name] Log: $PROJECT_DIR/.zscripts/mini-service-${service_name}.log"
		disown "$service_pid" 2>/dev/null || true
		started_count=$((started_count + 1))
	done

	echo "Mini-services startup completed. Started $started_count service(s)."
	log_step_end "Starting mini-services"
}

wait_for_service() {
	local host="$1"
	local port="$2"
	local service_name="$3"
	local max_attempts="${4:-60}"
	local attempt=1

	echo "Waiting for $service_name to be ready on $host:$port..."

	while [ "$attempt" -le "$max_attempts" ]; do
		if curl -s --connect-timeout 2 --max-time 5 "http://$host:$port" >/dev/null 2>&1; then
			echo "$service_name is ready!"
			return 0
		fi

		echo "Attempt $attempt/$max_attempts: $service_name not ready yet, waiting..."
		sleep 1
		attempt=$((attempt + 1))
	done

	echo "WARNING: $service_name failed to start within $max_attempts seconds"
	return 0  # Don't fail, just warn
}

cleanup() {
	if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
		echo "Stopping Next.js dev server (PID: $DEV_PID)..."
		kill "$DEV_PID" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

log_step_start "bun install (skip if fails)"
echo "[BUN] Installing dependencies (will continue on failure)..."
bun install 2>&1 || echo "[BUN] bun install failed, continuing with existing node_modules..."
log_step_end "bun install (skip if fails)"

log_step_start "bun run db:push (skip if fails)"
echo "[BUN] Setting up database (will continue on failure)..."
bun run db:push 2>&1 || echo "[BUN] db:push failed, continuing..."
log_step_end "bun run db:push (skip if fails)"

log_step_start "Starting Next.js dev server"
echo "[BUN] Starting development server..."
bun run dev &
DEV_PID=$!
echo "[BUN] dev server PID: $DEV_PID"
log_step_end "Starting Next.js dev server"

log_step_start "Waiting for Next.js dev server"
wait_for_service "localhost" "3000" "Next.js dev server"
log_step_end "Waiting for Next.js dev server"

log_step_start "Health check"
echo "[BUN] Performing health check..."
curl -fsS localhost:3000 >/dev/null 2>&1 || echo "[BUN] Health check failed, but continuing..."
echo "[BUN] Health check done"
log_step_end "Health check"

start_mini_services

echo "Next.js dev server is running in background (PID: $DEV_PID)."
echo "Use 'kill $DEV_PID' to stop it."
disown "$DEV_PID" 2>/dev/null || true
unset DEV_PID

# Keep the script alive so the platform doesn't think we exited
echo "[DEV] dev.sh main logic complete, keeping process alive..."
while true; do
  sleep 60
  # Check if dev server is still running, if not restart it
  if [ -n "${DEV_PID:-}" ] && ! kill -0 "$DEV_PID" >/dev/null 2>&1; then
    echo "[DEV] dev server died, restarting..."
    bun run dev &
    DEV_PID=$!
    echo "[DEV] new dev server PID: $DEV_PID"
    disown "$DEV_PID" 2>/dev/null || true
  fi
done
