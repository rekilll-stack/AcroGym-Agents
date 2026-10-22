"""Tests for the API for booking a tennis court in UDC. No live writes."""
import datetime as dt
import contextlib
import io
import json
import socket
import tempfile
import unittest
import urllib.error
import uuid
from copy import deepcopy
from unittest.mock import patch

import udc_booker as u
import udc_scheduler as scheduler

DAY = dt.date(2026, 10, 25)
NOW = dt.datetime(2026, 10, 18, 0, 0, 0, tzinfo=u.DOHA)
EVENING = ("evening", 18, 21)
TENNIS = 100000001
CATALOGUE = [{"id": cid, "name": name, "amenityTypeId": TENNIS, "precinctLock": False} for cid, name in u.COURTS.items()]

def slot(cid, hour, *, cost=100, available=True, sport=TENNIS):
    return {"amenityId": cid, "amenityTypeId": sport, "day": "Sunday", "dayId": 6,
            "timeSlotId": hour, "timeSlot": f"{hour:02}:00-{hour+1:02}:00", "duration": 60,
            "bookingCost": cost, "isAvailable": available, "isInException": False, "isPaymentRequired": True}

def record(cid=u.GV, hour=18, *, day=DAY, paid=False, cost=100, booking_id=None):
    midnight = dt.datetime.combine(day, dt.time(), u.DOHA)
    expiry = (midnight-dt.timedelta(days=7)+dt.timedelta(hours=1)).isoformat()
    return {"id": booking_id or str(uuid.uuid4()), "amenityName": u.COURTS[cid], "bookingDate": day.isoformat()+"T00:00:00",
            "bookingStartDateTime": (midnight+dt.timedelta(hours=hour)).astimezone(dt.timezone.utc).isoformat(),
            "bookingEndDateTime": (midnight+dt.timedelta(hours=hour+1)).astimezone(dt.timezone.utc).isoformat(),
            "bookingTimeSlot": f"{hour:02}:00-{hour+1:02}:00", "bookingCharges": cost, "bookingReferenceNumber": "UDC-TEST",
            "status": "Active", "paymentStatus": "Confirmed" if paid else "Pending",
            "bookingExpiry": expiry, "bookingPaymentDeadLine": expiry}

class FakeAPI:
    def __init__(self, slots=None, history=None, failures=None, visible=True):
        self.token = "synthetic-test-token"
        self.data = slots or {u.GV: [slot(u.GV, 18), slot(u.GV, 19)], u.FP: []}
        self.records = deepcopy(history or [])
        self.failures = failures or {}
        self.visible = visible
        self.calls = []
        self.book_calls = 0
        self.checkout_url = "https://checkout.example.test/udc/order"
        self.price_delta = 0
        self.fail_reads_after_write = False

    def history(self):
        if self.book_calls and self.fail_reads_after_write:
            raise u.APIError("UDC history unavailable")
        return deepcopy(self.records)

    def slots(self, cid, day):
        return deepcopy(self.data.get(cid, []))

    def call(self, path, payload=None, *, mutation=False):
        self.calls.append((path, deepcopy(payload), mutation))
        if path == "Amenities/BookAmenities":
            self.book_calls += 1
            failure = self.failures.get(self.book_calls)
            if failure is not None:
                raise failure
            start = dt.datetime.fromisoformat(payload["bookingStartTime"])
            r = record(payload["amenityId"], start.hour, day=start.date(), cost=payload["bookingCharges"]+self.price_delta)
            if self.visible:
                self.records.append(r)
            return {"bookingId": r["id"], "referenceNumber": r["bookingReferenceNumber"], "expiryDate": r["bookingExpiry"]}
        if path == "Payment/paymentAuth":
            return {"redirectURL": self.checkout_url, "orderId": "synthetic-order"}
        raise AssertionError("Unexpected endpoint: " + path)

def execute(api, *, clock=lambda: NOW):
    return u.process_window(api, DAY, EVENING, CATALOGUE, TENNIS, execute=True, clock=clock)

