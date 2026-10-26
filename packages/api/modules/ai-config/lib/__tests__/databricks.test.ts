import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hasExplicitPath,
	listDatabricksModels,
	toDatabricksApiHost,
	toDatabricksInferenceBaseUrl,
	validateDatabricksToken,
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
		expect(toDatabricksInferenceBaseUrl(HOST, "custom-chat")).toBe(
			`${HOST}/serving-endpoints`,
		);
		expect(toDatabricksInferenceBaseUrl(`${HOST}/`, "custom-chat")).toBe(
			`${HOST}/serving-endpoints`,
		);
	});

	it("respects a Unity AI Gateway path verbatim", () => {
		expect(
			toDatabricksInferenceBaseUrl(
				`${HOST}/ai-gateway/mlflow/v1`,
				"custom-chat",
			),
		).toBe(`${HOST}/ai-gateway/mlflow/v1`);
	});

	it("does not double-append an explicit /serving-endpoints", () => {
		expect(
			toDatabricksInferenceBaseUrl(
				`${HOST}/serving-endpoints`,
				"custom-chat",
			),
		).toBe(`${HOST}/serving-endpoints`);
	});
});

describe("shared Databricks inference routing", () => {
	it.each([
		["system.ai.claude-sonnet-5", "ai-gateway/mlflow/v1"],
		["custom-chat", "serving-endpoints"],
	])("routes %s through %s", (modelId, path) => {
		expect(
			toDatabricksInferenceBaseUrl(
				"https://example.cloud.databricks.com",
				modelId,
			),
		).toBe(`https://example.cloud.databricks.com/${path}`);
	});
});

afterEach(() => vi.unstubAllGlobals());
describe("Databricks connection checks remain workspace-scoped", () => {
	it("lists custom endpoints at the workspace API for a bare host", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ endpoints: [{ name: "custom-chat" }] }),
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			listDatabricksModels(
				"https://example.cloud.databricks.com",
				"example-key",
			),
		).resolves.toEqual({ ok: true, models: ["custom-chat"] });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.cloud.databricks.com/api/2.0/serving-endpoints",
			expect.anything(),
		);
	});
	it("checks identity at the workspace origin when a gateway URL is stored", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			validateDatabricksToken(
				"https://example.cloud.databricks.com/ai-gateway/mlflow/v1",
				"example-key",
			),
		).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.cloud.databricks.com/api/2.0/preview/scim/v2/Me",
			expect.anything(),
		);
	});
});
