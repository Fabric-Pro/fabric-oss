"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { ArrowLeftIcon, Loader2Icon, PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	BROWSER_LABEL,
	BROWSERS,
	type Browser,
	SUGGESTED_RESOLUTIONS,
} from "../../qa-settings/qa-settings-constants";

/**
 * The run-configuration dialog, and the saved configurations it offers.
 *
 * Before this, dispatching was a bare Run button: the environment came from the
 * QA policy and the browser and resolution from whatever that policy listed
 * first, with no way to say "this run, on Firefox, against staging" without
 * editing project settings — and no way to say it twice without repeating
 * yourself.
 *
 * **A configuration says HOW a run executes, never WHICH cases.** The selection
 * stays where the user made it, on the Cases tab. Saving a case list would go
 * stale the moment somebody added a case, and would keep looking like a
 * regression suite while silently no longer covering new work.
 *
 * Every field can be left as "project default", which is the honest option
 * rather than a hidden one: a configuration that pins today's policy values
 * would silently stop tracking the policy.
 *
 * **The billed figure, before the bill.** Fizzy #2233: dispatching used to show
 * a sentence that PROMISED an estimate ("Fabric calculates the final token
 * estimate…") without ever showing one, Agentic was preselected on every open,
 * and pressing Start spent real tokens with no confirmation. `agenticRuns.quote`
 * resolves the selection the same way `dispatch` will and reports what BOTH
 * runners would do with it; Agentic additionally requires a second, explicit
 * "Confirm and start" step that states the figure. Scripted makes no model
 * calls, so it dispatches directly.
 */

/** Sentinel — Radix Select cannot hold an empty value. */
const USE_PROJECT_DEFAULT = "__default__";

type RunMode = "MODE_A" | "MODE_B";

/**
 * Which cases a run should cover — the same shape `testCaseSelectionSchema`
 * validates server-side. Defined locally rather than imported from
 * `BulkActionsBar` so this dialog does not couple to the cases list page;
 * both callers already hold a value in this shape.
 */
export type RunSelection =
	| { mode: "ids"; ids: string[] }
	| { mode: "filter"; filter: Record<string, unknown> };

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * The viewer's last dispatched runner for this project, remembered in
 * `localStorage` so the dialog does not default back to Agentic on every
 * open. Per-viewer, per-project, best-effort: every read and write is
 * wrapped, since a private window or a full/blocked store must not break the
 * dialog.
 */
function rememberedRunnerKey(projectId: string): string {
	return `fabric.qa.run-configuration.runner.${projectId}`;
}

function readRememberedRunner(projectId: string): RunMode | null {
	try {
		const value = window.localStorage.getItem(
			rememberedRunnerKey(projectId),
		);
		return value === "MODE_A" || value === "MODE_B" ? value : null;
	} catch {
		return null;
	}
}

function rememberRunner(projectId: string, runMode: RunMode): void {
	try {
		window.localStorage.setItem(rememberedRunnerKey(projectId), runMode);
	} catch {
		// Best-effort convenience only.
	}
}

/**
 * The shared wording for "a run just started", so the two dispatch sites
 * (`AgenticRunsPanel`, `QaPanel`) cannot drift onto two different sentences.
 * A hook rather than a helper taking `t`: it owns the `…runConfiguration`
 * translator itself, so neither caller has to hold a second, differently
 * scoped one just to pass it through.
 */
export function useDescribeDispatchedRun(): (run: {
	runMode: RunMode;
	caseCount: number;
	estimatedCostUsd: number;
}) => string {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.runConfiguration",
	);
	return (run) =>
		run.runMode === "MODE_B"
			? t("dispatchedScripted", { count: run.caseCount })
			: t("dispatchedAgentic", {
					count: run.caseCount,
					cost: formatUsd(run.estimatedCostUsd),
				});
}

