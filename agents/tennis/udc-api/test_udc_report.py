"""Confirmed UDC booking reporting tests: no real server writes."""
import datetime as dt
import contextlib
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import udc_booker as u
import udc_report as report
import udc_confirmation_worker as worker
from test_udc_booker import DAY, NOW, FakeAPI, record

PAYLOAD = {"date": str(DAY), "from": "18:00", "to": "20:00", "court": "Family Park"}

class Response(io.BytesIO):
    code = 200
    def __init__(self, data):
        super().__init__(json.dumps(data).encode())

class ReporterDouble:
    key = "synthetic-test-report-key"
    def __init__(self, receipt=None):
        self.calls = []
        self.receipt = receipt or {"outcome": "added_to_calendar_and_jarvis", "accepted": True, "calendar": True, "stop": False}
    def clock(self):
        return NOW
    def post(self, payload):
        self.calls.append(payload.copy())
        return self.receipt.copy()

class PayloadTests(unittest.TestCase):
    def test_confirmed_adjacent_hours_merged_four_fields_only(self):
        rows = [record(u.FP, 18, paid=True), record(u.FP, 19, paid=True)]
        payloads, deferred = report.confirmed_payloads(rows, [DAY], NOW)
        self.assertEqual(payloads, [PAYLOAD])
        self.assertEqual(deferred, [])
        self.assertEqual(set(payloads[0]), {"date", "from", "to", "court"})

    def test_two_reserved_hours_wait_for_both_confirmations(self):
        payloads, deferred = report.confirmed_payloads([record(hour=18, paid=True), record(hour=19)], [DAY], NOW)
        self.assertEqual(payloads, [])
        self.assertEqual(len(deferred), 1)

    def test_single_confirmed_hour_fallback_exported(self):
        payloads, _ = report.confirmed_payloads([record(hour=18, paid=True)], [DAY], NOW)
        self.assertEqual(payloads, [{"date": str(DAY), "from": "18:00", "to": "19:00", "court": "Giardino"}])

    def test_pending_rejected_cancelled_not_exported(self):
        rows = [record(), {**record(paid=True), "status": "Rejected"}, {**record(paid=True), "status": "Cancelled"}]
        self.assertEqual(report.confirmed_payloads(rows, [DAY], NOW)[0], [])

    def test_separate_courts_and_nonadjacent_hours_not_merged(self):
        rows = [record(u.GV, 18, paid=True), record(u.FP, 19, paid=True), record(u.GV, 20, paid=True)]
        payloads, _ = report.confirmed_payloads(rows, [DAY], NOW)
        self.assertEqual(len(payloads), 3)
        self.assertTrue(all(p["from"] != p["to"] for p in payloads))

    def test_utc_timestamps_converted_to_doha(self):
        r = record(hour=20, paid=True)
        self.assertIn("T17:00", r["bookingStartDateTime"])
        payloads, _ = report.confirmed_payloads([r], [DAY], NOW)
        self.assertEqual(payloads[0]["from"], "20:00")

    def shifted_monday(self,hour,paid=True):
        day=dt.date(2026,10,19)
        row=record(hour=hour,day=day,paid=paid,cost=0)
        row["amenityName"]="Tennis Court-GV"
        row["bookingDate"]=day.isoformat()+"T12:00:00Z"
        row["bookingStartDateTime"]=day.isoformat()+f"T{hour-6:02}:00:00Z"
        row["bookingEndDateTime"]=day.isoformat()+f"T{hour-5:02}:00:00Z"
        row["bookingExpiry"]=(NOW+dt.timedelta(hours=1)).isoformat()
        return row

    def test_live_udc_history_shape_exports_displayed_eight_to_nine(self):
        payloads,deferred=report.confirmed_payloads([self.shifted_monday(8)],[dt.date(2026,10,19)],NOW)
        self.assertEqual(payloads,[{"date":"2026-10-19","from":"08:00","to":"09:00","court":"Giardino"}])
        self.assertEqual(deferred,[])

    def test_shifted_unpaid_neighbor_still_defers_whole_window(self):
        rows=[self.shifted_monday(7,paid=False),self.shifted_monday(8)]
        payloads,deferred=report.confirmed_payloads(rows,[dt.date(2026,10,19)],NOW)
        self.assertEqual(payloads,[])
        self.assertEqual(len(deferred),1)

    def test_monday_morning_and_evening_separate(self):
        day = DAY+dt.timedelta(days=1)
        now = NOW+dt.timedelta(days=1)
        rows = [record(hour=h, day=day, paid=True) for h in (7, 8, 18, 19)]
        payloads, _ = report.confirmed_payloads(rows, [day], now)
        self.assertEqual({(p["from"], p["to"]) for p in payloads}, {("07:00", "09:00"), ("18:00", "20:00")})

    def test_rejects_extra_fields_bad_times_dates_and_courts(self):
        bad = [{**PAYLOAD, "phone": "synthetic"}, {**PAYLOAD, "from": "8:00"}, {**PAYLOAD, "to": "18:00"}, {**PAYLOAD, "to": "22:00"}, {**PAYLOAD, "date": "2026-10-16"}, {**PAYLOAD, "date": "2027-01-01"}, {**PAYLOAD, "court": "Other"}]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(report.ReportError):
                report.validate(payload, NOW)

    def test_duplicates_of_history_record_exported_once(self):
        r = record(paid=True)
        payloads, _ = report.confirmed_payloads([r, r], [DAY, DAY], NOW)
        self.assertEqual(len(payloads), 1)