class PlanningTests(unittest.TestCase):
    def test_sunday_to_thursday_only_and_monday_both_windows(self):
        self.assertEqual(u.windows(dt.date(2026, 10, 19)), [("evening", 18, 21), ("morning", 7, 9)])
        for d in (dt.date(2026, 10, 16), dt.date(2026, 10, 17)):
            self.assertEqual(u.windows(d), [])
        for d in (18, 20, 21, 22):
            self.assertEqual(u.windows(dt.date(2026, 10, d)), [EVENING])

    def test_date_plus_seven_uses_doha_not_utc(self):
        utc = dt.datetime(2026, 10, 17, 21, 0, tzinfo=dt.timezone.utc)
        self.assertEqual(u.scheduled_target(utc), DAY)

    def test_execution_time_and_weekend_guards(self):
        for now in (NOW.replace(hour=18), NOW.replace(minute=5), NOW.replace(day=16), NOW.replace(day=17)):
            with self.subTest(now=now), self.assertRaises(u.APIError):
                u.scheduled_target(now)

    def test_two_hours_same_court_take_priority_over_single(self):
        api = FakeAPI({u.GV: [slot(u.GV, 18)], u.FP: [slot(u.FP, 19), slot(u.FP, 20)]})
        result = u.process_window(api, DAY, EVENING, CATALOGUE, TENNIS, clock=lambda: NOW)
        self.assertEqual(result["planned_new_hours"], 2)
        self.assertEqual([x["payload"]["amenityId"] for x in result["requests"]], [u.FP, u.FP])
        self.assertEqual(api.calls, [])

    def test_single_hour_fallback_and_no_cross_court_pair(self):
        api = FakeAPI({u.GV: [slot(u.GV, 18)], u.FP: [slot(u.FP, 19)]})
        result = execute(api)
        self.assertEqual(result["held_hours"], 1)
        self.assertEqual(api.book_calls, 1)
        self.assertFalse(result["two_consecutive_hours_same_court"])

    def test_filter_other_sport_exception_unavailable_outside_window(self):
        excluded = [slot(u.GV, 17), slot(u.GV, 21), slot(u.GV, 18, sport=100000000), slot(u.GV, 19, available=False)]
        exception = slot(u.GV, 20)
        exception["isInException"] = True
        excluded.append(exception)
        self.assertEqual(u.candidates(FakeAPI({u.GV: excluded}), DAY, EVENING, TENNIS), [])

    def test_conflicting_slot_prices_fail_closed(self):
        with self.assertRaises(u.APIError):
            u.candidates(FakeAPI({u.GV: [slot(u.GV, 18), slot(u.GV, 18, cost=150)]}), DAY, EVENING, TENNIS)

    def test_server_price_and_local_midnight_are_preserved(self):
        item = u.candidates(FakeAPI({u.GV: [slot(u.GV, 18, cost=87.5)]}), DAY, EVENING, TENNIS)[0]
        payload = u.booking_payload(item, DAY, CATALOGUE)
        self.assertEqual(payload["bookingDate"], "2026-10-25T00:00:00")
        self.assertEqual(payload["bookingStartTime"], "2026-10-25T18:00:00+03:00")
        self.assertEqual(payload["bookingEndTime"], "2026-10-25T19:00:00+03:00")
        self.assertEqual(payload["bookingCharges"], 87.5)
        self.assertEqual(payload["bookingChargesAfterDiscount"], 87.5)

