#!/bin/bash
cd /home/z/my-project
while true; do
  echo "[$(date)] Starting next dev..."
  node_modules/.bin/next dev -p 3000 -H 0.0.0.0 > dev.log 2>&1
  EXIT=$?
  echo "[$(date)] next dev exited with code $EXIT, restarting in 3s..."
  sleep 3
done
