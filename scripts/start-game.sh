#!/bin/bash
# Persistent game server launcher.
# Uses `setsid -f` so the next-server process is reparented to PID 1 (init/tini)
# and survives the tool-call bash session ending.
# This is the only reliable way to keep the dev server alive in this container.

cd /home/z/my-project

# Kill any existing next processes
pkill -9 -f "next-server" 2>/dev/null
pkill -9 -f "next dev" 2>/dev/null
pkill -9 -f "standalone/server.js" 2>/dev/null
sleep 1

# Make sure standalone build exists
if [ ! -f ".next/standalone/server.js" ]; then
  echo "Building standalone..."
  NODE_OPTIONS="--max-old-space-size=2048" node_modules/.bin/next build 2>&1 | tail -5
  cp -r .next/static .next/standalone/.next/ 2>/dev/null
  cp -r public .next/standalone/ 2>/dev/null
fi

# Launch with setsid -f so the process is reparented to init (PID 1)
# This prevents it from being killed when our bash session exits.
setsid -f node /home/z/my-project/.next/standalone/server.js > /home/z/my-project/dev.log 2>&1

# Wait for it to be ready
sleep 3

# Verify it's running
if ss -tlnp 2>/dev/null | grep -q ":3000"; then
  echo "Game server is running on port 3000"
  ss -tlnp 2>/dev/null | grep ":3000"
else
  echo "WARNING: Game server not detected on port 3000"
  tail -20 /home/z/my-project/dev.log
fi