class BookingTests(unittest.TestCase):
    def test_two_individual_reservations_two_checkout_links(self):
        api = FakeAPI()
        result = execute(api)
        self.assertEqual(result["outcome"], "reserved_two_hours_pending")
        self.assertEqual(result["held_hours"], 2)
        self.assertEqual(result["total_QAR"], 200)
        self.assertEqual(len(result["new_booking_ids"]), 2)
        self.assertEqual(len(result["payments"]), 2)
        payments = [p for path, p, _ in api.calls if path == "Payment/paymentAuth"]
        self.assertEqual({p["bookedAmenityId"] for p in payments}, set(result["new_booking_ids"]))
        self.assertTrue(all(p["order"]["amount"] == "100.00" and p["order"]["currency"] == "QAR" for p in payments))
        self.assertTrue(all(mutation for _, _, mutation in api.calls))

    def test_extend_existing_hour_with_adjacent_same_court_only(self):
        api = FakeAPI({u.GV: [slot(u.GV, 18), slot(u.GV, 20)], u.FP: [slot(u.FP, 18), slot(u.FP, 19)]}, [record(hour=19, paid=True)])
        result = execute(api)
        self.assertEqual(api.book_calls, 1)
        self.assertTrue(result["two_consecutive_hours_same_court"])
        submitted = [p for path, p, _ in api.calls if path == "Amenities/BookAmenities"][0]
        self.assertEqual(submitted["amenityId"], u.GV)
        self.assertIn("T18:00:00", submitted["bookingStartTime"])

    def test_existing_one_hour_no_adjacent_does_not_add_unrelated_hour(self):
        api = FakeAPI({u.GV: [slot(u.GV, 20)], u.FP: [slot(u.FP, 18), slot(u.FP, 19)]}, [record(hour=18, paid=True)])
        result = execute(api)
        self.assertEqual(api.book_calls, 0)
        self.assertEqual(result["held_hours"], 1)
        self.assertEqual(result["payments"], [])

    def test_unknown_existing_status_stops_new_writes(self):
        r = record()
        r["paymentStatus"] = "Unrecognized status"
        api = FakeAPI(history=[r])
        result = execute(api)
        self.assertTrue(result["safety_stop"])
        self.assertEqual(result["outcome"], "booking_status_requires_review")
        self.assertEqual(api.calls, [])

    def test_existing_confirmed_two_hours_no_write(self):
        api = FakeAPI(history=[record(hour=18, paid=True), record(hour=19, paid=True)])
        self.assertEqual(execute(api)["outcome"], "confirmed_two_hours")
        self.assertEqual(api.calls, [])

    def test_two_nonadjacent_existing_hours_require_review_no_extra(self):
        api = FakeAPI(history=[record(hour=18, paid=True), record(hour=20, paid=True)])
        self.assertEqual(execute(api)["outcome"], "existing_bookings_require_review")
        self.assertEqual(api.book_calls, 0)

    def test_second_hour_failure_preserves_first(self):
        api = FakeAPI(failures={2: u.APIError("UDC rule rejected request")})
        result = execute(api)
        self.assertEqual(result["held_hours"], 1)
        self.assertEqual(len(result["new_booking_ids"]), 1)
        self.assertEqual(len(result["payments"]), 1)
        self.assertEqual(api.book_calls, 2)

    def test_definite_conflict_replans_on_other_court(self):
        api = FakeAPI({u.GV: [slot(u.GV, 18), slot(u.GV, 19)], u.FP: [slot(u.FP, 18), slot(u.FP, 19)]}, failures={1: u.APIError("slot not available")})
        result = execute(api)
        self.assertEqual(api.book_calls, 3)
        self.assertEqual(result["held_hours"], 2)
        self.assertIsNone(result["reason"])

    def test_uncertain_write_never_replayed(self):
        api = FakeAPI(failures={1: u.MutationUnknown("timeout")})
        result = execute(api)
        self.assertTrue(result["safety_stop"])
        self.assertEqual(api.book_calls, 1)
        self.assertEqual(result["payments"], [])

    def test_created_but_not_visible_in_history_is_held_and_gets_payment_link(self):
        """18.10, бой: неоплаченная бронь UDC в истории не видна (держится 5 мин до оплаты) — держим её сами и сразу просим ссылку."""
        api = FakeAPI(visible=False)
        result = execute(api)
        self.assertFalse(result["safety_stop"])
        self.assertGreaterEqual(api.book_calls, 1)
        self.assertTrue(result["bookings"] and all(b["status"] == "Pending" for b in result["bookings"]))
        self.assertTrue(result["outcome"].startswith("reserved_"), result["outcome"])
        self.assertTrue(result["payments"])

    def test_history_failure_after_write_preserves_reference(self):
        api = FakeAPI()
        api.fail_reads_after_write = True
        result = execute(api)
        self.assertTrue(result["safety_stop"])
        self.assertEqual(len(result["new_booking_ids"]), 1)
        self.assertEqual(result["bookings"][0]["reference"], "UDC-TEST")

    def test_price_changed_after_creation_stops_before_checkout(self):
        api = FakeAPI()
        api.price_delta = 50
        result = execute(api)
        self.assertTrue(result["safety_stop"])
        self.assertEqual(api.book_calls, 1)
        self.assertEqual(result["total_QAR"], 150)
        self.assertEqual(result["payments"], [])

    def test_guard_rechecked_before_second_hour(self):
        api = FakeAPI()
        def clock():
            return NOW.replace(minute=5 if api.book_calls else 0)
        result = execute(api, clock=clock)
        self.assertEqual(api.book_calls, 1)
        self.assertEqual(result["held_hours"], 1)

    def test_monday_evening_and_morning_independently(self):
        day = dt.date(2026, 10, 26)
        now = NOW.replace(day=19)
        api = FakeAPI({u.GV: [slot(u.GV, h) for h in (7, 8, 18, 19)], u.FP: []})
        results = [u.process_window(api, day, w, CATALOGUE, TENNIS, execute=True, clock=lambda: now) for w in u.windows(day)]
        self.assertEqual([r["held_hours"] for r in results], [2, 2])
        self.assertEqual(api.book_calls, 4)

