import { ORPCError } from "@orpc/client";
import { FABRIC_IGNORE_FILE, SNAPSHOT_LIMITS } from "@repo/instructions";
import type { AuditRequestContext } from "../../../../../lib/audit";
import { assertInstructionDeriveAccess } from "../proposal-authorization";
import { assertRepositoryWritable } from "../read-only-guard";
import { submitInstructionChange } from "../submit-change";
import { withDirectRead } from "./direct-query";
import {
	type DirectRepositoryFileVersion,
	readDirectRepositoryFileVersion,
} from "./direct-read";
import {
	assertDirectRepositoryPin,
	resolveDirectRepositoryHead,
} from "./direct-source";
import { assertInstructionRepositoryFileVisible } from "./file-path";

type FileRestoreInput = {
	projectId: string;
	userId: string;
	generation: number;
	targetCommitSha: string;
	path: string;
	currentCommitSha?: string;
	signal?: AbortSignal;
};

function stalePreview(): never {
	throw new ORPCError("CONFLICT", {
		message:
			"The repository changed. Refresh the file comparison before restoring.",
		data: { code: "FILE_RESTORE_PREVIEW_STALE" },
	});
}

function restoreDecision(
	path: string,
	current: DirectRepositoryFileVersion,
	selected: DirectRepositoryFileVersion,
) {
	if (path === FABRIC_IGNORE_FILE) {
		return { available: false as const, reason: "ignoreFile" as const };
	}
	if (current.state === "unavailable" || selected.state === "unavailable") {
		return { available: false as const, reason: "incomplete" as const };
	}
	if (current.state === "nonRegular" || selected.state === "nonRegular") {
		return { available: false as const, reason: "nonRegular" as const };
	}
	if (current.state === "binary" || selected.state === "binary") {
		return { available: false as const, reason: "binary" as const };
	}
	if (current.state === "tooLarge" || selected.state === "tooLarge") {
		return { available: false as const, reason: "tooLarge" as const };
	}
	if (
		(current.state === "absent" && selected.state === "absent") ||
		(current.state === "found" &&
			selected.state === "found" &&
			current.text === selected.text)
	) {
		return { available: false as const, reason: "unchanged" as const };
	}
	return {
		available: true as const,
		operation:
			selected.state === "absent"
				? ("delete" as const)
				: ("put" as const),
	};
}

/** Reads Git on demand; no historical file bytes or commit list are persisted. */
export async function previewInstructionFileRestore(input: FileRestoreInput) {
	const { pin, value } = await withDirectRead(
		{
			projectId: input.projectId,
			userId: input.userId,
			signal: input.signal,
		},
		async ({ source, pin }) => {
			if (pin.generation !== input.generation) {
				throw new ORPCError("CONFLICT", {
					message:
						"The repository configuration changed. Refresh and try again.",
					data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
				});
			}
			if (
				input.currentCommitSha !== undefined &&
				input.currentCommitSha !== pin.commitSha
			) {
				stalePreview();
			}
			await assertInstructionRepositoryFileVisible({
				source,
				pin,
				path: input.path,
			});
			const target = {
				generation: pin.generation,
				commitSha: input.targetCommitSha,
			};
			await assertDirectRepositoryPin(source, target);
			const current = await readDirectRepositoryFileVersion({
				source,
				pin,
				path: input.path,
			});
			const selected =
				input.targetCommitSha === pin.commitSha
					? current
					: await readDirectRepositoryFileVersion({
							source,
							pin: target,
							path: input.path,
						});
			const afterRead = await resolveDirectRepositoryHead(source);
			if (
				afterRead.commitSha !== pin.commitSha ||
				afterRead.generation !== pin.generation
			) {
				stalePreview();
			}
			return {
				path: input.path,
				targetCommitSha: input.targetCommitSha,
				current,
				selected,
				restore: restoreDecision(input.path, current, selected),
				maxTextBytes: SNAPSHOT_LIMITS.maxInlineTextBytes,
			};
		},
		{ verifyBeforeRead: true },
	);
	return { ...value, nativeBase: pin };
}

export async function restoreInstructionFile(
	input: FileRestoreInput & {
		currentCommitSha: string;
		audit: AuditRequestContext;
	},
) {
	await assertInstructionDeriveAccess({
		projectId: input.projectId,
		userId: input.userId,
		proposal: false,
	});
	await assertRepositoryWritable(input.projectId);
	const preview = await previewInstructionFileRestore(input);
	if (!preview.restore.available) {
		if (preview.restore.reason === "unchanged") {
			return {
				kind: "unchanged" as const,
				nativeBase: preview.nativeBase,
			};
		}
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This file version cannot be restored through the inline editor.",
			data: {
				code: "FILE_RESTORE_UNSUPPORTED",
				reason: preview.restore.reason,
			},
		});
	}
	// The immutable selected bytes, never client content, form the sole changed path.
	const selected = preview.selected;
	if (selected.state !== "found" && selected.state !== "absent") {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: "The selected file version is unavailable.",
		});
	}
	input.signal?.throwIfAborted();
	await assertRepositoryWritable(input.projectId);
	const result = await submitInstructionChange({
		projectId: input.projectId,
		userId: input.userId,
		nativeBase: preview.nativeBase,
		changes: [
			selected.state === "found"
				? {
						op: "put",
						path: input.path,
						content: selected.text,
						encoding: "utf8",
					}
				: { op: "delete", path: input.path },
		],
		mode: "commit",
		message: `Restore ${input.path} from ${input.targetCommitSha}`,
		audit: input.audit,
		via: "orpc-file-restore",
	});
	return {
		kind: "native" as const,
		operationId: result.snapshotId,
		nativeBase: result.nativeBase,
		putCount: result.putCount,
		deleteCount: result.deleteCount,
		status: result.status,
	};
}
