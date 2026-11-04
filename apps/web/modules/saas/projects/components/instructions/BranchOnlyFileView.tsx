"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { editInstructionSnapshot } from "@saas/projects/lib/edit-snapshot";
import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	BranchFileActionButton,
	type BranchFileRestore,
} from "./BranchFileActions";
import { InstructionMarkdown } from "./InstructionMarkdown";
import type { RepositoryLinks } from "./instruction-links";
import { invalidateProposalViews } from "./lib/instructions-proposal-views";

const BRANCH_FILE_MAX = 200_000;

/**
 * A file only the caller's own proposal branch holds: the published version
 * has no such file, so there is nothing published to show or diff against.
 * It reads the bytes Fabric wrote on the branch. Edit suggests a change to
 * them, and Delete from my branch removes the file there; both are ordinary
 * proposals that the server admits relative to the branch.
 */
export function BranchOnlyFileView({
	projectId,
	branchId,
	path,
	nativeBase,
	canPropose,
	existingPaths,
	repositoryLinks,
	onOpenPath,
	restore,
	onChanged,
}: {
	projectId: string;
	branchId: string;
	path: string;
	nativeBase: NativeInstructionBase;
	canPropose: boolean;
	existingPaths?: ReadonlySet<string>;
	repositoryLinks?: RepositoryLinks | null;
	onOpenPath?: (path: string) => void;
	restore: BranchFileRestore;
	onChanged?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.branchFiles");
	const actionError = useInstructionActionError();
	const queryClient = useQueryClient();
	const file = useQuery(
		orpc.projects.instructions.proposals.myBranchFile.queryOptions({
			input: {
				projectId,
				branchId,
				path,
				offset: 0,
				maxLength: BRANCH_FILE_MAX,
			},
		}),
	);
	// The text being edited, with the path it was read from: a draft for
	// another path is not this file's draft.
	const [draft, setDraft] = useState<{ path: string; text: string } | null>(
		null,
	);
	const editing = draft?.path === path ? draft.text : null;
	const suggest = useMutation({
		mutationFn: (text: string) =>
			editInstructionSnapshot({
				projectId,
				nativeBase,
				publishOnReady: false,
				proposal: true,
				edits: [
					{
						op: "put",
						path,
						body: new Blob([text], { type: "text/plain" }),
					},
				],
			}),
		onSuccess: () => {
			setDraft(null);
			toast.success(t("suggestSuccess"));
			void invalidateProposalViews(queryClient);
			onChanged?.();
		},
		onError: (error: Error) => toast.error(actionError(error)),
	});

	const body = file.data?.body ?? null;
	const editable =
		canPropose && body !== null && file.data?.truncated === false;

	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-border border-b bg-muted/40 py-2.5 pr-3 pl-4">
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
					<code className="min-w-0 truncate text-foreground text-xs">
						{path}
					</code>
					<Badge variant="secondary">{t("branchOnlyBadge")}</Badge>
				</div>
				{canPropose && editing === null ? (
					<div className="flex flex-wrap items-center gap-2">
						{editable ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									setDraft({ path, text: body ?? "" })
								}
							>
								<PencilIcon
									className="size-3.5"
									aria-hidden="true"
								/>
								{t("edit")}
							</Button>
						) : null}
						<BranchFileActionButton
							path={path}
							marker="branchOnly"
							restore={restore}
						/>
					</div>
				) : null}
			</div>
			<p className="border-border border-b px-5 py-2 text-muted-foreground text-sm">
				{t("branchOnlyNotice")}
			</p>
			{editing !== null ? (
				<div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
					<Textarea
						aria-label={t("editorLabel", { path })}
						value={editing}
						onChange={(event) =>
							setDraft({ path, text: event.target.value })
						}
						spellCheck={false}
						className="min-h-[320px] flex-1 font-mono text-xs"
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							disabled={suggest.isPending}
							onClick={() => {
								if (editing === body) {
									setDraft(null);
									toast.info(t("noChanges"));
									return;
								}
								suggest.mutate(editing);
							}}
						>
							{t("suggest")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={suggest.isPending}
							onClick={() => setDraft(null)}
						>
							{t("cancel")}
						</Button>
					</div>
				</div>
			) : (
				<div className="min-w-0 overflow-auto px-7 py-6 [overflow-wrap:anywhere]">
					<div className="flex max-w-[72ch] min-w-0 flex-col gap-4">
						{file.isLoading ? (
							<Skeleton className="h-64 w-full" />
						) : file.isError || !file.data ? (
							<p
								role="alert"
								className="text-muted-foreground text-sm"
							>
								{t("loadError")}
							</p>
						) : body === null ? (
							<p className="text-muted-foreground">
								{t("binary")}{" "}
								{file.data.url ? (
									<a
										href={file.data.url}
										target="_blank"
										rel="noopener noreferrer"
										className="underline"
									>
										{t("download")}
									</a>
								) : null}
							</p>
						) : path.toLowerCase().endsWith(".md") ? (
							<InstructionMarkdown
								path={path}
								existingPaths={existingPaths}
								repositoryLinks={repositoryLinks ?? null}
								onOpenPath={onOpenPath}
							>
								{body}
							</InstructionMarkdown>
						) : (
							<pre className="whitespace-pre-wrap font-mono text-xs">
								{body}
							</pre>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
