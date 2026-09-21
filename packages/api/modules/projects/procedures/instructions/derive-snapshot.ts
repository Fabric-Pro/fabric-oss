import { ORPCError } from "@orpc/client";
import {
	createDerivedInstructionSnapshot,
	getInstructionSnapshot,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
} from "@repo/database";
import { SNAPSHOT_LIMITS, snapshotPrefix } from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	derivedSnapshotRefusal,
	MAX_CHANGES,
	validateInstructionChanges,
} from "./change-set";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertInstructionDeriveAccess } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure plus a dynamic project permission:
 * INSTRUCTION_READ for a proposal, INSTRUCTION_CREATE for a direct version.
 *
 * Registers a snapshot DERIVED from a READY one: a small set of per-path
 * changes (`put` / `delete`) against a base whose every other file is
 * inherited without the client uploading anything. The `put` rows come back as
 * staged files the client PUTs through the ordinary `createUploadUrls` →
 * `finalize` path, so an edit runs the SAME verify → scan → finalize → publish
 * workflow an upload does: the secret gate reads every file, the digest is
 * recomputed, history and retention behave identically.
 *
 * Storage keys are ALWAYS server-generated, exactly as in `begin-snapshot.ts`:
 * each `put` gets the provisional `stagingKey(projectId, "pending", <index>)`
 * that `createUploadUrls` rewrites to the real key. An inherited row's key is
 * the base's immutable object and the client never sees it — `createUploadUrls`
 * refuses to sign a PUT for a non-staging key, so a client that tried to
 * upload over an inherited row is refused by that procedure rather than
 * trusted by this one.
 *
 * The refusals split in two, deliberately:
 *
 *  - Payload-shaped ones are in `change-set.ts`, because they need
 *    `@repo/instructions` and none of them needs the base's rows: an invalid
 *    relative path, a path the base's FROZEN ignore rules exclude, a
 *    secret-shaped filename, a file over the per-file cap, a change touching
 *    `.fabricignore`, a path named twice. They are shared verbatim with
 *    `submit-change.ts`, the inline-content entry point the REST route, the
 *    CLI and the MCP proposal tool go through.
 *  - Base-shaped ones are in `createDerivedInstructionSnapshot`, inside the
 *    transaction that writes the snapshot, because a read taken out here would
 *    answer about a moment that has already passed.
 *
 * `.fabricignore` cannot be edited or deleted through this path AT ALL. The
 * validation gate binds the stored file to the snapshot's `settingsFrozen`
 * (`ignoreProvenanceRejection`), and a derived snapshot copies
 * `settingsFrozen` from its base verbatim — so changing the file would produce
 * a snapshot the gate is right to reject. Changing the exclusion rules is a
 * settings change plus a folder re-upload, which is the operation that
 * re-freezes them.
 */
