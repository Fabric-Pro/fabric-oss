"""Dependency-free tests; no workspace or credentials are required."""

import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


NOTEBOOK = Path(__file__).parents[1] / "src" / "context_quality_pilot.py"
SPEC = importlib.util.spec_from_file_location("context_quality_pilot", NOTEBOOK)
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)


class FakeRun:
    def __init__(self, owner):
        self.owner = owner
        self.info = SimpleNamespace(run_id="synthetic-run")

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        self.owner.status = "FAILED" if kind else "FINISHED"


class FakeMlflow:
    __version__ = "synthetic-version"

    def __init__(self, discard_metrics=False, wrong_status=False):
        self.params = {}
        self.metrics = {}
        self.tags = {}
        self.status = "RUNNING"
        self.discard_metrics = discard_metrics
        self.wrong_status = wrong_status
        self.tracking = SimpleNamespace(MlflowClient=lambda: self)

    def set_tracking_uri(self, uri):
        self.uri = uri

    def set_experiment(self, path):
        self.experiment_path = path

    def start_run(self, run_name):
        self.run_name = run_name
        return FakeRun(self)

    def set_tags(self, tags):
        self.tags.update(tags)

    def log_params(self, params):
        self.params.update(params)

    def log_metrics(self, metrics):
        if not self.discard_metrics:
            self.metrics.update(metrics)

    def get_run(self, run_id):
        return SimpleNamespace(
            info=SimpleNamespace(status="RUNNING" if self.wrong_status else self.status),
            data=SimpleNamespace(params=self.params.copy(), metrics=self.metrics.copy()),
        )


