"""Render immutable audience-bound bundles offline; never deploy or grant access."""

import argparse
import configparser
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import uuid

ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parents[2]
SPEC = importlib.util.spec_from_file_location(
    "delivery_pilot_binding", ROOT.parent / "context-quality-pilot" / "bind_workspace.py"
)
PILOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PILOT)
IDENTIFIER = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
TOKEN = re.compile(r"\{\{([A-Z_]+)\}\}")
SQL_FILES = (
    "00_events.sql", "01_current.sql", "01_facts.sql", "02_daily.sql",
    "03_ready_durations.sql", "04_metric_view.sql", "05_grants.sql",
)


def exact_object(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Unexpected binding shape")


def bounded_text(value):
    if (not isinstance(value, str) or not value or len(value.encode("utf-8")) > 200
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError("Invalid binding identity")
    return value


def validate_binding(value):
    exact_object(value, (
        "version", "audience_id", "organization_id", "project_ids", "source",
        "destination", "query_principal", "deployment_principal", "warehouse_id",
        "workspace_host", "target",
    ))
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported binding version")
    if not isinstance(value["audience_id"], str) or not re.fullmatch(
            r"[a-z][a-z0-9_]{0,31}", value["audience_id"]):
        raise ValueError("Invalid audience identifier")
    bounded_text(value["organization_id"])
    projects = value["project_ids"]
    if not isinstance(projects, list) or not 1 <= len(projects) <= 50:
        raise ValueError("Expected a bounded nonempty project allowlist")
    for project in projects:
        bounded_text(project)
    if len(set(projects)) != len(projects):
        raise ValueError("Duplicate project binding")
    for key in ("source", "destination"):
        exact_object(value[key], ("catalog", "schema"))
        if any(not isinstance(part, str) or not IDENTIFIER.fullmatch(part)
               for part in value[key].values()):
            raise ValueError("Invalid Unity Catalog identifier")
    if value["source"] == value["destination"]:
        raise ValueError("Source and audience destination must be separate schemas")
    for key in ("query_principal", "deployment_principal"):
        principal = value[key]
        if (not isinstance(principal, str) or str(uuid.UUID(principal)) != principal
                or uuid.UUID(principal).int == 0):
            raise ValueError("Expected canonical service-principal UUID")
    if value["query_principal"] == value["deployment_principal"]:
        raise ValueError("Query principal must be distinct from deployment principal")
    if not isinstance(value["warehouse_id"], str) or not re.fullmatch(
            r"[a-zA-Z0-9_-]{1,64}", value["warehouse_id"]):
        raise ValueError("Invalid warehouse binding")
    if (not isinstance(value["workspace_host"], str)
            or PILOT.PREFLIGHT.workspace_origin(value["workspace_host"]) != value["workspace_host"]):
        raise ValueError("Expected canonical workspace origin")
    if value["target"] not in PILOT.TARGETS:
        raise ValueError("Unsupported deployment target")
    return value


def sql_text(value):
    # Hex contains no SQL syntax, independent of backslash/string parser modes.
    return "decode(unhex('" + value.encode("utf-8").hex() + "'), 'UTF-8')"


def substitute(template, values):
    return TOKEN.sub(lambda match: values[match.group(1)], template)


def render_assets(binding, profile):
    binding = validate_binding(binding)
    if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", profile):
        raise ValueError("Invalid explicit CLI profile")
    source, destination = binding["source"], binding["destination"]
    dest = ".".join("`" + destination[key] + "`" for key in ("catalog", "schema"))
    plain = destination["catalog"] + "." + destination["schema"]
    values = {
        "DEST": dest, "DEST_PLAIN": plain,
        "DEST_CATALOG": "`" + destination["catalog"] + "`",
        "SOURCE": ".".join("`" + source[key] + "`" for key in ("catalog", "schema"))
            + ".`lb_delivery_event_history`",
        "ORGANIZATION": sql_text(binding["organization_id"]),
        "PROJECTS": ", ".join(sql_text(project) for project in sorted(binding["project_ids"])),
        "PRINCIPAL": sql_text(binding["query_principal"]),
        "PRINCIPAL_IDENTIFIER": "`" + binding["query_principal"] + "`",
    }
    files = {
        "views/src/" + name: substitute((ROOT / "src" / name).read_text(), values)
        for name in SQL_FILES
    }
    space = json.loads(substitute((ROOT / "src/delivery_pulse.geniespace.json").read_text(), values))
    common = {
        "bundle": {"name": "delivery-" + binding["audience_id"], "engine": "direct",
                   "databricks_cli_version": ">= 1.7.0"},
        "workspace": {"host": binding["workspace_host"], "profile": profile},
        "targets": {binding["target"]: {"default": True, "mode": "production"}},
    }
    views = json.loads(json.dumps(common))
    views["bundle"]["name"] += "-views"
    views["workspace"]["root_path"] = "/Workspace/delivery-analytics/" + binding["audience_id"] + "/views/${bundle.target}"
    tasks = []
    for index, name in enumerate(SQL_FILES):
        task = {
            "task_key": "apply_" + name.removesuffix(".sql"),
            "environment_key": "sql_refresh",
            "notebook_task": {"notebook_path": "./src/" + name},
        }
        if index:
            task["depends_on"] = [{"task_key": tasks[-1]["task_key"]}]
        tasks.append(task)
    views["resources"] = {"jobs": {"apply_delivery_views": {
        "name": "delivery-" + binding["audience_id"] + "-apply",
        "run_as": {"service_principal_name": binding["deployment_principal"]},
        "performance_target": "STANDARD", "max_concurrent_runs": 1,
        "environments": [{"environment_key": "sql_refresh", "spec": {"client": "5"}}],
        "tasks": tasks,
    }}}
    genie = json.loads(json.dumps(common))
    genie["bundle"]["name"] += "-genie"
    genie["workspace"]["root_path"] = "/Workspace/delivery-analytics/" + binding["audience_id"] + "/genie/${bundle.target}"
    genie["resources"] = {"genie_spaces": {"delivery_pulse": {
        "title": "Delivery pulse: " + binding["audience_id"],
        "description": "Fixed-audience recorded delivery metadata; capture coverage is incomplete.",
        "warehouse_id": binding["warehouse_id"],
        "serialized_space": space,
        "permissions": [{"level": "CAN_RUN", "service_principal_name": binding["query_principal"]}],
    }}}
    files["views/databricks.yml"] = json.dumps(views, indent=2) + "\n"
    files["genie/databricks.yml"] = json.dumps(genie, indent=2) + "\n"
    # Local operator artifact only; never source content, credentials or live responses.
    files["binding.json"] = json.dumps(binding, indent=2, sort_keys=True) + "\n"
    return files


def load_binding(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Binding must be a regular file")
        content = stream.read(65537)
        if len(content.encode("utf-8")) > 65536:
            raise ValueError("Binding is too large")
    return validate_binding(json.loads(content, object_pairs_hook=PILOT.unique_object))


def write_bundle(binding_path, output, profile, environ=None):
    binding = load_binding(binding_path)
    PILOT.PREFLIGHT.selected_environment(
        profile, binding["workspace_host"], os.environ if environ is None else environ
    )
    files = render_assets(binding, profile)
    output = Path(output).absolute()
    if output.is_relative_to(REPOSITORY) and not output.is_relative_to(REPOSITORY / ".git"):
        raise ValueError("Render private bindings outside the public checkout")
    if output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError("Expected a new output directory with an existing parent")
    if any(path.is_symlink() for path in (output.parent, *output.parent.parents)):
        raise ValueError("Symlinked output directories are not supported")
    # Private new directories only. Never replace an existing audience or bundle state.
    output.mkdir(mode=0o700)
    for name, content in files.items():
        path = output / name
        directory = output
        for component in Path(name).parts[:-1]:
            directory /= component
            directory.mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
    return {"status": "rendered", "cloud_calls": False, "bundle_count": 2}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binding", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    try:
        report = write_bundle(args.binding, args.output, args.profile)
    except (ValueError, OSError, configparser.Error, KeyError, TypeError):
        print(json.dumps({"status": "refused", "cloud_calls": False, "reason": "invalid_binding_profile_or_output"}))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
