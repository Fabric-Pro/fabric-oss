/**
 * Carry a retired duplicate's assets into the surviving work item's keyspace
 * when two items are merged (Fizzy #2048).
 *
 * WHY A COPY AND NOT A RE-POINT
 * -----------------------------
 * A work item's assets live in two separate keyspaces, and BOTH are prefix-gated
 * at read time against the owning item:
 *
 *   - inline images — objects under `story-media/{projectId}/{storyId}/`,
 *     referenced only as text inside `UserStory.description`. Every resolver
 *     (`resolve-media-urls`, `resolveStoryMediaUrlsInContent`, the agent
 *     resolver) drops any key outside the owning item's prefix;
 *   - uploaded attachments — `StoryAttachment` rows whose `storageKey` sits
 *     under `story-attachments/{projectId}/{storyId}/`. The list procedure mints
 *     a signed download URL only for keys under that prefix and returns a null
 *     URL otherwise.
 *
 * So a merge cannot simply carry the duplicate's keys over: a re-pointed key
 * renders as a broken image, and a re-parented attachment row that keeps the
 * duplicate's key renders as a dead entry that can never be downloaded. The
 * object itself has to move. `@repo/storage`'s `copyFile` is a within-bucket
 * server-side copy (the same primitive `create-attachment.ts` uses to promote a
 * staged upload) and both keyspaces live in the `project-contexts` bucket, so
 * the carry-over is one CopyObject per asset — no download/re-upload.
 *
 * TWO SAFETY PROPERTIES
 * ---------------------
 * 1. Source keys are validated before anything is copied. Media keys are
 *    harvested by regex-scanning free-text markdown that any user can write, so
 *    a key found in the duplicate's body is a CLAIM, not a fact. Every harvested
 *    key must sit under the duplicate's OWN prefix and end in a single safe path
 *    segment. Without that filter, pasting
 *    `story-media/{anotherProject}/{anotherStory}/secret.png` into the
 *    duplicate's body would make the server copy a stranger's object into the
 *    caller's keyspace, where it would then resolve. (The pre-merge code was
 *    safe only because it filtered to the SURVIVOR's prefix and dropped
 *    everything else; that filter is what this helper replaces.)
 *
 * 2. Nothing is referenced whose copy did not succeed. The caller copies FIRST
 *    and writes references afterwards, using only what this function reports as
 *    copied. A copy failure never fails the merge — the merge completes, the
 *    skipped keys are logged with their reason, and the merged body / attachment
 *    re-parenting simply omit them, leaving those assets on the retired
 *    duplicate where they are still reachable.
 *
 * Pure w.r.t. the database: it reads nothing and writes nothing. The caller
 * supplies the duplicate's description and attachment rows and applies the
 * returned remapping (see `merge-duplicate.ts`).
 */

import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { extractStoryMediaKeysFromContent } from "./extract-story-media-keys";

/** Inline-image keyspace (pasted / AI-embedded images inside the body). */
const STORY_MEDIA_KEYSPACE = "story-media/";
/** Uploaded-attachment keyspace (`StoryAttachment.storageKey`). */
const STORY_ATTACHMENT_KEYSPACE = "story-attachments/";

/**
 * The final path segment of a key must be a single safe segment — no nested
 * paths, no traversal. Mirrors the temp-key validation in `create-attachment.ts`
 * so a copied attachment key stays structurally identical to an uploaded one.
 */
const SAFE_KEY_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Marker woven into every copied key: `merged-{sourceStoryId}-{segment}`.
 *
 * Two properties matter. It is DETERMINISTIC, so re-running a merge produces the
 * same destination key rather than a second copy of the same bytes. And it can
 * never collide with a key the survivor generated for itself — every generator
 * in the codebase produces a uuid / timestamp segment, none of which is prefixed
 * with a source story id — so carrying both items' images over leaves both sets
 * intact.
 */
const MERGED_SEGMENT_PREFIX = "merged-";

/** Why a source key was not carried over. */
type SkippedAssetReason =
	/** Not under the source item's own prefix — a foreign key pasted into the body. */
	| "foreign-key"
	/** Under the right prefix but not a single safe path segment. */
	| "unsafe-key"
	/** Prefix-valid, but the storage copy failed. */
	| "copy-failed";

