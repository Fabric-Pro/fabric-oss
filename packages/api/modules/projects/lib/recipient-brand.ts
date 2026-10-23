import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	canEditProject,
	db,
	getRecipientBrand,
	hasProjectAccess,
	isOrganizationMember,
	isRecipientLogoKeyForProject,
	recipientLogoKeyPrefix,
} from "@repo/database";
import {
	LOGO_MAX_INPUT_BYTES,
	type NormalizeLogoFailureCode,
	normalizeLogo,
} from "@repo/integrations/website-brand";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import {
	LOGO_UPLOAD_CONTENT_TYPES,
	type LogoUploadContentType,
} from "@repo/utils/brand-assets";
import { isRecipientSuggestedLogoKey } from "@repo/utils/proposal-artifact/brand-sources";
import { z } from "zod";
import { assertGlossyOrProposalArtifactEnabled } from "./proposal-artifact-feature";

/**
 * Shared plumbing for the recipient brand procedures (Fizzy #2589): the
 * project gate every one of them runs, and the only place a recipient
 * logo's storage key is ever built.
 *
 * Every key lives under `project-brand/{projectId}/recipient-brand/` in the
 * private `projectContexts` bucket — outside `story-attachments/`, whose daily
 * orphan sweep deletes any object without a story attachment row, and inside
 * the prefix project deletion sweeps. Keys are built HERE from the gated
 * project id and a server-generated token; a client never names a key, so a
 * client can never point a confirmation at another project's object, a
 * workspace file, or a path with `..` in it.
 */

/**
 * The recipient brand fields a website fetch can suggest (Fizzy #2946). The
 * Style tab confirms them one at a time, so a fetched name is applied only
 * by itself.
 */
export const RECIPIENT_SUGGESTION_FIELDS = ["name", "colors", "logo"] as const;

/**
 * Upload types the signed PUT accepts; promotion re-checks the bytes anyway.
 * The shared brand-asset vocabulary, so the picker's `accept` list, the
 * browser's pre-check and this signer can never disagree.
 */
export const RECIPIENT_LOGO_UPLOAD_CONTENT_TYPES =
	LOGO_UPLOAD_CONTENT_TYPES as readonly [
		LogoUploadContentType,
		...LogoUploadContentType[],
	];

/** A signed PUT is used at once, from the form that asked for it. */
export const RECIPIENT_LOGO_UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Signed reads are for rendering a preview right now, not for sharing. A
 * caller that holds its reads longer (the Glossy page) passes its own TTL.
 */
const RECIPIENT_LOGO_READ_URL_TTL_SECONDS = 300;

/** 24 random bytes as base64url: exactly this shape, nothing else. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function recipientBrandBucket(): string {
	return config.storage.bucketNames.projectContexts;
}

function recipientBrandPrefix(projectId: string): string {
	return `project-brand/${projectId}/recipient-brand/`;
}

/** Where every fetch and upload for this project waits to be confirmed. */
function recipientLogoPendingPrefix(projectId: string): string {
	return `${recipientBrandPrefix(projectId)}pending/`;
}

/** A new, unguessable name for one pending object. */
export function newRecipientLogoToken(): string {
	return randomBytes(24).toString("base64url");
}

/** Whether `value` has the shape of a token this module issued. */
function isRecipientLogoToken(value: unknown): value is string {
	return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * The pending object a token names, for THIS project. Refuses anything that
 * is not a token — a key, a path, `..` — before it can reach storage.
 */
export function recipientLogoPendingKey(
	projectId: string,
	token: string,
): string {
	if (!isRecipientLogoToken(token)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The logo upload is not valid",
		});
	}
	return `${recipientLogoPendingPrefix(projectId)}${token}.png`;
}

/** Whether `key` is a pending object of THIS project, as a token names it. */
function isRecipientLogoPendingKeyForProject(
	projectId: string,
	key: string,
): boolean {
	const prefix = recipientLogoPendingPrefix(projectId);
	return (
		key.startsWith(prefix) &&
		key.endsWith(".png") &&
		isRecipientLogoToken(key.slice(prefix.length, -".png".length))
	);
}

/**
 * A new immutable key for a promoted logo, with a fresh server-generated id.
 * The shape is exactly what `isRecipientLogoKeyForProject` and the
 * migration's CHECK constraint accept.
 */
function newRecipientLogoCurrentKey(projectId: string): string {
	const key = `${recipientLogoKeyPrefix(projectId)}${randomUUID()}.png`;
	if (!isRecipientLogoKeyForProject(projectId, key)) {
		// Unreachable unless the two builders drift apart; fail before any
		// object is written rather than at the CHECK constraint after.
		throw new Error("Recipient logo key does not match its own prefix");
	}
	return key;
}

