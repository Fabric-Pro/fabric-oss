/**
 * Build an absolute URL to a Fabric artifact for inclusion in operation-
 * result chat messages.
 *
 * Returns ABSOLUTE URLs (not relative paths) because completion messages
 * may be rendered in contexts that don't share the current document
 * origin — Slack unfurls, email digests, push notifications, mobile
 * WebView shells. The URL has to stand alone.
 *
 * Three artifact kinds are supported:
 *
 *   - `story`     — `/app/[slug]?/projects/{p}/stories/{s}`
 *   - `document`  — `/app/[slug]?/projects/{p}/documents/{d}`
 *   - `task`      — `/app/[slug]?/projects/{p}/stories/{parent}/tasks/{t}`
 *
 * The story segment is delegated to `buildStoryDetailsRoute` so the two
 * helpers can't drift on the org-vs-personal base path convention.
 */

import { buildStoryDetailsRoute } from "../stories/routes";

interface BuildArtifactLinkBaseInput {
	readonly id: string;
	readonly projectId: string;
	readonly organizationSlug?: string;
	readonly baseUrl: string;
}

export type BuildArtifactLinkInput =
	| ({ readonly kind: "story" } & BuildArtifactLinkBaseInput)
	| ({ readonly kind: "document" } & BuildArtifactLinkBaseInput)
	| ({
			readonly kind: "task";
			readonly parentStoryId: string;
	  } & BuildArtifactLinkBaseInput);

function projectBasePath(organizationSlug: string | undefined): string {
	// Mirrors the `/app` and `/app/{slug}` convention used throughout the
	// SaaS app shell. `buildStoryDetailsRoute` returns the trailing
	// segments (everything from `/projects/...`) so we just produce the
	// org-or-personal prefix here.
	return organizationSlug ? `/app/${organizationSlug}` : "/app";
}

function stripTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildArtifactLink(input: BuildArtifactLinkInput): string {
	if (!input.baseUrl) {
		throw new Error("buildArtifactLink: baseUrl is required");
	}

	const root = stripTrailingSlash(input.baseUrl);
	const basePath = projectBasePath(input.organizationSlug);

	if (input.kind === "story") {
		return `${root}${buildStoryDetailsRoute(basePath, input.projectId, input.id)}`;
	}

	if (input.kind === "document") {
		return `${root}${basePath}/projects/${input.projectId}/documents/${input.id}`;
	}

	if (input.kind === "task") {
		if (!input.parentStoryId) {
			throw new Error(
				"buildArtifactLink: parentStoryId is required for task kind",
			);
		}
		const storyPath = buildStoryDetailsRoute(
			basePath,
			input.projectId,
			input.parentStoryId,
		);
		return `${root}${storyPath}/tasks/${input.id}`;
	}

	// Exhaustiveness check — surfaces missed enum branches at compile time.
	const _exhaustive: never = input;
	throw new Error(
		`buildArtifactLink: unsupported kind ${JSON.stringify(_exhaustive)}`,
	);
}
