"use client";

/**
 * A project's Coding Instructions sets (spec 2026-11-11 §4.1): each named set
 * applies to the code repositories chosen for it, and a repository in no set
 * gets no instructions (D2). Lists the sets with their repositories, and lets
 * a person who may change the instructions create, rename, reassign and
 * delete one. Deleting removes the set from Fabric only; its files stay in
 * the instructions repository (D7). The default set holds the project's
 * existing instructions and cannot be deleted.
 *
 * A set is a folder of the project's one instructions source
 * (`instructions/<slug>/`; the default set is the root without the other
 * sets' folders). Sync, versions and review stay per project.
 */

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
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
import { Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

type SetRow = {
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
	repositoryIntegrationIds: string[];
	folder: string;
};

type CodeRepository = { id: string; name: string };

/** What the server said, kept when it is one of the set refusals. */
function refusalMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function InstructionSetsPanel({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.sets");
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const query = useQuery(
		orpc.projects.instructions.listSets.queryOptions({
			input: { projectId },
		}),
	);
	const remove = useMutation(
		orpc.projects.instructions.deleteSet.mutationOptions(),
	);
	const [editing, setEditing] = useState<SetRow | "new" | null>(null);

	if (!query.data) {
		return null;
	}
	const { sets, codeRepositories } = query.data;
	const names = new Map(codeRepositories.map((r) => [r.id, r.name]));
	const covered = new Set(sets.flatMap((s) => s.repositoryIntegrationIds));
	const uncovered = codeRepositories.filter((r) => !covered.has(r.id));

	// One set holding today's instructions and nothing else to manage: say
	// nothing until someone wants a second set.
	if (sets.length <= 1 && !canEdit) {
		return null;
	}

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.listSets.key(),
		});

	const askDelete = (set: SetRow) =>
		confirm({
			title: t("deleteTitle", { name: set.name }),
			message: t("deleteMessage"),
			confirmLabel: t("delete"),
			destructive: true,
			onConfirm: async () => {
				try {
					await remove.mutateAsync({ projectId, setId: set.id });
					await refresh();
					toast.success(t("deleted", { name: set.name }));
				} catch (error) {
					toast.error(refusalMessage(error, t("deleteFailed")));
				}
			},
		});

	return (
		<section
			aria-labelledby="instruction-sets-heading"
			className="space-y-2"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id="instruction-sets-heading"
					className="font-medium text-sm"
				>
					{t("title")}
				</h3>
				{canEdit ? (
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setEditing("new")}
					>
						<PlusIcon className="size-4" aria-hidden="true" />
						{t("new")}
					</Button>
				) : null}
			</div>
			<ul className="divide-y rounded-md border">
				{sets.map((set) => (
					<li
						key={set.id}
						className="flex flex-wrap items-start justify-between gap-2 px-3 py-2"
					>
						<div className="min-w-0 space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium text-sm">
									{set.name}
								</span>
								<code className="text-muted-foreground text-xs">
									{set.folder === ""
										? t("rootFolder")
										: set.folder}
								</code>
								{set.isDefault ? (
									<Badge status="info">{t("default")}</Badge>
								) : null}
							</div>
							<p className="text-muted-foreground text-xs">
								{set.repositoryIntegrationIds.length === 0
									? t("noRepositories")
									: set.repositoryIntegrationIds
											.map((id) => names.get(id) ?? id)
											.join(", ")}
							</p>
						</div>
						{canEdit ? (
							<div className="flex items-center gap-1">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									aria-label={t("editLabel", {
										name: set.name,
									})}
									onClick={() => setEditing(set)}
								>
									<PencilIcon
										className="size-3.5"
										aria-hidden="true"
									/>
								</Button>
								{set.isDefault ? null : (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										aria-label={t("deleteLabel", {
											name: set.name,
										})}
										onClick={() => askDelete(set)}
									>
										<Trash2Icon
											className="size-3.5"
											aria-hidden="true"
										/>
									</Button>
								)}
							</div>
						) : null}
					</li>
				))}
			</ul>
			{uncovered.length > 0 && sets.length > 1 ? (
				<output className="block text-muted-foreground text-xs">
					{t("uncovered", {
						names: uncovered.map((r) => r.name).join(", "),
					})}
				</output>
			) : null}
			{editing ? (
				<InstructionSetDialog
					projectId={projectId}
					set={editing === "new" ? null : editing}
					repositories={codeRepositories}
					onClose={() => setEditing(null)}
					onSaved={refresh}
				/>
			) : null}
		</section>
	);
}