export type RecipientLogoPromotion =
	| {
			outcome: "promoted";
			key: string;
			/** SHA-256 (hex) of the bytes stored under `key`. */
			hash: string;
	  }
	/**
	 * The source object is not there: never stored, or cleaned up since,
	 * before or while it was read.
	 */
	| { outcome: "missing" }
	| { outcome: "rejected"; code: NormalizeLogoFailureCode };

function logoStorageFailure(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "Could not save the logo",
	});
}

/**
 * Step 1 of a logo promotion: normalize one stored logo of THIS
 * project and copy it to a new immutable `current/{promotionId}.png`, with
 * the hash of the bytes written. Nothing references the new object yet, so
 * any failure here changes nothing, and the source object is left where it
 * is: its owner (a pending upload, a website fetch's suggestion) decides
 * when it goes.
 *
 * `sourceKey` is a pending object a token named or a logo the recipient
 * website fetch suggested, both of this project; anything else is refused
 * before storage is touched. The bytes are untrusted whichever way they
 * arrived, so every source goes through the same hardened pipeline, which
 * refuses anything that is not a raster PNG, JPEG, GIF or WebP (an SVG or an
 * HTML page stored as `image/png` included) and re-encodes the rest.
 */
export async function promoteRecipientLogo(
	projectId: string,
	sourceKey: string,
): Promise<RecipientLogoPromotion> {
	if (
		!isRecipientLogoPendingKeyForProject(projectId, sourceKey) &&
		!isRecipientSuggestedLogoKey(projectId, sourceKey)
	) {
		// Unreachable unless a caller skipped its own key check; fail before
		// any object is read rather than copy another project's bytes.
		throw new Error("Recipient logo source is not one of this project's");
	}
	const storage = getStorageProvider();
	const bucket = recipientBrandBucket();

	let metadata: Awaited<ReturnType<typeof storage.getFileMetadata>>;
	try {
		metadata = await storage.getFileMetadata(sourceKey, { bucket });
	} catch {
		throw logoStorageFailure();
	}
	if (!metadata) {
		return { outcome: "missing" };
	}

	let normalized: Awaited<ReturnType<typeof normalizeLogo>>;
	if (metadata.size > LOGO_MAX_INPUT_BYTES) {
		normalized = { ok: false, code: "too_large" };
	} else {
		let bytes: Buffer;
		try {
			bytes = (await storage.downloadFile(sourceKey, { bucket })).data;
		} catch {
			// Its owner may have deleted it between the two reads (a newer
			// website fetch replacing its suggestion): that is a missing
			// object, not a storage failure.
			const stillThere = await storage
				.getFileMetadata(sourceKey, { bucket })
				.catch(() => undefined);
			if (stillThere === null) {
				return { outcome: "missing" };
			}
			throw logoStorageFailure();
		}
		normalized = await normalizeLogo(bytes);
	}
	if (!normalized.ok) {
		return { outcome: "rejected", code: normalized.code };
	}

	const key = newRecipientLogoCurrentKey(projectId);
	try {
		await storage.uploadFile(key, normalized.png, {
			bucket,
			contentType: "image/png",
		});
	} catch {
		throw logoStorageFailure();
	}
	return {
		outcome: "promoted",
		key,
		hash: createHash("sha256").update(normalized.png).digest("hex"),
	};
}

/**
 * The gate every recipient brand procedure runs after
 * `requireProjectPermission`, in NOT_FOUND-before-FORBIDDEN order:
 *   1. the rollout gate, resolved from the project row: GLOSSY_EDITION or
 *      PROPOSAL_ARTIFACT, since the Proposal artifact's Style tab edits the
 *      same recipient brand (Fizzy #2801; NOT_FOUND when both are off);
 *   2. a trashed project, or one outside any organization, is NOT_FOUND;
 *   3. `hasProjectAccess`, the same project access the Glossy page's
 *      document procedures require (FORBIDDEN otherwise);
 *   4. writes also need `canEditProject` AND a `member` row in the
 *      project's owning organization (FORBIDDEN otherwise): a project guest
 *      with an editor role reads the recipient brand but never changes it
 *      (Fizzy #2946).
 *
 * Returns the project's organization — the one id that drives storage keys
 * and audit. It comes from the project row; no input carries one.
 */
