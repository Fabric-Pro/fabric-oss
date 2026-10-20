import { describe, expect, it } from "vitest";
import {
	buildProjectReference,
	buildProjectResource,
	looksLikeProjectResource,
	parseOAuthReference,
	parseProjectResource,
	staticResourceFor,
} from "../oauth-project-resource";

const APP_URL = "https://app.example.com";

describe("project resource URLs", () => {
	it("builds the canonical MCP and API resources", () => {
		expect(
			buildProjectResource(APP_URL, "mcp", "project-example-one"),
		).toBe(
			"https://app.example.com/api/mcp-gateway/projects/project-example-one",
		);
		expect(
			buildProjectResource(APP_URL, "api", "project-example-one"),
		).toBe("https://app.example.com/api/v1/projects/project-example-one");
	});

	it("ignores a trailing slash on the app URL", () => {
		expect(
			buildProjectResource(`${APP_URL}/`, "mcp", "project-example-one"),
		).toBe(buildProjectResource(APP_URL, "mcp", "project-example-one"));
	});

	it.each([
		["a plain origin", APP_URL],
		["a long slash suffix", `${APP_URL}${"/".repeat(8_192)}`],
		["a long interior slash run", `${APP_URL}/${"/".repeat(8_192)}tail`],
		[
			"interior slashes, query and fragment",
			`${APP_URL}/base//path?value=/#fragment`,
		],
		["an empty base", ""],
		["only slashes", "///"],
	])("removes only trailing slashes from %s", (_label, appUrl) => {
		// Splitting defines the expected spelling without another suffix regex.
		const segments = appUrl.split("/");
		while (segments.at(-1) === "") {
			segments.pop();
		}
		const base = segments.join("/");
		for (const audience of ["mcp", "api"] as const) {
			const path = audience === "mcp" ? "/api/mcp-gateway" : "/api/v1";
			const resource = `${base}${path}/projects/project-example-one`;
			expect(
				buildProjectResource(appUrl, audience, "project-example-one"),
			).toBe(resource);
			expect(staticResourceFor(appUrl, audience)).toBe(`${base}${path}`);
			expect(parseProjectResource(appUrl, resource)).toEqual({
				audience,
				projectId: "project-example-one",
			});
			expect(looksLikeProjectResource(appUrl, resource)).toBe(true);
		}
	});

	it("refuses to build a resource for an id that could add a segment", () => {
		for (const projectId of ["", "a/b", "a?b", "a#b", "a b", "..", "a.b"]) {
			expect(() =>
				buildProjectResource(APP_URL, "mcp", projectId),
			).toThrow();
		}
	});

	it("parses what it builds, for both audiences", () => {
		for (const audience of ["mcp", "api"] as const) {
			const resource = buildProjectResource(
				APP_URL,
				audience,
				"abc_123-X",
			);
			expect(parseProjectResource(APP_URL, resource)).toEqual({
				audience,
				projectId: "abc_123-X",
			});
		}
	});

	it("reads only the exact canonical spelling as a project resource", () => {
		const canonical = buildProjectResource(
			APP_URL,
			"mcp",
			"project-example-one",
		);
		for (const resource of [
			`${canonical}/`,
			`${canonical}?x=1`,
			`${canonical}#frag`,
			`${canonical}/extra`,
			`${canonical}%2Fextra`,
			"https://elsewhere.example/api/mcp-gateway/projects/project-example-one",
			"http://app.example.com/api/mcp-gateway/projects/project-example-one",
			"https://app.example.com/api/mcp-gateway/projects/",
			"https://app.example.com/api/mcp-gateway",
			"https://app.example.com/api/v1",
			"https://app.example.com/api/other/projects/project-example-one",
		]) {
			expect(
				parseProjectResource(APP_URL, resource),
				resource,
			).toBeNull();
		}
	});

	it("recognises a misspelled project resource as one so it can be refused clearly", () => {
		const canonical = buildProjectResource(
			APP_URL,
			"api",
			"project-example-one",
		);

		expect(looksLikeProjectResource(APP_URL, `${canonical}/`)).toBe(true);
		expect(looksLikeProjectResource(APP_URL, canonical)).toBe(true);
		expect(
			looksLikeProjectResource(APP_URL, `${APP_URL}/api/mcp-gateway`),
		).toBe(false);
		expect(
			looksLikeProjectResource(
				APP_URL,
				"https://elsewhere.example/api/v1/projects/x",
			),
		).toBe(false);
	});

	it("names the static resource each audience is exchanged under", () => {
		expect(staticResourceFor(APP_URL, "mcp")).toBe(
			"https://app.example.com/api/mcp-gateway",
		);
		expect(staticResourceFor(APP_URL, "api")).toBe(
			"https://app.example.com/api/v1",
		);
	});
});

describe("grant references", () => {
	it("tags a project reference with its audience", () => {
		expect(buildProjectReference("mcp", "project-example-one")).toBe(
			"project:mcp:project-example-one",
		);
		expect(buildProjectReference("api", "project-example-one")).toBe(
			"project:api:project-example-one",
		);
	});

	it("reads an untagged reference as an organization id", () => {
		expect(parseOAuthReference("org-example-alpha")).toEqual({
			kind: "organization",
			organizationId: "org-example-alpha",
		});
	});

	it("reads a tagged reference as a project, for both audiences", () => {
		expect(parseOAuthReference("project:mcp:project-example-one")).toEqual({
			kind: "project",
			audience: "mcp",
			projectId: "project-example-one",
		});
		expect(parseOAuthReference("project:api:project-example-one")).toEqual({
			kind: "project",
			audience: "api",
			projectId: "project-example-one",
		});
	});

	it("never reads a malformed project reference as an organization", () => {
		for (const reference of [
			"",
			"project:",
			"project:mcp",
			"project:mcp:",
			"project:web:project-example-one",
			"project:mcp:project-example-one:extra",
			"project:mcp:a/b",
			"project::project-example-one",
		]) {
			expect(parseOAuthReference(reference), reference).toBeNull();
		}
	});

	it("round-trips a built reference", () => {
		expect(
			parseOAuthReference(buildProjectReference("api", "abc_123-X")),
		).toEqual({ kind: "project", audience: "api", projectId: "abc_123-X" });
	});
});