function InstructionSetDialog({
	projectId,
	set,
	repositories,
	onClose,
	onSaved,
}: {
	projectId: string;
	set: SetRow | null;
	repositories: CodeRepository[];
	onClose: () => void;
	onSaved: () => Promise<unknown>;
}) {
	const t = useTranslations("projects.codingInstructions.sets");
	const id = useId();
	const create = useMutation(
		orpc.projects.instructions.createSet.mutationOptions(),
	);
	const update = useMutation(
		orpc.projects.instructions.updateSet.mutationOptions(),
	);
	const [name, setName] = useState(set?.name ?? "");
	const [chosen, setChosen] = useState<Set<string>>(
		new Set(set?.repositoryIntegrationIds ?? []),
	);
	const [problem, setProblem] = useState<string | null>(null);
	const pending = create.isPending || update.isPending;

	const toggle = (repositoryId: string, on: boolean) =>
		setChosen((current) => {
			const next = new Set(current);
			if (on) {
				next.add(repositoryId);
			} else {
				next.delete(repositoryId);
			}
			return next;
		});

	async function submit() {
		setProblem(null);
		const repositoryIntegrationIds = [...chosen];
		try {
			if (set) {
				await update.mutateAsync({
					projectId,
					setId: set.id,
					name,
					repositoryIntegrationIds,
				});
			} else {
				await create.mutateAsync({
					projectId,
					name,
					repositoryIntegrationIds,
				});
			}
			await onSaved();
			toast.success(set ? t("saved") : t("created", { name }));
			onClose();
		} catch (error) {
			setProblem(refusalMessage(error, t("saveFailed")));
		}
	}

	return (
		<Dialog open onOpenChange={(open) => (open ? null : onClose())}>
			<DialogContent>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{set ? t("editTitle") : t("newTitle")}
						</DialogTitle>
						<DialogDescription>{t("dialogHelp")}</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor={`${id}-name`}>{t("name")}</Label>
						<Input
							id={`${id}-name`}
							value={name}
							maxLength={80}
							required
							disabled={pending}
							onChange={(e) => setName(e.target.value)}
						/>
						{set ? (
							<p className="text-muted-foreground text-xs">
								{t("slugStays", {
									folder:
										set.folder === ""
											? t("rootFolder")
											: set.folder,
								})}
							</p>
						) : null}
					</div>
					<fieldset className="space-y-2">
						<legend className="font-medium text-sm">
							{t("repositories")}
						</legend>
						{repositories.length === 0 ? (
							<p className="text-muted-foreground text-xs">
								{t("noCodeRepositories")}
							</p>
						) : (
							<ul className="max-h-64 space-y-1 overflow-y-auto">
								{repositories.map((repository) => (
									<li
										key={repository.id}
										className="flex items-center gap-2"
									>
										<Checkbox
											id={`${id}-${repository.id}`}
											checked={chosen.has(repository.id)}
											disabled={pending}
											onCheckedChange={(v) =>
												toggle(
													repository.id,
													v === true,
												)
											}
										/>
										<Label
											htmlFor={`${id}-${repository.id}`}
											className="font-normal"
										>
											{repository.name}
										</Label>
									</li>
								))}
							</ul>
						)}
					</fieldset>
					{problem ? (
						<p role="alert" className="text-destructive text-sm">
							{problem}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={pending}
							onClick={onClose}
						>
							{t("cancel")}
						</Button>
						<Button
							type="submit"
							disabled={pending || name.trim() === ""}
						>
							{pending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							{set ? t("save") : t("create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
