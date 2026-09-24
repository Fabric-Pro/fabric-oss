"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import { Loader2Icon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	activeContextSyncIntegrations,
	type ContextSyncConfiguration,
	type ContextSyncIntegration,
	type ContextSyncNowResult,
	contextSyncConfigureErrorMessage,
	contextSyncNowResultMessage,
	contextSyncPathValidationMessage,
	validateContextSyncPathAddition,
} from "../lib/context-repository-sync";

/**
 * Points the project's Living Memory at selected folders and files of a
 * branch in one of its connected repositories, then starts the first sync
 * (design 2026-09-23 §5.1, §7.2, Fizzy #2657). The server verifies the
 * branch and canonicalizes the paths before saving anything; what it refuses
 * is shown inline, beside the field it is about when it names one.
 *
 * Mounted only while open, so a background poll of the tab cannot overwrite
 * what someone is typing.
 */
export function ConfigureContextRepositorySyncDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	integrations,
	current,
	onSaved,
}: {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Every connected integration, as `repositorySync.get` returns them. */
	integrations: ContextSyncIntegration[];
	current: ContextSyncConfiguration | null;
	onSaved: () => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.repositorySync");
	const active = activeContextSyncIntegrations(integrations);
	const seed =
		(current &&
			active.find((i) => i.id === current.repositoryIntegrationId)) ??
		active[0] ??
		null;
	const [integrationId, setIntegrationId] = useState(seed?.id ?? "");
	const [ref, setRef] = useState(current?.ref ?? seed?.defaultBranch ?? "");
	const [paths, setPaths] = useState<string[]>(current?.paths ?? []);
	const [pathInput, setPathInput] = useState("");
	const [pathError, setPathError] = useState<string | null>(null);
	const [inlineError, setInlineError] = useState<string | null>(null);
	const [inlineErrorField, setInlineErrorField] = useState<
		"branch" | "paths" | null
	>(null);

	const configure = useMutation(
		orpc.projects.contexts.repositorySync.configure.mutationOptions(),
	);
	const syncNow = useMutation(
		orpc.projects.contexts.repositorySync.syncNow.mutationOptions(),
	);
	const pending = configure.isPending || syncNow.isPending;
	const selected = active.find((i) => i.id === integrationId) ?? null;
	const branch = ref.trim();

	function addPath() {
		const result = validateContextSyncPathAddition(pathInput, paths);
		if (!result.ok) {
			const message = contextSyncPathValidationMessage(result.error);
			setPathError(t(message.key, message.values));
			return;
		}
		setPaths((prev) => [...prev, result.path]);
		setPathInput("");
		setPathError(null);
	}

	function removePath(path: string) {
		setPaths((prev) => prev.filter((p) => p !== path));
		setPathError(null);
	}

	async function submit() {
		setInlineError(null);
		setInlineErrorField(null);
		try {
			await configure.mutateAsync({
				projectId,
				organizationId,
				repositoryIntegrationId: integrationId,
				ref: branch,
				paths,
			});
		} catch (error) {
			const mapped = contextSyncConfigureErrorMessage(error);
			const message = t(mapped.key, mapped.values);
			if (mapped.inline) {
				setInlineError(message);
				setInlineErrorField(
					mapped.field === "branch" || mapped.field === "paths"
						? mapped.field
						: null,
				);
			} else {
				toast.error(message);
			}
			return;
		}
		// Saved. The first sync starts now (§7.2); a refusal to start is
		// reported, and the configuration stands either way.
		try {
			const result = (await syncNow.mutateAsync({
				projectId,
				organizationId,
			})) as ContextSyncNowResult;
			const announced = contextSyncNowResultMessage(result);
			toast[announced.tone](t(announced.key));
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("configureDialog.errors.generic"),
			);
		}
		onSaved();
		onOpenChange(false);
	}

	const canSubmit =
		!pending && integrationId !== "" && branch !== "" && paths.length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("configureDialog.title")}</DialogTitle>
					<DialogDescription>
						{t("configureDialog.description")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					{active.length > 1 ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="context-sync-repository">
								{t("configureDialog.repositoryLabel")}
							</Label>
							<select
								id="context-sync-repository"
								className="h-9 rounded-md border border-input bg-background px-3 text-sm"
								value={integrationId}
								onChange={(e) => {
									const next = active.find(
										(i) => i.id === e.target.value,
									);
									setIntegrationId(e.target.value);
									if (next) {
										setRef(next.defaultBranch);
									}
									setInlineError(null);
									setInlineErrorField(null);
								}}
							>
								{active.map((i) => (
									<option key={i.id} value={i.id}>
										{`${i.provider} · ${i.repositoryOwner}/${i.repositoryName}`}
									</option>
								))}
							</select>
						</div>
					) : selected ? (
						<p className="text-sm">
							<span className="text-muted-foreground">
								{t("configureDialog.repositoryLabel")}:{" "}
							</span>
							<span>{`${selected.repositoryOwner}/${selected.repositoryName}`}</span>
						</p>
					) : null}

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="context-sync-branch">
							{t("configureDialog.branchLabel")}
						</Label>
						<Input
							id="context-sync-branch"
							value={ref}
							onChange={(e) => {
								setRef(e.target.value);
								setInlineError(null);
								setInlineErrorField(null);
							}}
							aria-invalid={
								inlineErrorField === "branch" ? true : undefined
							}
							aria-describedby={
								inlineErrorField === "branch"
									? "context-sync-error"
									: undefined
							}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="context-sync-path-input">
							{t("configureDialog.pathsLabel")}
						</Label>
						<div
							className="flex flex-wrap gap-1.5"
							data-testid="context-sync-paths-chips"
						>
							{paths.map((path) => (
								<Badge
									key={path}
									variant="outline"
									className="gap-1 font-mono text-xs"
								>
									{path === ""
										? t("configureDialog.wholeRepo")
										: path}
									<button
										type="button"
										aria-label={t(
											"configureDialog.removePath",
											{
												path:
													path === ""
														? t(
																"configureDialog.wholeRepo",
															)
														: path,
											},
										)}
										onClick={() => removePath(path)}
										className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									>
										<XIcon
											className="size-3"
											aria-hidden="true"
										/>
									</button>
								</Badge>
							))}
						</div>
						<div className="flex gap-2">
							<Input
								id="context-sync-path-input"
								value={pathInput}
								placeholder={t(
									"configureDialog.pathsPlaceholder",
								)}
								onChange={(e) => {
									setPathInput(e.target.value);
									setPathError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addPath();
									}
								}}
								aria-invalid={pathError ? true : undefined}
								aria-describedby={
									pathError
										? "context-sync-path-error"
										: undefined
								}
							/>
							<Button
								type="button"
								variant="outline"
								onClick={addPath}
								disabled={pending}
							>
								{t("configureDialog.addPath")}
							</Button>
						</div>
						{pathError ? (
							<p
								id="context-sync-path-error"
								role="alert"
								className="text-destructive text-xs"
							>
								{pathError}
							</p>
						) : (
							<p className="text-muted-foreground text-xs">
								{t("configureDialog.pathsHint")}
							</p>
						)}
					</div>

					{inlineError ? (
						<p
							id="context-sync-error"
							role="alert"
							className="text-destructive text-xs"
						>
							{inlineError}
						</p>
					) : null}
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.contextignoreNotice")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.pruneNotice")}
					</p>
					<p className="text-muted-foreground text-sm">
						{t("configureDialog.actingNotice")}
					</p>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						{t("configureDialog.cancel")}
					</Button>
					<Button onClick={submit} disabled={!canSubmit}>
						{pending ? (
							<Loader2Icon
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						{t("configureDialog.submit")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
