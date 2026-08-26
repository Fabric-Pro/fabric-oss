import { describe, expect, it } from "vitest";
import {
	getDatabricksConfig,
	getDatabricksHost,
	isDatabricksConfigured,
} from "../src/config";

describe("getDatabricksConfig", () => {
	it("returns null when DATABRICKS_HOST is unset", () => {
		expect(getDatabricksConfig({})).toBeNull();
	});

	it("returns null when DATABRICKS_HOST is blank", () => {
		expect(getDatabricksConfig({ DATABRICKS_HOST: "   " })).toBeNull();
	});

	it("throws when DATABRICKS_HOST starts with http://", () => {
		expect(() =>
			getDatabricksConfig({
				DATABRICKS_HOST: "http://my-workspace.azuredatabricks.net",
			}),
		).toThrow(/must start with "https:\/\/"/);
	});

	it("strips trailing slashes from host", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "https://my-workspace.azuredatabricks.net///",
		});
		expect(config?.host).toBe("https://my-workspace.azuredatabricks.net");
	});

	it("trims whitespace from host and strips trailing slash", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "  https://ws.azuredatabricks.net/  ",
		});
		expect(config?.host).toBe("https://ws.azuredatabricks.net");
	});

	it("reads PAT token from DATABRICKS_TOKEN", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "https://ws.azuredatabricks.net",
			DATABRICKS_TOKEN: "dapi123",
		});
		expect(config?.token).toBe("dapi123");
	});

	it("treats empty DATABRICKS_TOKEN as undefined", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "https://ws.azuredatabricks.net",
			DATABRICKS_TOKEN: "  ",
		});
		expect(config?.token).toBeUndefined();
	});

	it("reads OAuth credentials", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "https://ws.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "client-id",
			DATABRICKS_CLIENT_SECRET: "client-secret",
		});
		expect(config?.clientId).toBe("client-id");
		expect(config?.clientSecret).toBe("client-secret");
	});

	it("treats empty OAuth fields as undefined", () => {
		const config = getDatabricksConfig({
			DATABRICKS_HOST: "https://ws.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "",
			DATABRICKS_CLIENT_SECRET: "  ",
		});
		expect(config?.clientId).toBeUndefined();
		expect(config?.clientSecret).toBeUndefined();
	});
});

describe("isDatabricksConfigured", () => {
	it("returns false when host is not set", () => {
		expect(isDatabricksConfigured({})).toBe(false);
	});

	it("returns false when host is set but no credentials", () => {
		expect(
			isDatabricksConfigured({
				DATABRICKS_HOST: "https://ws.azuredatabricks.net",
			}),
		).toBe(false);
	});

	it("returns true when host + PAT token are set", () => {
		expect(
			isDatabricksConfigured({
				DATABRICKS_HOST: "https://ws.azuredatabricks.net",
				DATABRICKS_TOKEN: "dapi123",
			}),
		).toBe(true);
	});

	it("returns false when host + clientId only (no secret)", () => {
		expect(
			isDatabricksConfigured({
				DATABRICKS_HOST: "https://ws.azuredatabricks.net",
				DATABRICKS_CLIENT_ID: "client-id",
			}),
		).toBe(false);
	});

	it("returns true when host + clientId + clientSecret are set", () => {
		expect(
			isDatabricksConfigured({
				DATABRICKS_HOST: "https://ws.azuredatabricks.net",
				DATABRICKS_CLIENT_ID: "client-id",
				DATABRICKS_CLIENT_SECRET: "client-secret",
			}),
		).toBe(true);
	});

	it("returns false when only clientId + clientSecret but no host", () => {
		expect(
			isDatabricksConfigured({
				DATABRICKS_CLIENT_ID: "client-id",
				DATABRICKS_CLIENT_SECRET: "client-secret",
			}),
		).toBe(false);
	});
});

describe("getDatabricksHost", () => {
	it("throws when DATABRICKS_HOST is not set", () => {
		expect(() => getDatabricksHost({})).toThrow(
			"DATABRICKS_HOST is not set",
		);
	});

	it("returns the normalized host", () => {
		expect(
			getDatabricksHost({
				DATABRICKS_HOST: "https://ws.azuredatabricks.net/",
			}),
		).toBe("https://ws.azuredatabricks.net");
	});
});
