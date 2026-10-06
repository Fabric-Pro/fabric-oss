/**
 * Conditional bulk writes for repository instruction acquisition and
 * finalization. Both statements bind every row to its snapshot, project and
 * organization. Callers require the complete count before they advance;
 * a partial match is retryable progress, never an accepted publication.
 */
import { db } from "../client";
import type { InstructionFileKind } from "./instructions";

export const INSTRUCTION_FILE_BATCH_MAX_ROWS = 500;

type FileKeyClaim = {
	fileId: string;
	from: string;
	to: string;
};

function assertDistinctFileIds(items: readonly { fileId: string }[]): void {
	const ids = new Set<string>();
	for (const item of items) {
		if (ids.has(item.fileId)) {
			throw new Error(
				"An instruction file batch cannot contain a file twice.",
			);
		}
		ids.add(item.fileId);
	}
}

/**
 * Claims a bounded acquisition chunk before its first object upload. A row
 * must still be in RECEIVING and hold either the key this attempt observed or
 * its own deterministic staging key, making a retry idempotent without ever
 * moving a promoted row back to writable staging.
 */
export async function claimInstructionFileStagingKeys(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	claims: readonly FileKeyClaim[];
}): Promise<{ moved: number }> {
	if (input.claims.length === 0) {
		return { moved: 0 };
	}
	if (input.claims.length > INSTRUCTION_FILE_BATCH_MAX_ROWS) {
		throw new Error("Instruction file claim batch exceeds its row limit.");
	}
	assertDistinctFileIds(input.claims);
	const ids = input.claims.map((claim) => claim.fileId);
	const from = input.claims.map((claim) => claim.from);
	const to = input.claims.map((claim) => claim.to);
	const moved = await db.$executeRaw`
		WITH parent AS MATERIALIZED (
			SELECT "id"
			FROM "project_instruction_snapshot"
			WHERE "id" = ${input.snapshotId}
				AND "projectId" = ${input.projectId}
				AND "organizationId" = ${input.organizationId}
				AND "status" = 'RECEIVING'
			FOR UPDATE
		)
		UPDATE "project_instruction_file" AS f
		SET "storageKey" = v."to"
		FROM unnest(${ids}::text[], ${from}::text[], ${to}::text[])
			AS v("id", "from", "to"),
			parent AS s
		WHERE f."id" = v."id"
			AND f."snapshotId" = ${input.snapshotId}
			AND f."projectId" = ${input.projectId}
			AND f."organizationId" = ${input.organizationId}
			AND (f."storageKey" = v."from" OR f."storageKey" = v."to")
			AND s."id" = f."snapshotId"
	`;
	return { moved };
}

export type VerifiedInstructionFileMetadata = {
	fileId: string;
	expectedStorageKey: string;
	storageKey: string;
	kind: InstructionFileKind;
	name: string | null;
	description: string | null;
	/** Undefined keeps the persisted mode; a verified shebang supplies 0755. */
	mode?: number;
};

/**
 * Persists verified metadata and the storage-key promotion for a repository
 * finalization chunk. The snapshot status and attempt token are part of the
 * same statement as every file row, so a superseded attempt cannot move more
 * metadata or keys. The caller requires the complete updated count before it
 * advances to cleanup or READY.
 */
export async function persistVerifiedInstructionFileMetadataBatch(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	/** Null is the legacy unowned row, never an arbitrary newer attempt. */
	validationAttemptId: string | null;
	/** The activity attempt's absolute database-clock fence, when known. */
	notAfter: Date | null;
	updates: readonly VerifiedInstructionFileMetadata[];
}): Promise<{ updated: number }> {
	if (input.updates.length === 0) {
		return { updated: 0 };
	}
	if (input.updates.length > INSTRUCTION_FILE_BATCH_MAX_ROWS) {
		throw new Error(
			"Instruction file metadata batch exceeds its row limit.",
		);
	}
	assertDistinctFileIds(input.updates);
	const ids = input.updates.map((update) => update.fileId);
	const expected = input.updates.map((update) => update.expectedStorageKey);
	const storageKeys = input.updates.map((update) => update.storageKey);
	const kinds = input.updates.map((update) => update.kind);
	const names = input.updates.map((update) => update.name);
	const descriptions = input.updates.map((update) => update.description);
	const modes = input.updates.map((update) => update.mode ?? 0);
	const writeModes = input.updates.map((update) => update.mode !== undefined);
	const updated = await db.$executeRaw`
		WITH parent AS MATERIALIZED (
			SELECT "id"
			FROM "project_instruction_snapshot"
			WHERE "id" = ${input.snapshotId}
				AND "projectId" = ${input.projectId}
				AND "organizationId" = ${input.organizationId}
				AND "status" IN ('RECEIVING', 'VALIDATING')
				AND "validationAttemptId" IS NOT DISTINCT FROM ${input.validationAttemptId}
			FOR UPDATE
		),
		live AS MATERIALIZED (
			SELECT "id"
			FROM parent
			WHERE ${input.notAfter}::timestamp IS NULL
				OR (clock_timestamp() AT TIME ZONE 'UTC') < ${input.notAfter}::timestamp
		)
		UPDATE "project_instruction_file" AS f
		SET
			"storageKey" = v."storageKey",
			"kind" = v."kind"::"ProjectInstructionFileKind",
			"name" = v."name",
			"description" = v."description",
			"mode" = CASE WHEN v."writeMode" THEN v."mode" ELSE f."mode" END
		FROM unnest(
			${ids}::text[],
			${expected}::text[],
			${storageKeys}::text[],
			${kinds}::text[],
			${names}::text[],
			${descriptions}::text[],
			${modes}::integer[],
			${writeModes}::boolean[]
		) AS v("id", "expectedStorageKey", "storageKey", "kind", "name", "description", "mode", "writeMode"),
			live AS s
		WHERE f."id" = v."id"
			AND f."snapshotId" = ${input.snapshotId}
			AND f."projectId" = ${input.projectId}
			AND f."organizationId" = ${input.organizationId}
			AND (f."storageKey" = v."expectedStorageKey" OR f."storageKey" = v."storageKey")
			AND s."id" = f."snapshotId"
	`;
	return { updated };
}
