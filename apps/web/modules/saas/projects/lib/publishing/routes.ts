/**
 * Build the Topic Item Page route for a publishing topic (Fizzy #1851, FR2).
 *
 * Returns a RELATIVE path, mirroring `lib/stories/routes.ts`: a caller passing
 * it to `router.push` or an `<a href>` resolves it against the current origin,
 * so every environment inherits its own domain with no per-environment config.
 *
 * `basePath` is the org-or-personal route base from `useBasePath()` — `/app`
 * in personal context, `/app/{slug}` in an organization. Taking it as an
 * argument rather than reading the hook here keeps this pure and testable, and
 * keeps the caller honest about which tenant context it is rendering in.
 *
 * Examples:
 *   buildPublishingTopicRoute("/app", "proj_1", "topic_2")
 *     -> "/app/projects/proj_1/publishing/topic_2"
 *   buildPublishingTopicRoute("/app/acme", "proj_1", "topic_2")
 *     -> "/app/acme/projects/proj_1/publishing/topic_2"
 */
export function buildPublishingTopicRoute(
	basePath: string,
	projectId: string,
	topicId: string,
): string {
	return `${basePath}/projects/${projectId}/publishing/${topicId}`;
}