class TransportTests(unittest.TestCase):
    def reporter(self):
        return report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=lambda seconds: None)

    def test_correct_endpoint_bearer_and_exact_body(self):
        client = self.reporter()
        with patch.object(client.opener, "open", return_value=Response({"ok": True, "calendar": True})) as call:
            receipt = client.post(PAYLOAD)
            request = call.call_args.args[0]
            self.assertEqual(request.full_url, report.ENDPOINT)
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-test-report-key")
            self.assertEqual(json.loads(request.data), PAYLOAD)
            self.assertEqual(receipt["outcome"], "added_to_calendar_and_jarvis")

    def test_calendar_false_means_queued(self):
        client = self.reporter()
        with patch.object(client.opener, "open", return_value=Response({"ok": True, "calendar": False})):
            result = client.post(PAYLOAD)
        self.assertEqual(result["outcome"], "accepted_calendar_pending")
        self.assertFalse(result["calendar"])

    def test_duplicate_not_new_calendar_success(self):
        client = self.reporter()
        with patch.object(client.opener, "open", return_value=Response({"ok": True, "duplicate": True})):
            self.assertEqual(client.post(PAYLOAD)["outcome"], "already_recorded")

    def test_unauthorized_stops_without_retry(self):
        client = self.reporter()
        error = urllib.error.HTTPError(report.ENDPOINT, 401, "Unauthorized", {}, io.BytesIO(b"{}"))
        with patch.object(client.opener, "open", side_effect=error) as call:
            receipt = client.post(PAYLOAD)
            self.assertEqual(call.call_count, 1)
        self.assertEqual(receipt["outcome"], "report_unauthorized")
        self.assertTrue(receipt["stop"])

    def test_bad_data_error_redacts_secret(self):
        client = self.reporter()
        body = json.dumps({"ok": False, "err": "bad input "+client.key}).encode()
        error = urllib.error.HTTPError(report.ENDPOINT, 400, "Invalid", {}, io.BytesIO(body))
        with patch.object(client.opener, "open", side_effect=error):
            receipt = client.post(PAYLOAD)
        self.assertEqual(receipt["outcome"], "report_invalid_data")
        self.assertNotIn(client.key, receipt["message"])

    def test_403_stops_without_claiming_wrong_key_or_success(self):
        client = self.reporter()
        error = urllib.error.HTTPError(report.ENDPOINT, 403, "Denied", {}, io.BytesIO(b"{}"))
        with patch.object(client.opener, "open", side_effect=error) as call:
            receipt = client.post(PAYLOAD)
            self.assertEqual(call.call_count, 1)
        self.assertEqual(receipt["outcome"], "report_access_blocked")
        self.assertNotIn("accepted", receipt)

    def test_timeout_and_unverifiable_200_are_uncertain(self):
        client = self.reporter()
        with patch.object(client.opener, "open", side_effect=socket.timeout()) as call:
            self.assertEqual(client.post(PAYLOAD)["outcome"], "report_uncertain")
            self.assertEqual(call.call_count, 4)
        with patch.object(client.opener, "open", return_value=Response({"ok": True})):
            self.assertEqual(client.post(PAYLOAD)["outcome"], "report_uncertain")

    def test_redirect_is_not_followed(self):
        client = self.reporter()
        self.assertIsNone(u.NoRedirect().redirect_request(None, None, 302, "Redirect", {}, "https://other.test"))
        error = urllib.error.HTTPError(report.ENDPOINT, 302, "Redirect", {"Location": "https://other.test"}, io.BytesIO(b"{}"))
        with patch.object(client.opener, "open", side_effect=error):
            self.assertEqual(client.post(PAYLOAD)["outcome"], "report_uncertain")

    def test_network_failure_then_success_retries_same_body_after_one_minute(self):
        sleep = unittest.mock.Mock()
        client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
        with patch.object(client.opener, "open", side_effect=[socket.timeout(), Response({"ok": True, "calendar": True})]) as call:
            result = client.post(PAYLOAD)
        self.assertEqual(result["attempts"], 2)
        self.assertTrue(result["accepted"])
        sleep.assert_called_once_with(60)
        self.assertEqual([json.loads(c.args[0].data) for c in call.call_args_list], [PAYLOAD, PAYLOAD])

    def test_5xx_then_duplicate_is_success(self):
        sleep = unittest.mock.Mock()
        client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
        errors = [urllib.error.HTTPError(report.ENDPOINT, 503, "Unavailable", {}, io.BytesIO(b"{}")) for _ in range(2)]
        with patch.object(client.opener, "open", side_effect=errors+[Response({"ok": True, "duplicate": True})]):
            result = client.post(PAYLOAD)
        self.assertEqual(result["outcome"], "already_recorded")
        self.assertEqual(result["attempts"], 3)
        self.assertEqual(sleep.call_args_list, [unittest.mock.call(60), unittest.mock.call(60)])

    def test_5xx_budget_is_initial_request_plus_three_retries(self):
        sleep = unittest.mock.Mock()
        client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
        errors = [urllib.error.HTTPError(report.ENDPOINT, 500, "Unavailable", {}, io.BytesIO(b"{}")) for _ in range(4)]
        with patch.object(client.opener, "open", side_effect=errors) as call:
            result = client.post(PAYLOAD)
        self.assertEqual(call.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertTrue(result["retry_exhausted"])
        self.assertTrue(result["stop"])

    def test_401_after_transient_failure_stops_without_more_retries(self):
        sleep = unittest.mock.Mock()
        client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
        unauthorized = urllib.error.HTTPError(report.ENDPOINT, 401, "Unauthorized", {}, io.BytesIO(b"{}"))
        with patch.object(client.opener, "open", side_effect=[socket.timeout(), unauthorized]) as call:
            result = client.post(PAYLOAD)
        self.assertEqual(call.call_count, 2)
        self.assertEqual(result["outcome"], "report_unauthorized")
        sleep.assert_called_once_with(60)

    def test_400_and_429_are_not_retried_unchanged(self):
        for status in (400, 429):
            sleep = unittest.mock.Mock()
            client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
            error = urllib.error.HTTPError(report.ENDPOINT, status, "Rejected", {}, io.BytesIO(b'{"ok":false,"err":"format"}'))
            with patch.object(client.opener, "open", side_effect=error) as call:
                client.post(PAYLOAD)
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()

    def test_response_network_failure_can_retry_and_receive_duplicate(self):
        class BrokenResponse(Response):
            def read(self, *args):
                raise OSError("Response interrupted")
        sleep = unittest.mock.Mock()
        client = report.Reporter("synthetic-test-report-key", clock=lambda: NOW, sleep=sleep)
        with patch.object(client.opener, "open", side_effect=[BrokenResponse({}), Response({"ok": True, "duplicate": True})]):
            result = client.post(PAYLOAD)
        self.assertEqual(result["outcome"], "already_recorded")
        sleep.assert_called_once_with(60)

class JournalTests(unittest.TestCase):
    def test_accepted_payload_not_sent_twice_and_key_not_saved(self):
        client = ReporterDouble()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"state.json"
            report.deliver([PAYLOAD], client, path)
            results = report.deliver([PAYLOAD], client, path)
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(results[0]["outcome"], "already_reported_locally")
            self.assertNotIn(client.key, path.read_text())

    def test_uncertain_payload_not_replayed(self):
        client = ReporterDouble({"outcome": "report_uncertain", "stop": True})
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"state.json"
            report.deliver([PAYLOAD], client, path)
            results = report.deliver([PAYLOAD], client, path)
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(results[0]["outcome"], "previous_report_requires_review")

    def test_401_key_blocked_across_runs_new_key_can_retry(self):
        client = ReporterDouble({"outcome": "report_unauthorized", "stop": True})
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"state.json"
            report.deliver([PAYLOAD], client, path)
            report.deliver([PAYLOAD], client, path)
            self.assertEqual(len(client.calls), 1)
            client.key = "synthetic-replacement-key"
            client.receipt = {"outcome": "added_to_calendar_and_jarvis", "accepted": True, "stop": False}
            self.assertTrue(report.deliver([PAYLOAD], client, path)[0]["accepted"])
            self.assertEqual(len(client.calls), 2)

    def test_extended_already_reported_hour_not_duplicated(self):
        client = ReporterDouble()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"state.json"
            report.deliver([{**PAYLOAD, "to": "19:00"}], client, path)
            receipt = report.deliver([PAYLOAD], client, path)
            self.assertEqual(len(client.calls), 1)
            self.assertEqual(receipt[0]["outcome"], "overlapping_report_requires_review")

    def test_preview_and_pending_bookings_never_request_key_or_send(self):
        def secret():
            raise AssertionError("Key requested for a read-only operation")
        api = FakeAPI(history=[record(paid=True)])
        preview = report.sync(api, [DAY], key_provider=secret, state_path="unused", preview=True, clock=lambda: NOW)
        self.assertEqual(preview["outcome"], "report_preview_only")
        api = FakeAPI(history=[record()])
        self.assertEqual(report.sync(api, [DAY], key_provider=secret, state_path="unused", clock=lambda: NOW)["outcome"], "nothing_confirmed_to_report")

    def test_corrupted_journal_does_not_send(self):
        client = ReporterDouble()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"state.json"
            path.write_text("invalid")
            with self.assertRaises(report.ReportError):
                report.deliver([PAYLOAD], client, path)
            self.assertEqual(client.calls, [])

class IntegrationTests(unittest.TestCase):
    def test_cli_sync_reports_confirmed_history_without_booking_or_payment(self):
        api = FakeAPI(history=[record(hour=18, paid=True), record(hour=19, paid=True)])
        api.login = lambda *args: None
        with tempfile.TemporaryDirectory() as folder, patch.object(u, "UDCAPI", return_value=api), patch.object(report.Reporter, "post", return_value={"outcome": "added_to_calendar_and_jarvis", "accepted": True, "stop": False}) as post, contextlib.redirect_stdout(io.StringIO()) as output:
            code = u.main(["--sync-confirmed", "--sync-date", str(DAY), "--username", "test", "--report-state-dir", folder], password_provider=lambda: "synthetic-password", report_key_provider=lambda: "synthetic-report-key")
            self.assertEqual(code, 0)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.args[0]["to"], "20:00")
            self.assertEqual(api.calls, [])
            self.assertNotIn("synthetic-report-key", output.getvalue())

    def test_cli_sync_returns_failure_for_unauthorized_export(self):
        api = FakeAPI(history=[record(paid=True)])
        api.login = lambda *args: None
        with tempfile.TemporaryDirectory() as folder, patch.object(u, "UDCAPI", return_value=api), patch.object(report.Reporter, "post", return_value={"outcome": "report_unauthorized", "stop": True}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(u.main(["--sync-confirmed", "--sync-date", str(DAY), "--username", "test", "--report-state-dir", folder], password_provider=lambda: "synthetic-password", report_key_provider=lambda: "synthetic-report-key"), 2)

    def test_worker_stops_after_failure_without_retry(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(worker.os.environ, {"UDC_PASSWORD": "synthetic-password", "UDC_TENNIS_REPORT_KEY": "synthetic-report-key"}), patch.object(u, "main", return_value=2) as run, patch.object(worker.time, "sleep") as sleep, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(worker.main(["--username", "test", "--state-dir", folder]), 2)
            run.assert_called_once()
            self.assertIn("--sync-confirmed", run.call_args.args[0])
            self.assertNotIn("--execute-scheduled", run.call_args.args[0])
            sleep.assert_not_called()

    def test_worker_success_waits_for_next_confirmation_check(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(worker.os.environ, {"UDC_PASSWORD": "synthetic-password", "UDC_TENNIS_REPORT_KEY": "synthetic-report-key"}), patch.object(u, "main", return_value=0) as run, patch.object(worker.time, "sleep", side_effect=KeyboardInterrupt) as sleep:
            self.assertEqual(worker.main(["--username", "test", "--state-dir", folder]), 0)
            run.assert_called_once()
            sleep.assert_called_once_with(60)

    def test_actions_schema_exposes_four_fields_and_bearer_auth(self):
        schema = json.loads(Path(__file__).with_name("udc-confirmed-bookings.actions.openapi.json").read_text())
        self.assertEqual(schema["servers"][0]["url"], "https://hook.acrogym.org")
        operation = schema["paths"]["/tennis"]["post"]
        self.assertEqual(operation["operationId"], "addTennisBooking")
        body = operation["requestBody"]["content"]["application/json"]["schema"]
        self.assertEqual(set(body["properties"]), {"date", "from", "to", "court"})
        self.assertFalse(body["additionalProperties"])
        self.assertEqual(schema["components"]["securitySchemes"]["bearerAuth"]["scheme"], "bearer")

if __name__ == "__main__":
    unittest.main()
