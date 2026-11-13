"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

/**
 * "Remove coding instructions" in the tab's settings dialog: delete every
 * version at once, the published one included, so the project starts over
 * with nothing published (`projects.instructions.removeAll`).
 *
 * Shown only to a member who holds INSTRUCTION_DELETE (`canDeleteInstructions`
 * on `projects.get`, the permission the procedure requires), and only when
 * there is something to remove. The settings dialog mounts it only in upload
 * mode with no move into a repository open; the server refuses both anyway.
 *
 * What it says comes from `removeAllPreview`: the number of versions the
 * removal deletes, which History cannot give, and the refusal the removal
 * would meet now. While one applies the button is disabled and the reason is
 * shown beside it, as "Reset Living Memory" does; the server's refusal stays
 * the backstop for a state that changes after the preview was read.
 * Destructive, so the confirmation names the published version and how many
 * other versions go with it, and is confirmed only once the project's name is
 * typed exactly, as "Reset Living Memory" is.
 */
export function RemoveCodingInstructions({
	projectId,
	onRemoved,
}: {
	projectId: string;
	/** Every version is gone and the tab's reads were invalidated. */
	onRemoved: () => void;
}) {
	const t = useTranslations(
		"projects.codingInstructions.settingsDialog.remove",
	);
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const tErrors = useTranslations("projects.codingInstructions.actionErrors");
	const actionError = useInstructionActionError();
	const headingId = useId();
	const inputId = useId();
	const reasonId = useId();

	const project = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const details = project.data?.project;
	// The server's count, not History's: History hides other members'
	// proposals and every git intent row, all of which the removal deletes.
	const preview = useQuery({
		...orpc.projects.instructions.removeAllPreview.queryOptions({
			input: { projectId },
		}),
		enabled: details?.canDeleteInstructions === true,
	});

	const remove = useMutation(
		orpc.projects.instructions.removeAll.mutationOptions({
			onSuccess: (result) => {
				toast.success(t("done", { count: result.removed }));
				setOpen(false);
				setTyped("");
				// Close the settings dialog first, so focus goes back to its
				// trigger before the refetch unmounts this section.
				onRemoved();
				// Every instructions read, so the tab returns to its empty state.
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.instructions.key(),
				});
			},
			onError: (error) => {
				toast.error(t("failed", { reason: actionError(error) }));
			},
		}),
	);

	if (
		!details?.canDeleteInstructions ||
		!preview.isSuccess ||
		preview.data.snapshotCount === 0
	) {
		return null;
	}
	const { publishedVersion, blockedBy } = preview.data;
	const otherVersions =
		preview.data.snapshotCount - (publishedVersion === null ? 0 : 1);
	// What the server would refuse the removal for now, in the words its
	// refusal would use; the server still decides again under its locks.
	let blockedLine: string | null;
	switch (blockedBy) {
		case null:
			blockedLine = null;
			break;
		case "MIGRATION_OPEN":
			blockedLine = t("blockedMigrationOpen");
			break;
		case "REPOSITORY_MODE":
			blockedLine = tErrors("repositoryMode");
			break;
		case "SNAPSHOT_ACTIVE":
			blockedLine = tErrors("snapshotActive");
			break;
		case "PULL_REQUEST_UNRESOLVED":
			blockedLine = tErrors("pullRequestUnresolved");
			break;
		case "PROPOSAL_PENDING":
			blockedLine = tErrors("proposalPending");
			break;
		default: {
			const unreachable: never = blockedBy;
			throw new Error(`Unhandled removal block: ${String(unreachable)}`);
		}
	}
	const projectName = details.name;
	const confirmed = typed.trim() === projectName && blockedBy === null;

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-2 rounded-md border border-destructive/40 p-3"
			data-testid="instructions-remove-section"
		>
			<h3 id={headingId} className="font-medium text-destructive text-sm">
				{t("sectionTitle")}
			</h3>
			<p className="text-muted-foreground text-xs">
				{t("sectionDescription")}
			</p>
			<Button
				type="button"
				variant="destructive"
				size="sm"
				disabled={blockedLine !== null}
				aria-describedby={blockedLine === null ? undefined : reasonId}
				data-testid="instructions-remove"
				onClick={() => setOpen(true)}
			>
				<Trash2Icon className="mr-1.5 size-3.5" aria-hidden="true" />
				{t("action")}
			</Button>
			{blockedLine === null ? null : (
				<p
					id={reasonId}
					className="text-muted-foreground text-xs"
					data-testid="instructions-remove-blocked"
				>
					{blockedLine}
				</p>
			)}
			<AlertDialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) {
						setTyped("");
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("title")}</AlertDialogTitle>
						<AlertDialogDescription>
							{publishedVersion === null
								? t("descriptionNothingPublished", {
										count: otherVersions,
									})
								: t("description", {
										version: publishedVersion,
										count: otherVersions,
									})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label htmlFor={inputId}>
							{t("confirmLabel", { name: projectName })}
						</Label>
						<Input
							id={inputId}
							value={typed}
							autoComplete="off"
							spellCheck={false}
							data-testid="instructions-remove-name"
							onChange={(event) => setTyped(event.target.value)}
							onKeyDown={(event) => {
								if (
									event.key === "Enter" &&
									confirmed &&
									!remove.isPending
								) {
									event.preventDefault();
									remove.mutate({ projectId });
								}
							}}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={!confirmed || remove.isPending}
							data-testid="instructions-remove-confirm"
							onClick={(event) => {
								// Keep the dialog open until the server answers.
								event.preventDefault();
								remove.mutate({ projectId });
							}}
						>
							{remove.isPending ? t("removing") : t("confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
