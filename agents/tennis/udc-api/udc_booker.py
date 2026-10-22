#!/usr/bin/env python3
"""API for booking a tennis court in UDC: two consecutive hours, manual payment."""
from __future__ import annotations
import argparse
import datetime as dt
import getpass
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

DOHA = ZoneInfo("Asia/Qatar")
BASE = "https://tpiapp.udcqatar.com/api/"
GV = "b69ef8b8-fe79-ec11-8d22-0022489cbcfa"
FP = "b89ef8b8-fe79-ec11-8d22-0022489cbcfa"
COURTS = {GV: "Giardino (GV)", FP: "Family Park / Costa Malaz"}
ALIASES = {"tennis court-gv": GV, "giardino": GV, "giardino (gv)": GV, "gv": GV,
           "tennis -basketball court-fp": FP, "family park": FP, "costa malaz": FP,
           "family park / costa malaz": FP}
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MAX_SUBMISSIONS = 3
REQUEST_TIMEOUT = 60
READ_ATTEMPTS = 3
READ_ENDPOINTS = frozenset({"Account/login", "Amenities/GetAll", "Amenities/GetAllSlots", "Amenities/GetBookedAmenity"})
WRITE_ENDPOINTS = frozenset({"Amenities/BookAmenities", "Payment/paymentAuth"})
INACTIVE = {"cancelled", "canceled", "expired", "inactive", "rejected", "cancellednonpayment", "cancelednonpayment"}

class APIError(Exception):
    pass

class MutationUnknown(APIError):
    """A submitted UDC write may have succeeded; never replay blindly."""

class NetworkError(APIError):
    """Sanitized transport diagnostics without URLs, credentials or bodies."""
    def __init__(self, endpoint, stage, cause, attempts, timeout):
        self.endpoint = endpoint
        self.stage = stage
        self.cause_type = type(getattr(cause, "reason", cause)).__name__
        self.attempts = attempts
        self.timeout_seconds = timeout
        super().__init__(f"UDC {endpoint}: {self.cause_type} during {stage}; {attempts} attempts, timeout {timeout}s each.")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def now_doha():
    return dt.datetime.now(DOHA)

