"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	configureErrorMessage,
	type RepositorySyncState,
} from "../../lib/instructions-repository-sync";

/**
 * The Settings dialog's "Repository" section (design 2026-09-23 §7.4). It
 * also renders for a project left in repository mode with nothing
 * configured (the integration was disconnected, or its delegate deleted), so
 * such a project can always be switched back and is never locked.
 *
 * The automatic toggle calls `configure` with the stored repository, branch
 * and folder and the flipped flag, so it goes through the same branch check,
 * generation bump and delegation as "Change…". Readers see the state as
 * text.
 *
 * One change at a time (Decision 40): while the toggle's `configure` or a
 * switch to upload mode is in flight, the toggle, "Change…" and "Switch to
 * upload mode" are all disabled, so a second change cannot be built from
 * the configuration the first is replacing.
 *
 * In flight lasts until the tab has re-read what the change moved
 * (Decision 53). Each mutation's own `onSuccess` awaits `onChanged()`, and
 * TanStack Query keeps a mutation pending until that settles
 * (`@tanstack/query-core` 5.90.6, `mutation.ts:244` before the success
 * dispatch at `:269`). A per-call `mutate(vars, { onSuccess })` callback is
 * not awaited, so the toggle's handlers live in `mutationOptions`.
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
	/** Re-read what a change moved; resolves once the new state is loaded. */
	onChanged: () => Promise<void>;
}) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.settings",
	);
	const tSync = useTranslations("projects.codingInstructions.repositorySync");
	const disable = useMutation(
		orpc.projects.instructions.repositorySync.disable.mutationOptions({
			onSuccess: async () => {
				toast.success(t("switched"));
				await onChanged();
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const configure = useMutation(
		orpc.projects.instructions.repositorySync.configure.mutationOptions({
			onSuccess: async (_result, variables) => {
				toast.success(
					t(
						variables.automatic
							? "automaticTurnedOn"
							: "automaticTurnedOff",
					),
				);
				await onChanged();
			},
			onError: (error, variables) => {
				const mapped = configureErrorMessage(error);
				toast.error(tSync(mapped.key, { ref: variables.ref }));
			},
		}),
	);
	const busy = configure.isPending || disable.isPending;
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

	function setAutomatic(next: boolean) {
		if (!configured) {
			return;
		}
		configure.mutate({
			projectId,
			repositoryIntegrationId: configured.repositoryIntegrationId,
			ref: configured.ref,
			rootPath: configured.rootPath,
			automatic: next,
		});
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
				<dl className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm">
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
					<dt
						id="instructions-sync-automatic-setting"
						className="text-muted-foreground"
					>
						{t("automatic")}
					</dt>
					<dd>
						{state.canConfigure ? (
							<Switch
								aria-labelledby="instructions-sync-automatic-setting"
								aria-describedby="instructions-sync-automatic-setting-hint"
								checked={configured.automatic}
								disabled={busy}
								onCheckedChange={setAutomatic}
							/>
						) : (
							t(
								configured.automatic
									? "automaticOn"
									: "automaticOff",
							)
						)}
					</dd>
				</dl>
			) : (
				<p className="text-muted-foreground text-sm">
					{t("disconnected")}
				</p>
			)}
			{configured && state.canConfigure ? (
				<p
					id="instructions-sync-automatic-setting-hint"
					className="text-muted-foreground text-xs"
				>
					{t("automaticHint")}
				</p>
			) : null}
			{state.canConfigure ? (
				<div className="flex flex-wrap gap-2">
					{configured ? (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={onChange}
						>
							{t("changeButton")}
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						className="text-destructive"
						disabled={busy}
						onClick={switchToUpload}
					>
						{t("switchToUpload")}
					</Button>
				</div>
			) : null}
		</section>
	);
}