class HistoryAndPaymentTests(unittest.TestCase):
    def info(self, r):
        return u.held_bookings([r], DAY, EVENING, NOW)[0]

    def test_expired_pending_and_cancelled_not_held(self):
        expired = record()
        expired["bookingExpiry"] = (NOW-dt.timedelta(seconds=1)).isoformat()
        cancelled = record()
        cancelled["status"] = "Cancelled"
        self.assertEqual(u.held_bookings([expired, cancelled], DAY, EVENING, NOW), [])

    def test_paid_booking_remains_held_after_old_expiry(self):
        r = record(paid=True)
        r["bookingExpiry"] = "2020-01-01T00:00:00Z"
        self.assertTrue(u.confirmed(self.info(r)))

    def test_history_fallback_uses_local_display_slot(self):
        r = record()
        del r["bookingStartDateTime"], r["bookingEndDateTime"]
        self.assertEqual(self.info(r)["start"], 18*60)

    def test_history_duplicate_id_not_counted_twice(self):
        r = record()
        self.assertEqual(len(u.held_bookings([r, r], DAY, EVENING, NOW)), 1)

    def test_checkout_skips_paid_zero_unknown_status(self):
        api = FakeAPI()
        for r in (record(paid=True), record(cost=0), {**record(), "paymentStatus": None}, {**record(), "paymentStatus": "Unrecognized status"}):
            self.assertNotEqual(u.checkout_link(api, self.info(r))["outcome"], "manual_payment_link")
        self.assertEqual(api.calls, [])

    def test_checkout_rejects_invalid_urls(self):
        for url in ("http://gateway.test/pay", "https://user:secret@gateway.test/pay", "https://gateway.test/\x00pay", "https://gateway.test\\@other.test/pay", "javascript:alert(1)", "https:///pay"):
            api = FakeAPI()
            api.checkout_url = url
            with self.subTest(url=url):
                self.assertEqual(u.checkout_link(api, self.info(record()))["outcome"], "checkout_link_unavailable")

    def test_checkout_uncertainty_not_retried(self):
        api = FakeAPI()
        def unknown(*args, **kwargs):
            raise u.MutationUnknown("UDC timeout")
        with patch.object(api, "call", side_effect=unknown) as call:
            self.assertEqual(u.checkout_link(api, self.info(record()))["outcome"], "checkout_link_unavailable")
            self.assertEqual(call.call_count, 1)

    def test_checkout_rejects_invalid_charge_and_booking_id(self):
        api = FakeAPI()
        for amount in (-1, "unknown", 1.234, float("inf"), True):
            with self.subTest(amount=amount):
                self.assertEqual(u.checkout_link(api, self.info(record(cost=amount)))["outcome"], "checkout_link_unavailable")
        r = record(booking_id="invalid-booking-id")
        self.assertEqual(u.checkout_link(api, self.info(r))["outcome"], "checkout_link_unavailable")
        self.assertEqual(api.calls, [])

