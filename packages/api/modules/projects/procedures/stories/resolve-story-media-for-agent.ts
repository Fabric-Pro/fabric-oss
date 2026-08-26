/**
 * Resolve a UserStory's `story-media/...` attachment keys into synthetic
 * rag-context markdown strings suitable for the AI Feature Assistant agent's
 * multimodal pipeline.
 *
 * RESPONSIBILITY:
 *   The web client (StoryWorkspace) invokes this procedure with the story
 *   identity, receives base64-encoded image markdown strings, and exposes
 *   them via `useCopilotReadable("RAG context...")`. The agent's chat-node
 *   (`splitRagContextImages`) extracts the `data:image/...;base64,...`
 *   URLs and attaches them as `image_url` parts on the last HumanMessage.
 *
 * WHY A PROCEDURE (not an agent-direct call):
 *   Agents are stateless — `agents/langchain/project-document-generator`'s
 *   package.json deliberately omits `@repo/database`, `@repo/storage`, and
 *   `@repo/config` so an agent cannot bypass tenant boundaries. The earlier
 *   shape (Phase 2 of #1389 / PR #1130) imported a helper from
 *   `@repo/api/modules/projects/lib/...` directly into the agent — that path
 *   broke the agent's tsup build (no `exports` field on `@repo/api` for deep
 *   paths) and would also have crossed the stateless-agent boundary at
 *   runtime. The right home is here, callable via oRPC from the web tier
 *   which already holds authenticated session context.
 *
 * AUTHORIZATION:
 *   `requireProjectPermission(STORY_UPDATE)` (same gate as `resolve-media-urls`
 *   and `create-media-upload-url`). Three layers of access control:
 *     1. `hasProjectAccess(projectId, userId, organizationId)` — user/org
 *        membership in the project.
 *     2. `getStoryById(storyId, projectId)` — XOR tenant gate confirming the
 *        story actually belongs to the project. Loads the description as a
 *        side effect (caller does not supply description text, eliminating a
 *        spoof vector).
 *     3. Explicit org-context check: the resolved project's `organizationId`
 *        MUST match the authenticated org (covers the gap that
 *        `hasProjectAccess` ignores its `_organizationId` arg). Without this,
 *        a user could chat under org B with a forged project id from org A
 *        (where they happen to also be a member) and exfiltrate org A media.
 *
 * BYTE / TIME CAPS:
 *   - Each fetch is bounded by `perFetchTimeoutMs` via `AbortSignal.timeout`
 *     so a slow / hanging storage provider cannot stall a chat turn.
 *   - Each response is capped at `MAX_IMAGE_BYTES` (5 MB) via both an
 *     honest `Content-Length` check AND a bounded streaming reader (defense
 *     in depth — the presigned PUT does not enforce Content-Length
 *     server-side, see `packages/storage/provider/s3/index.ts`).
 *   - Max `maxImages` (default 6) keys per request — cap how many vision
 *     tokens any single chat turn can pull.
 *
 * FAILURE TOLERANCE:
 *   Per-key failures (unsupported extension, sign error, fetch error,
 *   non-2xx, oversize, stream error) log a structured
 *   `feature_assistant_image_fetch_failed` warn and are dropped from the
 *   returned array. The chat path proceeds without the failed image.
 *   PII-safe: logs carry an `s3KeyHash` (SHA-256 prefix) instead of the raw
 *   key, which embeds user-supplied filenames.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { db, getStoryById, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { buildAiChatAttachmentEntry } from "@repo/utils/ai-chat-attachment";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { extractStoryMediaKeysFromContent } from "../../lib/extract-story-media-keys";

/** One image's worth of multimodal context ready for `splitRagContextImages`. */
export interface StoryMediaRagContext {
	s3Key: string;
	filename: string;
	ragContextMarkdown: string;
}

const SUPPORTED_EXTENSIONS: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

const DEFAULT_MAX_IMAGES = 6;
const DEFAULT_PER_FETCH_TIMEOUT_MS = 5_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function inferMimeType(s3Key: string): string | null {
	const dot = s3Key.lastIndexOf(".");
	if (dot < 0) {
		return null;
	}
	return SUPPORTED_EXTENSIONS[s3Key.slice(dot + 1).toLowerCase()] ?? null;
}

function basename(s3Key: string): string {
	const slash = s3Key.lastIndexOf("/");
	return slash >= 0 ? s3Key.slice(slash + 1) : s3Key;
}

/**
 * Convert an arbitrary thrown value into a small, PII-safe shape for logging.
 *
 * Raw `error` objects from storage providers (S3 SDK, Azure Blob SDK) and from
 * `fetch` failures routinely embed presigned URLs (with `X-Amz-Signature=...`)
 * in `error.message` / `error.stack` / `error.cause`. Dumping the whole object
 * via pino's default serializer leaks those signatures into ops logs, where
 * anyone with log access can replay them inside the (short) expiry window.
 * Strip URLs and prefer error class + code over free-form text.
 */
function sanitizeErrorForLog(error: unknown): {
	name: string;
	code?: string;
	message?: string;
} {
	if (error instanceof Error) {
		const maybeCode = (error as unknown as { code?: unknown }).code;
		const code = typeof maybeCode === "string" ? maybeCode : undefined;
		// Redact http(s) URLs anywhere in the message (presigned URLs always
		// have a scheme); keep enough text for triage.
		const safeMessage = error.message
			.replace(/https?:\/\/\S+/g, "[url-redacted]")
			.slice(0, 200);
		return { name: error.name, code, message: safeMessage };
	}
	return { name: typeof error };
}

