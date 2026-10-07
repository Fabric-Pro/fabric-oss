import {
	classifyPath,
	fileTypingFor,
	parseFrontmatter,
} from "@repo/instructions";
import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";

export type NativeInstructionFile = {
	path: string;
	kind: ReturnType<typeof classifyPath>;
	mode?: string;
	size?: number;
};

export function useInstructionFileContent(input: {
	projectId: string;
	path: string;
	snapshotId?: string;
	nativeBase?: NativeInstructionBase;
	nativeFile?: NativeInstructionFile;
}) {
	const legacy = useQuery(
		input.snapshotId
			? orpc.projects.instructions.getFile.queryOptions({
					input: {
						projectId: input.projectId,
						snapshotId: input.snapshotId,
						path: input.path,
						offset: 0,
						maxLength: 200_000,
					},
				})
			: {
					queryKey: ["instruction-file-inactive", input.projectId],
					queryFn: async () => null,
					enabled: false,
				},
	);
	const sourceKey = `${input.nativeBase?.generation}:${input.nativeBase?.commitSha}:${input.path}`;
	const [paging, setPaging] = useState({ sourceKey, offsets: [0] });
	const offsets = paging.sourceKey === sourceKey ? paging.offsets : [0];
	const nativeBase = input.nativeBase;
	const pages = useQueries({
		queries: nativeBase
			? offsets.map((offset) => ({
					...orpc.projects.instructions.repository.getFile.queryOptions(
						{
							input: {
								projectId: input.projectId,
								...nativeBase,
								path: input.path,
								offset,
								maxLength: 200_000,
							},
						},
					),
					staleTime: Number.POSITIVE_INFINITY,
					refetchOnWindowFocus: false,
				}))
			: [],
	});
	const native = pages[0];
	const lastPage = pages.at(-1);
	const read = native?.data;
	const completePages = pages.flatMap((page) =>
		page.data?.state === "found" ? [page.data] : [],
	);
	const nextOffset = completePages.at(-1)?.nextOffset ?? null;
	const loadMore = () => {
		if (lastPage?.isError) {
			void lastPage.refetch();
			return;
		}
		if (nextOffset !== null && !offsets.includes(nextOffset)) {
			setPaging({ sourceKey, offsets: [...offsets, nextOffset] });
		}
	};
	const controls = {
		loadMore,
		isLoadingMore: offsets.length > 1 && Boolean(lastPage?.isFetching),
		pageError: lastPage?.error ?? null,
	};
	if (!input.nativeBase) return { ...legacy, ...controls, refusal: null };
	if (!native) throw new Error("Native file query is missing");
	if (!read || read.state === "absent")
		return { ...native, ...controls, data: null, refusal: null };
	const body =
		read.state === "found"
			? completePages.map((page) => page.body).join("")
			: null;
	const frontmatter = body === null ? null : parseFrontmatter(body);
	return {
		...native,
		...controls,
		refusal: read.state === "tooLarge" ? "tooLarge" : null,
		data: {
			path: input.path,
			kind: input.nativeFile?.kind ?? classifyPath(input.path),
			name: frontmatter?.name ?? null,
			description: frontmatter?.description ?? null,
			size: "size" in read ? read.size : (input.nativeFile?.size ?? 0),
			mimeType: fileTypingFor(input.path).mimeType,
			isText: body !== null,
			mode:
				input.nativeFile?.mode === undefined
					? null
					: Number.parseInt(input.nativeFile.mode, 8),
			body,
			offset: 0,
			nextOffset,
			truncated:
				read.state === "found"
					? nextOffset !== null
					: read.state === "tooLarge",
			url: nativeInstructionDownloadUrl({
				projectId: input.projectId,
				nativeBase: input.nativeBase,
				path: input.path,
			}),
		},
	};
}

export function nativeInstructionDownloadUrl(input: {
	projectId: string;
	nativeBase: NativeInstructionBase;
	path?: string;
}) {
	const query = new URLSearchParams({
		generation: String(input.nativeBase.generation),
		commitSha: input.nativeBase.commitSha,
	});
	if (input.path !== undefined) query.set("path", input.path);
	return `/api/projects/${encodeURIComponent(input.projectId)}/instructions/repository/download?${query}`;
}
