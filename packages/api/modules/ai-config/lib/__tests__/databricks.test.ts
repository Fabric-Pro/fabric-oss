import { describe, expect, it } from "vitest";
import {
	hasExplicitPath,
	toDatabricksApiHost,
	toDatabricksInferenceBaseUrl,
} from "../databricks";

describe("toDatabricksApiHost", () => {
	const HOST = "https://abc-123.cloud.databricks.com";

	it("returns the workspace origin for a bare host", () => {
		expect(toDatabricksApiHost(HOST)).toBe(HOST);
	});

	it("strips a trailing slash", () => {
		expect(toDatabricksApiHost(`${HOST}/`)).toBe(HOST);
	});

	it("resolves to the origin when the classic serving path is present", () => {
		expect(toDatabricksApiHost(`${HOST}/serving-endpoints`)).toBe(HOST);
	});

	it("resolves to the origin when a Unity AI Gateway path is present", () => {
		expect(toDatabricksApiHost(`${HOST}/ai-gateway/mlflow/v1`)).toBe(HOST);
	});

	it("keeps a non-default explicit port", () => {
		expect(toDatabricksApiHost(`${HOST}:8443/serving-endpoints`)).toBe(
			`${HOST}:8443`,
		);
	});

	it("falls back to suffix stripping for an unparseable value", () => {
		expect(
			toDatabricksApiHost("abc.databricks.com/serving-endpoints"),
		).toBe("abc.databricks.com");
	});
});

describe("hasExplicitPath", () => {
	const HOST = "https://abc-123.cloud.databricks.com";

	it("is false for a bare host", () => {
		expect(hasExplicitPath(HOST)).toBe(false);
	});

	it("is false for a bare host with a trailing slash", () => {
		expect(hasExplicitPath(`${HOST}/`)).toBe(false);
	});

	it("is true for a Unity AI Gateway path", () => {
		expect(hasExplicitPath(`${HOST}/ai-gateway/mlflow/v1`)).toBe(true);
	});

	it("is true for an explicit /serving-endpoints path", () => {
		expect(hasExplicitPath(`${HOST}/serving-endpoints`)).toBe(true);
	});
});

describe("toDatabricksInferenceBaseUrl", () => {
	const HOST = "https://abc-123.cloud.databricks.com";

	it("defaults a bare host to the classic serving path", () => {
		expect(toDatabricksInferenceBaseUrl(HOST)).toBe(
			`${HOST}/serving-endpoints`,
		);
		expect(toDatabricksInferenceBaseUrl(`${HOST}/`)).toBe(
			`${HOST}/serving-endpoints`,
		);
	});

	it("respects a Unity AI Gateway path verbatim", () => {
		expect(
			toDatabricksInferenceBaseUrl(`${HOST}/ai-gateway/mlflow/v1`),
		).toBe(`${HOST}/ai-gateway/mlflow/v1`);
	});

	it("does not double-append an explicit /serving-endpoints", () => {
		expect(toDatabricksInferenceBaseUrl(`${HOST}/serving-endpoints`)).toBe(
			`${HOST}/serving-endpoints`,
		);
	});
});