class PilotTests(unittest.TestCase):
    def test_acceptance_and_each_rejection(self):
        rows = pilot.evaluate_cases(pilot.synthetic_cases())
        self.assertEqual([row["passed"] for row in rows], [1, 0, 0, 0])
        self.assertEqual(rows[1]["required_phrases"], 0)
        self.assertEqual(rows[2]["forbidden_phrases"], 0)
        self.assertEqual(rows[3]["required_citations"], 0)

    def test_matching_is_case_sensitive(self):
        case = pilot.synthetic_cases()[0]
        case["answer"] = case["answer"].upper()
        self.assertEqual(pilot.score_case(case)["passed"], 0)

    def test_wrong_expected_score_is_fatal_before_tracking(self):
        cases = pilot.synthetic_cases()
        cases[1]["expected_pass"] = True
        fake = FakeMlflow()
        with self.assertRaisesRegex(RuntimeError, "expectation"):
            pilot.run_pilot(fake, cases=cases)
        self.assertFalse(hasattr(fake, "uri"))

    def test_dropped_metrics_marks_run_failed(self):
        fake = FakeMlflow(discard_metrics=True)
        with self.assertRaisesRegex(RuntimeError, "metric readback"):
            pilot.run_pilot(fake)
        self.assertEqual(fake.status, "FAILED")

    def test_unfinished_run_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError, "finish"):
            pilot.run_pilot(FakeMlflow(wrong_status=True))

    def test_tracking_errors_are_not_swallowed(self):
        fake = FakeMlflow()
        fake.log_metrics = lambda _: (_ for _ in ()).throw(ConnectionError("offline"))
        with self.assertRaises(ConnectionError):
            pilot.run_pilot(fake)
        self.assertEqual(fake.status, "FAILED")

    def test_success_verifies_provenance_and_does_not_log_text(self):
        fake = FakeMlflow()
        report = pilot.run_pilot(fake)
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["case_count"], 4)
        self.assertEqual(report["accepted_count"], 1)
        self.assertEqual(report["rejected_count"], 3)
        self.assertEqual(report["target"], "test")
        self.assertEqual(report["experiment_path"], f"{pilot.EXPERIMENT_ROOT}/test")
        self.assertEqual(fake.uri, "databricks")
        self.assertEqual(fake.experiment_path, f"{pilot.EXPERIMENT_ROOT}/test")
        self.assertEqual(fake.metrics["expectation_match_rate"], 1.0)
        self.assertEqual(len(fake.params["dataset_sha256"]), 64)
        self.assertNotIn("30 days", repr(fake.params))
        self.assertNotIn("30 days", repr(fake.metrics))
        self.assertNotIn("example-policy", repr(fake.params))

    def test_fixture_changes_change_digest(self):
        cases = pilot.synthetic_cases()
        changed = copy.deepcopy(cases)
        changed[0]["answer"] += " Extra sentence."
        self.assertNotEqual(pilot.digest(cases), pilot.digest(changed))

    def test_target_is_validated_before_tracking(self):
        for target in ("../prod", "production", "", "test/other"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                pilot.run_pilot(FakeMlflow(), target=target)

    def test_explicit_experiment_path_is_used(self):
        fake = FakeMlflow()
        path = "/Users/dev@example.com/fabric-context-quality-pilot-test"
        pilot.run_pilot(fake, experiment_path=path)
        self.assertEqual(fake.experiment_path, path)

    def test_invalid_experiment_path_is_rejected(self):
        for path in (
            "relative/path",
            "https://example.com/experiment",
            "",
            "/",
            "//test",
            "/Shared//test",
            "/Shared/test/",
            "/Shared/./test",
            "/Shared/../test",
            "/Shared\\test",
            "/Shared/\n/test",
            "/Shared/\x7f/test",
            "/Shared/\x85/test",
            "/Shared/\u2028/test",
            "/Shared/\u202e/test",
        ):
            fake = FakeMlflow()
            with self.subTest(path=path), self.assertRaises(ValueError):
                pilot.run_pilot(fake, experiment_path=path)
            self.assertFalse(hasattr(fake, "uri"))

    def test_target_mismatched_experiment_is_rejected_before_tracking(self):
        for target, path in (
            ("prod", "/Shared/pilot-test"),
            ("prod", "/Shared/test"),
            ("staging", "/Shared/pilot-prod"),
            ("test", "/Shared/pilot-contest"),
        ):
            fake = FakeMlflow()
            with self.subTest(target=target, path=path), self.assertRaisesRegex(
                ValueError, "selected target"
            ):
                pilot.run_pilot(fake, target=target, experiment_path=path)
            self.assertFalse(hasattr(fake, "uri"))

    def test_non_test_targets_propagate_default_and_explicit_paths(self):
        for target in ("staging", "prod"):
            for path in (None, f"/Users/dev@example.com/pilot-{target}"):
                with self.subTest(target=target, path=path):
                    fake = FakeMlflow()
                    report = pilot.run_pilot(fake, target=target, experiment_path=path)
                    expected = path or f"{pilot.EXPERIMENT_ROOT}/{target}"
                    self.assertEqual(fake.experiment_path, expected)
                    self.assertEqual(fake.params["target"], target)
                    self.assertEqual(report["target"], target)
                    self.assertEqual(report["experiment_path"], expected)
                    self.assertEqual(report["accepted_count"], 1)
                    self.assertEqual(report["rejected_count"], 3)

    def test_databricks_entrypoint_returns_the_printed_receipt(self):
        fake = FakeMlflow()
        values = {
            "target": "staging",
            "experiment_path": "/Users/dev@example.com/pilot-staging",
        }
        receipts = []
        runtime = SimpleNamespace(
            widgets=SimpleNamespace(
                text=lambda key, default: values.setdefault(key, default),
                get=values.__getitem__,
            ),
            notebook=SimpleNamespace(exit=receipts.append),
        )
        output = io.StringIO()
        with patch.dict(sys.modules, {"mlflow": fake}), redirect_stdout(output):
            runpy.run_path(str(NOTEBOOK), run_name="__main__", init_globals={"dbutils": runtime})
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0], output.getvalue().strip())
        report = json.loads(receipts[0])
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["target"], "staging")
        self.assertEqual(report["experiment_path"], values["experiment_path"])

    def test_notebook_exit_errors_are_not_suppressed(self):
        values = {"target": "test", "experiment_path": ""}

        def fail_exit(_):
            raise RuntimeError("exit failed")

        runtime = SimpleNamespace(
            widgets=SimpleNamespace(
                text=lambda key, default: values.setdefault(key, default),
                get=values.__getitem__,
            ),
            notebook=SimpleNamespace(exit=fail_exit),
        )
        with patch.dict(sys.modules, {"mlflow": FakeMlflow()}), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, "exit failed"):
                runpy.run_path(str(NOTEBOOK), run_name="__main__", init_globals={"dbutils": runtime})

    def test_local_entrypoint_without_dbutils_still_reports_result(self):
        output = io.StringIO()
        with patch.dict(sys.modules, {"mlflow": FakeMlflow()}), redirect_stdout(output):
            runpy.run_path(str(NOTEBOOK), run_name="__main__")
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["target"], "test")

    def test_duplicate_ids_are_rejected(self):
        cases = pilot.synthetic_cases()
        cases[1]["id"] = cases[0]["id"]
        with self.assertRaisesRegex(ValueError, "unique"):
            pilot.evaluate_cases(cases)

    def test_all_pass_cannot_fake_negative_coverage(self):
        with self.assertRaisesRegex(ValueError, "acceptance and rejection"):
            pilot.evaluate_cases([pilot.synthetic_cases()[0]])


if __name__ == "__main__":
    unittest.main()