class Response(io.BytesIO):
    code = 200
    def __init__(self, data):
        super().__init__(json.dumps(data).encode())

class TransportTests(unittest.TestCase):
    def test_http_200_failure_is_not_success(self):
        api = u.UDCAPI()
        with patch.object(api.opener, "open", return_value=Response({"result": {"successful": False, "message": "Rejected", "data": None}})):
            with self.assertRaises(u.APIError):
                api.catalogue()

    def test_network_timeout_after_submission_is_uncertain(self):
        api = u.UDCAPI()
        api.token = "synthetic-test-token"
        with patch.object(api.opener, "open", side_effect=socket.timeout()):
            with self.assertRaises(u.MutationUnknown):
                api.call("Amenities/BookAmenities", {}, mutation=True)

    def test_http_503_after_submission_is_uncertain(self):
        api = u.UDCAPI()
        api.token = "synthetic-test-token"
        exc = urllib.error.HTTPError(u.BASE, 503, "Unavailable", {}, io.BytesIO(b"{}"))
        with patch.object(api.opener, "open", side_effect=exc):
            with self.assertRaises(u.MutationUnknown):
                api.call("Amenities/BookAmenities", {}, mutation=True)

    def test_rejects_unapproved_endpoints_and_unauthenticated_writes(self):
        api = u.UDCAPI()
        for path in ("Payment/paymentConfirmation", "Amenities/CancelBooking", "Account/delete"):
            with self.subTest(path=path), self.assertRaises(u.APIError):
                api.call(path, {}, mutation=True)
        with self.assertRaises(u.APIError):
            api.call("Amenities/BookAmenities", {}, mutation=True)

    def test_wrong_weekday_returned_by_server_rejected(self):
        api = u.UDCAPI()
        r = slot(u.GV, 18)
        r["day"] = "Saturday"
        with patch.object(api, "call", return_value=[r]), self.assertRaises(u.APIError):
            api.slots(u.GV, DAY)

