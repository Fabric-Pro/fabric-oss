"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { RepositorySyncState } from "../../lib/instructions-repository-sync";

/**
 * The Settings dialog's "Repository" section (design 2026-09-23 §7.4). It
 * also renders for a project left in repository mode with nothing
 * configured (the integration was disconnected, or its delegate deleted), so
 * such a project can always be switched back and is never locked.
 */
export function RepositorySyncSettingsSection({
	projectId,
	state,
	onChange,
	onChanged,
}: {
	projectId: string;
	state: RepositorySyncState;
	/** Reopen the configure dialog. */
	onChange: () => void;
	onChanged: () => void;
}) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.settings",
	);
	const disable = useMutation(
		orpc.projects.instructions.repositorySync.disable.mutationOptions({
			onSuccess: () => {
				toast.success(t("switched"));
				onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const configured = state.configured;
	if (!configured && state.sourceOfTruth !== "REPOSITORY") {
		return null;
	}
	const repository = configured
		? `${configured.repositoryOwner}/${configured.repositoryName}`
		: null;

	function switchToUpload() {
		const question = repository
			? t(state.running ? "switchConfirmRunning" : "switchConfirm", {
					repository,
				})
			: t("switchConfirmDisconnected");
		if (window.confirm(question)) {
			disable.mutate({ projectId });
		}
	}

	return (
		<section
			aria-labelledby="instructions-repository-settings"
			className="flex flex-col gap-3 rounded-lg border border-border p-4"
		>
			<h3 id="instructions-repository-settings" className="font-medium">
				{t("title")}
			</h3>
			{configured ? (
				<dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
					<dt className="text-muted-foreground">{t("repository")}</dt>
					<dd>{repository}</dd>
					<dt className="text-muted-foreground">{t("branch")}</dt>
					<dd>
						<code>{configured.ref}</code>
					</dd>
					<dt className="text-muted-foreground">{t("folder")}</dt>
					<dd>
						{configured.rootPath === "" ? (
							t("folderRoot")
						) : (
							<code>{configured.rootPath}</code>
						)}
					</dd>
				</dl>
			) : (
				<p className="text-muted-foreground text-sm">
					{t("disconnected")}
				</p>
			)}
			{state.canConfigure ? (
				<div className="flex flex-wrap gap-2">
					{configured ? (
						<Button size="sm" variant="outline" onClick={onChange}>
							{t("changeButton")}
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						className="text-destructive"
						disabled={disable.isPending}
						onClick={switchToUpload}
					>
						{t("switchToUpload")}
					</Button>
				</div>
			) : null}
		</section>
	);
}
