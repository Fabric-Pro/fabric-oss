/**
 * Resolve `story-media/...` references in a UserStory `description` /
 * `acceptanceCriteria` to fresh, directly-renderable signed download URLs at
 * FETCH time, normalising every reference to the
 * `<img src="<signed>" data-s3-key="story-media/...">` shape the StoryWorkspace
 * editor already handles for pasted images.
 *
 * WHY: images embedded by the proposal / AI flow are stored as bare relative
 * markdown keys — `![image](story-media/{projectId}/{storyId}/{uuid}.png)`. A
 * bare relative key resolves against the page URL in the browser and 404s, so
 * the image renders broken in Fabric. The PM-tool push pipeline already
 * resolves these keys to signed URLs (which is why the image renders in Fizzy);
 * this is the Fabric-fetch equivalent so the image renders for every reader.
 *
 * Two properties make this durable:
 *   - It runs under `STORY_READ` (the get-story gate), so read-only viewers see
 *     the image too — unlike the client-side `resolveMediaUrls` resolver, which
 *     needs `STORY_UPDATE`.
 *   - Injecting `data-s3-key` means the editor's reload resolver + save
 *     round-trip (`buildImgTag`) keep the canonical key on the node, so the src
 *     is simply re-signed on each subsequent fetch (self-healing).
 *
 * Idempotent: an already-resolved `<img src="<old-signed>" data-s3-key="...">`
 * is just re-signed; running twice yields an equivalent result.
 *
 * Best-effort: a signing failure leaves that single reference untouched, and a
 * thrown error returns the original content — a media problem never breaks the
 * story fetch.
 */

import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { extractStoryMediaKeysFromContent } from "./extract-story-media-keys";

/** Default signed-URL TTL (1h) — matches `resolve-media-urls.ts`. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Extract the canonical `story-media/...` key from a single URL/src value.
 * Handles bare keys (`story-media/p/s/uuid.png`), root-relative paths, and
 * signed URLs on any host. The capture stops at `?`/`&`/`"`/`'`/`)`/whitespace
 * so the signed-URL query string and trailing delimiters are excluded — the
 * canonical S3 key never contains those characters.
 */
function extractStoryMediaKeyFromUrl(url: string): string | null {
	const m = url.match(/(?:^|\/)(story-media\/[^"'\s)?&]+)/);
	return m ? m[1] : null;
}

function escapeAttr(value: string): string {
	return value.replace(/"/g, "&quot;");
}

/**
 * Rewrite every story-media reference in `content` to a keyed `<img>` whose
 * `src` is the signed URL from `urlMap` (canonical key → signed URL). Handles:
 *   - existing `<img>` tags — `src` re-signed, `data-s3-key` ensured;
 *   - markdown `![alt](url)` images — converted to a keyed `<img>`.
 * References with no entry in `urlMap` are left untouched. Pure / no I/O.
 */
export function rewriteStoryMediaToSignedImgTags(
	content: string,
	urlMap: ReadonlyMap<string, string>,
): string {
	if (!content || urlMap.size === 0) {
		return content;
	}

	// 1) <img ...> — re-sign src; ensure data-s3-key carries the canonical key.
	let result = content.replace(/<img\b[^>]*>/gi, (tag) => {
		const dataKeyMatch = tag.match(/\bdata-s3-key=["']([^"']+)["']/i);
		const srcMatch = tag.match(/\bsrc=(["'])([^"']*)\1/i);
		const dataKey = dataKeyMatch?.[1] ?? null;
		const srcKey = srcMatch
			? extractStoryMediaKeyFromUrl(srcMatch[2])
			: null;
		const key = dataKey?.startsWith("story-media/")
			? dataKey
			: (srcKey ?? null);
		if (!key) {
			return tag;
		}
		const signed = urlMap.get(key);
		if (!signed) {
			return tag;
		}
		const safeSrc = escapeAttr(signed);
		let out = srcMatch
			? tag.replace(/\bsrc=(["'])([^"']*)\1/i, `src="${safeSrc}"`)
			: tag.replace(/<img\b/i, `<img src="${safeSrc}"`);
		if (!dataKey) {
			out = out.replace(
				/<img\b/i,
				`<img data-s3-key="${escapeAttr(key)}"`,
			);
		}
		return out;
	});

	// 2) Markdown ![alt](url) → keyed <img>. Conservative URL parse: stop at the
	//    first whitespace / `)`; story-media keys never contain those.
	result = result.replace(
		/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
		(whole, alt: string, url: string) => {
			const key = extractStoryMediaKeyFromUrl(url);
			if (!key) {
				return whole;
			}
			const signed = urlMap.get(key);
			if (!signed) {
				return whole;
			}
			const altAttr = alt ? ` alt="${escapeAttr(alt)}"` : "";
			return `<img src="${escapeAttr(signed)}" data-s3-key="${escapeAttr(key)}"${altAttr}>`;
		},
	);

	return result;
}

export interface ResolveStoryMediaOptions {
	/** Inject a signer (for tests); defaults to the storage provider. */
	signUrl?: (key: string) => Promise<string | null>;
	/** Signed-URL TTL in seconds (default 1h). */
	expiresIn?: number;
}

/**
 * Resolve all story-media references in `content`, scoped to the
 * `story-media/{projectId}/{storyId}/` keyspace (defense in depth — mirrors the
 * prefix gate in `resolve-media-urls.ts`), to signed `<img>` references.
 * Returns the original content unchanged when there is nothing to resolve or on
 * any error.
 */
export async function resolveStoryMediaUrlsInContent(
	content: string | null | undefined,
	projectId: string,
	storyId: string,
	opts: ResolveStoryMediaOptions = {},
): Promise<string | null | undefined> {
	if (!content) {
		return content;
	}
	try {
		const prefix = `story-media/${projectId}/${storyId}/`;
		const keys = extractStoryMediaKeysFromContent(content).filter((k) =>
			k.startsWith(prefix),
		);
		if (keys.length === 0) {
			return content;
		}

		const expiresIn = opts.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
		const sign =
			opts.signUrl ??
			((key: string) =>
				getStorageProvider().getSignedUrl(key, {
					bucket: config.storage.bucketNames.projectContexts,
					expiresIn,
				}));

		const urlMap = new Map<string, string>();
		await Promise.all(
			keys.map(async (key) => {
				try {
					const url = await sign(key);
					if (url) {
						urlMap.set(key, url);
					}
				} catch (error) {
					// Never log the key (embeds user-supplied filenames) or the
					// error message (may embed a presigned URL) — name only.
					logger.warn("[resolve-story-media] sign failed", {
						error: error instanceof Error ? error.name : "unknown",
					});
				}
			}),
		);
		if (urlMap.size === 0) {
			return content;
		}
		return rewriteStoryMediaToSignedImgTags(content, urlMap);
	} catch (error) {
		logger.warn(
			"[resolve-story-media] unexpected error; returning original",
			{
				error: error instanceof Error ? error.name : "unknown",
			},
		);
		return content;
	}
}
