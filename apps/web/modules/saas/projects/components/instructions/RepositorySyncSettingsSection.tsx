"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useSyncActionError } from "../../hooks/use-sync-action-error";
import { migrationActions } from "../../lib/instructions-migration";
import {
	offersMoveIntoRepository,
	type RepositoryMigrationControls,
	type RepositorySyncConfiguration,
	type RepositorySyncState,
} from "../../lib/instructions-repository-sync";
import { instructionsSettingsSummary } from "../repository-sync/lib/instructions-selection";
import { translateSelectionMessage } from "../repository-sync/lib/selection-row";

/**
 * The Settings dialog's "Repository" section (design 2026-09-23 §7.4). It
 * also renders for a project left in repository mode with nothing
 * configured (the integration was disconnected, or its delegate deleted), so
 * such a project can always be switched back and is never locked.
 *
 * The automatic toggle calls `configure` with the stored repository, branch
 * and folder and the flipped flag, so it goes through the same branch check
 * and delegation as "Change…". Because nothing that is synced changes, it
 * keeps the configuration's generation: a sync already running finishes
 * normally and suggestions in flight stay current (Fizzy #2744). Readers see
 * the state as text.
 *
 * One change at a time (Decision 40): while the toggle's `configure` or a
 * switch to upload mode is in flight, the toggle, "Change…" and "Switch to
 * upload mode" are all disabled, so a second change cannot be built from
 * the configuration the first is replacing.
 *
 * Under the configuration, the same summary the configure dialog shows
 * says what syncs (Fizzy #2750 §6), without a count, since no listing is
 * read here: the folder, and that the project's ignore rules leave some
 * files out whenever `getSettings` (which the tab reads anyway) shows any.
 *
 * "Let read-only members propose changes as pull requests" (Fizzy #2563
 * spec §12, §16.1) has its own procedure, `updateProposalSettings`, which
 * never bumps the configuration's generation, so flipping it never fails a
 * proposal in flight. It is one more change under the same one-at-a-time
 * rule.
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
	onMove,
	migration,
	directRepository = false,
}: {
	projectId: string;
	directRepository?: boolean;
	state: RepositorySyncState;
	/**
	 * The tab's read of the move while one is open: it says whether a blocked
	 * move leaves switching back to upload mode as the way out.
	 */
	migration?: RepositoryMigrationControls;
	/** Reopen the configure dialog. */
	onChange: () => void;
	/**
	 * Open "Move these instructions into a repository". Given only when the
	 * member may both create and update and something is published; the section
	 * adds that the project is an upload one with a repository to move into.
	 */
	onMove?: () => void;
	/** Re-read what a change moved; resolves once the new state is loaded. */
	onChanged: () => Promise<void>;
}) {
	const { confirm } = useConfirmationAlert();
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.settings",
	);
	const tSync = useTranslations("projects.codingInstructions.repositorySync");
	const syncActionError = useSyncActionError();
	const disable = useMutation(
		orpc.projects.instructions.repositorySync.disable.mutationOptions({
			onSuccess: async () => {
				toast.success(t("switched"));
				await onChanged();
			},
			onError: (error) => toast.error(syncActionError(error, "disable")),
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
			onError: (error, variables) =>
				toast.error(syncActionError(error, "configure", variables.ref)),
		}),
	);
	const updateProposalSettings = useMutation(
		orpc.projects.instructions.repositorySync.updateProposalSettings.mutationOptions(
			{
				onSuccess: async (_result, variables) => {
					toast.success(
						t(
							variables.allowReaderProposals
								? "readerProposalsTurnedOn"
								: "readerProposalsTurnedOff",
						),
					);
					await onChanged();
				},
				onError: (error) =>
					toast.error(
						syncActionError(error, "updateProposalSettings"),
					),
			},
		),
	);
	// The tab reads the same query; without it the rules clause is left out.
	const settings = useQuery(
		orpc.projects.instructions.getSettings.queryOptions({
			input: { projectId },
		}),
	);
	const busy =
		configure.isPending ||
		disable.isPending ||
		updateProposalSettings.isPending;
	const configured = state.configured;
	if (!configured && state.sourceOfTruth !== "REPOSITORY") {
		// An upload project has no repository settings; what it can do is move
		// its published files into one, when the tab says the member may.
		return onMove && offersMoveIntoRepository(state) ? (
			<section
				aria-labelledby="instructions-repository-move"
				className="flex flex-col gap-3 rounded-lg border border-border p-4"
			>
				<h3 id="instructions-repository-move" className="font-medium">
					{t("moveTitle")}
				</h3>
				<p className="text-muted-foreground text-sm">{t("moveHint")}</p>
				<div>
					<Button size="sm" variant="outline" onClick={onMove}>
						{t("moveButton")}
					</Button>
				</div>
			</section>
		) : null;
	}
	const repository = configured
		? `${configured.repositoryOwner}/${configured.repositoryName}`
		: null;
	// A move of uploaded instructions into this repository is open: the sync
	// is the one the move created, and the server refuses every setting below,
	// so the section says where the move goes and offers none of them. The one
	// exception is the way out of a move Cancel cannot end: a project that is
	// switching over, and a blocked move.
	if (configured && state.migration) {
		const canLeave =
			state.canConfigure &&
			migrationActions(
				migration?.read?.migration ?? null,
				state.migration.state,
			).switchToUpload;
		return (
			<section
				aria-labelledby="instructions-repository-settings"
				className="flex flex-col gap-3 rounded-lg border border-border p-4"
			>
				<h3
					id="instructions-repository-settings"
					className="font-medium"
				>
					{t("title")}
				</h3>
				<dl className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm">
					<RepositoryRows
						repository={repository}
						configured={configured}
					/>
				</dl>
				<p className="text-muted-foreground text-sm">
					{t("migrationPaused")}
				</p>
				{canLeave ? (
					<div>
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

	function switchToUpload() {
		const message = repository
			? state.migration
				? t("switchMoveConfirm", { repository })
				: t(state.running ? "switchConfirmRunning" : "switchConfirm", {
						repository,
					})
			: t("switchConfirmDisconnected");
		confirm({
			title: t("switchConfirmTitle"),
			message,
			confirmLabel: t("switchToUpload"),
			destructive: true,
			onConfirm: () => disable.mutate({ projectId }),
		});
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
					<RepositoryRows
						repository={repository}
						configured={configured}
					/>
					{directRepository ? null : (
						<>
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
						</>
					)}
				</dl>
			) : (
				<p className="text-muted-foreground text-sm">
					{t("disconnected")}
				</p>
			)}
			{configured ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="instructions-sync-selection-summary"
				>
					{directRepository
						? t(
								configured.rootPath === ""
									? "directSelectionRoot"
									: "directSelectionFolder",
								{ folder: configured.rootPath },
							)
						: instructionsSettingsSummary({
								rootPath: configured.rootPath,
								settings: settings.data,
							})
								.map((line) =>
									translateSelectionMessage(tSync, line),
								)
								.join(" ")}
				</p>
			) : null}
			{configured && state.canConfigure && !directRepository ? (
				<p
					id="instructions-sync-automatic-setting-hint"
					className="text-muted-foreground text-xs"
				>
					{t("automaticHint")}
				</p>
			) : null}
			{configured ? (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<p
							id="instructions-sync-reader-proposals"
							className="text-sm"
						>
							{t("readerProposalsLabel")}
						</p>
						<p
							id="instructions-sync-reader-proposals-hint"
							className="text-muted-foreground text-xs"
						>
							{t(
								directRepository
									? "directReaderProposalsHint"
									: "readerProposalsHint",
							)}
						</p>
					</div>
					{state.canConfigure ? (
						<Switch
							aria-labelledby="instructions-sync-reader-proposals"
							aria-describedby="instructions-sync-reader-proposals-hint"
							checked={configured.allowReaderProposals === true}
							disabled={busy}
							onCheckedChange={(next) =>
								updateProposalSettings.mutate({
									projectId,
									allowReaderProposals: next,
								})
							}
						/>
					) : (
						<p className="text-sm sm:max-w-64 sm:text-right">
							{t(
								configured.allowReaderProposals
									? "readerProposalsOn"
									: "readerProposalsOff",
							)}
						</p>
					)}
				</div>
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

/** The repository, branch and folder rows of the section's `<dl>`. */
function RepositoryRows({
	repository,
	configured,
}: {
	repository: string | null;
	configured: RepositorySyncConfiguration;
}) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.settings",
	);
	return (
		<>
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
		</>
	);
}
