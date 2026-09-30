#!/usr/bin/env python3
"""Daemon launcher that double-forks to fully detach from parent.
This survives the bash tool killing its child processes.
"""
import os
import sys
import subprocess
import time
from pathlib import Path

PROJECT = Path("/home/z/my-project")
LOG = PROJECT / "server.log"
PIDFILE = PROJECT / "scripts" / "server.pid"

def is_running():
    if not PIDFILE.exists():
        return False
    try:
        pid = int(PIDFILE.read_text().strip())
        os.kill(pid, 0)  # signal 0 = check existence
        return True
    except (ProcessLookupError, ValueError, FileNotFoundError):
        return False

def kill_existing():
    """Kill any existing next/server.js processes."""
    subprocess.run(["pkill", "-9", "-f", "next dev"], capture_output=True)
    subprocess.run(["pkill", "-9", "-f", "next-server"], capture_output=True)
    subprocess.run(["pkill", "-9", "-f", "standalone/server.js"], capture_output=True)
    time.sleep(2)

def daemonize():
    """Double-fork to become a true daemon."""
    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent exits immediately
        sys.exit(0)
    
    # Decouple from parent environment
    os.setsid()
    os.umask(0)
    
    # Second fork
    pid = os.fork()
    if pid > 0:
        sys.exit(0)
    
    # Now we're a daemon
    # Redirect std fds
    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, 'r') as f:
        os.dup2(f.fileno(), 0)
    with open(LOG, 'w') as f:
        os.dup2(f.fileno(), 1)
        os.dup2(f.fileno(), 2)
    
    # Write pidfile
    PIDFILE.write_text(str(os.getpid()))
    
    # Exec the server
    os.execvp("node", ["node", str(PROJECT / ".next/standalone/server.js")])

def main():
    if is_running():
        print("Server already running.")
        return
    kill_existing()
    # Ensure standalone has assets
    static_dir = PROJECT / ".next/standalone/.next/static"
    if not static_dir.exists():
        subprocess.run(["cp", "-r", str(PROJECT / ".next/static"), str(PROJECT / ".next/standalone/.next/")])
    public_dir = PROJECT / ".next/standalone/public"
    if not public_dir.exists():
        subprocess.run(["cp", "-r", str(PROJECT / "public"), str(PROJECT / ".next/standalone/")])
    daemonize()

if __name__ == "__main__":
    main()
