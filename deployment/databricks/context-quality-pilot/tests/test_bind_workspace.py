import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "pilot_bind_workspace", Path(__file__).parents[1] / "bind_workspace.py"
)
BIND = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BIND)
HOST = "https://example.cloud.databricks.com"


class BindWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "bundle"
        self.root.mkdir()
        self.profile = Path(self.directory.name) / "profiles"
        self.profile.write_text(f"[example-test]\nhost = {HOST}\nauth_type = databricks-cli\n")
        self.env = {"DATABRICKS_CONFIG_FILE": str(self.profile)}
        self.binding = self.root / ".databricks" / "workspace-bindings.yml"

    def bind(self, target="test", host=HOST, root=None):
        return BIND.bind_workspace(
            "example-test", target, host, self.env, self.root if root is None else root
        )

    def existing(self, value):
        self.binding.parent.mkdir(exist_ok=True)
        self.binding.write_text(json.dumps(value))

    def test_exact_target_only_and_sanitized_receipt(self):
        receipt = self.bind("staging")
        self.assertEqual(json.loads(self.binding.read_text()), {
            "targets": {"staging": {"workspace": {"host": HOST}}}
        })
        self.assertEqual(receipt, {"status": "bound", "target": "staging", "cloud_calls": False})
        self.assertNotIn(HOST, json.dumps(receipt))

    def test_wrong_host_causes_no_writes(self):
        with self.assertRaises(ValueError):
            self.bind(host="https://other.cloud.databricks.com")
        self.assertFalse(self.binding.parent.exists())

    def test_missing_auth_type_causes_no_writes(self):
        self.profile.write_text(f"[example-test]\nhost = {HOST}\n")
        with self.assertRaises(ValueError):
            self.bind()
        self.assertFalse(self.binding.parent.exists())

    def test_preserves_other_targets(self):
        self.bind("test")
        self.bind("staging")
        targets = json.loads(self.binding.read_text())["targets"]
        self.assertEqual(set(targets), {"test", "staging"})
        self.assertEqual(targets["test"], {"workspace": {"host": HOST}})

    def test_same_target_cannot_mix_deployment_state_across_workspaces(self):
        self.bind("test")
        before = self.binding.read_bytes()
        other_host = "https://other.azuredatabricks.net"
        self.profile.write_text(
            f"[example-test]\nhost = {other_host}\nauth_type = databricks-cli\n"
        )
        with self.assertRaisesRegex(ValueError, "another workspace"):
            self.bind("test", host=other_host)
        self.assertEqual(self.binding.read_bytes(), before)
        self.assertEqual(list(self.binding.parent.iterdir()), [self.binding])

    def test_rebinding_same_target_to_same_host_is_idempotent(self):
        self.bind("test")
        before = self.binding.read_bytes()
        self.bind("test")
        self.assertEqual(self.binding.read_bytes(), before)

    def test_unknown_or_credential_fields_are_rejected_without_changes(self):
        invalid = [
            {"targets": {"unknown": {"workspace": {"host": HOST}}}},
            {"targets": {"test": {"workspace": {"host": HOST, "token": "synthetic-secret"}}}},
            {"targets": {"test": {"workspace": {"host": HOST}, "auth_type": "pat"}}},
            {"targets": {}, "token": "synthetic-secret"},
            {"targets": {"test": {"workspace": {"host": HOST + "/"}}}},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.existing(value)
                before = self.binding.read_bytes()
                with self.assertRaises(ValueError):
                    self.bind()
                self.assertEqual(self.binding.read_bytes(), before)
                self.assertEqual(list(self.binding.parent.glob("*.tmp")), [])

    def test_duplicate_json_keys_are_rejected(self):
        self.existing({"targets": {}})
        self.binding.write_text('{"targets":{},"targets":{}}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.bind()

    def test_file_symlink_is_rejected(self):
        destination = Path(self.directory.name) / "other.json"
        destination.write_text('{"targets":{}}')
        self.binding.parent.mkdir()
        self.binding.symlink_to(destination)
        with self.assertRaises(OSError):
            self.bind()
        self.assertEqual(destination.read_text(), '{"targets":{}}')

    def test_parent_symlink_is_rejected(self):
        destination = Path(self.directory.name) / "other"
        destination.mkdir()
        self.binding.parent.symlink_to(destination, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.bind()
        self.assertEqual(list(destination.iterdir()), [])

    def test_ancestor_symlink_is_rejected(self):
        alias = Path(self.directory.name) / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.bind(root=alias)
        self.assertFalse(self.binding.parent.exists())

    def test_binding_mode_is_private_and_parent_mode_is_preserved(self):
        self.binding.parent.mkdir(mode=0o755)
        before = stat.S_IMODE(self.binding.parent.stat().st_mode)
        self.bind()
        self.assertEqual(stat.S_IMODE(self.binding.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.binding.parent.stat().st_mode), before)
        self.assertEqual(list(self.binding.parent.iterdir()), [self.binding])

    def test_atomic_replace_failure_removes_temporary_file(self):
        from unittest.mock import patch
        self.bind()
        before = self.binding.read_bytes()
        with patch.object(BIND.os, "replace", side_effect=OSError("synthetic write failure")):
            with self.assertRaises(OSError):
                self.bind("prod")
        self.assertEqual(self.binding.read_bytes(), before)
        self.assertEqual(list(self.binding.parent.iterdir()), [self.binding])


if __name__ == "__main__":
    unittest.main()
