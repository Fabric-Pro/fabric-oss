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
 * A URL in the one spelling two equal addresses share: scheme and host in lower
 * case, no default port, no trailing slash, no empty query or fragment. Strict
 * otherwise: another host (`www.` included), a non-empty query or fragment, or
 * credentials make a different address. `null` for anything that is not an
 * http(s) URL.
 */
export function normalizeServerUrl(value: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		return null;
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}${parsed.hash}`;
}

/**
 * Whether a URL is a gateway URL of this deployment: the organization-wide one
 * or any project's, in whatever spelling of the same address. An MCP server
 * registered at one is Fabric's own, which is what lets `init` replace it and
 * no one else's.
 */
export function isGatewayUrlOf(origin: string, url: string): boolean {
	const gateway = normalizeServerUrl(
		`${origin.replace(/\/+$/, "")}${RESOURCE_BASE_PATH.mcp}`,
	);
	const candidate = normalizeServerUrl(url);
	if (gateway === null || candidate === null) {
		return false;
	}
	return (
		candidate === gateway ||
		new RegExp(`^${escaped(gateway)}/projects/[A-Za-z0-9_-]{1,64}$`).test(
			candidate,
		)
	);
}

/** Whether a URL is this deployment's organization-wide gateway, which no project owns. */
export function isOrgGatewayUrlOf(origin: string, url: string): boolean {
	const gateway = normalizeServerUrl(
		`${origin.replace(/\/+$/, "")}${RESOURCE_BASE_PATH.mcp}`,
	);
	return gateway !== null && normalizeServerUrl(url) === gateway;
}

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How a URL stands to one project of this deployment. */
export type GatewayRelation =
	/** This project's own gateway, in whatever spelling. */
	| "this-project"
	/** Another project's gateway of this deployment. */
	| "other-project"
	/** This deployment's organization-wide gateway. */
	| "org-wide"
	/** Not this deployment's, or not an http(s) address. */
	| "foreign"
	/** On this deployment's origin but not one of the shapes its gateway is published at. */
	| "unfamiliar";

function originOf(value: string): string | null {
	const normal = normalizeServerUrl(value);
	return normal === null ? null : new URL(normal).origin;
}

export function classifyGatewayUrl(
	origin: string,
	projectId: string,
	url: string,
): GatewayRelation {
	const candidate = normalizeServerUrl(url);
	if (candidate === null || originOf(url) !== originOf(origin)) {
		return "foreign";
	}
	if (
		candidate ===
		normalizeServerUrl(projectResource(origin, "mcp", projectId))
	) {
		return "this-project";
	}
	if (isOrgGatewayUrlOf(origin, url)) {
		return "org-wide";
	}
	return isGatewayUrlOf(origin, url) ? "other-project" : "unfamiliar";
}

/**
 * How the `resource` a gateway names in its protected-resource metadata stands
 * to a project: either spelling a deployment publishes for it (the gateway's or
 * the REST API's) names it.
 */
export function classifyGatewayResource(
	origin: string,
	projectId: string,
	resource: string,
): GatewayRelation {
	const relation = classifyGatewayUrl(origin, projectId, resource);
	if (relation !== "unfamiliar") {
		return relation;
	}
	const api = normalizeServerUrl(
		`${origin.replace(/\/+$/, "")}${RESOURCE_BASE_PATH.api}`,
	);
	const candidate = normalizeServerUrl(resource);
	const named =
		api === null || candidate === null
			? null
			: new RegExp(
					`^${escaped(api)}/projects/([A-Za-z0-9_-]{1,64})$`,
				).exec(candidate);
	if (named === null) {
		return "unfamiliar";
	}
	return named[1] === projectId ? "this-project" : "other-project";
}
