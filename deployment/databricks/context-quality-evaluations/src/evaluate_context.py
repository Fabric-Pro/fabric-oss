# Databricks notebook source
# MAGIC %md
# MAGIC # Fabric recorded-output context evaluation
# MAGIC Reads one approved bounded snapshot from a Unity Catalog volume. No model,
# MAGIC retrieval, external tools or dynamic code are called. Source bytes, answers
# MAGIC and expectations are never logged; the receipt contains only the safe report.

# COMMAND ----------

import copy
import hashlib
import json
import re

SCORER_VERSION = "fabric-deterministic-context-v1"
MAX_BYTES = 128 * 1024
JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def utf16(value):
    return value.encode("utf-16-be", "surrogatepass")


def js_utf8(value):
    return utf16(value).decode("utf-16-be", "replace").encode("utf-8")


def js_string(value):
    rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return re.sub(r"[\ud800-\udfff]", lambda match: "\\u%04x" % ord(match[0]), rendered)


def canonical(value):
    if isinstance(value, dict):
        return "{" + ",".join(js_string(key) + ":" + canonical(value[key]) for key in sorted(value, key=utf16)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    return js_string(value)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def trim(value):
    return value.strip(JS_WHITESPACE)


def includes(value, phrase):
    haystack, needle = utf16(value), utf16(phrase)
    index = haystack.find(needle)
    while index >= 0:
        if index % 2 == 0:
            return True
        index = haystack.find(needle, index + 1)
    return False


def keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Invalid context evaluation snapshot")


def bounded_string(value, maximum, nonblank=True):
    if not isinstance(value, str) or len(utf16(value)) // 2 > maximum or (nonblank and not trim(value)):
        raise ValueError("Invalid context evaluation string")


def string_list(value, maximum_count, maximum_length=128):
    if not isinstance(value, list) or len(value) > maximum_count:
        raise ValueError("Invalid context evaluation list")
    for entry in value:
        bounded_string(entry, maximum_length)
    if len({utf16(entry) for entry in value}) != len(value):
        raise ValueError("Duplicate context evaluation identifiers")


def validate(snapshot):
    keys(snapshot, ("version", "sources", "cases"))
    if type(snapshot["version"]) is not int or snapshot["version"] != 1:
        raise ValueError("Unsupported context evaluation version")
    sources, cases = snapshot["sources"], snapshot["cases"]
    if not isinstance(sources, list) or len(sources) > 50 or not isinstance(cases, list) or not 1 <= len(cases) <= 50:
        raise ValueError("Invalid context evaluation bounds")
    for source in sources:
        keys(source, ("id", "revision", "content"))
        bounded_string(source["id"], 128)
        bounded_string(source["content"], 96 * 1024)
        if not isinstance(source["revision"], str) or not re.fullmatch("[a-f0-9]{64}", source["revision"]) or hashlib.sha256(js_utf8(source["content"])).hexdigest() != source["revision"]:
            raise ValueError("Context source revision mismatch")
    for case in cases:
        keys(case, ("id", "recordedAnswer", "retrievedSourceIds", "citedSourceIds", "expectations"))
        bounded_string(case["id"], 128)
        bounded_string(case["recordedAnswer"], 16384, False)
        string_list(case["retrievedSourceIds"], 50)
        string_list(case["citedSourceIds"], 50)
        expected = case["expectations"]
        keys(expected, ("expectedSourceIds", "requiredPhrases", "forbiddenPhrases"))
        string_list(expected["expectedSourceIds"], 50)
        string_list(expected["requiredPhrases"], 20, 512)
        string_list(expected["forbiddenPhrases"], 20, 512)
        if not any(expected.values()):
            raise ValueError("At least one substantive expectation is required")
    for entries in (sources, cases):
        if len({utf16(entry["id"]) for entry in entries}) != len(entries):
            raise ValueError("Duplicate context evaluation identifiers")
    if len(canonical(snapshot).encode("utf-8")) > MAX_BYTES:
        raise ValueError("Context snapshot exceeds byte limit")


def metrics(actual, expected):
    if not expected:
        return {"precision": None, "recall": None}
    relevant = set(expected)
    matched = sum(item in relevant for item in actual)
    return {"precision": matched / len(actual) if actual else 0, "recall": matched / len(expected)}


def evaluate_case(entry, available):
    checks = []

    def check(identifier, category, passed):
        checks.append({"id": identifier, "category": category, "status": "passed" if passed else "failed"})

    retrieved, cited, expected = set(entry["retrievedSourceIds"]), set(entry["citedSourceIds"]), entry["expectations"]["expectedSourceIds"]
    check("recorded-answer-present", "integrity", bool(trim(entry["recordedAnswer"])))
    check("retrieved-sources-available", "integrity", all(item in available for item in entry["retrievedSourceIds"]))
    check("cited-sources-available", "integrity", all(item in available for item in entry["citedSourceIds"]))
    check("citations-retrieved", "integrity", all(item in retrieved for item in entry["citedSourceIds"]))
    if expected:
        check("expected-sources-available", "integrity", all(item in available for item in expected))
        check("expected-sources-retrieved", "quality", all(item in retrieved for item in expected))
        check("expected-sources-cited", "quality", all(item in cited for item in expected))
        check("citation-precision", "quality", metrics(entry["citedSourceIds"], expected)["precision"] == 1)
    if entry["expectations"]["requiredPhrases"]:
        check("required-phrases", "quality", all(includes(entry["recordedAnswer"], phrase) for phrase in entry["expectations"]["requiredPhrases"]))
    if entry["expectations"]["forbiddenPhrases"]:
        check("forbidden-phrases", "quality", all(not includes(entry["recordedAnswer"], phrase) for phrase in entry["expectations"]["forbiddenPhrases"]))
    return {"id": entry["id"], "status": "passed" if all(item["status"] == "passed" for item in checks) else "failed", "checks": checks, "retrieval": metrics(entry["retrievedSourceIds"], expected), "citations": metrics(entry["citedSourceIds"], expected)}


def evaluate(snapshot):
    validate(snapshot)
    snapshot = copy.deepcopy(snapshot)
    snapshot["sources"].sort(key=lambda item: utf16(item["id"]))
    snapshot["cases"].sort(key=lambda item: utf16(item["id"]))
    for case in snapshot["cases"]:
        for field in ("retrievedSourceIds", "citedSourceIds"):
            case[field].sort(key=utf16)
        for field in ("expectedSourceIds", "requiredPhrases", "forbiddenPhrases"):
            case["expectations"][field].sort(key=utf16)
    manifest = [{"id": source["id"], "revision": source["revision"]} for source in snapshot["sources"]]
    available = {source["id"] for source in snapshot["sources"]}
    cases = [evaluate_case(case, available) for case in snapshot["cases"]]
    failed = sum(case["status"] == "failed" for case in cases)
    failures = [item for case in cases for item in case["checks"] if item["status"] == "failed"]
    return {
        "version": 1, "mode": "recorded-output", "scorerVersion": SCORER_VERSION,
        "datasetHash": digest({"version": 1, "sources": manifest, "cases": [{"id": case["id"], "expectations": case["expectations"]} for case in snapshot["cases"]]}),
        "configurationHash": digest({"scorerVersion": SCORER_VERSION, "phraseMatching": "literal-case-sensitive", "expectedSourceMatching": "exact-identifiers", "requiredSourceRecall": 1, "requiredCitationPrecision": 1, "unavailableEvidence": "fail"}),
        "snapshotHash": digest(snapshot), "status": "failed" if failed else "passed",
        "counts": {"cases": len(cases), "passed": len(cases) - failed, "failed": failed, "integrityFailures": sum(item["category"] == "integrity" for item in failures), "qualityFailures": sum(item["category"] == "quality" for item in failures)},
        "sources": manifest, "cases": cases,
    }


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate snapshot keys")
        result[key] = value
    return result


def run_evaluation(snapshot_path, payload_hash, fabric_run_id, experiment_id, mlflow):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", fabric_run_id) or not re.fullmatch(r"[0-9]{1,16}", experiment_id) or not re.fullmatch(r"[a-f0-9]{64}", payload_hash):
        raise ValueError("Invalid evaluation parameters")
    if not re.fullmatch(r"/Volumes(?:/[A-Za-z0-9_-]+){3,8}/" + re.escape(fabric_run_id) + r"\.json", snapshot_path):
        raise ValueError("Invalid approved snapshot path")
    with open(snapshot_path, "rb") as snapshot_file:
        raw = snapshot_file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES or hashlib.sha256(raw).hexdigest() != payload_hash:
        raise ValueError("Snapshot identity mismatch")
    snapshot = json.loads(raw, object_pairs_hook=unique_object)
    report = evaluate(snapshot)
    mlflow.set_tracking_uri("databricks")
    mlflow.set_experiment(experiment_id=experiment_id)
    with mlflow.start_run(run_name="fabric-recorded-context-evaluation") as run:
        mlflow_run_id = run.info.run_id
        expected_params = {"scorer_version": SCORER_VERSION, "payload_hash": payload_hash, "dataset_hash": report["datasetHash"], "configuration_hash": report["configurationHash"], "snapshot_hash": report["snapshotHash"]}
        mlflow.log_params(expected_params)
        expected_metrics = {"case_count": report["counts"]["cases"], "passed_count": report["counts"]["passed"], "failed_count": report["counts"]["failed"]}
        mlflow.log_metrics(expected_metrics)
        stored = mlflow.tracking.MlflowClient().get_run(mlflow_run_id)
        if any(stored.data.metrics.get(key) != value for key, value in expected_metrics.items()) or any(stored.data.params.get(key) != value for key, value in expected_params.items()):
            raise RuntimeError("Evaluation tracking readback mismatch")
    if mlflow.tracking.MlflowClient().get_run(mlflow_run_id).info.status != "FINISHED":
        raise RuntimeError("Evaluation tracking did not finish")
    receipt = {"version": 1, "fabricRunId": fabric_run_id, "payloadHash": payload_hash, "experimentId": experiment_id, "mlflowRunId": mlflow_run_id, "report": report}
    if len(json.dumps(receipt, ensure_ascii=True, separators=(",", ":")).encode("utf-8")) > 100 * 1024:
        raise RuntimeError("Evaluation receipt exceeds the approved bound")
    return receipt


# COMMAND ----------

if __name__ == "__main__":
    import mlflow

    try:
        values = {}
        for parameter in ("snapshot_path", "payload_hash", "fabric_run_id", "experiment_id"):
            dbutils.widgets.text(parameter, "")
            values[parameter] = dbutils.widgets.get(parameter)
        receipt = run_evaluation(mlflow=mlflow, **values)
    except Exception:
        # Do not expose JSON parser excerpts, source data, paths or provider bodies.
        raise RuntimeError("Fabric context evaluation failed; inspect the authorized Fabric run status.") from None
    dbutils.notebook.exit(json.dumps(receipt, ensure_ascii=True, separators=(",", ":")))
