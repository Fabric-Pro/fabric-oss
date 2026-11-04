"""Bind one bundle target to a validated private CLI profile without cloud calls."""

import argparse
import configparser
import importlib.util
import json
import os
from pathlib import Path
import stat
import uuid


ROOT = Path(__file__).absolute().parent
SPEC = importlib.util.spec_from_file_location("pilot_binding_preflight", ROOT / "preflight.py")
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)
TARGETS = ("test", "staging", "prod")
FILENAME = "workspace-bindings.yml"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Binding JSON contains duplicate keys")
        result[key] = value
    return result


def validate_bindings(value):
    if not isinstance(value, dict) or set(value) != {"targets"}:
        raise ValueError("Bindings must contain only targets")
    targets = value["targets"]
    if not isinstance(targets, dict) or any(target not in TARGETS for target in targets):
        raise ValueError("Binding target is unsupported")
    for binding in targets.values():
        if not isinstance(binding, dict) or set(binding) != {"workspace"}:
            raise ValueError("Binding must contain only workspace")
        workspace = binding["workspace"]
        if not isinstance(workspace, dict) or set(workspace) != {"host"}:
            raise ValueError("Workspace binding must contain only host")
        host = workspace["host"]
        if not isinstance(host, str) or PREFLIGHT.workspace_origin(host) != host:
            raise ValueError("Binding host must be a canonical workspace origin")
    return value


def bind_workspace(profile, target, expected_host, environ=None, root=None):
    if target not in TARGETS:
        raise ValueError("Unsupported target")
    # Validate the exact profile host and explicit auth_type before any write.
    PREFLIGHT.selected_environment(
        profile, expected_host, os.environ if environ is None else environ
    )
    host = PREFLIGHT.workspace_origin(expected_host)
    bundle_root = ROOT if root is None else Path(root).absolute()
    for component in (bundle_root, *bundle_root.parents):
        if component.is_symlink():
            raise ValueError("Symlinked binding directories are not supported")
    if not bundle_root.is_dir():
        raise ValueError("Bundle directory does not exist")
    directory = bundle_root / ".databricks"
    if directory.is_symlink():
        raise ValueError("Symlinked binding directories are not supported")
    directory.mkdir(mode=0o700, exist_ok=True)
    # Do not chmod a preexisting directory: the CLI may already own its policy.
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temp_name = None
    try:
        try:
            descriptor = os.open(FILENAME, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        except FileNotFoundError:
            bindings = {"targets": {}}
        else:
            with os.fdopen(descriptor, "r", encoding="utf-8") as existing:
                if not stat.S_ISREG(os.fstat(existing.fileno()).st_mode):
                    raise ValueError("Binding must be a regular file")
                content = existing.read(65537)
                if len(content) > 65536:
                    raise ValueError("Binding file is too large")
                bindings = validate_bindings(json.loads(content, object_pairs_hook=unique_object))
        previous = bindings["targets"].get(target)
        if previous is not None and previous["workspace"]["host"] != host:
            raise ValueError(
                "Target already belongs to another workspace; use a separate bundle copy"
            )
        bindings["targets"][target] = {"workspace": {"host": host}}
        payload = json.dumps(bindings, sort_keys=True, indent=2) + "\n"
        temp_name = f".workspace-bindings-{uuid.uuid4().hex}.tmp"
        descriptor = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_fd,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, FILENAME, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        temp_name = None
        os.fsync(directory_fd)
    finally:
        if temp_name is not None:
            os.unlink(temp_name, dir_fd=directory_fd)
        os.close(directory_fd)
    return {"status": "bound", "target": target, "cloud_calls": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--target", required=True, choices=TARGETS)
    args = parser.parse_args()
    try:
        result = bind_workspace(
            args.profile, args.target, os.environ.get("FABRIC_DATABRICKS_EXPECTED_HOST", "")
        )
    except (ValueError, OSError, configparser.Error):
        print(json.dumps({"status": "not_bound", "error": "binding_validation_or_write_failed"}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
