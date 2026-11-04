"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type ContextFolderPolicy,
	type ContextRepositoryTreeEntry,
	contextIgnorePathOf,
} from "./lib/context-selection";
import type { RepositoryTreeIndex } from "./lib/repository-tree";

const READ_STALE_MS = 5 * 60 * 1000;

/** One folder's answer from `readIgnoreFiles`. */
type ContextIgnoreFileAnswer =
	| { state: "absent" }
	| { state: "rules"; text: string }
	| { state: "tooLarge" }
	| { state: "encoding" }
	| { state: "ruleRejected"; line: number };

/** What the hook keeps of one folder's read. */
type ReadState = {
	data?: {
		files: readonly ({ folder: string } & ContextIgnoreFileAnswer)[];
	};
	isError: boolean;
};

/** What the run makes of a folder's `.contextignore`, as the server read it. */
export function contextFolderPolicyOf(
	answer: ContextIgnoreFileAnswer,
): ContextFolderPolicy {
	switch (answer.state) {
		case "absent":
			return { kind: "defaults" };
		case "rules":
			return { kind: "rules", text: answer.text };
		case "tooLarge":
			return { kind: "unreadable", reason: "tooLarge" };
		case "encoding":
			return { kind: "unreadable", reason: "encoding" };
		case "ruleRejected":
			return { kind: "rejected", line: answer.line };
		default: {
			const unreachable: never = answer;
			return unreachable;
		}
	}
}

/**
 * Which ticked folders' `.contextignore` must be read, and what the listing
 * already says of the others, as the run would read them: only a ticked
 * folder's own `F/.contextignore` counts. A regular file listed there is
 * read; a folder or a symbolic link there is a policy the run cannot
 * evaluate; nothing listed there is no policy — unless the listing is
 * truncated and may have stopped before it, when it is read too (an absent
 * file is simply the defaults). A ticked file, or a ticked path a complete
 * listing does not hold, has no policy to read.
 */
export function contextIgnoreReads(input: {
	tree: RepositoryTreeIndex<ContextRepositoryTreeEntry>;
	truncated: boolean;
	paths: readonly string[];
}): { read: string[]; known: Map<string, ContextFolderPolicy> } {
	const read: string[] = [];
	const known = new Map<string, ContextFolderPolicy>();
	for (const path of input.paths) {
		const node = path === "" ? null : input.tree.nodes.get(path);
		if (
			node?.type === "file" ||
			(path !== "" && !node && !input.truncated)
		) {
			continue;
		}
		const policy = input.tree.nodes.get(contextIgnorePathOf(path));
		if (policy && (policy.type === "dir" || policy.regular === false)) {
			known.set(path, { kind: "unreadable", reason: "notRegular" });
		} else if (policy || input.truncated) {
			read.push(path);
		}
	}
	return { read: read.sort(), known };
}

/**
 * Each ticked folder's `.contextignore` policy for the configure dialog's
 * tree (`contextSelectionModel`'s `policies`), read only alongside a
 * listing (`tree`). One read per folder, cached per branch, so ticking
 * another folder reads only that folder's file, and unticking and ticking
 * one again reads nothing.
 */
export function useContextIgnorePolicies(input: {
	projectId: string;
	repositoryIntegrationId: string;
	/** The settled branch the listing is of. */
	ref: string;
	tree: RepositoryTreeIndex<ContextRepositoryTreeEntry> | null;
	truncated: boolean;
	paths: readonly string[];
}): ReadonlyMap<string, ContextFolderPolicy> {
	const { tree, truncated, paths } = input;
	const plan = useMemo(
		() =>
			tree
				? contextIgnoreReads({ tree, truncated, paths })
				: { read: [], known: new Map<string, ContextFolderPolicy>() },
		[tree, truncated, paths],
	);
	// Stable, so the combined reads keep their identity until one changes,
	// and the model built on them is not rebuilt on every render.
	const combine = useCallback(
		(results: readonly ReadState[]) =>
			results.map(({ data, isError }) => ({ data, isError })),
		[],
	);
	const reads = useQueries({
		queries: plan.read.map((folder) =>
			orpc.projects.contexts.repositorySync.readIgnoreFiles.queryOptions({
				input: {
					projectId: input.projectId,
					repositoryIntegrationId: input.repositoryIntegrationId,
					ref: input.ref,
					folders: [folder],
				},
				staleTime: READ_STALE_MS,
				retry: false,
			}),
		),
		combine,
	});
	return useMemo(() => {
		const policies = new Map(plan.known);
		plan.read.forEach((folder, index) => {
			const read = reads[index];
			const answer = read?.data?.files.find(
				(file) => file.folder === folder,
			);
			policies.set(
				folder,
				read?.isError
					? { kind: "failed" }
					: answer
						? contextFolderPolicyOf(answer)
						: read?.data
							? { kind: "defaults" }
							: { kind: "loading" },
			);
		});
		return policies;
	}, [plan, reads]);
}