class UDCAPI:
    def __init__(self, *, timeout=REQUEST_TIMEOUT, read_attempts=READ_ATTEMPTS, sleeper=None):
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("UDC request timeout must be a positive number.")
        if type(read_attempts) is not int or not 1 <= read_attempts <= READ_ATTEMPTS:
            raise ValueError("UDC read attempts must be between one and three.")
        self.token = None
        self.opener = urllib.request.build_opener(NoRedirect())
        self.timeout = timeout
        self.read_attempts = read_attempts
        self.sleep = sleeper if sleeper is not None else time.sleep

    def call(self, path, payload=None, *, mutation=False):
        allowed = READ_ENDPOINTS | WRITE_ENDPOINTS
        if path not in allowed:
            raise APIError("Endpoint is outside the UDC court-booking scope.")
        if path in WRITE_ENDPOINTS and (not mutation or not self.token):
            raise APIError("Authenticated UDC execution is required for this write.")
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(BASE + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        attempts = self.read_attempts if path in READ_ENDPOINTS and not mutation else 1
        for attempt in range(1, attempts+1):
            stage = "connection_or_headers"
            try:
                try:
                    response = self.opener.open(request, timeout=self.timeout)
                except urllib.error.HTTPError as exc:
                    response = exc
                status = response.code
                if status >= 500 or status == 408:
                    response.close()
                    if mutation:
                        raise MutationUnknown(f"UDC {path}: HTTP {status} after submission; do not replay the write.")
                    if attempt < attempts:
                        self.sleep(2*attempt)
                        continue
                    raise APIError(f"UDC {path}: HTTP {status} after {attempt} attempts.")
                stage = "response_body"
                with response:
                    raw = response.read(2_000_000)
            except (urllib.error.URLError, TimeoutError, OSError, http.client.IncompleteRead) as exc:
                if mutation:
                    kind = type(getattr(exc, "reason", exc)).__name__
                    raise MutationUnknown(f"UDC {path}: {kind} during {stage} after submission; do not replay the write.") from exc
                if attempt < attempts:
                    self.sleep(2*attempt)
                    continue
                raise NetworkError(path, stage, exc, attempt, self.timeout) from exc
            break
        try:
            content = json.loads(raw)
        except Exception as exc:
            raise (MutationUnknown if mutation else APIError)(f"UDC {path} returned an unreadable response (HTTP {status}).") from exc
        result = content.get("result", content) if isinstance(content, dict) else None
        if not isinstance(result, dict):
            raise (MutationUnknown if mutation else APIError)("Unexpected UDC response structure.")
        if status >= 400 or result.get("successful") is False:
            message = "UDC login rejected." if path == "Account/login" else str(result.get("message") or content.get("message") or f"HTTP {status}")[:250]
            if self.token:
                message = message.replace(self.token, "[redacted]")
            raise APIError(message)
        return result.get("data")

    def login(self, username, password):
        data = self.call("Account/login", {"userName": username, "password": password, "rememberMe": False, "userTimeZoneOffset": 180})
        if not isinstance(data, dict) or not data.get("token"):
            raise APIError("UDC login did not return a token.")
        self.token = data["token"]

    def catalogue(self):
        return rows(self.call("Amenities/GetAll"))

    def history(self):
        return rows(self.call("Amenities/GetBookedAmenity")) if self.token else []

    def slots(self, court_id, day):
        data = rows(self.call("Amenities/GetAllSlots", {"amenityId": court_id, "bookingDate": day.isoformat()+"T00:00:00", "pageSize": 100, "pageNumber": 1}))
        for row in data:
            if row.get("amenityId") != court_id or row.get("day") != WEEKDAYS[day.weekday()]:
                raise APIError("UDC returned slots for a different court or weekday.")
        return data

def rows(value):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise APIError("UDC did not return a list of records.")
    return value

def windows(day):
    return [] if day.weekday() in (4, 5) else [("evening", 18, 21)] + ([("morning", 7, 9)] if day.weekday() == 0 else [])

def scheduled_target(now):
    now = now.astimezone(DOHA)
    if now.weekday() in (4, 5):
        raise APIError("UDC Friday/Saturday execution is disabled.")
    if now.hour != 0 or now.minute >= 5:
        raise APIError("UDC reservation writes are allowed only between 00:00 and 00:05 Doha time.")
    return now.date() + dt.timedelta(days=7)

HORIZON_DAYS = int(os.environ.get("UDC_HORIZON_DAYS", "7"))  # 18.10 владелец: правило 7 дней (UDC пускает и на 14, но не используем)

def manual_target(day, window, now):
    """Validate a separately authorized, one-off booking; scheduler is unchanged."""
    now = now.astimezone(DOHA)
    if not 0 <= (day-now.date()).days <= HORIZON_DAYS:  # 18.10: UDC даёт бронировать дальше недели (проверено +8) — днём, когда владелец может сразу оплатить
        raise APIError(f"UDC one-off booking date must be today through date+{HORIZON_DAYS} in Doha.")
    match = next((w for w in windows(day) if w[0] == window), None)
    if match is None:
        raise APIError("UDC one-off booking must use an allowed weekday and time window.")
    if day == now.date() and now >= dt.datetime.combine(day, dt.time(match[1]), DOHA):
        raise APIError("UDC one-off booking window has already started.")
    return day

def slot_hours(value):
    match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*", str(value))
    if not match:
        return None
    h1, m1, h2, m2 = map(int, match.groups())
    if h1 > 23 or h2 > 23 or m1 > 59 or m2 > 59:
        return None
    return h1*60+m1, h2*60+m2

def timestamp(value):
    try:
        value = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return value.astimezone(DOHA) if value.tzinfo is not None else None
    except (ValueError, TypeError):
        return None

def norm(value):
    return re.sub(r"[^a-z]", "", str(value).casefold())

def confirmed(info):
    r = info["record"]
    return norm(r.get("status")) == "active" and norm(r.get("paymentStatus")) == "confirmed"

def status_requires_review(info):
    r = info["record"]
    return norm(r.get("status")) not in {"active", "pending", "reserved", "booked", "awaitingpayment", "inprogress"} or (r.get("bookingCharges") != 0 and norm(r.get("paymentStatus")) not in {"confirmed", "paid", "settled", "pending", "unpaid", "notpaid", "unconfirmed", "notconfirmed", "awaitingpayment", "paymentpending", "inprogress", "initiated"})

def held_bookings(history, day, window, now):
    _, lower, upper = window
    held, seen = [], set()
    for r in history:
        name = re.sub(r"\s+", " ", str(r.get("amenityName", ""))).strip().casefold()
        court_id = r.get("amenityId") if r.get("amenityId") in COURTS else ALIASES.get(name)
        if court_id is None or norm(r.get("status")) in INACTIVE:
            continue
        expiry = timestamp(r.get("bookingExpiry"))
        if norm(r.get("paymentStatus")) != "confirmed" and expiry is not None and expiry <= now:
            continue
        start, end = timestamp(r.get("bookingStartDateTime")), timestamp(r.get("bookingEndDateTime"))
        interval = slot_hours(r.get("bookingTimeSlot"))
        if str(r.get("bookingDate", ""))[:10] == day.isoformat() and interval is not None:
            midnight = dt.datetime.combine(day, dt.time(), DOHA)
            s, e = (midnight + dt.timedelta(minutes=m) for m in interval)
            known = [(actual, shown) for actual, shown in ((start, s), (end, e)) if actual is not None]
            shifts = {shown-actual for actual, shown in known}
            # Verified in live UDC history: the displayed local slot is correct,
            # while both service timestamps can carry an extra UTC+3 conversion.
            # Accept only that exact, equal shift; any other conflict needs review.
            if shifts and shifts != {dt.timedelta()} and not (len(known) == 2 and shifts == {dt.timedelta(hours=3)}):
                raise APIError("UDC booking timestamps disagree with its displayed slot; review required.")
            start, end = s, e
        elif start is None or end is None:
            if str(r.get("bookingDate", ""))[:10] != day.isoformat():
                continue
            if interval is None:
                raise APIError("An existing UDC booking on the target date cannot be interpreted safely.")
            midnight = dt.datetime.combine(day, dt.time(), DOHA)
            s, e = (midnight + dt.timedelta(minutes=m) for m in interval)
            if (start is not None and start != s) or (end is not None and end != e):
                raise APIError("UDC booking timestamps disagree with its displayed slot.")
            start, end = s, e
        if start.date() != day or end.date() != day:
            continue
        first, last = start.hour*60+start.minute, end.hour*60+end.minute
        if not lower*60 <= first < last <= upper*60:
            continue
        key = r.get("id") or (court_id, first, last)
        if key not in seen:
            seen.add(key)
            held.append({"court_id": court_id, "court": COURTS[court_id], "start": first, "end": last, "record": r})
    return sorted(held, key=lambda x: (x["start"], x["court_id"]))

def candidates(api, day, window, tennis_type):
    _, lower, upper = window
    with ThreadPoolExecutor(max_workers=2) as pool:
        datasets = list(pool.map(lambda cid: (cid, api.slots(cid, day)), COURTS))
    found = {}
    for cid, dataset in datasets:
        for r in dataset:
            interval = slot_hours(r.get("timeSlot"))
            if r.get("amenityTypeId") != tennis_type or r.get("isAvailable") is not True or r.get("isInException") is True or interval is None:
                continue
            first, last = interval
            if not (lower*60 <= first < last <= upper*60 and last-first == 60 and r.get("duration") == 60):
                continue
            cost = r.get("bookingCost")
            if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0:
                raise APIError("UDC did not return a valid price.")
            if not isinstance(r.get("isPaymentRequired"), bool) or type(r.get("timeSlotId")) is not int or type(r.get("dayId")) is not int:
                raise APIError("UDC did not return valid payment/slot/day fields.")
            key = cid, first, last
            if key in found and (found[key]["slot"]["bookingCost"] != cost or found[key]["slot"]["timeSlotId"] != r["timeSlotId"]):
                raise APIError("UDC returned conflicting data for the same hour.")
            found[key] = {"court_id": cid, "court": COURTS[cid], "slot": r, "start": first, "end": last}
    return sorted(found.values(), key=lambda x: (x["start"], x["slot"]["bookingCost"], x["court_id"]))

def held_minutes(held):
    return sum(x["end"]-x["start"] for x in held)

def contiguous_pair(held):
    if held_minutes(held) != 120 or not held or len({x["court_id"] for x in held}) != 1:
        return False
    ordered = sorted(held, key=lambda x: x["start"])
    return all(a["end"] == b["start"] for a, b in zip(ordered, ordered[1:]))

def choose_plan(available, held):
    if held_minutes(held) >= 120 or len(held) >= 2:
        return []
    if held:
        if len(held) != 1 or held_minutes(held) != 60:
            return []
        old = held[0]
        return sorted((x for x in available if x["court_id"] == old["court_id"] and
                       (x["end"] == old["start"] or x["start"] == old["end"])), key=lambda x: (x["start"], x["slot"]["bookingCost"]))[:1]
    pairs = [[a, b] for a in available for b in available if a["court_id"] == b["court_id"] and a["end"] == b["start"]]
    if pairs:
        return min(pairs, key=lambda p: (p[0]["court_id"] != GV, p[0]["start"], sum(x["slot"]["bookingCost"] for x in p)))  # владелец 15.10: Giardino первым, Family Park — запасной
    return sorted(available, key=lambda x: x["court_id"] != GV)[:1]

def booking_payload(item, day, catalogue):
    r = item["slot"]
    court = next((x for x in catalogue if x.get("id") == item["court_id"]), None)
    if court is None or not isinstance(court.get("precinctLock"), bool):
        raise APIError("UDC court metadata is missing or changed.")
    midnight = dt.datetime.combine(day, dt.time(), DOHA)
    return {"amenityId": item["court_id"], "amenityTypeId": r["amenityTypeId"], "isPaymentRequired": r["isPaymentRequired"],
            "bookingDate": day.isoformat()+"T00:00:00", "bookingDayId": r["dayId"],
            "bookingStartTime": (midnight+dt.timedelta(minutes=item["start"])).isoformat(),
            "bookingEndTime": (midnight+dt.timedelta(minutes=item["end"])).isoformat(),
            "bookingTimeSlotId": r["timeSlotId"], "bookingCharges": r["bookingCost"],
            "bookingChargesAfterDiscount": r["bookingCost"], "precinctLock": court["precinctLock"]}

def public_booking(info):
    r = info["record"]
    return {"bookingId": r.get("id"), "court": info["court"],
            "time": f'{info["start"]//60:02}:{info["start"]%60:02}-{info["end"]//60:02}:{info["end"]%60:02}',
            "charge_QAR": r.get("bookingCharges"), "reference": r.get("bookingReferenceNumber"),
            "status": r.get("status"), "paymentStatus": r.get("paymentStatus"),
            "paymentDeadline": r.get("bookingPaymentDeadLine"), "expiry": r.get("bookingExpiry")}

def checkout_link(api, info):
    r = info["record"]
    if norm(r.get("paymentStatus")) in {"confirmed", "paid", "settled"}:
        return {"outcome": "payment_not_needed", "bookingId": r.get("id")}
    if status_requires_review(info):
        return {"outcome": "payment_status_unknown_review_required", "bookingId": r.get("id")}
    try:
        booking_id = str(uuid.UUID(str(r.get("id"))))
        amount = Decimal(str(r.get("bookingCharges")))  # 18.10: сумма — цена брони в формате «75.00» («75» шлюз отвергает); списывает UDC свою цену
        if not amount.is_finite() or amount < 0 or amount != amount.quantize(Decimal("0.01")):
            raise ValueError("Invalid UDC booking amount.")
        if amount == 0:
            return {"outcome": "zero_charge_no_checkout", "bookingId": booking_id}
        data = api.call("Payment/paymentAuth", {"order": {"amount": format(amount, ".2f"), "currency": "QAR", "description": "Amenity Booking"}, "bookedAmenityId": booking_id}, mutation=True)  # 18.10: другое описание → HTTP 500
        if not isinstance(data, dict) or not isinstance(data.get("redirectURL"), str):
            raise APIError("UDC checkout did not return a payment link.")
        url = data["redirectURL"]
        if url.lstrip().startswith("{"):  # 18.10: ссылка приходит JSON-строкой {"redirect_url": …} или ошибкой шлюза
            j = json.loads(url); url = j.get("redirect_url") or ""
            if not url: raise APIError("UDC checkout error: " + json.dumps(j.get("errors") or j.get("error_message"))[:200])
        parsed = urllib.parse.urlsplit(url)
        if len(url) > 4096 or any(ord(c) < 33 or ord(c) == 127 for c in url) or "\\" in url or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise APIError("UDC returned an invalid checkout URL.")
        return {"outcome": "manual_payment_link", "bookingId": booking_id, "amount_QAR": format(amount, ".2f"), "url": url,
                "orderId": data.get("orderId"), "deadline": r.get("bookingPaymentDeadLine"), "expiry": r.get("bookingExpiry")}
    except (APIError, InvalidOperation, ValueError, TypeError) as exc:
        return {"outcome": "checkout_link_unavailable", "bookingId": r.get("id"), "message": str(exc)[:250]}

def window_result(day, window, held, *, reason=None, created_ids=None, payments=None, safety_stop=False):
    minutes = held_minutes(held)
    continuous = contiguous_pair(held)
    paid = bool(held) and all(confirmed(x) for x in held)
    if any(norm(x["record"].get("status")) == "unverified" for x in held):
        outcome = "booking_created_requires_verification"
    elif any(status_requires_review(x) for x in held):
        outcome = "booking_status_requires_review"
    elif not held:
        outcome = "no_reservation"
    elif continuous:
        outcome = "confirmed_two_hours" if paid else "reserved_two_hours_pending"
    elif minutes == 60 and len(held) == 1:
        outcome = "confirmed_one_hour_fallback" if paid else "reserved_one_hour_pending"
    else:
        outcome = "existing_bookings_require_review"
    amounts = [x["record"].get("bookingCharges") for x in held]
    numeric = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in amounts)
    return {"outcome": outcome, "date": day.isoformat(), "window": window[0], "preferred_hours": 2, "held_hours": minutes/60,
            "two_consecutive_hours_same_court": continuous, "total_QAR": round(sum(amounts), 2) if numeric else None,
            "bookings": [public_booking(x) for x in held], "new_booking_ids": created_ids or [],
            "payments": payments or [], "reason": reason, "safety_stop": safety_stop}

