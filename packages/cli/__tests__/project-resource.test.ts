/**
 * The CLI spells a project's resource URLs itself, because it is packed without
 * the shared package. These hold the copy to the original's answers, so a change
 * to either spelling fails here instead of at a sign-in the deployment refuses.
 */
import { describe, expect, it } from "vitest";
import {
	buildProjectResource,
	parseProjectResource,
	isProjectId as sharedIsProjectId,
} from "../../utils/lib/oauth-project-resource";
import {
	classifyGatewayResource,
	classifyGatewayUrl,
	isGatewayUrlOf,
	isOrgGatewayUrlOf,
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
		["a query", "https://deploy.example.com/api/mcp-gateway?x=1"],
		[
			"a lookalike host",
			"https://deploy.example.com.evil.example/api/mcp-gateway",
		],
		[
			"www. added to the host",
			"https://www.deploy.example.com/api/mcp-gateway",
		],
		["a password", "https://u:p@deploy.example.com/api/mcp-gateway"],
		["another scheme", "ftp://deploy.example.com/api/mcp-gateway"],
		[
			"a project id with a dot",
			"https://deploy.example.com/api/mcp-gateway/projects/a.b",
		],
		["nothing", ""],
	])("is not this deployment's for %s", (_label, url) => {
		expect(isGatewayUrlOf(origin, url)).toBe(false);
	});

	it.each([
		["a trailing slash", "https://deploy.example.com/api/mcp-gateway/"],
		[
			"capitals in the scheme and host",
			"HTTPS://Deploy.Example.com/api/mcp-gateway",
		],
		["the default port", "https://deploy.example.com:443/api/mcp-gateway"],
		[
			"an empty query and fragment",
			"https://deploy.example.com/api/mcp-gateway?#",
		],
		[
			"a project's trailing slash",
			"https://deploy.example.com/api/mcp-gateway/projects/project-example-one/",
		],
	])(
		"is this deployment's for the same address spelled with %s",
		(_label, url) => {
			expect(isGatewayUrlOf(origin, url)).toBe(true);
		},
	);

	it("tells the organization-wide gateway from a project's, however each is spelled", () => {
		expect(
			isOrgGatewayUrlOf(
				origin,
				"HTTPS://deploy.example.com/api/mcp-gateway/",
			),
		).toBe(true);
		expect(
			isOrgGatewayUrlOf(
				origin,
				projectResource(origin, "mcp", "project-example-one"),
			),
		).toBe(false);
		expect(
			isOrgGatewayUrlOf(
				origin,
				"https://elsewhere.example.com/api/mcp-gateway",
			),
		).toBe(false);
	});
});

describe("how a URL stands to a project", () => {
	const origin = "https://deploy.example.com";
	const here = `${origin}/api/mcp-gateway/projects/project-example-one`;

	it.each([
		["the project's gateway", here, "this-project"],
		["a trailing slash", `${here}/`, "this-project"],
		[
			"capitals and a default port",
			here
				.replace("https://deploy", "HTTPS://Deploy")
				.replace(".com", ".com:443"),
			"this-project",
		],
		[
			"another project's gateway",
			`${origin}/api/mcp-gateway/projects/project-example-two`,
			"other-project",
		],
		[
			"the organization-wide gateway",
			`${origin}/api/mcp-gateway`,
			"org-wide",
		],
		[
			"the organization-wide gateway, slashed",
			`${origin}/api/mcp-gateway/`,
			"org-wide",
		],
		["another host", "https://mcp.vendor.example.net/mcp", "foreign"],
		[
			"another deployment's gateway",
			"https://other.example.org/api/mcp-gateway",
			"foreign",
		],
		[
			"a lookalike host",
			"https://deploy.example.com.evil.example.net/api/mcp-gateway",
			"foreign",
		],
		["not a web address", "stdio://local", "foreign"],
		["the origin's other path", `${origin}/mcp`, "unfamiliar"],
		["the gateway with a query", `${here}?x=1`, "unfamiliar"],
		["a deeper path", `${here}/sse`, "unfamiliar"],
	])("is read for %s", (_label, url, expected) => {
		expect(classifyGatewayUrl(origin, "project-example-one", url)).toBe(
			expected,
		);
	});

	it.each([
		["the gateway", here, "this-project"],
		[
			"the REST API of this project",
			`${origin}/api/v1/projects/project-example-one`,
			"this-project",
		],
		[
			"the REST API of another",
			`${origin}/api/v1/projects/project-example-two`,
			"other-project",
		],
		[
			"the organization-wide gateway",
			`${origin}/api/mcp-gateway`,
			"org-wide",
		],
		["something else", `${origin}/elsewhere`, "unfamiliar"],
		[
			"another host",
			"https://other.example.org/api/v1/projects/project-example-one",
			"foreign",
		],
	])("names a resource that is %s", (_label, resource, expected) => {
		expect(
			classifyGatewayResource(origin, "project-example-one", resource),
		).toBe(expected);
	});
});
