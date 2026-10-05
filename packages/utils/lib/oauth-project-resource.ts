/**
 * How a coding agent signed in for ONE project names that project.
 *
 * Two identifiers describe the same grant and must never be built by hand:
 *
 *   - the resource URL a client sends as `resource=` and compares with the
 *     protected-resource metadata, character for character; and
 *   - the reference the authorization server stores on the consent and on every
 *     token (`OauthConsent.referenceId`), which is how a verifier knows which
 *     project, and which kind of surface, a token was issued for.
 *
 * A reference without the `project:` tag is an organization id, the grant
 * every agent held before projects could be named. Dependency-free on purpose:
 * the authorization server, the gateway, the v1 API, the database layer and the
 * Connect dialog all load it, and none should pull a server in to do it.
 */

/** Path of the MCP gateway, the resource an organization-wide agent signs in for. */
export const OAUTH_GATEWAY_RESOURCE_PATH = "/api/mcp-gateway";

/** Path of the REST API the CLI signs in for. */
export const OAUTH_API_RESOURCE_PATH = "/api/v1";

/**
 * The field of the consent request in which the page says what it showed: the
 * project, or an explicit null. The server refuses the consent when that is not
 * the binding it holds, so the grant is always the one the person read.
 */
export const OAUTH_DISPLAYED_BINDING_FIELD = "displayed_binding";

/** Which surface a project grant reaches: the MCP gateway or the v1 REST API. */
export type OAuthProjectAudience = "mcp" | "api";

const PROJECT_PATH_SEGMENT = "/projects/";

const RESOURCE_BASE_PATH: Record<OAuthProjectAudience, string> = {
	mcp: OAUTH_GATEWAY_RESOURCE_PATH,
	api: OAUTH_API_RESOURCE_PATH,
};

const PROJECT_REFERENCE_PREFIX = "project:";

/**
 * What a project id may be inside a resource URL or a reference. Wide enough
 * for every id this deployment issues, narrow enough that no value can add a
 * path segment, a query, a fragment or a separator.
 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isProjectId(value: string): boolean {
	return PROJECT_ID_PATTERN.test(value);
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function requireProjectId(projectId: string): string {
	if (!isProjectId(projectId)) {
		throw new Error("Not a project id");
	}
	return projectId;
}

/**
 * The canonical resource URL of a project: the only spelling a metadata
 * document may publish and the only one the authorization server accepts.
 */
export function buildProjectResource(
	appUrl: string,
	audience: OAuthProjectAudience,
	projectId: string,
): string {
	return `${trimTrailingSlash(appUrl)}${RESOURCE_BASE_PATH[audience]}${PROJECT_PATH_SEGMENT}${requireProjectId(projectId)}`;
}

/**
 * The resource every project of an audience is exchanged under at the token
 * endpoint. The plugin matches `resource` against a fixed list of audiences, so
 * the project resource is swapped for this one once it has been checked against
 * the grant. Opaque tokens store no audience, so nothing else sees it.
 */
export function staticResourceFor(
	appUrl: string,
	audience: OAuthProjectAudience,
): string {
	return `${trimTrailingSlash(appUrl)}${RESOURCE_BASE_PATH[audience]}`;
}

export interface ProjectResource {
	audience: OAuthProjectAudience;
	projectId: string;
}

/**
 * The project a resource URL names, or null for anything that is not exactly
 * one of this deployment's canonical project resources: another origin, a
 * trailing slash, a query, a fragment, extra segments or an id outside the
 * pattern all read as "not a project resource".
 */
export function parseProjectResource(
	appUrl: string,
	resource: string,
): ProjectResource | null {
	for (const audience of ["mcp", "api"] as const) {
		const prefix = `${trimTrailingSlash(appUrl)}${RESOURCE_BASE_PATH[audience]}${PROJECT_PATH_SEGMENT}`;
		if (!resource.startsWith(prefix)) {
			continue;
		}
		const projectId = resource.slice(prefix.length);
		return isProjectId(projectId) ? { audience, projectId } : null;
	}
	return null;
}

/**
 * Whether a resource URL sits where this deployment's project resources do,
 * canonical or not. A client that asks for `.../projects/<id>/` is asking for a
 * project and has misspelled it: that deserves a clear refusal rather than the
 * generic "unknown resource" an organization-wide client would get.
 */
export function looksLikeProjectResource(
	appUrl: string,
	resource: string,
): boolean {
	const origin = trimTrailingSlash(appUrl);
	return (["mcp", "api"] as const).some((audience) =>
		resource.startsWith(
			`${origin}${RESOURCE_BASE_PATH[audience]}${PROJECT_PATH_SEGMENT.slice(0, -1)}`,
		),
	);
}

export function buildProjectReference(
	audience: OAuthProjectAudience,
	projectId: string,
): string {
	return `${PROJECT_REFERENCE_PREFIX}${audience}:${requireProjectId(projectId)}`;
}

export type OAuthReference =
	| { kind: "organization"; organizationId: string }
	| { kind: "project"; audience: OAuthProjectAudience; projectId: string };

/**
 * What a stored `referenceId` binds a grant to.
 *
 * Null for a reference that carries the project tag and is not well formed, and
 * for an empty one: a malformed project reference must never be read as an
 * organization id, because that is the arm an organization-wide check accepts.
 */
export function parseOAuthReference(
	referenceId: string,
): OAuthReference | null {
	if (referenceId.length === 0) {
		return null;
	}
	if (!referenceId.startsWith(PROJECT_REFERENCE_PREFIX)) {
		return { kind: "organization", organizationId: referenceId };
	}
	const [, audience, projectId, ...rest] = referenceId.split(":");
	if (
		rest.length > 0 ||
		(audience !== "mcp" && audience !== "api") ||
		projectId === undefined ||
		!isProjectId(projectId)
	) {
		return null;
	}
	return { kind: "project", audience, projectId };
}