function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function fetchAndEncode(
	s3Key: string,
	perFetchTimeoutMs: number,
	bucket: string,
): Promise<StoryMediaRagContext | null> {
	const mimeType = inferMimeType(s3Key);
	if (!mimeType) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "unsupported_extension",
			s3KeyHash: hashKey(s3Key),
		});
		return null;
	}

	const provider = getStorageProvider();
	let signedUrl: string;
	try {
		signedUrl = await provider.getSignedUrl(s3Key, {
			bucket,
			expiresIn: 60,
		});
	} catch (error) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "signing_failed",
			s3KeyHash: hashKey(s3Key),
			error: sanitizeErrorForLog(error),
		});
		return null;
	}

	let response: Response;
	try {
		response = await fetch(signedUrl, {
			signal: AbortSignal.timeout(perFetchTimeoutMs),
		});
	} catch (error) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "fetch_error",
			s3KeyHash: hashKey(s3Key),
			error: sanitizeErrorForLog(error),
		});
		return null;
	}
	if (!response.ok) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "non_2xx",
			status: response.status,
			s3KeyHash: hashKey(s3Key),
		});
		return null;
	}

	const contentLength = response.headers.get("content-length");
	const declaredBytes = contentLength
		? Number.parseInt(contentLength, 10)
		: Number.NaN;
	if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "oversized_payload",
			declaredBytes,
			s3KeyHash: hashKey(s3Key),
		});
		return null;
	}

	const reader = response.body?.getReader();
	if (!reader) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "no_response_body",
			s3KeyHash: hashKey(s3Key),
		});
		return null;
	}

	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			received += value.byteLength;
			if (received > MAX_IMAGE_BYTES) {
				await reader.cancel();
				logger.warn({
					event: "feature_assistant_image_fetch_failed",
					reason: "stream_oversized",
					s3KeyHash: hashKey(s3Key),
				});
				return null;
			}
			chunks.push(value);
		}
	} catch (error) {
		logger.warn({
			event: "feature_assistant_image_fetch_failed",
			reason: "stream_read_error",
			s3KeyHash: hashKey(s3Key),
			error: sanitizeErrorForLog(error),
		});
		return null;
	}

	const total = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		total.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const base64 = Buffer.from(total).toString("base64");
	const filename = basename(s3Key);

	return {
		s3Key,
		filename,
		// Built through the shared builder rather than interpolated here. This
		// resolver is the second producer of the same envelope and previously
		// applied no neutralization at all, so a filename carrying a forged
		// heading reached the prompt through this path even after the client
		// path was guarded (R6).
		ragContextMarkdown: buildAiChatAttachmentEntry(
			filename,
			`data:${mimeType};base64,${base64}`,
		),
	};
}

export const resolveStoryMediaForAgentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/stories/:storyId/media/resolve-for-agent",
		tags: ["Projects", "Stories", "Media"],
		summary: "Resolve story media for AI Feature Assistant",
		description:
			"Resolve a story's attachment keys into base64 data-URL markdown strings suitable for multimodal injection via ragContexts.",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
			maxImages: z.number().int().min(1).max(10).optional(),
			perFetchTimeoutMs: z.number().int().min(500).max(30_000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, userStoryId } = input;
		const user = context.user;
		const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
		const perFetchTimeoutMs =
			input.perFetchTimeoutMs ?? DEFAULT_PER_FETCH_TIMEOUT_MS;

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// 1. user → project membership (defensive — the requireProjectPermission
		// middleware already gated, but mirroring resolve-media-urls.ts).
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			logger.warn({
				event: "feature_assistant_story_media_authz_denied",
				reason: "no_project_access",
			});
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// 2. Story exists in this project (XOR tenant gate). `getStoryById`
		// also loads `description` which we trust here — no caller-supplied
		// description string means no spoof vector.
		const story = await getStoryById(userStoryId, projectId);
		if (!story) {
			logger.warn({
				event: "feature_assistant_story_media_authz_denied",
				reason: "story_not_in_project",
			});
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found in this project",
			});
		}

		// 3. Org-context match. `hasProjectAccess` ignores its organizationId
		// arg; without this, a user chatting under org B could resolve media
		// from a project in org A where they happen to be a member.
		const resolvedOrg = organizationId ?? null;
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { organizationId: true },
		});
		if (!project || project.organizationId !== resolvedOrg) {
			logger.warn({
				event: "feature_assistant_story_media_authz_denied",
				reason: "org_context_mismatch",
			});
			throw new ORPCError("FORBIDDEN", {
				message: "Project belongs to a different organization context",
			});
		}

		const allKeys = extractStoryMediaKeysFromContent(story.description);
		const prefix = `story-media/${projectId}/${userStoryId}/`;
		const candidates: string[] = [];
		for (const k of allKeys) {
			if (k.startsWith(prefix)) {
				candidates.push(k);
			}
			if (candidates.length >= maxImages) {
				break;
			}
		}
		if (candidates.length === 0) {
			return { items: [] as StoryMediaRagContext[] };
		}

		const bucket = config.storage.bucketNames.projectContexts;
		const resolved = await Promise.all(
			candidates.map((s3Key) =>
				fetchAndEncode(s3Key, perFetchTimeoutMs, bucket),
			),
		);
		const items = resolved.filter(
			(x): x is StoryMediaRagContext => x !== null,
		);

		return { items };
	});