interface CopiedMediaKey {
	/** The key as it appears in the source item's body. */
	sourceKey: string;
	/** The key the object now also lives at, under the target item. */
	targetKey: string;
}

interface CopiedAttachment {
	/** `StoryAttachment.id` — the row the caller must re-parent and re-key. */
	attachmentId: string;
	sourceKey: string;
	targetKey: string;
}

interface SkippedAsset {
	key: string;
	reason: SkippedAssetReason;
}

export interface CopyStoryAssetsResult {
	/** Copied inline images, in first-appearance order within the source body. */
	media: CopiedMediaKey[];
	/** Copied attachment objects, in the order the rows were supplied. */
	attachments: CopiedAttachment[];
	/** Everything that was NOT carried over, with the reason. Never referenced. */
	skipped: SkippedAsset[];
}

export interface CopyStoryAssetsParams {
	projectId: string;
	/** The item whose assets are being carried over (the retired duplicate). */
	sourceStoryId: string;
	/** The item receiving them (the survivor). */
	targetStoryId: string;
	/**
	 * The source item's description. Its `story-media/` references are the only
	 * record of its inline images. Pass `null` to skip the media keyspace
	 * entirely — a plain merge writes no survivor body, so there would be nowhere
	 * for the image markdown to land.
	 */
	sourceDescription?: string | null;
	/** The source item's live attachment rows (soft-deleted rows excluded). */
	sourceAttachments?: readonly { id: string; storageKey: string }[];
	/**
	 * Copy port. Defaults to the storage provider's within-bucket server-side
	 * copy; injected in tests so no provider is constructed.
	 */
	copyObject?: (sourceKey: string, targetKey: string) => Promise<void>;
}

type CopyPlan = { targetKey: string } | { skip: SkippedAssetReason };

/**
 * Decide the destination key for one source key, or reject it. This is the
 * source-side validation: a key is only ever copied when it demonstrably belongs
 * to the source item.
 */
function planCopy(params: {
	sourceKey: string;
	keyspace: string;
	projectId: string;
	sourceStoryId: string;
	targetStoryId: string;
}): CopyPlan {
	const { sourceKey, keyspace, projectId, sourceStoryId, targetStoryId } =
		params;
	const sourcePrefix = `${keyspace}${projectId}/${sourceStoryId}/`;
	if (!sourceKey.startsWith(sourcePrefix)) {
		return { skip: "foreign-key" };
	}
	const segment = sourceKey.slice(sourcePrefix.length);
	if (!SAFE_KEY_SEGMENT_RE.test(segment)) {
		return { skip: "unsafe-key" };
	}
	return {
		targetKey: `${keyspace}${projectId}/${targetStoryId}/${MERGED_SEGMENT_PREFIX}${sourceStoryId}-${segment}`,
	};
}

/**
 * Copy one object, converting any failure into a skip. Returns `null` when the
 * copy did not happen, so the caller can never reference an absent object.
 */
async function copyOne(
	copyObject: (sourceKey: string, targetKey: string) => Promise<void>,
	sourceKey: string,
	targetKey: string,
	skipped: SkippedAsset[],
): Promise<string | null> {
	try {
		await copyObject(sourceKey, targetKey);
		return targetKey;
	} catch (error) {
		logger.warn("[duplicate-merge] asset copy failed", {
			sourceKey,
			targetKey,
			error: error instanceof Error ? error.name : "unknown",
		});
		skipped.push({ key: sourceKey, reason: "copy-failed" });
		return null;
	}
}

/**
 * Copy every asset the source item owns into the target item's keyspace.
 *
 * Never throws: a provider outage or a per-object failure degrades to "that
 * asset was not carried over", reported in `skipped`. The caller decides what to
 * reference, and must reference only what came back in `media` / `attachments`.
 */
