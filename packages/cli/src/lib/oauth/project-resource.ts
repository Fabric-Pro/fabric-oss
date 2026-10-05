/**
 * The resource URLs of one project, spelled the way the deployment publishes
 * them.
 *
 * A sign-in for one project asks for `<origin>/api/v1/projects/<id>` as the
 * `resource` of its authorization, and an agent's MCP server for the project is
 * `<origin>/api/mcp-gateway/projects/<id>`. The deployment compares both
 * character for character, so this is a copy of `buildProjectResource` in
 * `@repo/utils/oauth-project-resource` and not a second opinion: the CLI is
 * packed on its own and does not depend on that package, and
 * `project-resource.test.ts` holds the two to the same answers.
 */

/** Which surface a project resource reaches: the MCP gateway or the REST API. */
export type ProjectAudience = "mcp" | "api";

const RESOURCE_BASE_PATH: Record<ProjectAudience, string> = {
	mcp: "/api/mcp-gateway",
	api: "/api/v1",
};

/**
 * What a project id may be inside a resource URL: wide enough for every id the
 * deployment issues, narrow enough that none can add a path segment, a query or
 * a separator. Narrower than an identifier elsewhere in this CLI (no dot), and
 * the one the deployment applies to a project resource.
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isProjectId(value: string): boolean {
	return PROJECT_ID_PATTERN.test(value);
}

/** The resource URL of a project, for an origin such as `https://fabric.pro`. */
export function projectResource(
	origin: string,
	audience: ProjectAudience,
	projectId: string,
): string {
	return `${origin.replace(/\/+$/, "")}${RESOURCE_BASE_PATH[audience]}/projects/${projectId}`;
}

/**
 * Whether a URL is a gateway URL of this deployment: the organization-wide one
 * or any project's. An MCP server registered at one is Fabric's own, which is
 * what lets `init` replace it and no one else's.
 */
export function isGatewayUrlOf(origin: string, url: string): boolean {
	const gateway = `${origin.replace(/\/+$/, "")}${RESOURCE_BASE_PATH.mcp}`;
	return (
		url === gateway ||
		new RegExp(`^${escaped(gateway)}/projects/[A-Za-z0-9_-]{1,64}$`).test(
			url,
		)
	);
}

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
