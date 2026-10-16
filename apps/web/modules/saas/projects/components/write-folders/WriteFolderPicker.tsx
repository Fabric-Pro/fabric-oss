"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import type { ContextSyncConfiguration } from "../../lib/context-repository-sync";
import {
	type WriteFolderProblem,
	writeFolderProblem,
} from "../../lib/context-write-targets";
import type { ContextRepositoryTreeEntry } from "../repository-sync/lib/context-selection";
import {
	ancestorsOf,
	type RepositoryTreeEntry,
} from "../repository-sync/lib/repository-tree";
import {
	type SelectionRow,
	selectionTreeListingOf,
} from "../repository-sync/lib/selection-row";
import { RepositorySyncSelectionTree } from "../repository-sync/RepositorySyncSelectionTree";

const TREE_NAMESPACE = "projects.contexts.livingMemory.repositorySync";
const NAMESPACE = "projects.contexts.livingMemory.writeFolders";
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/** The listing notes that point at this picker's typed input: it takes one folder. */
const NOTE_KEYS = {
	unsupported: "tree.writeFolder.unsupported",
	truncated: "tree.writeFolder.truncated",
};

/**
 * The folders of the listing a write folder can be chosen from: only folders,
 * and only those in the sync's selection or on the way to it, so the tree
 * does not offer the rest of the repository. A listing names files, so the
 * folders above them are implied here.
 */
function selectableFolders(
	entries: readonly RepositoryTreeEntry[],
	paths: readonly string[],
): RepositoryTreeEntry[] {
	const folders = new Set<string>();
	for (const entry of entries) {
		for (const ancestor of ancestorsOf(entry.path)) {
			folders.add(ancestor);
		}
		if (entry.type === "dir") {
			folders.add(entry.path);
		}
	}
	return [...folders]
		.filter((folder) =>
			paths.some(
				(path) =>
					path === "" ||
					folder === path ||
					folder.startsWith(`${path}/`) ||
					path.startsWith(`${folder}/`),
			),
		)
		.sort()
		.map((path) => ({ path, type: "dir" as const }));
}

/**
 * Chooses one folder for a write folder, inside what the sync selects: the
 * shared selection tree over the sync's branch (a tick picks the folder, and
 * ticking it again clears the choice), or a typed path where the tree cannot
 * reach. A typed path goes through `writeFolderProblem`, the check the tree's
 * rows use, so typing can never choose what the tree would refuse; the server
 * still decides.
 */
export function WriteFolderPicker({
	projectId,
	sync,
	value,
	onChange,
	siblings,
	disabled,
}: {
	projectId: string;
	sync: ContextSyncConfiguration;
	/** The chosen folder, or `""` for none. */
	value: string;
	onChange: (folder: string) => void;
	/** Every other write folder. */
	siblings: readonly string[];
	disabled: boolean;
}) {
	const t = useTranslations(NAMESPACE);
	const id = useId();
	const [typed, setTyped] = useState("");
	const [typedProblem, setTypedProblem] = useState<WriteFolderProblem | null>(
		null,
	);
	// The way to the folder chosen when the picker opened.
	const [openAtStart] = useState<ReadonlySet<string>>(
		() => new Set(value === "" ? [] : ancestorsOf(value)),
	);
	const selection = useMemo(
		() => ({ paths: sync.paths, excludedPaths: sync.excludedPaths }),
		[sync.paths, sync.excludedPaths],
	);

	const treeQuery = useQuery(
		orpc.projects.contexts.repositorySync.listTree.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId: sync.repositoryIntegrationId,
				ref: sync.ref,
			},
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const listing = selectionTreeListingOf<ContextRepositoryTreeEntry>({
		requested: true,
		enabled: true,
		query: treeQuery,
		errorMessage: () => ({ key: "tree.writeFolder.error" }),
	});
	const folders = useMemo(
		() =>
			listing.status === "ready"
				? selectableFolders(listing.entries, sync.paths)
				: [],
		[listing, sync.paths],
	);
	const treeListing =
		listing.status === "ready" ? { ...listing, entries: folders } : listing;

	function row(node: { path: string }): SelectionRow {
		if (node.path === value) {
			return { membership: "in", disabledReason: null };
		}
		const problem = writeFolderProblem(node.path, selection, siblings);
		return {
			membership: "out",
			disabledReason: problem
				? { key: `tree.writeFolder.${problem}` }
				: null,
		};
	}

	function chooseTyped() {
		const raw = typed;
		const problem =
			raw.trim() === ""
				? "INVALID_PATH"
				: writeFolderProblem(raw, selection, siblings);
		setTypedProblem(problem);
		if (problem === null) {
			onChange(raw);
			setTyped("");
		}
	}

	const typedId = `${id}-typed`;
	const typedErrorId = `${id}-typed-error`;
	const typedHintId = `${id}-typed-hint`;
	return (
		<div className="flex flex-col gap-3">
			<RepositorySyncSelectionTree
				namespace={TREE_NAMESPACE}
				listing={treeListing}
				row={row}
				onToggle={(node, next) => onChange(next ? node.path : "")}
				disabled={disabled}
				summary={null}
				initiallyOpen={openAtStart}
				noteKeys={NOTE_KEYS}
			/>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={typedId}>{t("picker.typedLabel")}</Label>
				<div className="flex gap-2">
					<Input
						id={typedId}
						value={typed}
						placeholder={t("picker.typedPlaceholder")}
						disabled={disabled}
						onChange={(e) => {
							setTyped(e.target.value);
							setTypedProblem(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								chooseTyped();
							}
						}}
						aria-invalid={typedProblem ? true : undefined}
						aria-describedby={
							typedProblem ? typedErrorId : typedHintId
						}
					/>
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						onClick={chooseTyped}
					>
						{t("picker.typedUse")}
					</Button>
				</div>
				{typedProblem ? (
					<p
						id={typedErrorId}
						role="alert"
						className="text-destructive text-xs"
					>
						{t(`errors.${typedProblem}`, {
							path: typed,
							withPath: "",
							max: 0,
						})}
					</p>
				) : (
					<p
						id={typedHintId}
						className="text-muted-foreground text-xs"
					>
						{t("picker.typedHint")}
					</p>
				)}
			</div>
			<p className="text-sm" data-testid="write-folder-chosen">
				<span className="text-muted-foreground">
					{t("picker.chosen")}{" "}
				</span>
				{value === "" ? (
					<span className="text-muted-foreground">
						{t("picker.none")}
					</span>
				) : (
					<code className="font-mono text-xs">{value}</code>
				)}
			</p>
		</div>
	);
}