export async function loadRecipientBrandProject(args: {
	projectId: string;
	userId: string;
	write: boolean;
}): Promise<{ organizationId: string }> {
	await assertGlossyOrProposalArtifactEnabled(args.projectId);

	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { organizationId: true, deletedAt: true },
	});
	if (!project || project.deletedAt || !project.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	if (!(await hasProjectAccess(args.projectId, args.userId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
	if (args.write && !(await canEditProject(args.projectId, args.userId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have permission to edit this project",
		});
	}
	if (
		args.write &&
		!(await isOrganizationMember(args.userId, project.organizationId))
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only members of the organization that owns this project can change its recipient brand",
		});
	}

	return { organizationId: project.organizationId };
}

/**
 * Whether `userId` may change the project's recipient brand, as the write
 * gate in {@link loadRecipientBrandProject} decides it, for a form that must
 * not offer a Save the server would refuse. The caller has already passed the
 * read gate; `organizationId` is the project's owning organization.
 */
export async function canEditRecipientBrand(args: {
	projectId: string;
	organizationId: string;
	userId: string;
}): Promise<boolean> {
	const [canEdit, member] = await Promise.all([
		canEditProject(args.projectId, args.userId),
		isOrganizationMember(args.userId, args.organizationId),
	]);
	return canEdit && member;
}

/** A short-lived signed read that renders inline as a PNG. */
export async function signRecipientLogoRead(
	key: string,
	expiresIn: number = RECIPIENT_LOGO_READ_URL_TTL_SECONDS,
): Promise<string> {
	return getStorageProvider().getSignedUrl(key, {
		bucket: recipientBrandBucket(),
		expiresIn,
		responseContentType: "image/png",
		responseContentDisposition: "inline",
	});
}

/** The recipient brand as the procedures return it. */
export const recipientBrandOutputSchema = z.object({
	name: z.string().nullable(),
	website: z.string().nullable(),
	colors: z.array(z.string()),
	/** A short-lived inline PNG read, or null when there is no logo. */
	logoUrl: z.string().nullable(),
	updatedAt: z.date(),
});

type RecipientBrandOutput = z.infer<typeof recipientBrandOutputSchema>;

/**
 * Shape a stored recipient brand for the client; the key never leaves. The
 * logo read is best-effort: a storage failure shows the brand without its
 * logo rather than failing the read that carries it (the Glossy page's `get`).
 * `expiresIn` defaults to the short preview TTL; the Glossy page passes the
 * TTL of its other signed reads, since it holds them for one page session.
 */
export async function presentRecipientBrand(
	brand: {
		name: string | null;
		website: string | null;
		colors: string[];
		logoKey: string | null;
		updatedAt: Date;
	},
	options: { expiresIn?: number } = {},
): Promise<RecipientBrandOutput> {
	let logoUrl: string | null = null;
	if (brand.logoKey) {
		try {
			logoUrl = await signRecipientLogoRead(
				brand.logoKey,
				options.expiresIn,
			);
		} catch {
			logoUrl = null;
		}
	}
	return {
		name: brand.name,
		website: brand.website,
		colors: brand.colors,
		logoUrl,
		updatedAt: brand.updatedAt,
	};
}

/**
 * Best-effort deletion after a commit. A leftover object is unreferenced,
 * stays under the project prefix, and goes when the project does — so a
 * failure here is logged, never thrown.
 */
export async function deleteRecipientBrandObjects(
	projectId: string,
	keys: string[],
): Promise<void> {
	const unique = [...new Set(keys)];
	if (unique.length === 0) {
		return;
	}
	try {
		const result = await getStorageProvider().deleteObjects(unique, {
			bucket: recipientBrandBucket(),
		});
		if (result.errors.length > 0) {
			logger.warn(
				`[RecipientBrand] ${result.errors.length} object(s) left for project ${projectId}`,
			);
		}
	} catch (error) {
		logger.warn(
			`[RecipientBrand] cleanup failed for project ${projectId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * After a confirmation's write failed with an error: delete the logo it
 * promoted unless the stored recipient brand points at it, since the write
 * may have committed with only its answer lost. Nothing is deleted when the
 * row cannot be read back.
 */
export async function deleteUnsavedRecipientLogo(
	projectId: string,
	promotedKey: string | null,
): Promise<void> {
	if (!promotedKey) {
		return;
	}
	let stored: Awaited<ReturnType<typeof getRecipientBrand>>;
	try {
		stored = await getRecipientBrand(projectId);
	} catch {
		return;
	}
	if (stored?.logoKey !== promotedKey) {
		await deleteRecipientBrandObjects(projectId, [promotedKey]);
	}
}

/**
 * Every pending object of the project, for cleanup after a confirmation
 * applies. Best-effort like the deletion it feeds: a listing failure leaves
 * the objects for project deletion.
 */
export async function listRecipientLogoPendingKeys(
	projectId: string,
): Promise<string[]> {
	const keys: string[] = [];
	try {
		let continuationToken: string | undefined;
		// A project has a handful of pending objects; the page bound only
		// stops a misbehaving listing from looping.
		for (let page = 0; page < 10; page++) {
			const result = await getStorageProvider().listObjects({
				bucket: recipientBrandBucket(),
				prefix: recipientLogoPendingPrefix(projectId),
				continuationToken,
			});
			keys.push(...result.objects.map((object) => object.key));
			if (!result.nextContinuationToken) {
				break;
			}
			continuationToken = result.nextContinuationToken;
		}
	} catch (error) {
		logger.warn(
			`[RecipientBrand] could not list pending logos for project ${projectId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return keys;
}
