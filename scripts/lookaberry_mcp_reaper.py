#!/usr/bin/env python3
"""
LookaBerry MCP Reaper & Orphaned Process Cleaner
Scans for orphaned LookaBerry stdio MCP processes and hung PostgreSQL connection holders on port 5433.
Safely sends SIGTERM and, if necessary after grace period, SIGKILL.
"""

import os
import signal
import subprocess
import sys
import time

def find_lookaberry_pids():
    pids = set()
    current_pid = os.getpid()

    # Find node processes running LookaBerry stdio transport
    try:
        ps_out = subprocess.check_output(["ps", "-ef"], text=True)
        for line in ps_out.splitlines():
            if "lookaberry" in line.lower() and ("stdio.js" in line or "stdio.ts" in line):
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        pid = int(parts[1])
                        if pid != current_pid:
                            pids.add(pid)
                    except ValueError:
                        pass
    except Exception as e:
        print(f"[Reaper] Error scanning ps: {e}", file=sys.stderr)

    # Find processes holding open connections to PostgreSQL on port 5433
    try:
        lsof_out = subprocess.check_output(["lsof", "-nP", "-iTCP:5433", "-sTCP:ESTABLISHED"], text=True)
        for line in lsof_out.splitlines():
            if "node" in line.lower():
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        pid = int(parts[1])
                        if pid != current_pid:
                            pids.add(pid)
                    except ValueError:
                        pass
    except subprocess.CalledProcessError:
        # lsof returns code 1 if no matching process found
        pass
    except Exception as e:
        print(f"[Reaper] Error scanning lsof: {e}", file=sys.stderr)

    return list(pids)

def reap_processes(pids, timeout_sec=3.0):
    if not pids:
        print("[Reaper] No orphaned LookaBerry MCP processes found. System clean.")
        return 0

    print(f"[Reaper] Found {len(pids)} candidate process(es): {pids}")

    # First attempt graceful SIGTERM
    for pid in pids:
        try:
            print(f"[Reaper] Sending SIGTERM to PID {pid}...")
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as e:
            print(f"[Reaper] Failed to SIGTERM {pid}: {e}", file=sys.stderr)

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except ProcessLookupError:
                pass
        if not alive:
            print("[Reaper] All candidate processes terminated gracefully.")
            return 0
        time.sleep(0.3)

    # Force kill any remaining stubborn processes
    for pid in alive:
        try:
            print(f"[Reaper] Forcing SIGKILL to PID {pid}...")
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as e:
            print(f"[Reaper] Failed to SIGKILL {pid}: {e}", file=sys.stderr)

    return len(alive)

if __name__ == "__main__":
    candidates = find_lookaberry_pids()
    reaped = reap_processes(candidates)
    sys.exit(0)