export async function copyStoryAssetsToStory(
	params: CopyStoryAssetsParams,
): Promise<CopyStoryAssetsResult> {
	const {
		projectId,
		sourceStoryId,
		targetStoryId,
		sourceDescription = null,
		sourceAttachments = [],
	} = params;

	const skipped: SkippedAsset[] = [];
	const empty: CopyStoryAssetsResult = {
		media: [],
		attachments: [],
		skipped,
	};

	// Merging an item into itself would remap every key onto a `merged-` twin of
	// itself. The procedure rejects it up front; this is the belt-and-braces net.
	if (sourceStoryId === targetStoryId) {
		return empty;
	}

	const mediaKeys = sourceDescription
		? extractStoryMediaKeysFromContent(sourceDescription)
		: [];
	if (mediaKeys.length === 0 && sourceAttachments.length === 0) {
		return empty;
	}

	let copyObject = params.copyObject;
	if (!copyObject) {
		try {
			const provider = getStorageProvider();
			const bucket = config.storage.bucketNames.projectContexts;
			copyObject = (sourceKey: string, targetKey: string) =>
				provider.copyFile(sourceKey, targetKey, { bucket });
		} catch (error) {
			// No provider ⇒ nothing can be carried over. The merge still runs.
			logger.warn(
				"[duplicate-merge] storage unavailable; no assets copied",
				{
					projectId,
					sourceStoryId,
					targetStoryId,
					error: error instanceof Error ? error.name : "unknown",
				},
			);
			for (const key of mediaKeys) {
				skipped.push({ key, reason: "copy-failed" });
			}
			for (const attachment of sourceAttachments) {
				skipped.push({
					key: attachment.storageKey,
					reason: "copy-failed",
				});
			}
			return empty;
		}
	}
	const copy = copyObject;

	// Inline images. Order is preserved (Promise.all over an indexed array) so
	// the re-appended `## Attachments` block reads in the body's original order.
	const mediaResults = await Promise.all(
		mediaKeys.map(async (sourceKey): Promise<CopiedMediaKey | null> => {
			const plan = planCopy({
				sourceKey,
				keyspace: STORY_MEDIA_KEYSPACE,
				projectId,
				sourceStoryId,
				targetStoryId,
			});
			if ("skip" in plan) {
				skipped.push({ key: sourceKey, reason: plan.skip });
				return null;
			}
			const targetKey = await copyOne(
				copy,
				sourceKey,
				plan.targetKey,
				skipped,
			);
			return targetKey ? { sourceKey, targetKey } : null;
		}),
	);

	// Uploaded attachments. `storageKey` is written by the server, so a rejection
	// here means a legacy / hand-written row rather than user input — it is
	// skipped for exactly the same reason: its object cannot be proven to belong
	// to the source item.
	const attachmentResults = await Promise.all(
		sourceAttachments.map(
			async (attachment): Promise<CopiedAttachment | null> => {
				const plan = planCopy({
					sourceKey: attachment.storageKey,
					keyspace: STORY_ATTACHMENT_KEYSPACE,
					projectId,
					sourceStoryId,
					targetStoryId,
				});
				if ("skip" in plan) {
					skipped.push({
						key: attachment.storageKey,
						reason: plan.skip,
					});
					return null;
				}
				const targetKey = await copyOne(
					copy,
					attachment.storageKey,
					plan.targetKey,
					skipped,
				);
				return targetKey
					? {
							attachmentId: attachment.id,
							sourceKey: attachment.storageKey,
							targetKey,
						}
					: null;
			},
		),
	);

	const media = mediaResults.filter((r): r is CopiedMediaKey => r !== null);
	const attachments = attachmentResults.filter(
		(r): r is CopiedAttachment => r !== null,
	);

	if (skipped.length > 0) {
		// The keys are logged deliberately: an asset that did not survive a merge
		// is only recoverable if the operator can see which object was left
		// behind. Mirrors the `droppedKeys` payload in `log-reinjected-attachments`.
		logger.warn("[duplicate-merge] assets not carried to the survivor", {
			projectId,
			sourceStoryId,
			targetStoryId,
			skippedCount: skipped.length,
			skipped,
		});
	}
	if (media.length > 0 || attachments.length > 0) {
		logger.info("[duplicate-merge] carried assets to the survivor", {
			projectId,
			sourceStoryId,
			targetStoryId,
			mediaCount: media.length,
			attachmentCount: attachments.length,
		});
	}

	return { media, attachments, skipped };
}