export function RunConfigurationDialog({
	projectId,
	open,
	onOpenChange,
	caseCount,
	selection,
	onDispatch,
	dispatching,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** How many cases the user selected — shown so the dialog states its scope. */
	caseCount: number;
	/**
	 * What the run would cover — powers the pre-dispatch quote. `undefined`
	 * while the caller has nothing selected yet (`caseCount` is then 0, which
	 * already disables Start on its own).
	 */
	selection: RunSelection | undefined;
	onDispatch: (overrides: {
		environmentId?: string;
		browser?: Browser;
		resolution?: string;
		runMode: RunMode;
	}) => void;
	dispatching: boolean;
}) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.runConfiguration",
	);
	const queryClient = useQueryClient();

	const configurationsQuery = useQuery({
		...orpc.projects.agenticRuns.configurations.list.queryOptions({
			input: { projectId },
		}),
		// The list seeds a system row on read, so only ask while the dialog can
		// show it.
		enabled: open,
	});
	const environmentsQuery = useQuery({
		...orpc.projects.environments.list.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});
	// Read-only: resolves the selection for BOTH runners without creating a
	// run, so the figure below is known before Start is ever pressed. A quote
	// failure must not block dispatch — the server still enforces the cap —
	// so this is never awaited by anything that gates the button, only by what
	// it DISPLAYS.
	//
	// `skipToken` as the input — not `enabled` plus a cast — is how
	// `@orpc/tanstack-query` itself types "there is nothing to ask yet": with
	// a required `{projectId, selection}` input, `queryOptions` only accepts
	// `TInput | SkipToken`, so this is the one value that both disables the
	// query and needs no assertion that `selection` is defined.
	const quoteQuery = useQuery(
		orpc.projects.agenticRuns.quote.queryOptions({
			input:
				open && selection && caseCount > 0
					? { projectId, selection }
					: skipToken,
			retry: false,
		}),
	);

	const configurations = configurationsQuery.data ?? [];
	const environments = environmentsQuery.data ?? [];
	const quote = quoteQuery.data;

	const [configurationId, setConfigurationId] = useState<string | null>(null);
	const [environmentId, setEnvironmentId] = useState(USE_PROJECT_DEFAULT);
	const [browser, setBrowser] = useState(USE_PROJECT_DEFAULT);
	const [resolution, setResolution] = useState(USE_PROJECT_DEFAULT);
	const [runMode, setRunMode] = useState<RunMode>("MODE_A");
	const [saveAsName, setSaveAsName] = useState("");
	/** "configure" is the ordinary dialog; Agentic's Start moves to "confirm"
	 * rather than dispatching directly — a scripted run has no billed step to
	 * confirm, so it skips straight to `onDispatch`. */
	const [stage, setStage] = useState<"configure" | "confirm">("configure");
	/**
	 * True from the moment a SYSTEM configuration is adopted (nothing
	 * remembered for this viewer yet) until the quote answers whether every
	 * selected case has a saved script — the signal that decides the
	 * provisional default. Cleared the moment the user picks a runner
	 * themselves, so this can never override an explicit choice.
	 */
	const [awaitingDefaultRunner, setAwaitingDefaultRunner] = useState(false);

	const adoptSystemConfiguration = (config: {
		id: string;
		environmentId: string | null;
		browser: string | null;
		resolution: string | null;
	}) => {
		setConfigurationId(config.id);
		setEnvironmentId(config.environmentId ?? USE_PROJECT_DEFAULT);
		setResolution(config.resolution ?? USE_PROJECT_DEFAULT);
		// Agentic is the one runner every caller of this dialog may always
		// start — the procedure's own TEST_CASE_UPDATE floor covers it. Set
		// immediately so the dialog never shows a MODE_B default before it
		// knows whether this viewer is even permitted to run one; the effect
		// below settles the real default once the quote answers that.
		setRunMode("MODE_A");
		setBrowser(config.browser ?? USE_PROJECT_DEFAULT);
		setAwaitingDefaultRunner(true);
	};

	// Adopt the first configuration once they load, so the dialog opens on a
	// concrete choice rather than an empty picker the user must fill in.
	useEffect(() => {
		if (!open || configurationId || configurations.length === 0) {
			return;
		}
		const first = configurations[0];
		if (first.isSystem) {
			adoptSystemConfiguration(first);
			return;
		}
		// An explicitly saved (non-system) configuration keeps its own
		// runMode — only the seeded project-default row defers to a
		// remembered or scripted-aware default.
		setConfigurationId(first.id);
		setEnvironmentId(first.environmentId ?? USE_PROJECT_DEFAULT);
		setBrowser(
			first.runMode === "MODE_B"
				? "chromium"
				: (first.browser ?? USE_PROJECT_DEFAULT),
		);
		setResolution(first.resolution ?? USE_PROJECT_DEFAULT);
		setRunMode(first.runMode ?? "MODE_A");
	}, [open, configurationId, configurations]);

	// Settle the provisional default once the quote answers both whether
	// Scripted is RUNNABLE (every selected case has a saved script) and
	// whether it is PERMITTED (dispatch gates MODE_B one rung above this
	// dialog's own TEST_CASE_UPDATE floor — an ordinary EDITOR may not have
	// it). A remembered MODE_B is restored only when still permitted; the
	// scripted-aware fallback applies the same guard. Neither ever regresses
	// below Agentic, which every caller may always start.
	useEffect(() => {
		if (!awaitingDefaultRunner || !quote) {
			return;
		}
		setAwaitingDefaultRunner(false);
		const remembered = readRememberedRunner(projectId);
		if (remembered === "MODE_B") {
			if (quote.scripted.permitted) {
				setRunMode("MODE_B");
				setBrowser("chromium");
			}
			return;
		}
		if (remembered === "MODE_A") {
			return;
		}
		if (
			quote.scripted.permitted &&
			quote.resolvedCaseCount > 0 &&
			quote.scripted.runnableCaseCount === quote.resolvedCaseCount
		) {
			setRunMode("MODE_B");
			setBrowser("chromium");
		}
	}, [awaitingDefaultRunner, quote, projectId]);

	// The dialog always reopens on its first step, never mid-confirmation from
	// a previous visit.
	useEffect(() => {
		if (!open) {
			setStage("configure");
		}
	}, [open]);

	const applyConfiguration = (id: string) => {
		const chosen = configurations.find((c) => c.id === id);
		if (!chosen) {
			setConfigurationId(id);
			return;
		}
		if (chosen.isSystem) {
			adoptSystemConfiguration(chosen);
			return;
		}
		setAwaitingDefaultRunner(false);
		setConfigurationId(id);
		setEnvironmentId(chosen.environmentId ?? USE_PROJECT_DEFAULT);
		setBrowser(
			chosen.runMode === "MODE_B"
				? "chromium"
				: (chosen.browser ?? USE_PROJECT_DEFAULT),
		);
		setResolution(chosen.resolution ?? USE_PROJECT_DEFAULT);
		setRunMode(chosen.runMode ?? "MODE_A");
	};

	const saveMutation = useMutation(
		orpc.projects.agenticRuns.configurations.create.mutationOptions({
			onSuccess: (created) => {
				toast.success(t("saved", { name: created.name }));
				setSaveAsName("");
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.agenticRuns.configurations.list.key(),
				});
				setConfigurationId(created.id);
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	/** Undefined for "project default" — the server then reads the QA policy. */
	const asOverride = (value: string) =>
		value === USE_PROJECT_DEFAULT ? undefined : value;

	const overrides = {
		environmentId: asOverride(environmentId),
		// Narrowed against the closed set rather than cast: the picker can only
		// offer these, but the state is a string and a cast would hide a real
		// mismatch if the two ever drifted apart.
		browser:
			runMode === "MODE_B"
				? "chromium"
				: BROWSERS.find((b) => b === browser),
		resolution: asOverride(resolution),
		runMode,
	};

	// The cap refusal only applies to Agentic — Scripted costs nothing, so it
	// has nothing to be over. Undecided (no quote yet) never counts as over.
	const overCap =
		runMode === "MODE_A" && quote != null && !quote.agentic.withinCap;
	// Scripted is selected but this viewer is not permitted to dispatch one —
	// dispatch would come back FORBIDDEN. Undecided (no quote yet) never
	// counts as unpermitted; the Select's own onChange guard and the default/
	// remembered-runner effect above are what stop this from being reached in
	// the ordinary case, but a saved (non-system) configuration can still
	// carry MODE_B for a viewer who cannot run it, so Start stays gated here
	// regardless of how MODE_B was reached.
	const scriptedNotPermitted =
		runMode === "MODE_B" && quote != null && !quote.scripted.permitted;

	const dispatchNow = () => {
		rememberRunner(projectId, runMode);
		onDispatch(overrides);
	};

	const handleStart = () => {
		if (runMode === "MODE_A") {
			// Agentic spends real tokens — a second, explicit step states the
			// figure before anything is spent. Scripted has nothing to confirm.
			setStage("confirm");
			return;
		}
		dispatchNow();
	};

	const agenticEstimateText = quoteQuery.isLoading
		? t("estimating")
		: quote
			? t("estimateAgentic", {
					cost: formatUsd(quote.agentic.estimatedCostUsd),
					stepCount: quote.agentic.stepCount,
					cap: formatUsd(quote.agentic.capUsd),
				})
			: t("estimateUnavailable");

	const footerLine =
		runMode === "MODE_B"
			? scriptedNotPermitted
				? t("scriptedNotPermittedWarning")
				: t("estimateScripted")
			: overCap && quote
				? t("overCapWarning", {
						cost: formatUsd(quote.agentic.estimatedCostUsd),
						caseCount: quote.agentic.runnableCaseCount,
						stepCount: quote.agentic.stepCount,
						cap: formatUsd(quote.agentic.capUsd),
					})
				: agenticEstimateText;

	// Short per-option summaries so the cheap runner — and whether it is even
	// available to this viewer — is visible in the picker without switching
	// to it first.
	const agenticOptionSuffix = quote
		? ` — ${t("estimateAgenticShort", {
				cost: formatUsd(quote.agentic.estimatedCostUsd),
				stepCount: quote.agentic.stepCount,
			})}`
		: "";
	const scriptedPermitted = quote ? quote.scripted.permitted : true;
	const scriptedOptionSuffix = quote
		? ` — ${
				quote.scripted.permitted
					? t("estimateScriptedShort")
					: t("scriptedNotPermittedShort")
			}`
		: "";

	if (stage === "confirm") {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{t("confirmTitle")}</DialogTitle>
						<DialogDescription>
							{quote
								? t("confirmBody", {
										cost: formatUsd(
											quote.agentic.estimatedCostUsd,
										),
										cap: formatUsd(quote.agentic.capUsd),
									})
								: t("estimateUnavailable")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={dispatching}
							onClick={() => setStage("configure")}
						>
							<ArrowLeftIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
							{t("back")}
						</Button>
						<Button
							type="button"
							disabled={dispatching}
							onClick={dispatchNow}
						>
							{dispatching ? (
								<Loader2Icon
									className="mr-1.5 size-3.5 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<PlayIcon
									className="mr-1.5 size-3.5"
									aria-hidden="true"
								/>
							)}
							{t("confirmAndStart")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>
						{t("description", { count: caseCount })}
					</DialogDescription>
				</DialogHeader>

				{configurationsQuery.isLoading ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</div>
				) : (
					<div className="space-y-4">
						{configurations.length > 0 && (
							<div className="space-y-1.5">
								<Label htmlFor="run-configuration">
									{t("savedConfiguration")}
								</Label>
								<Select
									value={configurationId ?? undefined}
									onValueChange={applyConfiguration}
								>
									<SelectTrigger id="run-configuration">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{configurations.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												{c.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}

						<div className="space-y-1.5">
							<Label htmlFor="run-mode">{t("runner")}</Label>
							<Select
								value={runMode}
								onValueChange={(value: RunMode) => {
									if (
										value === "MODE_B" &&
										!scriptedPermitted
									) {
										// Defence in depth: the disabled SelectItem
										// below should already keep this from firing.
										return;
									}
									// A deliberate choice always wins over the
									// still-pending scripted-aware default.
									setAwaitingDefaultRunner(false);
									setRunMode(value);
									if (value === "MODE_B") {
										setBrowser("chromium");
									}
								}}
							>
								<SelectTrigger id="run-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="MODE_A">
										{t("runnerAgentic")}
										{agenticOptionSuffix}
									</SelectItem>
									<SelectItem
										value="MODE_B"
										disabled={!scriptedPermitted}
									>
										{t("runnerScripted")}
										{scriptedOptionSuffix}
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								{runMode === "MODE_B"
									? t("runnerHintScripted")
									: t("runnerHintAgentic")}
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="run-environment">
								{t("environment")}
							</Label>
							<Select
								value={environmentId}
								onValueChange={setEnvironmentId}
							>
								<SelectTrigger id="run-environment">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={USE_PROJECT_DEFAULT}>
										{t("projectDefault")}
									</SelectItem>
									{environments.map((e) => (
										<SelectItem key={e.id} value={e.id}>
											{t("environmentOption", {
												name: e.name,
												type: e.type,
											})}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="run-browser">
									{t("browser")}
								</Label>
								<Select
									value={browser}
									onValueChange={setBrowser}
									disabled={runMode === "MODE_B"}
								>
									<SelectTrigger id="run-browser">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={USE_PROJECT_DEFAULT}>
											{t("projectDefault")}
										</SelectItem>
										{BROWSERS.map((b) => (
											<SelectItem key={b} value={b}>
												{BROWSER_LABEL[b]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="run-resolution">
									{t("resolution")}
								</Label>
								<Select
									value={resolution}
									onValueChange={setResolution}
								>
									<SelectTrigger id="run-resolution">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={USE_PROJECT_DEFAULT}>
											{t("projectDefault")}
										</SelectItem>
										{SUGGESTED_RESOLUTIONS.map((r) => (
											<SelectItem key={r} value={r}>
												{r}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						<div className="space-y-1.5 border-border border-t pt-3">
							<Label htmlFor="run-save-as">
								{t("saveAs")}{" "}
								<span className="font-normal text-muted-foreground">
									{t("saveAsOptional")}
								</span>
							</Label>
							<div className="flex gap-2">
								<Input
									id="run-save-as"
									value={saveAsName}
									onChange={(e) =>
										setSaveAsName(e.target.value)
									}
									placeholder={t("saveAsPlaceholder")}
								/>
								<Button
									type="button"
									variant="outline"
									disabled={
										saveAsName.trim().length === 0 ||
										saveMutation.isPending
									}
									onClick={() =>
										saveMutation.mutate({
											projectId,
											name: saveAsName.trim(),
											environmentId:
												overrides.environmentId ?? null,
											browser: overrides.browser ?? null,
											resolution:
												overrides.resolution ?? null,
											runMode: overrides.runMode,
										})
									}
								>
									{t("save")}
								</Button>
							</div>
							{/*
							 * Says what a saved configuration does NOT include, because
							 * "save" beside a run dialog reads as "save this run" —
							 * and a saved case list would quietly stop covering cases
							 * added later.
							 */}
							<p className="text-muted-foreground text-xs">
								{t("saveHint")}
							</p>
						</div>
					</div>
				)}

				<DialogFooter>
					<p
						className={cn(
							"mr-auto text-xs",
							overCap || scriptedNotPermitted
								? "font-medium text-destructive"
								: "text-muted-foreground",
						)}
					>
						{footerLine}
					</p>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						disabled={
							dispatching ||
							caseCount === 0 ||
							overCap ||
							scriptedNotPermitted
						}
						onClick={handleStart}
					>
						{dispatching ? (
							<Loader2Icon
								className="mr-1.5 size-3.5 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<PlayIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
						)}
						{t("start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
