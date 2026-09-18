import { ORPCError } from "@orpc/client";
import {
	createDerivedInstructionSnapshot,
	type DerivedInstructionRefusal,
	getInstructionSnapshot,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
} from "@repo/database";
import {
	buildIgnoreMatcher,
	classifyPath,
	FABRIC_IGNORE_FILE,
	isSecretFileName,
	SNAPSHOT_LIMITS,
	snapshotPrefix,
	stagingKey,
	validateRelativePath,
} from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { fileTypingFor } from "./file-typing";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertInstructionDeriveAccess } from "./proposal-authorization";

/**
 * The most paths one derivation may touch.
 *
 * The tab sends one change per action, and the CLI push this primitive is
 * shared with sends a diff. A cap belongs here anyway: every `put` becomes a
 * signed PUT and every change becomes a row, and an unbounded change set is a
 * way to build a snapshot that is nothing like the base it claims to derive
 * from — at which point re-uploading the folder is the honest operation, and
 * the one that re-resolves the project's live ignore settings.
 */
const MAX_CHANGES = 50;

/**
 * The frozen `ignoreGlobs`/`layer` pair a snapshot carries, or null when the
 * `Json` column does not hold that shape.
 *
 * Mirrors `readFrozenIgnoreSettings` in the validation activity, and for the
 * same reason: nothing in the database constrains the column, and an older row
 * can hold anything. A shape this cannot read means the ignore check is
 * skipped here — the gate re-applies the real authority on the stored
 * `.fabricignore` regardless — rather than refusing an edit over a column
 * surprise.
 */
function readFrozenIgnoreGlobs(
	settingsFrozen: unknown,
): { globs: string[]; layer: "fabricignore" | "project" | "default" } | null {
	if (
		settingsFrozen === null ||
		typeof settingsFrozen !== "object" ||
		Array.isArray(settingsFrozen)
	) {
		return null;
	}
	const { layer, ignoreGlobs } = settingsFrozen as Record<string, unknown>;
	if (
		layer !== "fabricignore" &&
		layer !== "project" &&
		layer !== "default"
	) {
		return null;
	}
	if (
		!Array.isArray(ignoreGlobs) ||
		ignoreGlobs.some((glob) => typeof glob !== "string")
	) {
		return null;
	}
	return { globs: ignoreGlobs as string[], layer };
}

/**
 * The oRPC code and message for each refusal the database query can return.
 *
 * `base_not_found` is a 404 rather than a 403: a caller probing snapshot ids
 * across tenants learns only that there is nothing there.
 */
function refusal(
	reason: DerivedInstructionRefusal,
	detail: string | undefined,
): ORPCError<string, unknown> {
	switch (reason) {
		case "base_not_found":
			return new ORPCError("NOT_FOUND", {
				message: "That version is not available to edit",
			});
		case "base_not_ready":
			return new ORPCError("CONFLICT", {
				message:
					"That version has not finished its checks, so it cannot be edited yet",
			});
		case "base_key_unexpected":
			// Never reachable from a well-formed READY snapshot: promotion
			// rewrites every row into the snapshot's own prefix. Surfaced
			// rather than swallowed, because it means a file row points at
			// storage no activity in this feature ever wrote it to.
			return new ORPCError("CONFLICT", {
				message:
					"That version's stored files are not in a state this edit can build on",
			});
		case "delete_path_missing":
			return new ORPCError("CONFLICT", {
				message: `That file is not in this version any more: ${detail}`,
			});
		case "path_collision":
			return new ORPCError("BAD_REQUEST", {
				message: `Two files would have the same name: ${detail}`,
			});
		case "empty_result":
			return new ORPCError("BAD_REQUEST", {
				message: "That would leave no files at all",
			});
		case "too_many_files":
			return new ORPCError("BAD_REQUEST", {
				message: `Too many files (${detail} > ${SNAPSHOT_LIMITS.maxFiles})`,
			});
		case "too_large":
			return new ORPCError("BAD_REQUEST", {
				message: `Too large (${detail} bytes > ${SNAPSHOT_LIMITS.maxTotalBytes})`,
			});
		case "proposal_proposer_limit":
			return new ORPCError("CONFLICT", {
				message:
					"You already have five active coding-instructions proposals for this project. Cancel one or wait for a decision before submitting another.",
				data: { reason: "PROPOSAL_PROPOSER_LIMIT" },
			});
		case "proposal_project_limit":
			return new ORPCError("CONFLICT", {
				message:
					"This project already has 25 active coding-instructions proposals. Try again after one is decided or canceled.",
				data: { reason: "PROPOSAL_PROJECT_LIMIT" },
			});
	}
}

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
 *  - Payload-shaped ones are HERE, because they need `@repo/instructions` and
 *    none of them needs the base's rows: an invalid relative path, a path the
 *    base's FROZEN ignore rules exclude, a secret-shaped filename, a file over
 *    the per-file cap, a change touching `.fabricignore`, a path named twice.
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
		const frozen = readFrozenIgnoreGlobs(base.settingsFrozen);
		const isIgnored = frozen ? buildIgnoreMatcher(frozen) : null;

		const seen = new Set<string>();
		const changes: Parameters<
			typeof createDerivedInstructionSnapshot
		>[0]["changes"] = [];
		let putCount = 0;
		let deleteCount = 0;
		for (const change of input.changes) {
			const v = validateRelativePath(change.path);
			if (!v.ok) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Path rejected (${v.reason}): ${change.path}`,
				});
			}
			const lower = v.path.toLowerCase();
			if (seen.has(lower)) {
				throw new ORPCError("BAD_REQUEST", {
					message: `The same file is changed twice: ${v.path}`,
				});
			}
			seen.add(lower);
			if (v.path === FABRIC_IGNORE_FILE) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The .fabricignore file decides what this version excludes, so it can only be changed by uploading the folder again.",
				});
			}
			if (change.op === "delete") {
				deleteCount++;
				changes.push({ op: "delete", path: v.path });
				continue;
			}
			const secretRule = isSecretFileName(v.path);
			if (secretRule) {
				// The gate would reject this after the upload and throw the
				// whole version away. Refusing on the name alone costs the
				// user nothing and stores nothing.
				throw new ORPCError("BAD_REQUEST", {
					message: `Fabric never stores credential files: ${v.path}`,
				});
			}
			const excluded = isIgnored?.(v.path);
			if (excluded) {
				throw new ORPCError("BAD_REQUEST", {
					message: `This version's rules leave that path out (${excluded.rule}): ${v.path}`,
				});
			}
			if (change.size > SNAPSHOT_LIMITS.maxFileBytes) {
				throw new ORPCError("BAD_REQUEST", {
					message: `File too large (${change.size} bytes): ${v.path}`,
				});
			}
			changes.push({
				op: "put",
				path: v.path,
				size: change.size,
				sha256: change.sha256,
				...fileTypingFor(v.path),
				kind: classifyPath(v.path),
				// Provisional, like `begin`: the real key needs the snapshot
				// and file ids, which do not exist yet. `createUploadUrls`
				// rewrites it under a compare-and-set before it signs.
				storageKey: stagingKey(
					input.projectId,
					"pending",
					String(putCount),
				),
			});
			putCount++;
		}

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
			throw refusal(created.reason, created.detail);
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
