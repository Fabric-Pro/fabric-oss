"""Dependency-free job-contract tests. No cloud or database calls."""

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("context_evaluation", ROOT / "src" / "evaluate_context.py")
job = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(job)


class FakeRun:
    def __init__(self, owner):
        self.owner = owner
        self.info = SimpleNamespace(run_id="a" * 32)

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        self.owner.status = "FAILED" if kind else "FINISHED"


class FakeMlflow:
    def __init__(self, drop=False, unfinished=False, drop_params=False):
        self.params, self.metrics = {}, {}
        self.status, self.drop, self.unfinished = "RUNNING", drop, unfinished
        self.drop_params = drop_params
        self.tracking = SimpleNamespace(MlflowClient=lambda: self)

    def set_tracking_uri(self, uri):
        self.uri = uri

    def set_experiment(self, *, experiment_id):
        self.experiment_id = experiment_id

    def start_run(self, *, run_name):
        return FakeRun(self)

    def log_params(self, values):
        if not self.drop_params:
            self.params.update(values)

    def log_metrics(self, values):
        if not self.drop:
            self.metrics.update(values)

    def get_run(self, _):
        return SimpleNamespace(info=SimpleNamespace(status="RUNNING" if self.unfinished else self.status), data=SimpleNamespace(metrics=self.metrics, params=self.params))


def fixture():
    content = "Private example booking policy"
    return {"version": 1, "sources": [{"id": "example-source", "content": content, "revision": hashlib.sha256(content.encode()).hexdigest()}], "cases": [{"id": "example-case", "recordedAnswer": "Book online", "retrievedSourceIds": ["example-source"], "citedSourceIds": ["example-source"], "expectations": {"expectedSourceIds": ["example-source"], "requiredPhrases": ["online"], "forbiddenPhrases": []}}]}


class EvaluationJobTests(unittest.TestCase):
    def invoke(self, data=None, tracker=None, path=None, digest=None):
        raw = json.dumps(fixture()).encode() if data is None else data
        tracker = FakeMlflow() if tracker is None else tracker
        with patch("builtins.open", return_value=io.BytesIO(raw)) as opened:
            result = job.run_evaluation(path or "/Volumes/example_catalog/example_schema/example_volume/example-run.json", digest or hashlib.sha256(raw).hexdigest(), "example-run", "123", tracker)
        return result, tracker, opened

    def test_full_report_receipt_and_safe_tracking_only(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            receipt, tracker, opened = self.invoke()
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(receipt["report"], job.evaluate(fixture()))
        self.assertEqual(receipt["mlflowRunId"], "a" * 32)
        self.assertEqual(tracker.experiment_id, "123")
        self.assertEqual(tracker.metrics, {"case_count": 1, "passed_count": 1, "failed_count": 0})
        self.assertNotIn("Private example", json.dumps(tracker.params))
        self.assertNotIn("Book online", json.dumps(receipt))
        self.assertLess(len(json.dumps(receipt)), 100 * 1024)
        opened.assert_called_once_with("/Volumes/example_catalog/example_schema/example_volume/example-run.json", "rb")

    def test_hash_mismatch_never_logs_a_run(self):
        tracker = FakeMlflow()
        with self.assertRaisesRegex(ValueError, "identity"):
            self.invoke(tracker=tracker, digest="0" * 64)
        self.assertEqual(tracker.params, {})

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.invoke(data=b'{"version":1,"version":1}')

    def test_oversized_raw_payload_rejected_before_tracking(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            self.invoke(data=b" " * (128 * 1024 + 1))

    def test_path_and_run_id_must_match_the_approved_volume_contract(self):
        for path in ["https://example.com/input", "/tmp/example-run.json", "/Volumes/a/b/../example-run.json", "/Volumes/a/b/c/another-run.json"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.invoke(path=path)

    def test_tracking_readback_or_finish_failure_is_fatal(self):
        for tracker in [FakeMlflow(drop=True), FakeMlflow(unfinished=True), FakeMlflow(drop_params=True)]:
            with self.subTest(tracker=tracker), self.assertRaises(RuntimeError):
                self.invoke(tracker=tracker)

    def test_excessive_receipt_never_becomes_a_native_notebook_output(self):
        with patch.object(job, "evaluate", return_value={"datasetHash": "a" * 64, "configurationHash": "b" * 64, "snapshotHash": "c" * 64, "counts": {"cases": 1, "passed": 1, "failed": 0}, "padding": "x" * (100 * 1024)}):
            with self.assertRaisesRegex(RuntimeError, "bound"):
                self.invoke()

    def test_bundle_has_one_fixed_task_and_no_independent_trigger(self):
        text = (ROOT / "databricks.yml").read_text()
        self.assertEqual(text.count("task_key:"), 1)
        for required in ["task_key: evaluate_context_snapshot", "max_retries: 0", "retry_on_timeout: false", "max_concurrent_runs: 1", "timeout_seconds: 900", "https://workspace-not-configured.invalid"]:
            self.assertIn(required, text)
        for forbidden in ["schedule:", "continuous:", "trigger:", "notebook_params:"]:
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
