"use client";

import {
	type CommittedCallback,
	type RereadCallback,
	useDirectCommit,
} from "@saas/projects/hooks/use-direct-commit";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { editInstructionSnapshot } from "@saas/projects/lib/edit-snapshot";
import type { InstructionChangeBase } from "@saas/projects/lib/instruction-change-source";
import { defaultCommitMessage } from "@saas/projects/lib/instructions-direct-commit";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { pathRefusal, WRAPPING_BUTTON } from "./AddInstructionFileDialog";
import { CommitMessageField } from "./CommitMessageField";

/**
 * Renames one file of a repository-backed project: a commit that deletes the
 * old path and puts the same text at the new one, which git reads as a rename.
 * There is no rename procedure; the change set is the whole mechanism.
 *
 * The same two ways on as every other change to such a project: Commit to the
 * branch for a member who may (INSTRUCTION_CREATE), and Suggest as a pull
 * request, which is the only one for a reader. The new path is checked here
 * the way "Add file" checks one, and must not be a file that already exists:
 * a put over an existing path would silently replace it.
 */
export function RenameInstructionFileDialog({
	open,
	onOpenChange,
	projectId,
	baseSnapshotId,
	nativeBase,
	path,
	content,
	existingPaths,
	repositoryTarget,
	canCommit,
	canPropose,
	onChanged,
	onCommitted,
	onRenamed,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	/** The file being renamed. */
	path: string;
	/** Its text, which the new path receives unchanged. Null for a file that is not text: not renameable here. */
	content: string | null;
	existingPaths?: ReadonlySet<string>;
	repositoryTarget: { repository: string; ref: string };
	canCommit: boolean;
	canPropose: boolean;
	onChanged: RereadCallback;
	onCommitted?: CommittedCallback;
	/**
	 * The file now sits at this path. Called as the commit lands, before the
	 * refreshed list can drop the old path from under the page.
	 */
	onRenamed?: (newPath: string) => void;
} & InstructionChangeBase) {
	const t = useTranslations("projects.codingInstructions.renameDialog");
	const tAdd = useTranslations("projects.codingInstructions.addFileDialog");
	const tFile = useTranslations("projects.codingInstructions.fileView");
	const tDirect = useTranslations("projects.codingInstructions.direct");
	const actionError = useInstructionActionError();
	const [newPath, setNewPath] = useState(path);
	const [message, setMessage] = useState<string | null>(null);
	const [pullRequestOpened, setPullRequestOpened] = useState(false);

	const target = newPath.trim();
	const defaultMessage = defaultCommitMessage({
		kind: "rename",
		from: path,
		to: target,
	});
	const commitMessage = message ?? defaultMessage;
	const refusalCode =
		target === "" || target === path ? null : pathRefusal(target);
	const exists =
		target !== path && target !== "" && existingPaths?.has(target) === true;
	const problem =
		refusalCode !== null
			? tAdd(`pathRefusals.${refusalCode}`)
			: exists
				? t("pathExists")
				: null;
	const ready =
		target !== "" &&
		target !== path &&
		problem === null &&
		content !== null;

	function close() {
		setNewPath(path);
		setMessage(null);
		setPullRequestOpened(false);
		onOpenChange(false);
	}

	const suggest = useMutation({
		mutationFn: () =>
			editInstructionSnapshot({
				projectId,
				...(nativeBase ? { nativeBase } : { baseSnapshotId }),
				publishOnReady: false,
				proposal: true,
				edits: [
					{ op: "delete", path },
					{
						op: "put",
						path: target,
						body: new Blob([content ?? ""], { type: "text/plain" }),
					},
				],
			}),
		onSuccess: () => {
			toast.success(
				nativeBase
					? tDirect("suggestionSubmitted")
					: tFile("suggestionSubmitted"),
			);
			close();
			onChanged();
		},
		onError: (error: Error) => toast.error(actionError(error)),
	});

	const commit = useDirectCommit({
		projectId,
		branch: repositoryTarget.ref,
		onChanged,
		onCommitted: (committed) => {
			onRenamed?.(target);
			return onCommitted?.(committed);
		},
		onFinished: (result) => {
			if (result.kind === "pull-request") {
				setPullRequestOpened(true);
				return;
			}
			close();
		},
	});
	const working = suggest.isPending || commit.busy;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !working) {
					close();
				}
			}}
		>
			<DialogContent className="grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription className="[overflow-wrap:anywhere]">
						{t("description", { path, ref: repositoryTarget.ref })}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="rename-instruction-path">
							{t("pathLabel")}
						</Label>
						<Input
							id="rename-instruction-path"
							value={newPath}
							spellCheck={false}
							disabled={working || pullRequestOpened}
							aria-invalid={problem ? true : undefined}
							onChange={(event) => setNewPath(event.target.value)}
						/>
						{problem ? (
							<p className="text-destructive text-sm">
								{problem}
							</p>
						) : null}
					</div>
					{canCommit && !pullRequestOpened ? (
						<CommitMessageField
							value={commitMessage}
							refusal={commit.messageRefusal}
							disabled={working}
							onChange={(value) => {
								commit.clearMessageRefusal();
								setMessage(value);
							}}
						/>
					) : null}
					{commit.status}
				</div>
				<DialogFooter className="sm:flex-wrap sm:gap-y-2">
					{pullRequestOpened ? (
						<Button onClick={close}>{t("done")}</Button>
					) : (
						<>
							<Button
								variant="ghost"
								disabled={working}
								onClick={close}
							>
								{t("cancel")}
							</Button>
							{canPropose ? (
								<Button
									className={WRAPPING_BUTTON}
									variant={canCommit ? "outline" : "default"}
									disabled={!ready || working}
									onClick={() => suggest.mutate()}
								>
									{tFile("submitSuggestionButton")}
								</Button>
							) : null}
							{canCommit ? (
								<Button
									className={WRAPPING_BUTTON}
									disabled={
										!ready ||
										working ||
										commitMessage.trim() === ""
									}
									onClick={() =>
										content !== null &&
										commit.start({
											...(nativeBase
												? { nativeBase }
												: { baseSnapshotId }),
											message: commitMessage,
											changes: [
												{ op: "delete", path },
												{
													op: "put",
													path: target,
													content,
													encoding: "utf8",
												},
											],
											suggest: canPropose
												? () => suggest.mutate()
												: undefined,
										})
									}
								>
									{t("commitButton", {
										ref: repositoryTarget.ref,
									})}
								</Button>
							) : null}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
