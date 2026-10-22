#!/usr/bin/env python3
"""Daily scheduler for the API for booking a tennis court in UDC (Linux/macOS)."""
import argparse
import datetime as dt
import getpass
import hashlib
import json
import os
from pathlib import Path
import time

import udc_booker as u

def due_time(now, last_date=None):
    """Next Sunday–Thursday 00:00 Doha, allowing a late start within five minutes."""
    now = now.astimezone(u.DOHA)
    day = now.date()
    if now.hour != 0 or now.minute >= 5 or str(day) == last_date:
        day += dt.timedelta(days=1)
    while day.weekday() in (4, 5):
        day += dt.timedelta(days=1)
    return dt.datetime.combine(day, dt.time(), u.DOHA)

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--state-dir", type=Path, default=Path.home()/".local"/"state"/"udc-court-booking")
    args = parser.parse_args(argv)
    try:
        import fcntl
    except ImportError:
        parser.error("This UDC scheduler requires Linux or macOS; use an external scheduler on other systems.")
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = hashlib.sha256(args.username.encode()).hexdigest()[:16]
    with (args.state_dir/(key+".lock")).open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Another UDC scheduler for this account is already running.")
        state_path = args.state_dir/(key+".json")
        try:
            state = json.loads(state_path.read_text()) if state_path.exists() else {}
            if not isinstance(state, dict):
                raise ValueError("Invalid UDC scheduler state")
        except (ValueError, OSError):
            parser.error("Cannot safely read UDC scheduler state; inspect it before restarting.")
        password = os.environ.get("UDC_PASSWORD") or getpass.getpass("UDC password: ")
        try:
            while True:
                target = due_time(u.now_doha(), state.get("last_attempt_date"))
                print(json.dumps({"outcome": "udc_scheduler_waiting", "next_run": target.isoformat()}), flush=True)
                while True:
                    remaining = (target-u.now_doha()).total_seconds()
                    if remaining <= 0:
                        break
                    time.sleep(min(30, max(0.05, remaining)))
                # Record before executing: restart after an uncertain write cannot replay the day.
                state["last_attempt_date"] = str(target.date())
                temporary = state_path.with_suffix(".tmp")
                with temporary.open("w") as output:
                    json.dump(state, output)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, 0o600)
                temporary.replace(state_path)
                code = u.main(["--execute-scheduled", "--username", args.username], password_provider=lambda: password)
                print(json.dumps({"outcome": "udc_scheduler_run_finished", "exit_code": code}), flush=True)
        except KeyboardInterrupt:
            return 0
        finally:
            password = None

if __name__ == "__main__":
    raise SystemExit(main())
