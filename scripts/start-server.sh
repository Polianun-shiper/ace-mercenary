#!/bin/bash
# Persistent game server launcher
# Uses standalone production build for stability
cd /home/z/my-project

# Kill any existing servers
pkill -9 -f "next" 2>/dev/null
pkill -9 -f "server.js" 2>/dev/null
sleep 2

# Ensure standalone has static + public assets
if [ ! -d ".next/standalone/.next/static" ]; then
  cp -r .next/static .next/standalone/.next/ 2>/dev/null
fi
if [ ! -d ".next/standalone/public" ]; then
  cp -r public .next/standalone/ 2>/dev/null
fi

# Write a watchdog PID file
echo $$ > /home/z/my-project/scripts/server.pid

# Launch standalone server with full detachment
# Using exec replaces the shell, so there's no parent to kill
exec node .next/standalone/server.js > /home/z/my-project/server.log 2>&1
