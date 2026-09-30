#!/bin/bash
# Persistent dev server launcher
cd /home/z/my-project
exec npm run dev > /tmp/dev.log 2>&1
