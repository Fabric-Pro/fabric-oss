import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	authorizeInstructionProposalUploadUrls,
	claimInstructionFileStagingKey,
	getInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	isStagingKey,
	PROPOSAL_UPLOAD_SIGNING_WINDOW_MS,
	stagingKey,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertInstructionSnapshotMutationAccess } from "./proposal-authorization";

// Same source `SKILLS_BUCKET_NAME` feeds (config/index.ts:167), imported the
// way `packages/ai/skills/loader.ts` does.
const SKILLS_BUCKET = config.storage.bucketNames.skills;

/**
 * How long a signed PUT stays usable. Fifteen minutes, against a provider
 * default of 60 seconds: one page is 200 URLs signed together and drained by
 * six concurrent workers, so a 50 MB snapshot on an uplink below roughly
 * 7 Mbps — or simply many small files with real request latency — reaches the
 * tail of the queue long after those URLs would have expired, and each
 * per-file retry reuses the same dead URL.
 *
 * It is a ceiling on how long staged bytes stay writable, so it is not longer
 * than it needs to be. The window is not itself a correctness boundary: the
 * gate and promotion each hash what is actually at the key
 * (`activities/project-instructions.ts`), so bytes swapped inside it are
 * caught rather than published.
 */
const UPLOAD_URL_EXPIRY_SECONDS = 15 * 60;

/**
 * The one refusal this procedure gives once it has decided not to sign.
 *
 * Deliberately identical for "no such snapshot", "the snapshot has left
 * RECEIVING" and "that file has already been promoted": a caller probing with
 * stale ids learns only that no URL is coming, never which of the three it
 * hit, and the upload dialog's handling is the same in every case (the
 * snapshot is no longer accepting bytes).
 */
function notReceiving() {
	return new ORPCError("NOT_FOUND", {
		message: "Upload not found or no longer receiving",
	});
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Mints signed PUT URLs for up to 200 already-registered staging files.
 * The snapshot id used to scope every downstream query comes from a
 * tenant-scoped `getInstructionSnapshot(id, projectId, organizationId)`
 * lookup done first in this handler — never trusted from client input
 * directly. Each file's provisional `begin`-time storage key
 * (`stagingKey(projectId, "pending", <index>)`) is rewritten here to the
 * real `(projectId, snapshotId, fileId)` key before signing, because the
 * file id only exists after `createInstructionSnapshot` returns.
 *
 * That rewrite is ONE-WAY and conditional (`claimInstructionFileStagingKey`):
 * staging → staging only, and only while the parent snapshot is still
 * RECEIVING at the moment of the write. A file that finalization has already
 * promoted to its immutable snapshot key can never be pointed back at
 * writable storage, whatever this request read when it started.
 */
// The baseline middleware proves project visibility. The snapshot-aware guard
// below then requires CREATE for direct versions, or READ plus proposer
// ownership for a pending proposal.
export const createUploadUrlsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/upload-urls",
		tags: ["Projects", "Instructions"],
		summary: "Signed upload URLs for a page of files",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
			fileIds: z.array(z.string()).min(1).max(200),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!snapshot || snapshot.status !== "RECEIVING") {
			throw notReceiving();
		}
		await assertInstructionSnapshotMutationAccess({
			projectId: input.projectId,
			userId: context.user.id,
			snapshot,
		});
		const proposalSigningDate =
			snapshot.proposalStatus === null
				? null
				: new Date(
						Math.floor(snapshot.createdAt.getTime() / 1000) * 1000,
					);
		const proposalExpiresAt =
			proposalSigningDate === null
				? null
				: proposalSigningDate.getTime() +
					PROPOSAL_UPLOAD_SIGNING_WINDOW_MS;
		if (proposalExpiresAt !== null && proposalExpiresAt <= Date.now()) {
			throw notReceiving();
		}

		const storage = getStorageProvider();
		if (!(storage.supportsPresignedUrls && storage.getSignedUploadUrl)) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Storage provider does not support presigned uploads",
			});
		}
		const getSignedUploadUrl = storage.getSignedUploadUrl;

		const wanted = new Set(input.fileIds);
		const files = (
			await listInstructionFiles(input.snapshotId, organizationId)
		).filter((f) => wanted.has(f.id));
		const uploads: Array<{
			fileId: string;
			path: string;
			url: string;
			contentType: string;
		}> = [];
		for (const f of files) {
			const key = stagingKey(input.projectId, input.snapshotId, f.id);
			// A row already on the deterministic staging key needs no write:
			// this is a re-request for a page whose URLs expired, or a retry
			// of one that was interrupted mid-page.
			if (f.storageKey !== key) {
				// A key outside staging is an IMMUTABLE snapshot key that
				// promotion wrote. Nothing may ever point such a row back at
				// writable storage — the bytes under it are what the gate
				// hashed and what the recorded digest describes.
				if (!isStagingKey(f.storageKey)) {
					throw notReceiving();
				}
				// Compare-and-set, with the parent's RECEIVING state checked
				// in the same statement (see the query's own comment). The
				// `RECEIVING` read at the top of this handler is minutes old
				// by the time a 200-URL page reaches its tail, so it cannot be
				// what authorizes the write.
				const { moved } = await claimInstructionFileStagingKey({
					fileId: f.id,
					snapshotId: input.snapshotId,
					projectId: input.projectId,
					organizationId,
					from: f.storageKey,
					to: key,
				});
				if (!moved) {
					// The file moved on between the listing and the write —
					// finalization promoted it, the snapshot left RECEIVING,
					// or the row is not this snapshot's after all. Same shape
					// for all three: the response must not say which.
					throw notReceiving();
				}
			}
			// Explicit expiry: the provider's default is 60 seconds
			// (`packages/storage/provider/s3/index.ts`), and a page is 200
			// URLs drained by six upload workers, so the last entries in the
			// queue are reached minutes after they were signed on any slow
			// uplink — and a per-file retry reuses the same expired URL.
			const url = await getSignedUploadUrl(key, {
				bucket: SKILLS_BUCKET,
				contentType: f.mimeType,
				...(snapshot.proposalStatus === null
					? {}
					: { contentLength: f.size }),
				expiresIn:
					proposalExpiresAt === null
						? UPLOAD_URL_EXPIRY_SECONDS
						: PROPOSAL_UPLOAD_SIGNING_WINDOW_MS / 1000,
				...(proposalSigningDate === null
					? {}
					: { signingDate: proposalSigningDate }),
			});
			uploads.push({
				fileId: f.id,
				path: f.path,
				url,
				contentType: f.mimeType,
			});
		}
		if (snapshot.proposalStatus !== null) {
			const authorization = await authorizeInstructionProposalUploadUrls({
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId,
				createdAfter: new Date(
					Date.now() - PROPOSAL_UPLOAD_SIGNING_WINDOW_MS + 999,
				),
			});
			if (!authorization.authorized) {
				throw notReceiving();
			}
		}
		return { uploads };
	});
