import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("pilot_preflight", Path(__file__).parents[1] / "preflight.py")
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        path = Path(self.directory.name) / "profiles"
        path.write_text("[example-test]\nhost = https://example.cloud.databricks.com\nauth_type = databricks-cli\n")
        self.environment = {
            "DATABRICKS_CONFIG_FILE": str(path),
            "DATABRICKS_HOST": "https://other.cloud.databricks.com",
            "DATABRICKS_TOKEN": "synthetic-secret",
            "DATABRICKS_CONFIG_PROFILE": "other-profile",
            "DATABRICKS_AUTH_STORAGE": "plaintext",
            "ARM_CLIENT_ID": "example-unintended-principal",
            "ARM_CLIENT_SECRET": "synthetic-secret",
            "AZURE_CLIENT_SECRET": "synthetic-secret",
            "PATH": "/usr/bin",
        }

    def run_checks(self, response=None):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            if response:
                return response(command)
            data = {"id": "example-user", "active": True} if len(calls) == 1 else []
            return subprocess.CompletedProcess(command, 0, json.dumps(data), "")

        report = PREFLIGHT.preflight("example-test", "https://example.cloud.databricks.com/", self.environment, runner)
        return report, calls

    def test_all_checks_read_only_and_ambient_credentials_removed(self):
        report, calls = self.run_checks()
        self.assertTrue(report["all_checks_available"])
        self.assertEqual(len(calls), 5)
        for command, kwargs in calls:
            self.assertIn("--profile", command)
            self.assertEqual(command[-3:], ["example-test", "--output", "json"])
            self.assertNotIn("DATABRICKS_TOKEN", kwargs["env"])
            self.assertNotIn("DATABRICKS_HOST", kwargs["env"])
            self.assertNotIn("DATABRICKS_CONFIG_PROFILE", kwargs["env"])
            self.assertEqual(kwargs["env"]["DATABRICKS_AUTH_STORAGE"], "plaintext")
            self.assertNotIn("ARM_CLIENT_ID", kwargs["env"])
            self.assertNotIn("ARM_CLIENT_SECRET", kwargs["env"])
            self.assertNotIn("AZURE_CLIENT_SECRET", kwargs["env"])
        self.assertNotIn("example-user", json.dumps(report))

    def test_wrong_workspace_fails_before_any_command(self):
        def never(*args, **kwargs):
            self.fail("CLI must not run on mismatched workspace")
        with self.assertRaises(ValueError):
            PREFLIGHT.preflight("example-test", "https://other.cloud.databricks.com", self.environment, never)

    def test_host_only_profile_cannot_select_an_ambient_identity(self):
        Path(self.environment["DATABRICKS_CONFIG_FILE"]).write_text(
            "[example-test]\nhost = https://example.cloud.databricks.com\n"
        )
        def never(*args, **kwargs):
            self.fail("CLI must not choose an implicit authentication mechanism")
        with self.assertRaisesRegex(ValueError, "auth_type"):
            PREFLIGHT.preflight("example-test", "https://example.cloud.databricks.com", self.environment, never)

    def test_invalid_identity_stops_remaining_commands(self):
        report, calls = self.run_checks(lambda cmd: subprocess.CompletedProcess(cmd, 0, '{}', ""))
        self.assertFalse(report["all_checks_available"])
        self.assertEqual(len(calls), 1)

    def test_cli_failure_redacts_error_body_and_is_not_a_pass(self):
        report, calls = self.run_checks(lambda cmd: subprocess.CompletedProcess(cmd, 1, "synthetic-secret", "synthetic-secret"))
        self.assertFalse(report["all_checks_available"])
        self.assertEqual(len(calls), 1)
        self.assertNotIn("synthetic-secret", json.dumps(report))

    def test_partial_capability_failure_is_reported(self):
        def response(command):
            if command[1] == "current-user":
                return subprocess.CompletedProcess(command, 0, '{"id":"example-user","active":true}', "")
            return subprocess.CompletedProcess(command, 0, '{"unexpected":"shape"}', "")
        report, calls = self.run_checks(response)
        self.assertFalse(report["all_checks_available"])
        self.assertEqual(len(calls), 5)
        self.assertEqual(report["checks"]["jobs"]["reason"], "invalid_response")

    def test_missing_entitlements_are_actionable_without_exposing_raw_errors(self):
        def response(command):
            if command[1] == "current-user":
                return subprocess.CompletedProcess(command, 0, '{"id":"example-user","active":true}', "")
            entitlement = "databricks-sql-access" if command[1] == "warehouses" else "workspace-access"
            return subprocess.CompletedProcess(
                command, 1, "", f"Error: disabled for users without the {entitlement} entitlement. synthetic-secret"
            )
        report, calls = self.run_checks(response)
        self.assertFalse(report["all_checks_available"])
        self.assertEqual(report["checks"]["experiments"]["reason"], "missing_workspace_access")
        self.assertEqual(report["checks"]["sql_warehouses"]["reason"], "missing_sql_access")
        self.assertNotIn("synthetic-secret", json.dumps(report))

    def test_timeout_is_not_a_pass(self):
        def response(command):
            raise subprocess.TimeoutExpired(command, 45, output="synthetic-secret")
        report, calls = self.run_checks(response)
        self.assertFalse(report["all_checks_available"])
        self.assertNotIn("synthetic-secret", json.dumps(report))

    def test_untrusted_or_non_origin_hosts_rejected(self):
        for host in ("http://example.cloud.databricks.com", "https://example.com", "https://example.cloud.databricks.com.evil.com", "https://user:pass@example.cloud.databricks.com", "https://example.cloud.databricks.com/path", "https://example.cloud.databricks.com?token=example", "https://example.cloud.databricks.com:443"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                PREFLIGHT.workspace_origin(host)


if __name__ == "__main__":
    unittest.main()
