"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Edits the project's ignore-glob override. Source of truth (`.fabricignore`
 * vs this project override vs the built-in defaults) is display-only in this
 * slice — this dialog only ever writes `ignoreGlobs` via `updateSettings`.
 * The query is gated on `open` so it never fetches while the dialog is
 * closed, and the textarea reseeds every time the dialog opens.
 *
 * Someone who may not change the settings still sees them: the list reads as
 * text they can select, there is no Save or Reset, and one sentence says why.
 * (The save used to be offered to everyone and refused afterwards with a
 * FORBIDDEN toast.)
 */
export function InstructionsSettingsDialog({
	projectId,
	open,
	onOpenChange,
	canEdit: mayEdit,
	pausedReason = null,
	repositorySection,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	/**
	 * Whether this viewer may change the settings. A UI gate only:
	 * `updateSettings` re-checks the permission on every save.
	 */
	canEdit: boolean;
	/**
	 * Why no setting can be changed right now (a move of the uploaded
	 * instructions into a repository is open, Fizzy #2878 §9): the server would
	 * refuse the save, so the rules read as text and this sentence says why.
	 */
	pausedReason?: string | null;
	/** The Repository section (§7.4), when the project syncs or is left in repository mode. */
	repositorySection?: ReactNode;
}) {
	const actionError = useInstructionActionError();
	const canEdit = mayEdit && pausedReason === null;
	const t = useTranslations("projects.codingInstructions.settingsDialog");
	const queryClient = useQueryClient();
	const settings = useQuery({
		...orpc.projects.instructions.getSettings.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});
	const [text, setText] = useState("");
	const [seededFor, setSeededFor] = useState<string | null>(null);
	const seedKey = `${projectId}:${open}`;

	useEffect(() => {
		if (!open) {
			setSeededFor(null);
			return;
		}
		if (settings.data && seededFor !== seedKey) {
			// Seed from the project's OWN override only, never from the
			// defaults. Seeding from the defaults meant opening the dialog to
			// read the rules and pressing Save silently pinned a copy of
			// today's defaults onto the project (layer `default` -> `project`),
			// after which changes to `DEFAULT_IGNORE_GLOBS` no longer reached
			// it. The defaults are shown as placeholder text instead: visible
			// to read, never submitted.
			setText((settings.data.ignoreGlobs ?? []).join("\n"));
			setSeededFor(seedKey);
		}
	}, [open, seedKey, seededFor, settings.data]);
	const settingsReady = settings.isSuccess && seededFor === seedKey;

	const update = useMutation(
		orpc.projects.instructions.updateSettings.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.instructions.getSettings.queryOptions({
							input: { projectId },
						}).queryKey,
				});
				toast.success(t("saved"));
				onOpenChange(false);
			},
			onError: (error) => toast.error(actionError(error)),
		}),
	);

	function save() {
		const globs = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		// An empty textarea means "no override", which is `null` — the same
		// thing "Reset to defaults" writes. An empty ARRAY is a different
		// statement ("a project rule list that excludes nothing") and would
		// pin the project to layer `project` with no rules at all.
		update.mutate({
			projectId,
			ignoreGlobs: globs.length > 0 ? globs : null,
		});
	}

	function resetToDefaults() {
		update.mutate({ projectId, ignoreGlobs: null });
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>
				{canEdit ? null : (
					<p
						className="text-muted-foreground text-sm"
						data-testid="instructions-settings-read-only"
					>
						{pausedReason ?? t("readOnlyNotice")}
					</p>
				)}
				{repositorySection}
				<Textarea
					aria-label={t("textareaLabel")}
					placeholder={(settings.data?.defaultIgnoreGlobs ?? []).join(
						"\n",
					)}
					value={text}
					readOnly={!canEdit || !settingsReady}
					onChange={(e) => setText(e.target.value)}
					className="min-h-[200px] font-mono text-xs"
				/>
				{canEdit ? (
					<DialogFooter className="sm:justify-between">
						<Button
							variant="outline"
							onClick={resetToDefaults}
							disabled={update.isPending || !settingsReady}
						>
							{t("resetToDefaults")}
						</Button>
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={update.isPending}
							>
								{t("cancel")}
							</Button>
							<Button
								onClick={save}
								disabled={update.isPending || !settingsReady}
							>
								{t("save")}
							</Button>
						</div>
					</DialogFooter>
				) : (
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							{t("close")}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