def process_window(api, day, window, catalogue, tennis_type, *, execute=False, clock=now_doha, execution_guard=scheduled_target):
    held = held_bookings(api.history(), day, window, clock())
    available = candidates(api, day, window, tennis_type) if held_minutes(held) < 120 and len(held) < 2 else []
    if not execute:
        plan = choose_plan(available, held)
        return {"outcome": "preview_only", "date": day.isoformat(), "window": window[0], "preferred_hours": 2,
                "existing_bookings": [public_booking(x) for x in held], "planned_new_hours": len(plan),
                "planned_total_hours": held_minutes(held)/60+len(plan),
                "requests": [{"court": x["court"], "payload": booking_payload(x, day, catalogue)} for x in plan]}
    created_ids, attempted, pending = [], set(), []
    reason, safety_stop = None, False
    def hb():  # 18.10: неоплаченная бронь в истории UDC не видна (держится 5 мин до оплаты) — добавляем свои созданные сами
        h = held_bookings(api.history(), day, window, clock()); ids = {str(x["record"].get("id", "")).casefold() for x in h}
        return h + [x for x in pending if x["record"]["id"].casefold() not in ids]
    for _ in range(MAX_SUBMISSIONS):
        try:
            held = hb()
            if any(status_requires_review(x) for x in held):
                reason, safety_stop = "existing_booking_status_requires_review", True
                break
            if held_minutes(held) >= 120 or len(held) >= 2:
                reason = None
                break
            available = [x for x in candidates(api, day, window, tennis_type) if (x["court_id"], x["start"]) not in attempted]
            held = hb()
        except APIError as exc:
            reason, safety_stop = "udc_state_unavailable: " + str(exc), True
            break
        plan = choose_plan(available, held)
        if not plan:
            reason = "no_adjacent_hour_available" if held else "no_available_hour"
            break
        selected = plan[0]
        try:
            if execution_guard(clock()) != day:
                raise APIError("UDC target date changed before submission.")
        except APIError as exc:
            reason = str(exc)
            break
        attempted.add((selected["court_id"], selected["start"]))
        try:
            response = api.call("Amenities/BookAmenities", booking_payload(selected, day, catalogue), mutation=True)
        except MutationUnknown:
            reason, safety_stop = "submission_uncertain_no_further_booking_writes", True
            try:
                held = held_bookings(api.history(), day, window, clock())
            except APIError:
                pass
            break
        except APIError as exc:
            if any(w in str(exc).casefold() for w in ("not available", "already booked", "unavailable", "occupied")):
                reason = "slot_conflict"
                continue
            reason = str(exc)
            break
        try:
            booking_id = str(uuid.UUID(str(response.get("bookingId")))) if isinstance(response, dict) else None
        except (ValueError, TypeError, AttributeError):
            booking_id = None
        if not booking_id:
            reason, safety_stop = "booking_response_unverifiable_no_further_writes", True
            break
        created_ids.append(booking_id)
        verified = None
        try:
            for _ in range(2):
                held = held_bookings(api.history(), day, window, clock())
                verified = next((x for x in held if str(x["record"].get("id", "")).casefold() == booking_id), None)
                if verified is not None:
                    break
        except APIError:
            pass
        if verified is None:  # 18.10: так у UDC выглядит обычная неоплаченная бронь — ждёт оплаты 5 минут
            pending.append({**{k: selected[k] for k in ("court_id", "court", "start", "end")}, "record": {"id": booking_id, "bookingCharges": selected["slot"]["bookingCost"],
                "bookingReferenceNumber": response.get("referenceNumber"), "status": "Pending", "paymentStatus": "Pending",
                "bookingExpiry": response.get("expiryDate"), "bookingPaymentDeadLine": response.get("expiryDate")}})
            try:
                held = hb()
            except APIError:  # история недоступна сразу после записи — номер брони сохраняем, дальше не пишем
                held = held + [pending[-1]]
                reason, safety_stop = "udc_history_unavailable_after_write", True
                break
            continue
        if any(verified[k] != selected[k] for k in ("court_id", "start", "end")):
            reason, safety_stop = "created_booking_differs_from_requested_slot", True
            break
        if verified["record"].get("bookingCharges") != selected["slot"]["bookingCost"]:
            reason, safety_stop = "created_booking_price_changed_review_required", True
            break
    else:
        reason = None if held_minutes(held) >= 120 else "booking_attempt_limit_reached"
    payments = [checkout_link(api, x) for x in held if not confirmed(x)] if not safety_stop else []
    return window_result(day, window, held, reason=reason, created_ids=created_ids, payments=payments, safety_stop=safety_stop)

