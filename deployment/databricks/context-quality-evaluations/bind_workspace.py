"""Reuse the validated, private profile binding writer for this bundle."""

import argparse
import configparser
import importlib.util
import json
import os
from pathlib import Path

ROOT = Path(__file__).absolute().parent
SPEC = importlib.util.spec_from_file_location(
    "evaluation_binding", ROOT.parent / "context-quality-pilot" / "bind_workspace.py"
)
BINDING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BINDING)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--target", required=True, choices=BINDING.TARGETS)
    args = parser.parse_args()
    try:
        result = BINDING.bind_workspace(
            args.profile, args.target,
            os.environ.get("FABRIC_DATABRICKS_EXPECTED_HOST", ""), root=ROOT,
        )
    except (ValueError, OSError, configparser.Error):
        print(json.dumps({"status": "not_bound", "error": "binding_validation_or_write_failed"}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
