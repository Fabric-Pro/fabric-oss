import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { readRepositoryFileAtCommit } from "@repo/connectors";
import { findMemberBranchWrite, loadGitIntent } from "@repo/database";
import {
	BRANCH_DELETED_OBJECT_ID,
	fileTypingFor,
	instructionTextPage,
	SNAPSHOT_LIMITS,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { findBranchWrittenFile } from "./branch-written-file";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	directRepositoryPath,
	loadDirectRepositorySource,
} from "./repository/direct-source";

type Scope = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
};
type Side = {
	text: string | null;
	size: number | null;
	omitted:
		| "BINARY"
		| "FILE_TOO_LARGE"
		| "RESPONSE_LIMIT"
		| "SOURCE_CHANGED"
		| null;
};

function unavailable(): never {
	throw new ORPCError("NOT_FOUND", {
		message: "Proposal file not available",
	});
}

/** Stored bytes, checked against the size and hash recorded with them. */
async function readStored(
	stored: {
		storageKey: string;
		sha256: string;
		size: number;
		isText: boolean | null;
	},
	maxBytes: number,
): Promise<Side> {
	if (!stored.isText)
		return { text: null, size: stored.size, omitted: "BINARY" };
	if (stored.size > maxBytes)
		return { text: null, size: stored.size, omitted: "FILE_TOO_LARGE" };
	const object = await getStorageProvider().downloadFile(stored.storageKey, {
		bucket: config.storage.bucketNames.skills,
	});
	if (
		object.data.byteLength !== stored.size ||
		createHash("sha256").update(object.data).digest("hex") !== stored.sha256
	)
		return unavailable();
	return decodeSide(object.data);
}

function decodeSide(bytes: Uint8Array): Side {
	try {
		if (bytes.includes(0))
			return {
				text: null,
				size: bytes.byteLength,
				omitted: "BINARY",
			};
		return {
			text: new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes),
			size: bytes.byteLength,
			omitted: null,
		};
	} catch {
		return { text: null, size: bytes.byteLength, omitted: "BINARY" };
	}
}

async function openContent(scope: Scope) {
	const intent = await loadGitIntent(scope);
	if (
		!intent ||
		intent.status !== "READY" ||
		intent.repositoryGeneration === null ||
		intent.sourceCommitSha === null
	)
		return unavailable();
	const source = await loadDirectRepositorySource(scope);
	const pin = {
		generation: intent.repositoryGeneration,
		commitSha: intent.sourceCommitSha,
	};
	// A proposal is frozen against the repository configuration it was made
	// under. Once that changes, its base can no longer be read from the
	// repository, but its own changed bytes are stored and stay viewable.
	const baseReadable =
		source.generation === intent.repositoryGeneration &&
		source.integrationId === intent.repositoryIntegrationId &&
		source.ref === intent.sourceRef;
	if (baseReadable) await assertDirectRepositoryPin(source, pin);
	/**
	 * The "before" side of a branch-relative entry: the file Fabric wrote on
	 * the proposer's branch as the blob the entry froze, from Fabric's own
	 * stored copy. The repository's branch tip is not read, because the
	 * proposal itself may have been appended over that blob since.
	 */
	const readBranchBefore = async (
		path: string,
		branchObjectId: string,
		maxBytes: number,
	): Promise<Side> => {
		const write = await findMemberBranchWrite({
			projectId: scope.projectId,
			userId: intent.userId,
			organizationId: scope.organizationId,
			path,
			objectId: branchObjectId,
		});
		const file = write
			? await findBranchWrittenFile({
					...write,
					projectId: scope.projectId,
					organizationId: scope.organizationId,
					path,
				})
			: null;
		if (!file) return { text: null, size: null, omitted: "SOURCE_CHANGED" };
		if (maxBytes <= 0)
			return { text: null, size: file.size, omitted: "RESPONSE_LIMIT" };
		return readStored(file, maxBytes);
	};
	const readSide = async (
		path: string,
		side: "before" | "after",
		maxBytes: number,
	): Promise<Side> => {
		const entry = intent.gitIntentEntries.find(
			(entry) => entry.path === path,
		);
		if (!entry) return unavailable();
		if (side === "before") {
			if (entry.branchObjectId === BRANCH_DELETED_OBJECT_ID)
				return { text: null, size: null, omitted: null };
			if (entry.branchObjectId) {
				const onBranch = await readBranchBefore(
					path,
					entry.branchObjectId,
					maxBytes,
				);
				// A published file still has its published base to compare with
				// once the branch's bytes are gone.
				if (
					entry.baseObjectId === null ||
					onBranch.omitted !== "SOURCE_CHANGED"
				)
					return onBranch;
			} else if (entry.baseObjectId === null) {
				return { text: null, size: null, omitted: null };
			}
		}
		if (side === "after" && entry.operation === "DELETE")
			return { text: null, size: null, omitted: null };
		if (side === "before" && !baseReadable)
			return { text: null, size: null, omitted: "SOURCE_CHANGED" };
		if (maxBytes <= 0)
			return {
				text: null,
				size: side === "after" ? entry.size : null,
				omitted: "RESPONSE_LIMIT",
			};
		if (side === "after") {
			if (
				entry.storageKey === null ||
				entry.sha256 === null ||
				entry.size === null
			)
				return unavailable();
			return readStored(
				{
					storageKey: entry.storageKey,
					sha256: entry.sha256,
					size: entry.size,
					isText: entry.isText,
				},
				maxBytes,
			);
		}
		const result = await readRepositoryFileAtCommit({
			...source.repository,
			sha: pin.commitSha,
			path: directRepositoryPath(source, path),
			maxBytes,
		});
		if (!result.ok || result.state === "absent") return unavailable();
		if (result.state === "tooLarge")
			return { text: null, size: null, omitted: "FILE_TOO_LARGE" };
		return decodeSide(result.bytes);
	};
	return {
		intent,
		readSide,
		check: async () => {
			if (baseReadable)
				await assertDirectRepositorySourceCurrent({ ...scope, source });
		},
	};
}