export const deriveSnapshotProcedure = tenantProtectedProcedure
	// Every proposal author needs READ. Direct derives retain CREATE through
	// the dynamic check in the handler below.
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:baseSnapshotId/derive",
		tags: ["Projects", "Instructions"],
		summary: "Start a new version from an existing one",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with the sibling procedures and
			// ignored: the handler derives the organization from the project.
			organizationId: z.string().nullable().optional(),
			baseSnapshotId: z.string(),
			publishOnReady: z.boolean().default(true),
			proposal: z.boolean().default(false),
			changes: z
				.array(
					z.discriminatedUnion("op", [
						z.object({
							op: z.literal("put"),
							path: z.string().max(4096),
							size: z.number().int().min(0),
							sha256: z.string().regex(/^[0-9a-f]{64}$/),
						}),
						z.object({
							op: z.literal("delete"),
							path: z.string().max(4096),
						}),
					]),
				)
				.min(1)
				.max(MAX_CHANGES),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertInstructionDeriveAccess({
			projectId: input.projectId,
			userId: context.user.id,
			proposal: input.proposal,
		});
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);

		// Spec §6.12: one source of truth per project. A repository-backed
		// project's instructions are changed in git and refreshed by sync;
		// accepting an edit here would fork Fabric away from the repository
		// with no way to reconcile, which is the case the whole setting
		// exists to prevent.
		const settings = await getProjectInstructionSettings(
			input.projectId,
			organizationId,
		);
		if (settings.sourceOfTruth === "REPOSITORY") {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"This project's coding instructions come from its repository. Change the files there and sync the project.",
			});
		}

		const base = await getInstructionSnapshot(
			input.baseSnapshotId,
			input.projectId,
			organizationId,
		);
		if (!base) {
			throw new ORPCError("NOT_FOUND", {
				message: "That version is not available to edit",
			});
		}

		// Non-fast-forward semantics (spec §6.12). An editor who opened the
		// tab on version 7 and saves while a teammate has published version 8
		// would otherwise publish a version 9 built from 7 — silently
		// reverting everything 8 changed. Only enforced when this save
		// intends to publish: "Save as a new version" is explicitly not a
		// claim on the pointer.
		//
		// The check is exact-id, and stays right for a ROLLBACK too: after a
		// rollback from v9 to v7 an editor still based on v9 is refused,
		// because v9 is no longer what the project publishes. The message is
		// therefore direction-neutral — the replacement is not necessarily
		// newer, and History's rollback makes "someone published a newer
		// version" a plain falsehood.
		if (input.publishOnReady || input.proposal) {
			const published = await getPublishedInstructionSnapshot(
				input.projectId,
			);
			if (published?.id !== base.id) {
				throw new ORPCError("CONFLICT", {
					message:
						"The published version changed while you were editing. Reload the tab and make the change again.",
					data: { reason: "BASE_NOT_PUBLISHED" },
				});
			}
		}

		// The base's OWN rules, not the project's live ones: the inherited
		// files were admitted under these, `settingsFrozen` is copied from the
		// base verbatim, and the gate checks the stored `.fabricignore` still
		// parses to exactly them. Re-resolving here would let a new file in
		// that the snapshot's own frozen rules exclude.
		const { changes, putCount, deleteCount } = validateInstructionChanges({
			projectId: input.projectId,
			changes: input.changes,
			settingsFrozen: base.settingsFrozen,
		});

		const created = await createDerivedInstructionSnapshot({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			baseSnapshotId: base.id,
			publishOnReady: input.proposal ? false : input.publishOnReady,
			proposal: input.proposal,
			changes,
			limits: {
				maxFiles: SNAPSHOT_LIMITS.maxFiles,
				maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes,
			},
			baseKeyPrefix: snapshotPrefix(input.projectId, base.id),
		});
		if (!created.ok) {
			// The tab REFUSES an identical pending proposal rather than
			// resuming it (Fizzy #2605).
			//
			// The inline entry point can resume one, because it is holding
			// the bytes and finishes the upload in the same call. This flow
			// is three round trips and the BROWSER owns the middle one, so
			// handing this request the other snapshot's staged file ids would
			// point one tab's `createUploadUrls` at a snapshot another tab
			// created and may still be uploading into. There is nothing to
			// recover here anyway: the proposal is in the proposer's own
			// list, where it can be reviewed or cancelled.
			//
			// Not routed through `derivedSnapshotRefusal`: this is the only
			// caller that refuses it, the message names the existing version,
			// and the payload carries the row so the tab can link to it.
			if (created.reason === "duplicate_proposal") {
				throw new ORPCError("CONFLICT", {
					message: `You already have an identical pending proposal (version ${created.existing.version}). Review or cancel it before proposing it again.`,
					data: {
						reason: "PROPOSAL_DUPLICATE",
						snapshotId: created.existing.id,
						version: created.existing.version,
					},
				});
			}
			throw derivedSnapshotRefusal(created.reason, created.detail);
		}

		// The same action an upload records — this IS an upload, of a smaller
		// set of files — with the provenance and the shape of the change in
		// metadata. Counts and the base id only: a path is user content and
		// has no business in the audit log.
		recordAuditFromRequest(context, {
			action: "project.instructions.upload_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: created.id,
				name: `v${created.version}`,
			},
			metadata: {
				mode: input.proposal ? "proposal" : "derived",
				baseSnapshotId: base.id,
				baseVersion: base.version,
				putCount,
				deleteCount,
				inheritedCount: created.inheritedCount,
				keptCount: created.fileCount,
			},
		});

		return {
			snapshotId: created.id,
			version: created.version,
			baseVersion: base.version,
			fileCount: created.fileCount,
			inheritedCount: created.inheritedCount,
			proposalStatus: input.proposal ? ("PENDING" as const) : null,
			// Exactly the rows the client has to PUT. It must not ask
			// `listFiles` instead: that returns the inherited rows too, and
			// `createUploadUrls` refuses every one of them.
			staged: created.staged.map((f) => ({ fileId: f.id, path: f.path })),
		};
	});
