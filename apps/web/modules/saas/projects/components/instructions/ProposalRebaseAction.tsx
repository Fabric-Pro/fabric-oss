"use client";

import { hasConflictMarkers } from "@repo/instructions";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { orpc } from "@shared/lib/orpc-query-utils";
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
import { Textarea } from "@ui/components/textarea";
import { GitMergeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

type ConflictReason = "content" | "delete-edit" | "binary";

type RebaseConflict = {
	path: string;
	reason: ConflictReason;
	text: string | null;
};

/** What the proposer chose for one conflicting file. */
type Choice =
	| { kind: "text"; text: string }
	| { kind: "delete" }
	| { kind: "published" };

type Resolution =
	| { op: "put"; path: string; content: string }
	| { op: "delete"; path: string }
	| { op: "published"; path: string };

function initialChoice(conflict: RebaseConflict): Choice {
	return conflict.text === null
		? { kind: "published" }
		: { kind: "text", text: conflict.text };
}

function resolutionOf(path: string, choice: Choice): Resolution {
	switch (choice.kind) {
		case "text":
			return { op: "put", path, content: choice.text };
		case "delete":
			return { op: "delete", path };
		case "published":
			return { op: "published", path };
		default: {
			const unreachable: never = choice;
			throw new Error(`Unknown choice: ${String(unreachable)}`);
		}
	}
}

/**
 * "Rebase onto current version" for the proposer's own stale upload-mode
 * proposal. A clean rebase replaces the proposal at once. Conflicts open in
 * a dialog with their markers: the proposer edits each file's text, keeps the
 * published version or deletes the file, and submitting sends those answers
 * back so the server merges again and replaces the proposal in one step. The
 * stale proposal stays pending until then.
 */
export function ProposalRebaseAction({
	projectId,
	snapshotId,
	onRebased,
}: {
	projectId: string;
	snapshotId: string;
	/** The rebase wrote (or found) a proposal on the published version. */
	onRebased: (snapshotId: string) => void;
}) {
	const t = useTranslations(
		"projects.codingInstructions.proposalReview.rebase",
	);
	const actionError = useInstructionActionError();
	const [conflicts, setConflicts] = useState<RebaseConflict[] | null>(null);
	const [publishedVersion, setPublishedVersion] = useState(0);
	const [cleanCount, setCleanCount] = useState(0);
	const [choices, setChoices] = useState<Record<string, Choice>>({});
	const rebase = useMutation(
		orpc.projects.instructions.proposals.rebase.mutationOptions({
			onSuccess: (result) => {
				switch (result.outcome) {
					case "rebased":
						setConflicts(null);
						toast.success(
							t("success", { version: result.version }),
						);
						onRebased(result.snapshotId);
						return;
					case "duplicate":
						setConflicts(null);
						toast.info(t("duplicate", { version: result.version }));
						onRebased(result.snapshotId);
						return;
					case "conflicts":
						setConflicts(result.conflicts);
						setPublishedVersion(result.publishedVersion);
						setCleanCount(result.clean.length);
						setChoices(
							Object.fromEntries(
								result.conflicts.map((conflict) => [
									conflict.path,
									initialChoice(conflict),
								]),
							),
						);
						return;
					default: {
						const unreachable: never = result;
						throw new Error(
							`Unknown rebase outcome: ${String(unreachable)}`,
						);
					}
				}
			},
			onError: (error) => toast.error(actionError(error)),
		}),
	);
	const unresolved = (conflicts ?? []).some((conflict) => {
		const choice = choices[conflict.path];
		return choice?.kind === "text" && hasConflictMarkers(choice.text);
	});
	const choose = (path: string, choice: Choice) =>
		setChoices((current) => ({ ...current, [path]: choice }));

	return (
		<div className="flex flex-col gap-2">
			<div>
				<Button
					size="sm"
					variant="outline"
					disabled={rebase.isPending}
					onClick={() =>
						rebase.mutate({
							projectId,
							snapshotId,
							resolutions: [],
						})
					}
				>
					<GitMergeIcon className="size-3.5" aria-hidden="true" />
					{t("button")}
				</Button>
			</div>
			<p className="text-muted-foreground text-sm">{t("hint")}</p>
			<Dialog
				open={conflicts !== null}
				onOpenChange={(open) => {
					if (!open) {
						setConflicts(null);
					}
				}}
			>
				<DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
					<DialogHeader>
						<DialogTitle>{t("dialogTitle")}</DialogTitle>
						<DialogDescription>
							{t("dialogDescription", {
								version: publishedVersion,
							})}
						</DialogDescription>
					</DialogHeader>
					{cleanCount > 0 ? (
						<p className="text-muted-foreground text-sm">
							{t("cleanCount", { count: cleanCount })}
						</p>
					) : null}
					<ul className="flex flex-col gap-4">
						{(conflicts ?? []).map((conflict) => {
							const choice =
								choices[conflict.path] ??
								initialChoice(conflict);
							return (
								<li
									key={conflict.path}
									className="flex flex-col gap-2 rounded-lg border border-border p-3"
								>
									<div className="flex flex-col gap-0.5">
										<span className="font-mono text-sm [overflow-wrap:anywhere]">
											{conflict.path}
										</span>
										<span className="text-muted-foreground text-xs">
											{t(`reasons.${conflict.reason}`)}
										</span>
									</div>
									<div className="flex flex-wrap gap-2">
										{conflict.text !== null ? (
											<Button
												size="sm"
												variant={
													choice.kind === "text"
														? "secondary"
														: "outline"
												}
												aria-pressed={
													choice.kind === "text"
												}
												onClick={() =>
													choose(conflict.path, {
														kind: "text",
														text:
															conflict.text ?? "",
													})
												}
											>
												{t("editText")}
											</Button>
										) : null}
										<Button
											size="sm"
											variant={
												choice.kind === "published"
													? "secondary"
													: "outline"
											}
											aria-pressed={
												choice.kind === "published"
											}
											onClick={() =>
												choose(conflict.path, {
													kind: "published",
												})
											}
										>
											{t("keepPublished")}
										</Button>
										<Button
											size="sm"
											variant={
												choice.kind === "delete"
													? "secondary"
													: "outline"
											}
											aria-pressed={
												choice.kind === "delete"
											}
											onClick={() =>
												choose(conflict.path, {
													kind: "delete",
												})
											}
										>
											{t("deleteFile")}
										</Button>
									</div>
									{choice.kind === "text" ? (
										<Textarea
											aria-label={t("textLabel", {
												path: conflict.path,
											})}
											className="min-h-48 font-mono text-xs"
											value={choice.text}
											onChange={(event) =>
												choose(conflict.path, {
													kind: "text",
													text: event.target.value,
												})
											}
										/>
									) : null}
								</li>
							);
						})}
					</ul>
					{unresolved ? (
						<p role="alert" className="text-destructive text-sm">
							{t("markersLeft")}
						</p>
					) : null}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConflicts(null)}
						>
							{t("close")}
						</Button>
						<Button
							disabled={unresolved || rebase.isPending}
							onClick={() =>
								rebase.mutate({
									projectId,
									snapshotId,
									resolutions: (conflicts ?? []).map(
										(conflict) =>
											resolutionOf(
												conflict.path,
												choices[conflict.path] ??
													initialChoice(conflict),
											),
									),
								})
							}
						>
							{t("submit")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
