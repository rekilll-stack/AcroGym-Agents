#!/usr/bin/env python3
"""Watch UDC confirmations; report confirmed court hours without making reservations."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import time

import udc_booker as u

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--interval", type=int, default=60, help="Seconds between confirmation checks, minimum 60.")
    parser.add_argument("--state-dir", type=Path, default=Path.home()/".local"/"state"/"udc-court-booking")
    args = parser.parse_args(argv)
    if args.interval < 60:
        parser.error("UDC confirmation checks must be at least sixty seconds apart.")
    try:
        import fcntl
    except ImportError:
        parser.error("The UDC confirmation worker requires Linux/macOS.")
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    identifier = hashlib.sha256(args.username.encode()).hexdigest()[:16]
    with (args.state_dir/(identifier+".confirmation-worker.lock")).open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Another UDC confirmation worker is already active for this account.")
        password = os.environ.get("UDC_PASSWORD") or getpass.getpass("UDC password: ")
        report_key = os.environ.get("UDC_TENNIS_REPORT_KEY") or getpass.getpass("UDC reporting key: ")
        try:
            while True:
                code = u.main(["--sync-confirmed", "--username", args.username, "--report-state-dir", str(args.state_dir)], password_provider=lambda: password, report_key_provider=lambda: report_key)
                if code:
                    print(json.dumps({"outcome": "udc_confirmation_worker_stopped", "exit_code": code, "message": "Resolve the reported error before restarting; no automatic request replay."}), flush=True)
                    return code
                time.sleep(args.interval)
        except KeyboardInterrupt:
            return 0
        finally:
            password = report_key = None

if __name__ == "__main__":
    raise SystemExit(main())
