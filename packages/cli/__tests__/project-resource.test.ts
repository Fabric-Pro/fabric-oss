/**
 * The CLI spells a project's resource URLs itself, because it is packed without
 * the shared package. These hold the copy to the original's answers, so a change
 * to either spelling fails here instead of at a sign-in the deployment refuses.
 */
import { describe, expect, it } from "vitest";
import {
	buildProjectResource,
	isProjectId as sharedIsProjectId,
	parseProjectResource,
} from "../../utils/lib/oauth-project-resource";
import {
	isGatewayUrlOf,
	isProjectId,
	projectResource,
} from "../src/lib/oauth/project-resource.js";

describe("what a project id may be", () => {
	it.each([
		"project-example-one",
		"a",
		"a_b-C",
		"_leading",
		"a".repeat(64),
		"a".repeat(65),
		"",
		"has.dot",
		"has space",
		"a/b",
		"a?b",
		"a#b",
		"a%2Fb",
		"..",
		"é",
	])("is judged as the deployment judges it (%j)", (value) => {
		expect(isProjectId(value)).toBe(sharedIsProjectId(value));
	});
});

const ORIGINS = [
	"https://fabric.pro",
	"https://staging.example.com",
	"http://localhost:3001",
	"https://deploy.example.com/",
];
const PROJECT_IDS = ["project-example-one", "cm0abc123def", "a_b-C", "x"];

describe("a project's resource URL", () => {
	it.each(
		ORIGINS.flatMap((origin) =>
			PROJECT_IDS.flatMap((projectId) =>
				(["mcp", "api"] as const).map(
					(audience) => [origin, audience, projectId] as const,
				),
			),
		),
	)(
		"is spelled as the shared builder spells it (%s, %s, %s)",
		(origin, audience, projectId) => {
			expect(projectResource(origin, audience, projectId)).toBe(
				buildProjectResource(origin, audience, projectId),
			);
		},
	);

	it("is read back by the deployment's own parser as the same project and surface", () => {
		for (const audience of ["mcp", "api"] as const) {
			const url = projectResource(
				"https://deploy.example.com",
				audience,
				"project-example-one",
			);

			expect(
				parseProjectResource("https://deploy.example.com", url),
			).toEqual({
				audience,
				projectId: "project-example-one",
			});
		}
	});
});

describe("whose gateway a URL is", () => {
	const origin = "https://deploy.example.com";

	it("is this deployment's for its organization-wide gateway and any project's", () => {
		expect(isGatewayUrlOf(origin, `${origin}/api/mcp-gateway`)).toBe(true);
		expect(
			isGatewayUrlOf(
				origin,
				projectResource(origin, "mcp", "project-example-one"),
			),
		).toBe(true);
	});

	it.each([
		["another origin", "https://elsewhere.example.com/api/mcp-gateway"],
		["another port", "https://deploy.example.com:8443/api/mcp-gateway"],
		[
			"the REST API",
			"https://deploy.example.com/api/v1/projects/project-example-one",
		],
		[
			"a longer path",
			"https://deploy.example.com/api/mcp-gateway/projects/p/extra",
		],
		["a trailing slash", "https://deploy.example.com/api/mcp-gateway/"],
		["a query", "https://deploy.example.com/api/mcp-gateway?x=1"],
		[
			"a lookalike host",
			"https://deploy.example.com.evil.example/api/mcp-gateway",
		],
		["nothing", ""],
	])("is not this deployment's for %s", (_label, url) => {
		expect(isGatewayUrlOf(origin, url)).toBe(false);
	});
});
