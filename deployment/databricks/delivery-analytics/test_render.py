"""Offline protocol/relational checks; not Databricks SQL, identity or UC certification."""

from datetime import datetime
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("delivery_render", ROOT / "render.py")
RENDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER)


def binding():
    return {
        "version": 1, "audience_id": "example_audience", "organization_id": "example-org",
        "project_ids": ["example-project"],
        "source": {"catalog": "example_source", "schema": "example_events"},
        "destination": {"catalog": "example_destination", "schema": "example_delivery"},
        "query_principal": "11111111-1111-4111-8111-111111111111",
        "deployment_principal": "22222222-2222-4222-8222-222222222222",
        "warehouse_id": "example_warehouse", "workspace_host": "https://example.azuredatabricks.net",
        "target": "test",
    }


class BindingTests(unittest.TestCase):
    def test_exact_bounded_binding(self):
        self.assertEqual(RENDER.validate_binding(binding()), binding())
        cases = []
        for key, value in (("organization_id", ""), ("project_ids", []),
                           ("project_ids", ["same", "same"]), ("project_ids", [str(i) for i in range(51)]),
                           ("project_ids", [None]), ("organization_id", "x\n"),
                           ("organization_id", "x" * 201), ("version", True),
                           ("query_principal", "all-users"), ("target", "other"),
                           ("workspace_host", "https://example.azuredatabricks.net/path"),
                           ("warehouse_id", "x${var.secret}")):
            row = binding(); row[key] = value; cases.append(row)
        row = binding(); row["extra"] = "unsafe"; cases.append(row)
        row = binding(); row.pop("organization_id"); cases.append(row)
        row = binding(); row["destination"] = row["source"].copy(); cases.append(row)
        row = binding(); row["destination"]["schema"] = "bad`; DROP SCHEMA example; --"; cases.append(row)
        row = binding(); row["query_principal"] = row["deployment_principal"]; cases.append(row)
        row = binding(); row["source"]["table"] = "private_snapshots"; cases.append(row)
        for row in cases:
            with self.subTest(row_keys=list(row)):
                with self.assertRaises((ValueError, TypeError)):
                    RENDER.render_assets(row, "EXAMPLE")

    def test_unbound_bundle_has_no_resources_or_defaults(self):
        text = (ROOT / "databricks.yml").read_text()
        self.assertNotIn("include:", text)
        self.assertNotIn("resources:", text)
        self.assertIn("${var.operator_binding_required}", text)
        self.assertNotIn("default:", text)
        with self.assertRaises(ValueError):
            RENDER.render_assets({}, "EXAMPLE")
        for path in (ROOT / "src").glob("*.sql"):
            self.assertIn("{{", path.read_text())
            self.assertNotIn("tf_dbr", path.read_text())

    def test_duplicate_json_keys_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binding.json"
            path.write_text('{"version": 1, "version": 1}')
            with self.assertRaises(ValueError):
                RENDER.load_binding(path)

    def test_profile_pinned_before_write_private_output_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "binding.json"; source.write_text(json.dumps(binding()))
            config = root / "config"
            config.write_text('[EXAMPLE]\nhost=https://example.azuredatabricks.net\nauth_type=oauth-m2m\n')
            env = {"DATABRICKS_CONFIG_FILE": str(config), "DATABRICKS_HOST": "https://wrong.example.com",
                   "DATABRICKS_TOKEN": "synthetic-unused-token"}
            output = root / "rendered"
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, output, "MISSING", env)
            self.assertFalse(output.exists())
            report = RENDER.write_bundle(source, output, "EXAMPLE", env)
            self.assertFalse(report["cloud_calls"])
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            for path in output.rglob("*"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, output, "EXAMPLE", env)
            configs = [json.loads((output / name / "databricks.yml").read_text()) for name in ("views", "genie")]
            for row in configs:
                self.assertEqual(row["workspace"]["host"], binding()["workspace_host"])
                self.assertEqual(row["workspace"]["profile"], "EXAMPLE")
                self.assertNotIn("synthetic-unused-token", json.dumps(row))
            config.write_text('[EXAMPLE]\nhost=https://other.azuredatabricks.net\nauth_type=oauth-m2m\n')
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, root / "different", "EXAMPLE", env)
            config.write_text('[EXAMPLE]\nhost=https://example.azuredatabricks.net\n')
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, root / "different", "EXAMPLE", env)

    def test_symlink_and_public_checkout_output_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "binding.json"; source.write_text(json.dumps(binding()))
            link = root / "link.json"; link.symlink_to(source)
            with self.assertRaises(OSError):
                RENDER.load_binding(link)
            config = root / "config"
            config.write_text('[EXAMPLE]\nhost=https://example.azuredatabricks.net\nauth_type=oauth-m2m\n')
            env = {"DATABRICKS_CONFIG_FILE": str(config)}
            link_dir = root / "linked"; link_dir.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, link_dir / "rendered", "EXAMPLE", env)
            with self.assertRaises(ValueError):
                RENDER.write_bundle(source, ROOT / "example-should-not-exist", "EXAMPLE", env)

    def test_genie_and_grants_are_pinned_destination_only(self):
        row = binding(); files = RENDER.render_assets(row, "EXAMPLE")
        config = json.loads(files["genie/databricks.yml"])
        resource = config["resources"]["genie_spaces"]["delivery_pulse"]
        self.assertNotIn("file_path", resource)
        self.assertEqual(resource["permissions"], [{"level": "CAN_RUN", "service_principal_name": row["query_principal"]}])
        space = resource["serialized_space"]
        names = [item["identifier"] for kind in ("tables", "metric_views") for item in space["data_sources"][kind]]
        self.assertEqual(set(names), {"example_destination.example_delivery." + name for name in (
            "delivery_current", "delivery_ready_durations", "delivery_metrics")})
        self.assertEqual(len(space["data_sources"]["metric_views"]), 1)
        self.assertNotIn("supplied by the application or user", json.dumps(space))
        self.assertNotIn("{{", json.dumps(space))
        grants = files["views/src/05_grants.sql"]
        self.assertNotIn("example_source", grants)
        self.assertNotIn("ALL PRIVILEGES", grants)
        self.assertNotIn("delivery_events TO", grants)
        self.assertNotIn("delivery_facts TO", grants)
        views = json.loads(files["views/databricks.yml"])
        job = views["resources"]["jobs"]["apply_delivery_views"]
        self.assertNotIn("schedule", job)
        self.assertEqual(job["run_as"]["service_principal_name"], row["deployment_principal"])
        self.assertEqual(job["tasks"][-1]["task_key"], "apply_05_grants")
        metric = files["views/src/04_metric_view.sql"]
        self.assertIn('version: "1.1"', metric)
        self.assertEqual(metric.count("synonyms:"), 6)
        self.assertEqual(metric.count("comment:"), 7)

    def test_local_cli_schema_validation(self):
        # Local schema command only; do not run bundle validate (can authenticate).
        completed = subprocess.run(["databricks", "bundle", "schema"], capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, "Local CLI schema unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); schema = root / "schema.json"; schema.write_text(completed.stdout)
            files = RENDER.render_assets(binding(), "EXAMPLE")
            paths = []
            for name in ("views", "genie"):
                path = root / (name + ".json"); path.write_text(files[name + "/databricks.yml"]); paths.append(str(path))
            checked = subprocess.run(["node", str(ROOT / "validate_schema.cjs"), str(schema), *paths],
                                     capture_output=True, text=True, timeout=30)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertTrue(json.loads(checked.stdout)["schemaValid"])
            invalid = json.loads(files["genie/databricks.yml"])
            invalid["resources"]["genie_spaces"]["delivery_pulse"]["unsupported_external_knowledge"] = "synthetic-private-value"
            bad = root / "invalid.json"; bad.write_text(json.dumps(invalid))
            rejected = subprocess.run(["node", str(ROOT / "validate_schema.cjs"), str(schema), str(bad)],
                                      capture_output=True, text=True, timeout=30)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertNotIn("synthetic-private-value", rejected.stderr)


class RelationalTests(unittest.TestCase):
    def setUp(self):
        self.binding = binding()
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.principal = self.binding["query_principal"]
        self.db.create_function("session_user", 0, lambda: self.principal)
        self.db.create_function("unhex", 1, bytes.fromhex)
        self.db.create_function("decode", 2, lambda value, encoding: value.decode(encoding))
        self.db.create_function("UNIX_TIMESTAMP", 1, lambda value: datetime.fromisoformat(value).timestamp())
        self.db.execute('''CREATE TABLE lb_delivery_event_history (
            id TEXT, occurred_at TEXT, organization_id TEXT, project_id TEXT, subject_type TEXT,
            subject_id TEXT, event_type TEXT, from_state TEXT, to_state TEXT, schema_version INTEGER,
            _sort_by INTEGER, _pg_lsn INTEGER, _pg_change_type TEXT)''')
        self.install()

    def tearDown(self):
        self.db.close()

    def install(self):
        files = RENDER.render_assets(self.binding, "EXAMPLE")
        for name in RENDER.SQL_FILES[:5]:
            sql = files["views/src/" + name]
            # Execute the actual relational SQL with dialect-only DDL/name translation.
            sql = re.sub(r"`[^`]+`\.`[^`]+`\.(?:`([^`]+)`|([a-z_]+))", lambda m: m[1] or m[2], sql)
            sql = sql.replace("CREATE OR REPLACE VIEW", "CREATE VIEW")
            sql = sql.replace("SET TIME ZONE 'UTC';", "")
            self.db.executescript(sql)

    def event(self, id="example-created", at="2026-01-01 00:00:00", subject="example-story", kind="created",
              state=None, sort=1, lsn=None, change="insert", org=None, project=None, subject_type="story", version=1):
        self.db.execute("INSERT INTO lb_delivery_event_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            id, at, self.binding["organization_id"] if org is None else org,
            self.binding["project_ids"][0] if project is None else project, subject_type,
            subject, kind, None, state, version, sort, sort if lsn is None else lsn, change))

    def rows(self, table):
        return [dict(row) for row in self.db.execute("SELECT * FROM " + table)]

    def test_cdc_collapse_before_subject_order_and_redaction(self):
        self.event(id="example-old", kind="stage_changed", state="PUBLISHED", at="2026-02-01 00:00:00")
        self.event(id="example-old", kind="stage_changed", state=None, at="2026-01-01 00:00:00", sort=3, change="update_postimage")
        self.event(id="example-old", kind="stage_changed", state="PUBLISHED", sort=4, change="update_preimage")
        self.event(id="example-new", kind="stage_changed", state="REVIEW", at="2026-01-02 00:00:00", sort=2)
        self.assertEqual(self.rows("delivery_current")[0]["current_state"], "REVIEW")
        self.assertEqual(len(self.rows("delivery_events")), 2)
        self.assertEqual(self.rows("delivery_ready_durations"), [])
        self.event(id="example-new", kind="stage_changed", at="2020-01-01 00:00:00", sort=9, change="delete")
        self.assertIsNone(self.rows("delivery_current")[0]["current_state"])

    def test_tombstone_does_not_resurrect_old_audience_row(self):
        self.event()
        self.event(change="delete", org="example-other-org", project="example-other-project", sort=2, at="2000-01-01 00:00:00")
        self.assertEqual(self.rows("delivery_events"), [])
        self.assertEqual(self.rows("delivery_daily"), [])

    def test_same_offset_delete_wins_and_lsn_breaks_sort_ties(self):
        self.event(sort=1, lsn=1)
        self.event(sort=1, lsn=2, change="update_postimage", state="PUBLISHED")
        self.assertEqual(self.rows("delivery_events")[0]["to_state"], "PUBLISHED")
        self.event(sort=1, lsn=2, change="delete")
        self.assertEqual(self.rows("delivery_events"), [])

    def test_ready_tombstone_removes_count_and_duration(self):
        self.event()
        self.event(id="example-ready", kind="stage_changed", state="PUBLISHED", sort=2,
                   at="2026-01-03 00:00:00")
        self.assertEqual(self.rows("delivery_ready_durations")[0]["ready_days"], 2)
        self.event(id="example-ready", kind="stage_changed", state="PUBLISHED", sort=3,
                   at="2000-01-01 00:00:00", change="delete")
        self.assertEqual(self.rows("delivery_ready_durations"), [])
        self.assertEqual(sum(row["ready_count"] for row in self.rows("delivery_daily")), 0)

    def test_changed_audience_postimage_cannot_resurrect_old_org(self):
        self.event()
        self.event(org="example-other-org", sort=2, change="update_postimage")
        self.assertEqual(self.rows("delivery_events"), [])

    def test_missing_order_and_unsupported_schema_fail_closed(self):
        self.event()
        self.event(sort=None, change="update_postimage")
        self.event(id="example-version", subject="example-version", version=2)
        self.assertEqual(self.rows("delivery_events"), [])

    def test_daily_first_ready_and_creation_counts_no_postimage_or_reentry_duplication(self):
        self.event()
        self.event(sort=2, change="update_postimage")
        self.event(id="example-created-again", sort=3, at="2026-01-02 00:00:00")
        self.event(id="example-ready", sort=4, kind="stage_changed", state="PUBLISHED", at="2026-01-03 00:00:00")
        self.event(id="example-ready", sort=5, kind="stage_changed", state="PUBLISHED", at="2026-01-03 00:00:00", change="update_postimage")
        self.event(id="example-return-ready", sort=6, kind="stage_changed", state="PUBLISHED", at="2026-01-05 00:00:00")
        self.event(id="example-run", subject="example-run", subject_type="coding_run")
        rows = self.rows("delivery_daily")
        self.assertEqual(sum(row["created_count"] for row in rows), 1)
        self.assertEqual(sum(row["ready_count"] for row in rows), 1)
        self.assertEqual(sum(row["run_count"] for row in rows), 1)
        self.assertEqual(self.rows("delivery_ready_durations")[0]["ready_days"], 2)
        self.assertEqual([row["day"] for row in rows if row["ready_count"]], ["2026-01-03"])

    def test_missing_or_inconsistent_creation_never_fabricates_duration(self):
        self.event(id="example-ready", kind="stage_changed", state="PUBLISHED")
        row = self.rows("delivery_ready_durations")[0]
        self.assertIsNone(row["ready_days"])
        self.assertEqual(row["duration_coverage"], "CREATION_NOT_CAPTURED")
        self.event(id="example-created", at="2026-01-02 00:00:00")
        row = self.rows("delivery_ready_durations")[0]
        self.assertIsNone(row["ready_days"])
        self.assertEqual(row["duration_coverage"], "INCONSISTENT_EVENT_TIMES")

    def test_org_project_and_query_principal_are_enforced(self):
        self.event()
        self.event(id="example-foreign-org", org="example-other-org")
        self.event(id="example-foreign-project", project="example-other-project")
        self.assertEqual(len(self.rows("delivery_events")), 1)
        self.principal = "33333333-3333-4333-8333-333333333333"
        for table in ("delivery_events", "delivery_current", "delivery_daily", "delivery_ready_durations"):
            self.assertEqual(self.rows(table), [])
        self.principal = self.binding["query_principal"]
        self.assertEqual(len(self.rows("delivery_events")), 1)

    def test_current_generation_replacement_needs_no_cached_offset(self):
        self.event(sort=999)
        self.db.execute("DELETE FROM lb_delivery_event_history")
        self.event(id="example-resnapshot", sort=0)
        self.assertEqual([row["id"] for row in self.rows("delivery_events")], ["example-resnapshot"])

    def test_sql_literal_escaping_is_exact_not_executable(self):
        self.db.close()
        self.setUp()
        for table in ("delivery_ready_durations", "delivery_daily", "delivery_facts", "delivery_current", "delivery_events"):
            self.db.execute("DROP VIEW " + table)
        self.binding["organization_id"] = "example'\\ OR 1=1; -- 雪 ${var.secret}"
        self.binding["project_ids"] = ["example'); DROP TABLE lb_delivery_event_history; --"]
        self.install()
        self.event()
        self.event(id="example-foreign", org="example-org", project="example-project")
        self.assertEqual(len(self.rows("delivery_events")), 1)
        self.assertEqual(self.rows("delivery_events")[0]["organization_id"], self.binding["organization_id"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM lb_delivery_event_history").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
