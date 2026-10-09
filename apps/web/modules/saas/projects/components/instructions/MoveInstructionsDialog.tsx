"use client";

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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useInstructionActionError } from "../../hooks/use-instruction-action-error";
import { migrationOpenRefusal } from "../../lib/instructions-action-error";
import { moveRefusal } from "../../lib/instructions-migration";
import {
	configureErrorMessage,
	type RepositorySyncIntegration,
	repositorySyncTreeSelection,
} from "../../lib/instructions-repository-sync";
import { RepositoryChoice } from "./RepositoryChoice";

const NAMESPACE = "projects.codingInstructions.repositorySync";

/**
 * "Move these instructions into a repository" (Fizzy #2878 §9): starts the move
 * of an upload project's published files into a folder of a repository
 * connected to it. Fabric opens ONE pull request carrying the files, and the
 * project switches to syncing from the folder once it merges, so nothing here
 * changes the instructions yet.
 *
 * The repository and the branch are chosen as the configure dialog chooses
 * them. The folder is typed, not picked from the branch's tree: a folder the
 * move may use must hold no files, and git keeps no empty folders, so every
 * folder the tree could list would be refused. Leaving it empty puts the files
 * at the repository root, which is refused only where they would overwrite
 * something. Whatever the server refuses is shown beside the field that needs
 * changing.
 *
 * Mounted only while open, so the fields are seeded once from the props and a
 * background poll of the tab cannot overwrite what someone is choosing.
 */
export function MoveInstructionsDialog({
	projectId,
	open,
	onOpenChange,
	integrations,
	onStarted,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** ACTIVE integrations only, as `repositorySync.get` returns them. */
	integrations: RepositorySyncIntegration[];
	/** The move has started: the tab re-reads the state that now names it. */
	onStarted: () => void;
}) {
	const t = useTranslations(NAMESPACE);
	const actionError = useInstructionActionError();
	const id = useId();
	const first = integrations[0] ?? null;
	const [integrationId, setIntegrationId] = useState(first?.id ?? "");
	const [ref, setRef] = useState(first?.defaultBranch ?? "");
	const [folder, setFolder] = useState("");
	const [problem, setProblem] = useState<{
		message: string;
		field: "branch" | "folder" | null;
	} | null>(null);
	const migrate = useMutation(
		orpc.projects.instructions.repositorySync.migrate.mutationOptions(),
	);
	const pending = migrate.isPending;
	const branch = ref.trim();
	const rootPath = repositorySyncTreeSelection(folder);
	const errorId = `${id}-error`;

	function edit(change: () => void) {
		setProblem(null);
		change();
	}

	function explain(error: unknown) {
		if (migrationOpenRefusal(error) !== null) {
			setProblem({ message: actionError(error), field: null });
			return;
		}
		const refused = moveRefusal(error, rootPath);
		if (refused) {
			setProblem({
				message: t(`moveDialog.refusals.${refused.key}`),
				field: refused.field,
			});
			return;
		}
		const mapped = configureErrorMessage(error);
		if (mapped.key === "configureDialog.errors.generic") {
			toast.error(actionError(error));
			return;
		}
		const message = t(mapped.key, { ref: branch });
		if (mapped.inline) {
			setProblem({
				message,
				field:
					mapped.key === "configureDialog.errors.BRANCH_NOT_FOUND"
						? "branch"
						: mapped.key ===
								"configureDialog.errors.INVALID_ROOT_PATH"
							? "folder"
							: null,
			});
			return;
		}
		toast.error(message);
	}

	async function submit() {
		setProblem(null);
		try {
			await migrate.mutateAsync({
				projectId,
				repositoryIntegrationId: integrationId,
				ref: branch,
				rootPath,
			});
		} catch (error) {
			explain(error);
			return;
		}
		toast.success(t("moveDialog.started"));
		onStarted();
		onOpenChange(false);
	}

	const blocked = integrationId === "" || branch === "";

	return (
		<Dialog
			open={open}
			// Escape, the overlay and the close button are ignored while the
			// start is in flight: closing would drop the result of a write the
			// person is still waiting on.
			onOpenChange={(next) => {
				if (pending && !next) {
					return;
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-lg grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>{t("moveDialog.title")}</DialogTitle>
					<DialogDescription>
						{t("moveDialog.description")}
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!blocked && !pending) {
							void submit();
						}
					}}
				>
					<RepositoryChoice
						integrations={integrations}
						integrationId={integrationId}
						onChoose={(next) =>
							edit(() => {
								setIntegrationId(next.id);
								setRef(next.defaultBranch);
							})
						}
					/>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-branch`}>
							{t("configureDialog.branchLabel")}
						</Label>
						<Input
							id={`${id}-branch`}
							value={ref}
							disabled={pending}
							onChange={(e) => edit(() => setRef(e.target.value))}
							aria-invalid={
								problem?.field === "branch" ? true : undefined
							}
							aria-describedby={
								problem?.field === "branch"
									? errorId
									: undefined
							}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-folder`}>
							{t("moveDialog.folderLabel")}
						</Label>
						<Input
							id={`${id}-folder`}
							value={folder}
							disabled={pending}
							placeholder={t("moveDialog.folderPlaceholder")}
							onChange={(e) =>
								edit(() => setFolder(e.target.value))
							}
							aria-invalid={
								problem?.field === "folder" ? true : undefined
							}
							aria-describedby={
								problem?.field === "folder"
									? `${errorId} ${id}-folder-hint`
									: `${id}-folder-hint`
							}
						/>
						<p
							id={`${id}-folder-hint`}
							className="text-muted-foreground text-xs"
						>
							{t("moveDialog.folderHint")}
						</p>
					</div>
					{problem ? (
						<p
							id={errorId}
							role="alert"
							className="text-destructive text-xs"
						>
							{problem.message}
						</p>
					) : null}
					<DialogFooter className="items-center sm:flex-wrap sm:gap-y-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={pending}
						>
							{t("moveDialog.cancel")}
						</Button>
						<Button type="submit" disabled={pending || blocked}>
							{pending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							{t("moveDialog.submit")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