export async function buildNativeProposalChanges(scope: Scope) {
	const content = await openContent(scope);
	let remaining = SNAPSHOT_LIMITS.maxInlineTextBytes;
	const changes = [];
	for (const entry of content.intent.gitIntentEntries) {
		const before = await content.readSide(entry.path, "before", remaining);
		remaining -= before.text === null ? 0 : (before.size ?? 0);
		const after = await content.readSide(entry.path, "after", remaining);
		remaining -= after.text === null ? 0 : (after.size ?? 0);
		const binary =
			before.omitted === "BINARY" || after.omitted === "BINARY";
		// A branch-relative entry changes a file the proposer's branch holds:
		// an edit or delete of that file, never an added one, unless the branch
		// deleted the file and this puts it back.
		const hadFile =
			entry.branchObjectId !== BRANCH_DELETED_OBJECT_ID &&
			(entry.baseObjectId !== null || entry.branchObjectId !== null);
		changes.push({
			path: entry.path,
			op:
				entry.operation === "DELETE"
					? ("delete" as const)
					: hadFile
						? ("edit" as const)
						: ("add" as const),
			before: binary ? null : before.text,
			after: binary ? null : after.text,
			beforeSize: before.size,
			afterSize: after.size,
			beforeOmitted:
				binary && hadFile ? ("BINARY" as const) : before.omitted,
			afterOmitted:
				binary && entry.operation === "PUT"
					? ("BINARY" as const)
					: after.omitted,
			binary,
			// The proposer's branch deleted a published file and this puts the
			// published bytes back. The change is stated against the branch, so
			// it reads as an addition; the reviewer is told what it really is.
			restoresBranchDeletion:
				entry.operation === "PUT" &&
				entry.branchObjectId === BRANCH_DELETED_OBJECT_ID &&
				entry.baseObjectId !== null,
		});
	}
	await content.check();
	return changes;
}

export async function readNativeProposalFile(
	scope: Scope & {
		path: string;
		side: "before" | "after";
		offset: number;
		maxLength: number;
	},
) {
	const content = await openContent(scope);
	const side = await content.readSide(
		scope.path,
		scope.side,
		SNAPSHOT_LIMITS.maxFileBytes,
	);
	if (side.text === null) return unavailable();
	await content.check();
	return {
		path: scope.path,
		side: scope.side,
		...instructionTextPage(side.text, scope.offset, scope.maxLength),
		size: side.size ?? 0,
		mimeType: fileTypingFor(scope.path).mimeType,
	};
}