class SchedulerTests(unittest.TestCase):
    def test_next_sunday_after_thursday_daytime(self):
        now = dt.datetime(2026, 10, 15, 16, tzinfo=u.DOHA)
        self.assertEqual(scheduler.due_time(now), NOW)

    def test_completed_day_not_replayed_after_restart(self):
        self.assertEqual(scheduler.due_time(NOW, "2026-10-18"), NOW+dt.timedelta(days=1))

    def test_midnight_start_and_late_start_guard(self):
        self.assertEqual(scheduler.due_time(NOW.replace(minute=2)), NOW)
        self.assertEqual(scheduler.due_time(NOW.replace(minute=5)), NOW+dt.timedelta(days=1))

    def test_thursday_rolls_over_weekend(self):
        now = dt.datetime(2026, 10, 22, 0, tzinfo=u.DOHA)
        self.assertEqual(scheduler.due_time(now, "2026-10-22").date(), dt.date(2026, 10, 25))

    def test_scheduler_records_attempt_before_call_and_never_stores_password(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(u, "now_doha", return_value=NOW), patch.object(u, "main", side_effect=KeyboardInterrupt) as run, patch.dict(scheduler.os.environ, {"UDC_PASSWORD": "synthetic-test-password"}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scheduler.main(["--username", "synthetic-user", "--state-dir", directory]), 0)
            run.assert_called_once()
            files = list(scheduler.Path(directory).glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertEqual(json.loads(files[0].read_text()), {"last_attempt_date": "2026-10-18"})

    def test_included_openapi_has_no_missing_references(self):
        path = scheduler.Path(__file__).with_name("udc-court-booking.openapi.json")
        schema = json.loads(path.read_text())
        def inspect(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    ref = value["$ref"]
                    self.assertTrue(ref.startswith("#/"))
                    node = schema
                    for key in ref[2:].split("/"):
                        node = node[key.replace("~1", "/").replace("~0", "~")]
                for nested in value.values():
                    inspect(nested)
            elif isinstance(value, list):
                for nested in value:
                    inspect(nested)
        inspect(schema)

class ReliableTransportTests(unittest.TestCase):
    def api(self):
        pauses=[]
        api=u.UDCAPI(sleeper=pauses.append)
        return api,pauses

    def test_response_slower_than_old_limit_is_allowed(self):
        api,pauses=self.api()
        def slow_response(request, *, timeout):
            if timeout < 35:
                raise socket.timeout()
            return Response({"result":{"successful":True,"data":[]}})
        with patch.object(api.opener,"open",side_effect=slow_response) as request:
            self.assertEqual(api.catalogue(),[])
        self.assertEqual(request.call_count,1)
        self.assertEqual(pauses,[])

    def test_read_timeout_then_success_retries_same_request(self):
        api,pauses=self.api()
        with patch.object(api.opener,"open",side_effect=[socket.timeout(),Response({"result":{"data":[]}})]) as request:
            self.assertEqual(api.catalogue(),[])
        self.assertEqual(pauses,[2])
        self.assertEqual(request.call_count,2)
        self.assertIs(request.call_args_list[0].args[0],request.call_args_list[1].args[0])

    def test_failed_read_has_bounded_attempts_and_safe_diagnostics(self):
        api,pauses=self.api()
        api.token="synthetic-private-token"
        secret="synthetic-private-reason"
        failure=urllib.error.URLError(socket.timeout(secret))
        with patch.object(api.opener,"open",side_effect=failure) as request:
            with self.assertRaises(u.NetworkError) as caught:
                api.history()
        self.assertEqual(request.call_count,3)
        self.assertEqual(pauses,[2,4])
        self.assertEqual(caught.exception.endpoint,"Amenities/GetBookedAmenity")
        self.assertEqual(caught.exception.stage,"connection_or_headers")
        self.assertEqual(caught.exception.attempts,3)
        self.assertNotIn(secret,str(caught.exception))
        self.assertNotIn(api.token,str(caught.exception))

    def test_auth_network_retry_never_repeats_rejected_credentials(self):
        api,pauses=self.api()
        success=Response({"result":{"data":{"token":"synthetic-token"}}})
        with patch.object(api.opener,"open",side_effect=[socket.timeout(),success]) as request:
            api.login("synthetic-user","synthetic-password")
        self.assertEqual(request.call_count,2)
        self.assertEqual(api.token,"synthetic-token")
        rejected=Response({"result":{"successful":False,"message":"synthetic-password"}})
        with patch.object(api.opener,"open",return_value=rejected) as request:
            with self.assertRaises(u.APIError) as caught:
                api.login("synthetic-user","synthetic-password")
        self.assertEqual(request.call_count,1)
        self.assertNotIn("synthetic-password",str(caught.exception))

    def test_http_503_read_is_retried_and_closed(self):
        api,pauses=self.api()
        body=io.BytesIO(b"{}")
        failure=urllib.error.HTTPError(u.BASE,503,"Unavailable",{},body)
        with patch.object(api.opener,"open",side_effect=[failure,Response({"result":{"data":[]}})]) as request:
            self.assertEqual(api.catalogue(),[])
        self.assertEqual(request.call_count,2)
        self.assertTrue(body.closed)
        self.assertEqual(pauses,[2])

    def test_http_read_failures_stop_after_three_attempts(self):
        api,pauses=self.api()
        failures=[urllib.error.HTTPError(u.BASE,502,"Unavailable",{},io.BytesIO(b"{}")) for _ in range(3)]
        with patch.object(api.opener,"open",side_effect=failures) as request:
            with self.assertRaises(u.APIError) as caught:
                api.catalogue()
        self.assertEqual(request.call_count,3)
        self.assertIn("Amenities/GetAll",str(caught.exception))
        self.assertIn("502",str(caught.exception))
        self.assertEqual(pauses,[2,4])

    def test_auth_access_errors_and_bad_data_are_not_retried(self):
        for status in (400,401,403,429):
            api,pauses=self.api()
            failure=urllib.error.HTTPError(u.BASE,status,"Rejected",{},io.BytesIO(b'{"result":{"successful":false}}'))
            with self.subTest(status=status),patch.object(api.opener,"open",side_effect=failure) as request:
                with self.assertRaises(u.APIError):
                    api.catalogue()
                self.assertEqual(request.call_count,1)
                self.assertEqual(pauses,[])

    def test_body_timeout_is_retried_and_response_closed(self):
        api,pauses=self.api()
        response=Response({})
        with patch.object(response,"read",side_effect=socket.timeout()),patch.object(api.opener,"open",side_effect=[response,Response({"result":{"data":[]}})]) as request:
            self.assertEqual(api.catalogue(),[])
        self.assertTrue(response.closed)
        self.assertEqual(request.call_count,2)
        self.assertEqual(pauses,[2])

    def test_malformed_json_is_not_a_transport_retry(self):
        api,pauses=self.api()
        response=Response({})
        with patch.object(response,"read",return_value=b"broken-json"),patch.object(api.opener,"open",return_value=response) as request:
            with self.assertRaises(u.APIError):
                api.catalogue()
        self.assertEqual(request.call_count,1)
        self.assertEqual(pauses,[])

    def test_booking_and_checkout_writes_never_retry_timeouts(self):
        for endpoint in ("Amenities/BookAmenities","Payment/paymentAuth"):
            api,pauses=self.api()
            api.token="synthetic-token"
            with self.subTest(endpoint=endpoint),patch.object(api.opener,"open",side_effect=socket.timeout()) as request:
                with self.assertRaises(u.MutationUnknown):
                    api.call(endpoint,{},mutation=True)
                self.assertEqual(request.call_count,1)
                self.assertEqual(pauses,[])

    def test_booking_and_checkout_writes_never_retry_http_503(self):
        for endpoint in ("Amenities/BookAmenities","Payment/paymentAuth"):
            api,pauses=self.api()
            api.token="synthetic-token"
            failure=urllib.error.HTTPError(u.BASE,503,"Unavailable",{},io.BytesIO(b"{}"))
            with self.subTest(endpoint=endpoint),patch.object(api.opener,"open",side_effect=failure) as request:
                with self.assertRaises(u.MutationUnknown):
                    api.call(endpoint,{},mutation=True)
                self.assertEqual(request.call_count,1)
                self.assertEqual(pauses,[])

class HistoryTimeRegressionTests(unittest.TestCase):
    def legacy(self,hour=18,*,paid=True):
        row=record(hour=hour,paid=paid,cost=0)
        start=dt.datetime.combine(DAY,dt.time(hour),u.DOHA)-dt.timedelta(hours=3)
        row["bookingStartDateTime"]=start.astimezone(dt.timezone.utc).isoformat()
        row["bookingEndDateTime"]=(start+dt.timedelta(hours=1)).astimezone(dt.timezone.utc).isoformat()
        row["bookingDate"]=DAY.isoformat()+"T12:00:00Z"
        return row

    def test_verified_udc_three_hour_shift_uses_displayed_local_slot(self):
        row=self.legacy()
        held=u.held_bookings([row],DAY,EVENING,NOW)
        self.assertEqual(len(held),1)
        self.assertEqual((held[0]["start"],held[0]["end"]),(18*60,19*60))
        self.assertTrue(u.confirmed(held[0]))

    def test_other_timestamp_disagreement_requires_review(self):
        row=self.legacy()
        row["bookingStartDateTime"]="2026-10-25T10:00:00Z"
        row["bookingEndDateTime"]="2026-10-25T11:00:00Z"
        with self.assertRaises(u.APIError):
            u.held_bookings([row],DAY,EVENING,NOW)

    def test_shift_must_be_equal_for_both_endpoints(self):
        row=self.legacy()
        row["bookingEndDateTime"]="2026-10-25T14:00:00Z"
        with self.assertRaises(u.APIError):
            u.held_bookings([row],DAY,EVENING,NOW)

    def test_without_display_slot_utc_conversion_remains(self):
        row=record(hour=20,paid=True)
        row["bookingTimeSlot"]=None
        held=u.held_bookings([row],DAY,EVENING,NOW)
        self.assertEqual(held[0]["start"],20*60)

    def test_shifted_existing_pair_prevents_another_booking(self):
        api=FakeAPI(history=[self.legacy(18),self.legacy(19)])
        result=execute(api)
        self.assertEqual(result["outcome"],"confirmed_two_hours")
        self.assertEqual(api.book_calls,0)
        self.assertEqual(api.calls,[])

class OneOffBookingTests(unittest.TestCase):
    def test_one_off_dates_and_windows(self):
        now=dt.datetime(2026,10,16,9,30,tzinfo=u.DOHA)
        for day,window in ((dt.date(2026,10,18),"evening"),(dt.date(2026,10,19),"morning")):
            self.assertEqual(u.manual_target(day,window,now),day)
        for day,window in ((now.date(),"evening"),(dt.date(2026,10,17),"evening"),(dt.date(2026,10,18),"morning"),(dt.date(2026,10,15),"evening"),(dt.date(2026,10,25),"evening")):  # +9 дней — нельзя: правило 7 дней (владелец 18.10)
            with self.subTest(day=day,window=window),self.assertRaises(u.APIError):
                u.manual_target(day,window,now)

    def test_one_off_uses_doha_and_rejects_started_window(self):
        now=dt.datetime(2026,10,18,16,0,tzinfo=dt.timezone.utc)
        with self.assertRaises(u.APIError):
            u.manual_target(now.astimezone(u.DOHA).date(),"evening",now)

    def test_one_off_does_not_change_scheduled_midnight_guard(self):
        now=NOW.replace(hour=12)
        self.assertEqual(u.manual_target(DAY,"evening",now),DAY)
        with self.assertRaises(u.APIError):
            u.scheduled_target(now)

    def test_one_off_rechecks_state_and_limits_to_two_adjacent_hours(self):
        now=NOW.replace(hour=12)
        class ManualAPI(FakeAPI):
            def call(self,path,payload=None,*,mutation=False):
                value=super().call(path,payload,mutation=mutation)
                if path=="Amenities/BookAmenities":
                    self.records[-1]["bookingExpiry"]=(now+dt.timedelta(hours=1)).isoformat()
                return value
        api=ManualAPI()
        guard=lambda moment:u.manual_target(DAY,"evening",moment)
        result=u.process_window(api,DAY,EVENING,CATALOGUE,TENNIS,execute=True,clock=lambda:now,execution_guard=guard)
        self.assertEqual(result["held_hours"],2)
        self.assertTrue(result["two_consecutive_hours_same_court"])
        self.assertEqual(api.book_calls,2)
        again=u.process_window(api,DAY,EVENING,CATALOGUE,TENNIS,execute=True,clock=lambda:now,execution_guard=guard)
        self.assertEqual(again["held_hours"],2)
        self.assertEqual(api.book_calls,2)

    def test_one_off_requires_explicit_window_and_username_before_auth(self):
        variants=(["--execute-once","2026-10-19","--username","synthetic-user"],["--execute-once","2026-10-19","--window","morning"],["--check-login","--window","evening","--username","synthetic-user"])
        with patch.object(u,"now_doha",return_value=dt.datetime(2026,10,16,9,30,tzinfo=u.DOHA)):
            for argv in variants:
                with self.subTest(argv=argv),patch.object(u.UDCAPI,"login") as login,contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(u.main(argv,password_provider=lambda:"synthetic-password"),1)
                    login.assert_not_called()

if __name__ == "__main__":
    unittest.main()
