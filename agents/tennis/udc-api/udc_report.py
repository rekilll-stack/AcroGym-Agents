#!/usr/bin/env python3
"""Report confirmed UDC court bookings to the owner's tennis endpoint."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import udc_booker as u

ENDPOINT = "https://hook.acrogym.org/tennis"
MAX_RETRIES = 3
RETRY_SECONDS = 60
COURT_NAMES = {u.GV: "Giardino", u.FP: "Family Park"}

class ReportError(u.APIError):
    pass

def validate(payload, now):
    if not isinstance(payload, dict) or not {"date", "from", "to"} <= payload.keys() or payload.keys()-{"date", "from", "to", "court"}:
        raise ReportError("UDC report accepts only date, from, to and optional court.")
    try:
        day = dt.date.fromisoformat(payload["date"])
    except (ValueError, TypeError):
        raise ReportError("UDC report date must be YYYY-MM-DD.") from None
    if str(day) != payload["date"] or not now.astimezone(u.DOHA).date()-dt.timedelta(days=1) <= day <= now.astimezone(u.DOHA).date()+dt.timedelta(days=60):
        raise ReportError("UDC report date is outside yesterday through sixty days ahead.")
    for name in ("from", "to"):
        if not isinstance(payload[name], str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", payload[name]):
            raise ReportError("UDC report time must be HH:MM in Doha.")
    interval = u.slot_hours(payload["from"]+"-"+payload["to"])
    if interval is None or not interval[0] < interval[1] or not any(w[1]*60 <= interval[0] < interval[1] <= w[2]*60 for w in u.windows(day)):
        raise ReportError("UDC report is outside the authorized court-booking window.")
    if "court" in payload and payload["court"] not in COURT_NAMES.values():
        raise ReportError("UDC report court must be Giardino or Family Park.")

def confirmed_payloads(history, days, now):
    payloads, deferred = [], []
    for day in sorted(set(days)):
        for window in u.windows(day):
            held = u.held_bookings(history, day, window, now)
            if not held:
                continue
            # Wait for both reserved hours, avoiding an initial one-hour calendar entry.
            if any(not u.confirmed(item) for item in held):
                deferred.append({"date": str(day), "window": window[0], "reason": "awaiting_confirmation_of_reserved_hours"})
                continue
            for cid in COURT_NAMES:
                intervals = sorted((x["start"], x["end"]) for x in held if x["court_id"] == cid)
                merged = []
                for start, end in intervals:
                    if merged and start <= merged[-1][1]:
                        merged[-1][1] = max(merged[-1][1], end)
                    else:
                        merged.append([start, end])
                for start, end in merged:
                    payload = {"date": str(day), "from": f"{start//60:02}:{start%60:02}", "to": f"{end//60:02}:{end%60:02}", "court": COURT_NAMES[cid]}
                    validate(payload, now)
                    payloads.append(payload)
    return payloads, deferred

class Reporter:
    def __init__(self, key, *, clock=u.now_doha, sleep=time.sleep):
        if not isinstance(key, str) or not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise ReportError("UDC report key is missing or invalid.")
        self.key = key
        self.clock = clock
        self.sleep = sleep
        self.opener = urllib.request.build_opener(u.NoRedirect())

    def post(self, payload):
        for attempt in range(MAX_RETRIES+1):
            receipt = self._post_once(payload)
            if not receipt.pop("retryable", False):
                return {**receipt, "attempts": attempt+1}
            if attempt < MAX_RETRIES:
                self.sleep(RETRY_SECONDS)
        return {**receipt, "attempts": MAX_RETRIES+1, "retry_exhausted": True,
                "message": "UDC reporting failed after the initial request and three one-minute retries; notify the owner before further attempts."}

    def _post_once(self, payload):
        validate(payload, self.clock())
        request = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), headers={"Authorization": "Bearer "+self.key, "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
        try:
            response = self.opener.open(request, timeout=25)
        except urllib.error.HTTPError as exc:
            response = exc
        except (urllib.error.URLError, OSError, TimeoutError):
            return {"outcome": "report_uncertain", "stop": True, "retryable": True, "message": "UDC reporting network error."}
        status = response.code
        if 500 <= status <= 599:
            response.close()
            return {"outcome": "report_uncertain", "stop": True, "retryable": True, "http_status": status}
        if status in (401, 403):
            response.close()
            if status == 401:
                return {"outcome": "report_unauthorized", "stop": True, "message": "UDC reporting key was rejected; stop until a replacement key is configured."}
            return {"outcome": "report_access_blocked", "stop": True, "message": "UDC reporting access was denied before acceptance; resolve access before retrying."}
        try:
            with response:
                data = json.loads(response.read(65_536))
        except (urllib.error.URLError, OSError, TimeoutError):
            return {"outcome": "report_uncertain", "stop": True, "retryable": True, "message": "UDC reporting response could not be received."}
        except Exception:
            data = None
        if status == 400:
            message = str(data.get("err", "Invalid UDC reporting data.")) if isinstance(data, dict) else "Invalid UDC reporting data."
            return {"outcome": "report_invalid_data", "stop": False, "message": message.replace(self.key, "[redacted]")[:400]}
        if status != 200 or not isinstance(data, dict) or data.get("ok") is not True:
            return {"outcome": "report_uncertain", "stop": True, "message": "UDC reporting did not return a verifiable acceptance.", "http_status": status}
        if data.get("duplicate") is True:
            return {"outcome": "already_recorded", "stop": False, "accepted": True, "duplicate": True}
        if data.get("calendar") is True:
            return {"outcome": "added_to_calendar_and_jarvis", "stop": False, "accepted": True, "calendar": True}
        if data.get("calendar") is False:
            return {"outcome": "accepted_calendar_pending", "stop": False, "accepted": True, "calendar": False}
        return {"outcome": "report_uncertain", "stop": True, "message": "UDC reporting acceptance did not include calendar or duplicate status."}

def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        json.dump(state, output)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o600)
    temporary.replace(path)

def overlaps(a, b):
    return a.get("date") == b.get("date") and a.get("court") == b.get("court") and a["from"] < b["to"] and b["from"] < a["to"]

def deliver(payloads, reporter, state_path):
    """A durable local journal prevents repeat writes; the server also deduplicates."""
    try:
        import fcntl
    except ImportError:
        raise ReportError("UDC reporting journal requires Linux/macOS or an equivalent external executor.") from None
    path = Path(state_path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReportError("Another UDC reporting process is already active.") from None
        try:
            state = json.loads(path.read_text()) if path.exists() else {"entries": {}}
            if not isinstance(state, dict) or not isinstance(state.get("entries"), dict):
                raise ValueError()
        except (OSError, ValueError):
            raise ReportError("Cannot safely read the UDC reporting journal; do not discard it to replay requests.") from None
        key_hash = hashlib.sha256(reporter.key.encode()).hexdigest()
        if state.get("blocked_key_hash") == key_hash:
            return [{"outcome": "report_unauthorized", "stop": True, "message": "This UDC reporting key previously returned 401; no request was repeated."}]
        results = []
        for payload in payloads:
            validate(payload, reporter.clock())
            identifier = fingerprint(payload)
            previous = state["entries"].get(identifier)
            if previous and previous.get("state") == "accepted":
                results.append({"outcome": "already_reported_locally", "payload": payload, "accepted": True})
                continue
            if previous and previous.get("state") in {"uncertain", "rejected"}:
                results.append({"outcome": "previous_report_requires_review", "payload": payload, "stop": True})
                break
            conflict = any(key != identifier and entry.get("state") in {"accepted", "uncertain"} and overlaps(payload, entry["payload"]) for key, entry in state["entries"].items())
            if conflict:
                results.append({"outcome": "overlapping_report_requires_review", "payload": payload, "stop": True, "message": "An earlier shorter or overlapping entry exists; this add-only endpoint cannot safely replace it."})
                break
            state["entries"][identifier] = {"payload": payload, "state": "uncertain"}
            save_state(path, state)
            receipt = reporter.post(payload)
            results.append({**receipt, "payload": payload})
            state["entries"][identifier]["state"] = "accepted" if receipt.get("accepted") else "auth_failed" if receipt["outcome"] == "report_unauthorized" else "access_blocked" if receipt["outcome"] == "report_access_blocked" else "rejected" if receipt["outcome"] == "report_invalid_data" else "uncertain"
            if receipt["outcome"] == "report_unauthorized":
                state["blocked_key_hash"] = key_hash
            save_state(path, state)
            if receipt.get("stop"):
                break
        return results

def sync(api, days, *, key_provider, state_path, preview=False, clock=u.now_doha):
    payloads, deferred = confirmed_payloads(api.history(), days, clock())
    if preview:
        return {"outcome": "report_preview_only", "payloads": payloads, "deferred": deferred}
    if not payloads:
        return {"outcome": "nothing_confirmed_to_report", "reports": [], "deferred": deferred}
    reporter = Reporter(key_provider(), clock=clock)
    try:
        return {"outcome": "udc_confirmation_reporting", "reports": deliver(payloads, reporter, state_path), "deferred": deferred}
    finally:
        reporter.key = None
