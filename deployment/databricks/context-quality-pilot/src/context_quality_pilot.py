# Databricks notebook source
# MAGIC %md
# MAGIC # Synthetic context-quality capability pilot
# MAGIC
# MAGIC This notebook checks MLflow tracking using four fixed, synthetic recorded
# MAGIC answers. It does not call a model, retrieval service, Fabric, or Lakebase.
# MAGIC It is a capability probe, not the Fabric TypeScript evaluator or a
# MAGIC tenant-authorized production evaluation pipeline. Only metrics and hashes
# MAGIC are logged; source text, answers and citation labels stay in memory.

# COMMAND ----------

import copy
import hashlib
import json
import platform
import re
import unicodedata


PILOT_VERSION = "1"
EXPERIMENT_ROOT = "/Shared/fabric-context-quality-pilot/experiments"
TARGETS = ("test", "staging", "prod")


def synthetic_cases():
    """Fresh synthetic fixtures: one acceptance and three expected rejections."""
    base = {
        "answer": "The example service retains logs for 30 days.",
        "required_phrases": ["30 days"],
        "forbidden_phrases": ["90 days"],
        "required_citations": ["example-policy-v1"],
        "actual_citations": ["example-policy-v1"],
    }
    variants = [
        ("accepted", {}, True),
        ("missing_phrase", {"answer": "The example service retains logs."}, False),
        (
            "forbidden_phrase",
            {"answer": "Logs are retained for 30 days, or 90 days."},
            False,
        ),
        ("missing_citation", {"actual_citations": []}, False),
    ]
    return [
        {"id": case_id, **copy.deepcopy(base), **changes, "expected_pass": expected}
        for case_id, changes, expected in variants
    ]


def digest(value):
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def score_case(case):
    """Exact, case-sensitive phrase/citation checks for this pilot only."""
    required = all(phrase in case["answer"] for phrase in case["required_phrases"])
    forbidden = not any(
        phrase in case["answer"] for phrase in case["forbidden_phrases"]
    )
    cited = set(case["required_citations"]).issubset(case["actual_citations"])
    return {
        "required_phrases": int(required),
        "forbidden_phrases": int(forbidden),
        "required_citations": int(cited),
        "passed": int(required and forbidden and cited),
    }


def evaluate_cases(cases):
    if not cases or len(cases) > 50:
        raise ValueError("Pilot requires 1 to 50 synthetic cases")
    seen = set()
    results = []
    for case in cases:
        case_id = case["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", case_id) or case_id in seen:
            raise ValueError("Pilot case ids must be unique metric-safe identifiers")
        seen.add(case_id)
        if type(case["expected_pass"]) is not bool:
            raise ValueError("Pilot expectations must be booleans")
        result = score_case(case)
        if bool(result["passed"]) != case["expected_pass"]:
            raise RuntimeError("Synthetic scoring expectation was not met")
        results.append({"id": case_id, **result})
    if not any(row["passed"] for row in results) or all(
        row["passed"] for row in results
    ):
        raise ValueError("Pilot must exercise both acceptance and rejection")
    return results


def run_pilot(mlflow_module, target="test", cases=None, experiment_path=None):
    """Log, read back and verify synthetic metrics; propagate every failure."""
    if target not in TARGETS:
        raise ValueError("Target must be test, staging or prod")
    if experiment_path is None:
        experiment_path = f"{EXPERIMENT_ROOT}/{target}"
    if (
        not isinstance(experiment_path, str)
        or not experiment_path.startswith("/")
        or len(experiment_path) > 1024
        or "\\" in experiment_path
        or any(
            unicodedata.category(character) in ("Cc", "Cf", "Zl", "Zp")
            for character in experiment_path
        )
        or any(part in ("", ".", "..") for part in experiment_path.split("/")[1:])
    ):
        raise ValueError("Experiment must be a canonical absolute workspace path")
    basename = experiment_path.rsplit("/", 1)[1]
    if basename != target and not basename.endswith(f"-{target}"):
        raise ValueError("Experiment basename must match the selected target")
    cases = synthetic_cases() if cases is None else cases
    results = evaluate_cases(cases)
    params = {
        "pilot_version": PILOT_VERSION,
        "dataset_sha256": digest(cases),
        "rules_sha256": digest(
            {
                "version": PILOT_VERSION,
                "rules": ["exact-required", "exact-forbidden", "required-citation-subset"],
            }
        ),
        "python_version": platform.python_version(),
        "mlflow_version": str(mlflow_module.__version__),
        "target": target,
    }
    metrics = {
        "case_count": float(len(results)),
        "accepted_count": float(sum(row["passed"] for row in results)),
        "rejected_count": float(sum(1 - row["passed"] for row in results)),
        "expectation_match_rate": 1.0,
    }
    for row in results:
        for key, value in row.items():
            if key != "id":
                metrics[f"case.{row['id']}.{key}"] = float(value)

    mlflow_module.set_tracking_uri("databricks")
    mlflow_module.set_experiment(experiment_path)
    client = mlflow_module.tracking.MlflowClient()
    with mlflow_module.start_run(run_name="synthetic-context-quality") as run:
        run_id = run.info.run_id
        mlflow_module.set_tags(
            {"fabric.pilot": "context-quality", "fabric.synthetic": "true"}
        )
        mlflow_module.log_params(params)
        mlflow_module.log_metrics(metrics)
        persisted = client.get_run(run_id)
        if any(persisted.data.params.get(key) != value for key, value in params.items()):
            raise RuntimeError("MLflow parameter readback did not match")
        if any(persisted.data.metrics.get(key) != value for key, value in metrics.items()):
            raise RuntimeError("MLflow metric readback did not match")

    finished = client.get_run(run_id)
    if finished.info.status != "FINISHED":
        raise RuntimeError("MLflow run did not finish successfully")
    # The run identifier is a runtime result, never a committed fixture.
    return {
        "status": "verified",
        "target": target,
        "experiment_path": experiment_path,
        "run_id": run_id,
        "case_count": len(results),
        "accepted_count": int(metrics["accepted_count"]),
        "rejected_count": int(metrics["rejected_count"]),
        "dataset_sha256": params["dataset_sha256"],
        "rules_sha256": params["rules_sha256"],
        "python_version": params["python_version"],
        "mlflow_version": params["mlflow_version"],
    }


# COMMAND ----------

if __name__ == "__main__":
    # Databricks supplies MLflow in supported serverless notebook environments.
    # Fail if it is unavailable; do not silently install packages or fake tracking.
    import mlflow

    try:
        dbutils.widgets.text("target", "test")
        dbutils.widgets.text("experiment_path", "")
        pilot_target = dbutils.widgets.get("target")
        pilot_experiment = dbutils.widgets.get("experiment_path") or None
    except NameError:
        pilot_target = "test"
        pilot_experiment = None
    pilot_result = run_pilot(
        mlflow, target=pilot_target, experiment_path=pilot_experiment
    )
    pilot_receipt = json.dumps(pilot_result, sort_keys=True)
    print(pilot_receipt)
    try:
        dbutils.notebook.exit(pilot_receipt)
    except NameError:
        pass