def main(argv=None, *, password_provider=None, report_key_provider=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", type=dt.date.fromisoformat, metavar="YYYY-MM-DD", help="Read-only two-hour UDC plan.")
    mode.add_argument("--check-login", action="store_true", help="Verify UDC login and history without writing.")
    mode.add_argument("--status", type=dt.date.fromisoformat, metavar="YYYY-MM-DD", help="Read own UDC booking/payment status.")
    mode.add_argument("--payment-links", type=dt.date.fromisoformat, metavar="YYYY-MM-DD", help="Create checkout links for own existing UDC reservations; never pay.")
    mode.add_argument("--execute-scheduled", action="store_true", help="Reserve date+7, only 00:00–00:05 Doha, Sunday–Thursday.")
    mode.add_argument("--execute-once", type=dt.date.fromisoformat, metavar="YYYY-MM-DD", help="Separately authorized one-off UDC booking, today through date+7; requires --window.")
    mode.add_argument("--sync-confirmed", action="store_true", help="Read UDC confirmations and report them to the owner's tennis server.")
    mode.add_argument("--preview-sync", action="store_true", help="Read UDC confirmations and preview report payloads without sending them.")
    parser.add_argument("--username", help="UDC username; password is requested without echo.")
    parser.add_argument("--window", choices=("evening", "morning"), help="Required with --execute-once; books only this single allowed window.")
    parser.add_argument("--sync-date", type=dt.date.fromisoformat, metavar="YYYY-MM-DD", help="Limit UDC reporting to this date; default today through date+7.")
    parser.add_argument("--report-confirmed", action="store_true", help="After scheduled UDC booking, report already-confirmed hours only.")
    parser.add_argument("--report-state-dir", type=Path, default=Path.home()/".local"/"state"/"udc-court-booking", help="Persistent UDC reporting journal directory, without secrets.")
    args = parser.parse_args(argv)
    api = UDCAPI()
    try:
        syncing = args.sync_confirmed or args.preview_sync
        if args.report_confirmed and not args.execute_scheduled:
            raise APIError("--report-confirmed requires --execute-scheduled.")
        if args.sync_date and not syncing:
            raise APIError("--sync-date requires a UDC sync mode.")
        if bool(args.execute_once) != bool(args.window):
            raise APIError("--execute-once and --window must be provided together.")
        day = scheduled_target(now_doha()) if args.execute_scheduled else args.preview or args.status or args.payment_links or args.execute_once
        if args.execute_once:
            manual_target(day, args.window, now_doha())
        if (args.execute_scheduled or args.execute_once or args.check_login or args.status or args.payment_links or syncing) and not args.username:
            raise APIError("--username is required for authenticated UDC operations.")
        if args.username:
            password = password_provider() if password_provider is not None else os.environ.get("UDC_PASSWORD") or getpass.getpass("UDC password: ")
            try:
                api.login(args.username, password)
            finally:
                password = None
        if args.check_login:
            api.history()
            print(json.dumps({"outcome": "udc_login_and_history_verified"}))
            return 0
        def report(days, preview=False):
            import udc_report
            provider = report_key_provider or (lambda: os.environ.get("UDC_TENNIS_REPORT_KEY") or getpass.getpass("UDC reporting key: "))
            key = hashlib.sha256(args.username.encode()).hexdigest()[:16]
            return udc_report.sync(api, days, key_provider=provider, state_path=args.report_state_dir/(key+".reports.json"), preview=preview)
        if syncing:
            days = [args.sync_date] if args.sync_date else [now_doha().date()+dt.timedelta(days=n) for n in range(8)]
            receipt = report(days, args.preview_sync)
            print(json.dumps(receipt, ensure_ascii=False), flush=True)
            return 2 if any(x.get("stop") or x.get("outcome") == "report_invalid_data" for x in receipt.get("reports", [])) else 0
        if not windows(day):
            print(json.dumps({"outcome": "excluded_friday_saturday", "date": day.isoformat()}))
            return 0
        if args.status or args.payment_links:
            history = api.history()
            for window in windows(day):
                held = held_bookings(history, day, window, now_doha())
                payments = [checkout_link(api, x) for x in held if not confirmed(x)] if args.payment_links else []
                print(json.dumps(window_result(day, window, held, payments=payments), ensure_ascii=False), flush=True)
            return 0
        catalogue = api.catalogue()
        gv = next((x for x in catalogue if x.get("id") == GV), None)
        if gv is None or "tennis" not in str(gv.get("name", "")).casefold() or type(gv.get("amenityTypeId")) is not int:
            raise APIError("Cannot verify UDC tennis activity from the Giardino catalogue.")
        chosen_windows = [w for w in windows(day) if not args.window or w[0] == args.window]
        guard = (lambda now: manual_target(day, args.window, now)) if args.execute_once else scheduled_target
        for window in chosen_windows:
            result = process_window(api, day, window, catalogue, gv["amenityTypeId"], execute=bool(args.execute_scheduled or args.execute_once), execution_guard=guard)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if result.get("safety_stop"):
                break
        if args.report_confirmed and not result.get("safety_stop"):
            receipt = report([day])
            print(json.dumps(receipt, ensure_ascii=False), flush=True)
            if any(x.get("stop") or x.get("outcome") == "report_invalid_data" for x in receipt.get("reports", [])):
                return 2
        return 0
    except (APIError, KeyboardInterrupt) as exc:
        error = {"outcome": "error", "message": str(exc)}
        if isinstance(exc, NetworkError):
            error.update(endpoint=exc.endpoint, stage=exc.stage, cause_type=exc.cause_type, attempts=exc.attempts, timeout_seconds=exc.timeout_seconds)
        print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        api.token = None

if __name__ == "__main__":
    sys.modules.setdefault("udc_booker", sys.modules[__name__])
    raise SystemExit(main())
