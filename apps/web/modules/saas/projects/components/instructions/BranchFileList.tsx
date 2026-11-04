"use client";

import { instructionsFreshness } from "@saas/projects/lib/instructions-query-freshness";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
	BranchFileActionButton,
	useMyBranchFiles,
	useRestoreBranchFile,
} from "./BranchFileActions";
import { type BranchMarker, branchMarkerOf } from "./lib/branch-files";

const TAG: Record<BranchMarker, string> = {
	branchOnly: "branchOnlyTag",
	deletedOnBranch: "deletedOnBranchTag",
	changedOnBranch: "changedOnBranchTag",
};

/**
 * The files the caller's own accepting branch differs on from the published
 * version, each with its one action: Delete from my branch for a file only
 * the branch holds, Restore published version for one it changes or
 * deletes. Reads the same projection, repository state and published file
 * list the tab already holds, so it costs no request of its own there.
 */
export function BranchFileList({
	projectId,
	onChanged,
}: {
	projectId: string;
	onChanged?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.branchFiles");
	const tTree = useTranslations("projects.codingInstructions.tree");
	const { files } = useMyBranchFiles(projectId, true);
	const state = useQuery({
		...orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId },
		}),
		enabled: files.length > 0,
	});
	const pin =
		state.data?.availability === "READY"
			? {
					generation: state.data.generation,
					commitSha: state.data.currentCommitSha,
				}
			: null;
	const published = useQuery({
		...orpc.projects.instructions.repository.listFiles.queryOptions({
			input: {
				projectId,
				generation: pin?.generation ?? 1,
				commitSha: pin?.commitSha ?? "",
			},
		}),
		...instructionsFreshness.pinnedRead,
		enabled: pin !== null,
	});
	const restore = useRestoreBranchFile({
		projectId,
		nativeBase: pin,
		onChanged,
	});
	if (!published.data || published.data.incomplete) {
		return null;
	}
	const byPath = new Map(
		published.data.files.map((file) => [file.path, file]),
	);
	const rows = files.flatMap((entry) => {
		const marker = branchMarkerOf(byPath.get(entry.path), entry);
		return marker ? [{ path: entry.path, marker }] : [];
	});
	if (rows.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-1.5">
			<p className="font-medium text-muted-foreground text-xs">
				{t("listHeading")}
			</p>
			<ul className="flex flex-col gap-1">
				{rows.map(({ path, marker }) => (
					<li
						key={path}
						className="flex flex-wrap items-center justify-between gap-2"
					>
						<span className="flex min-w-0 items-center gap-2">
							<code className="truncate text-xs">{path}</code>
							<span className="shrink-0 text-[10.5px] text-muted-foreground">
								{tTree(TAG[marker])}
							</span>
						</span>
						<BranchFileActionButton
							path={path}
							marker={marker}
							restore={restore}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}
