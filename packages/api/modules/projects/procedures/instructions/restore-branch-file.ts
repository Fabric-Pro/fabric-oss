/**
 * "Restore published version" for one file on the caller's own proposal
 * branch. It is an ordinary native proposal: the published bytes put back,
 * or a delete when the published version has no such file. That delete is
 * branch-relative (`submitGitIntentChange` admits it only for a file Fabric
 * wrote on the caller's accepting branch), and the append applies it under
 * the same per-file rule and foreign-commit fence as every other change.
 *
 * The procedure (`proposals.restoreMyBranchFile`) is authorized as
 * `submitGitChange`; the proposal admission makes the live proposer check.
 * The bytes are read server-side at the published pin, never taken from the
 * client.
 */
import { ORPCError } from "@orpc/client";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import type { AuditRequestContext } from "../../../../lib/audit";
import { noteWithCommitMessage } from "./proposal-message-note";
import {
	assertDirectRepositoryPin,
	directRepositoryPath,
	directRepositoryReadError,
	loadDirectRepositorySource,
	readDirectRepositoryFileAtCommit,
} from "./repository/direct-source";
import { type NativeChange, submitGitIntentChange } from "./submit-git-intent";

type RestoreBranchFileInput = {
	projectId: string;
	organizationId: string;
	userId: string;
	nativeBase: { generation: number; commitSha: string };
	path: string;
	audit: AuditRequestContext;
};

/** The one change that puts `path` back to what the published pin holds. */
async function publishedChangeOf(
	input: Pick<
		RestoreBranchFileInput,
		"projectId" | "userId" | "nativeBase" | "path"
	>,
): Promise<NativeChange> {
	const source = await loadDirectRepositorySource({
		projectId: input.projectId,
		userId: input.userId,
	});
	await assertDirectRepositoryPin(source, input.nativeBase);
	const read = await readDirectRepositoryFileAtCommit(
		source,
		input.nativeBase,
		directRepositoryPath(source, input.path),
		SNAPSHOT_LIMITS.maxFileBytes,
	);
	if (!read.ok) {
		throw directRepositoryReadError(
			source,
			read.outcome === "unsupported" ? "unreachable" : read.outcome,
		);
	}
	switch (read.state) {
		case "absent":
			return { op: "delete", path: input.path };
		case "found":
			return {
				op: "put",
				path: input.path,
				content: Buffer.from(read.bytes),
			};
		case "tooLarge":
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"The published version of this file is too large to restore here.",
				data: { reason: "FILE_RESTORE_UNSUPPORTED" },
			});
		default: {
			const unexpected: never = read;
			throw new Error(
				`Unexpected file read: ${JSON.stringify(unexpected)}`,
			);
		}
	}
}

export async function restoreMyBranchFile(input: RestoreBranchFileInput) {
	const change = await publishedChangeOf(input);
	const result = await submitGitIntentChange({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		nativeBase: input.nativeBase,
		mode: "proposal",
		changes: [change],
		note: noteWithCommitMessage(
			undefined,
			`Restore ${input.path} to the published version`,
		),
		audit: input.audit,
		via: "orpc-branch-restore",
	});
	return {
		kind: "native" as const,
		operationId: result.snapshotId,
		nativeBase: result.nativeBase,
		operation: change.op,
		status: result.status,
	};
}
