import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { readRepositoryFileAtCommit } from "@repo/connectors";
import { loadGitIntent } from "@repo/database";
import {
	fileTypingFor,
	instructionTextPage,
	SNAPSHOT_LIMITS,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
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
	omitted: "BINARY" | "FILE_TOO_LARGE" | "RESPONSE_LIMIT" | null;
};

function unavailable(): never {
	throw new ORPCError("NOT_FOUND", {
		message: "Proposal file not available",
	});
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
	if (
		source.integrationId !== intent.repositoryIntegrationId ||
		source.ref !== intent.sourceRef
	)
		return unavailable();
	await assertDirectRepositoryPin(source, pin);
	const readSide = async (
		path: string,
		side: "before" | "after",
		maxBytes: number,
	): Promise<Side> => {
		const entry = intent.gitIntentEntries.find(
			(entry) => entry.path === path,
		);
		if (!entry) return unavailable();
		if (
			(side === "before" && entry.baseObjectId === null) ||
			(side === "after" && entry.operation === "DELETE")
		)
			return { text: null, size: null, omitted: null };
		if (maxBytes <= 0)
			return {
				text: null,
				size: side === "after" ? entry.size : null,
				omitted: "RESPONSE_LIMIT",
			};
		let bytes: Uint8Array;
		if (side === "after") {
			if (
				entry.storageKey === null ||
				entry.sha256 === null ||
				entry.size === null
			)
				return unavailable();
			if (!entry.isText)
				return { text: null, size: entry.size, omitted: "BINARY" };
			if (entry.size > maxBytes)
				return {
					text: null,
					size: entry.size,
					omitted: "FILE_TOO_LARGE",
				};
			const object = await getStorageProvider().downloadFile(
				entry.storageKey,
				{ bucket: config.storage.bucketNames.skills },
			);
			if (
				object.data.byteLength !== entry.size ||
				createHash("sha256").update(object.data).digest("hex") !==
					entry.sha256
			)
				return unavailable();
			bytes = object.data;
		} else {
			const result = await readRepositoryFileAtCommit({
				...source.repository,
				sha: pin.commitSha,
				path: directRepositoryPath(source, path),
				maxBytes,
			});
			if (!result.ok || result.state === "absent") return unavailable();
			if (result.state === "tooLarge")
				return { text: null, size: null, omitted: "FILE_TOO_LARGE" };
			bytes = result.bytes;
		}
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
	};
	return {
		intent,
		readSide,
		check: () => assertDirectRepositorySourceCurrent({ ...scope, source }),
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
		changes.push({
			path: entry.path,
			op:
				entry.operation === "DELETE"
					? ("delete" as const)
					: entry.baseObjectId === null
						? ("add" as const)
						: ("edit" as const),
			before: binary ? null : before.text,
			after: binary ? null : after.text,
			beforeSize: before.size,
			afterSize: after.size,
			beforeOmitted:
				binary && entry.baseObjectId !== null
					? ("BINARY" as const)
					: before.omitted,
			afterOmitted:
				binary && entry.operation === "PUT"
					? ("BINARY" as const)
					: after.omitted,
			binary,
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
