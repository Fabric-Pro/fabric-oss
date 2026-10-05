/**
 * What a credential bound to one project may reach on the REST API.
 *
 * An agent that signed in for a project is told, at its consent, that it reaches
 * that project and nothing else. The REST API enforces it here, once, for every
 * route there is or will be, instead of leaving it to each route to ask: a route
 * nobody has classified is a route a bound credential cannot reach.
 *
 * It reaches three things: who it is, which projects a repository belongs to
 * (answered for its own project only), and the routes under its own project.
 */

import { db } from "@repo/database";

/** Where the public v1 API is mounted. */
const V1_PATH = "/api/v1";

/** Routes of the v1 API that name no project and are about the caller. */
const CALLER_ROUTES: ReadonlySet<string> = new Set([
	"/auth/whoami",
	"/instructions/checkouts/resolve",
]);

/**
 * Whether a request path is one a credential bound to `boundProjectId` may
 * reach: `/api/v1/auth/whoami`, `/api/v1/instructions/checkouts/resolve`, or
 * anything under `/api/v1/projects/<boundProjectId>/`. Anything else, including
 * every other project, every organization-wide route and every path outside the
 * v1 API, is refused.
 */
export function projectBoundRouteAllowed(
	path: string,
	boundProjectId: string,
): boolean {
	if (!path.startsWith(`${V1_PATH}/`)) {
		return false;
	}
	const route = path.slice(V1_PATH.length);
	return (
		CALLER_ROUTES.has(route) ||
		route.startsWith(`/projects/${boundProjectId}/`)
	);
}

/**
 * The refusal an agent that signed in for one project gets from anything that
 * is not that project. 403, not 404: the credential is genuine and the person
 * can fix it by connecting the other project, which the message says.
 */
export async function projectBoundRefusal(
	boundProjectId: string,
): Promise<{ error: string; status: 403 }> {
	const project = await db.project.findUnique({
		where: { id: boundProjectId },
		select: { name: true },
	});
	return {
		error: `This sign-in is limited to project ${project?.name ?? boundProjectId}`,
		status: 403,
	};
}
