"""Read-only CLI capability checks; never print workspace identities or API bodies."""

import argparse
import configparser
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit


CHECKS = {
    "identity": (["current-user", "me"], None),
    "experiments": (["experiments", "search-experiments", "--max-results", "10", "--limit", "10"], "experiments"),
    "jobs": (["jobs", "list", "--limit", "10"], "jobs"),
    "sql_warehouses": (["warehouses", "list"], "warehouses"),
    "lakebase_projects": (["postgres", "list-projects"], "projects"),
}


def workspace_origin(value):
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not host.endswith((".databricks.com", ".azuredatabricks.net"))
    ):
        raise ValueError("Expected an HTTPS Databricks workspace origin")
    return "https://" + host


def selected_environment(profile, expected_host, environ):
    """Pin profile host/auth mechanism and discard ambient credential overrides."""
    config_path = Path(environ.get("DATABRICKS_CONFIG_FILE", "~/.databrickscfg")).expanduser()
    config = configparser.ConfigParser(interpolation=None)
    if not config.read(config_path) or not config.has_section(profile):
        raise ValueError("Selected CLI profile was not found")
    actual = workspace_origin(config.get(profile, "host", fallback=""))
    if actual != workspace_origin(expected_host):
        raise ValueError("Selected profile does not match the expected workspace")
    if not config.get(profile, "auth_type", fallback="").strip():
        raise ValueError("Selected CLI profile must explicitly choose auth_type")
    clean = {
        key: value for key, value in environ.items()
        if not key.startswith(("DATABRICKS_", "ARM_", "AZURE_"))
    }
    # Keep the operator's existing CLI storage choice, without selecting a new
    # backend or carrying host/token/identity overrides across profiles.
    if "DATABRICKS_AUTH_STORAGE" in environ:
        clean["DATABRICKS_AUTH_STORAGE"] = environ["DATABRICKS_AUTH_STORAGE"]
    clean["DATABRICKS_CONFIG_FILE"] = str(config_path)
    return clean


def preflight(profile, expected_host, environ=None, runner=subprocess.run):
    env = selected_environment(profile, expected_host, os.environ if environ is None else environ)
    results = {}
    for name, (arguments, collection) in CHECKS.items():
        command = ["databricks", *arguments, "--profile", profile, "--output", "json"]
        try:
            completed = runner(command, env=env, capture_output=True, text=True, timeout=45)
            if completed.returncode != 0:
                reason = "cli_error"
                # Emit only an allowlisted diagnosis, never the provider's raw
                # error text, which can include identities and workspace URLs.
                if "without the workspace-access entitlement" in completed.stderr:
                    reason = "missing_workspace_access"
                elif "without the databricks-sql-access entitlement" in completed.stderr:
                    reason = "missing_sql_access"
                results[name] = {"available": False, "reason": reason}
                if name == "identity":
                    break
                continue
            response = json.loads(completed.stdout)
            if collection is None:
                if not isinstance(response, dict) or response.get("active") is not True or not response.get("id"):
                    raise ValueError("Unexpected identity response")
                results[name] = {"available": True}
            else:
                rows = response if isinstance(response, list) else response.get(collection)
                if not isinstance(rows, list):
                    raise ValueError("Unexpected collection response")
                results[name] = {"available": True, "observed_count": len(rows)}
        except (subprocess.TimeoutExpired, OSError):
            results[name] = {"available": False, "reason": "command_unavailable_or_timed_out"}
        except (ValueError, AttributeError, TypeError):
            results[name] = {"available": False, "reason": "invalid_response"}
        if name == "identity" and not results[name]["available"]:
            break
    return {
        "workspace_match": True,
        "read_only": True,
        "checks": results,
        "all_checks_available": len(results) == len(CHECKS) and all(row["available"] for row in results.values()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    expected_host = os.environ.get("FABRIC_DATABRICKS_EXPECTED_HOST", "")
    try:
        report = preflight(args.profile, expected_host)
    except (ValueError, OSError, configparser.Error):
        print(json.dumps({"workspace_match": False, "read_only": True, "error": "profile_or_expected_host_invalid"}))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0 if report["all_checks_available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
