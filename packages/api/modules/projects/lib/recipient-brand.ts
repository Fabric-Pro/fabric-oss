import { randomBytes, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	canEditProject,
	db,
	hasProjectAccess,
	isRecipientLogoKeyForProject,
	recipientLogoKeyPrefix,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { assertGlossyOrProposalArtifactEnabled } from "./proposal-artifact-feature";

/**
 * Shared plumbing for the recipient brand procedures (Fizzy #2589, KTD19,
 * KTD23): the project gate every one of them runs, and the only place a
 * recipient logo's storage key is ever built.
 *
 * Every key lives under `project-brand/{projectId}/recipient-brand/` in the
 * private `projectContexts` bucket — outside `story-attachments/`, whose daily
 * orphan sweep deletes any object without a story attachment row, and inside
 * the prefix project deletion sweeps. Keys are built HERE from the gated
 * project id and a server-generated token; a client never names a key, so a
 * client can never point a confirmation at another project's object, a
 * workspace file, or a path with `..` in it.
 */

/** Upload types the signed PUT accepts; promotion re-checks the bytes anyway. */
export const RECIPIENT_LOGO_UPLOAD_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

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

/**
 * A new immutable key for a promoted logo, with a fresh server-generated id.
 * The shape is exactly what `isRecipientLogoKeyForProject` and the
 * migration's CHECK constraint accept.
 */
export function newRecipientLogoCurrentKey(projectId: string): string {
	const key = `${recipientLogoKeyPrefix(projectId)}${randomUUID()}.png`;
	if (!isRecipientLogoKeyForProject(projectId, key)) {
		// Unreachable unless the two builders drift apart; fail before any
		// object is written rather than at the CHECK constraint after.
		throw new Error("Recipient logo key does not match its own prefix");
	}
	return key;
}

/**
 * The gate every recipient brand procedure runs after
 * `requireProjectPermission` (KTD19), in NOT_FOUND-before-FORBIDDEN order:
 *   1. the rollout gate, resolved from the project row: GLOSSY_EDITION or
 *      PROPOSAL_ARTIFACT, since the Proposal artifact's Style tab edits the
 *      same recipient brand (Fizzy #2801; NOT_FOUND when both are off);
 *   2. a trashed project, or one outside any organization, is NOT_FOUND;
 *   3. `hasProjectAccess`, the same project access the Glossy page's
 *      document procedures require (FORBIDDEN otherwise);
 *   4. writes also need `canEditProject`, which a project guest with an
 *      editor role holds (FORBIDDEN otherwise).
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

	return { organizationId: project.organizationId };
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
 * Best-effort deletion after a commit (KTD23 step 3). A leftover object is
 * unreferenced, stays under the project prefix, and goes when the project
 * does — so a failure here is logged, never thrown.
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
