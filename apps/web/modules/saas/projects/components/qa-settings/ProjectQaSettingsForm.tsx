"use client";

import { parseArchitectureRules } from "@repo/utils/architecture-rules";
import {
	isOverridingDepthDefault,
	QA_TEST_TYPES,
	type QaTestType,
	resolveRequiredTestTypes,
	scepticRolesSuppressedByDepth,
} from "@repo/utils/qa-test-types";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	BROWSER_LABEL,
	BROWSERS,
	type Browser,
	EVIDENCE_POLICIES,
	EVIDENCE_POLICY_LABEL,
	type EvidencePolicy,
	knownScepticRoles,
	PIPELINE_SYNC_INTERVAL_OPTIONS,
	REQUIRED_TEST_TYPE_LABELS,
	SCEPTIC_DEPTH_INTERACTION_NOTE,
	SCEPTIC_ROLES,
	type ScepticRoleKey,
	STRATEGY_DEPTH_INFO,
	STRATEGY_DEPTHS,
	type StrategyDepth,
	SUGGESTED_RESOLUTIONS,
} from "./qa-settings-constants";
import {
	dirtySections,
	TESTING_SECTIONS,
	type TestingSectionId,
} from "./testing-sections";

/** The editable shape — mirrors the procedure's optional fields. */
type Draft = {
	strategyDepth: StrategyDepth;
	/** Empty = follow the depth tier. See `resolveRequiredTestTypes`. */
	requiredTestTypes: QaTestType[];
	confidenceThreshold: number;
	indexCoverageEnabled: boolean;
	prReviewQaLensEnabled: boolean;
	prReviewArchitectureLensEnabled: boolean;
	prReviewAutoReviewEnabled: boolean;
	architectureRules: string;
	coverageTarget: number;
	resolutions: string[];
	browsers: Browser[];
	rulesMarkdown: string;
	implementationNotes: string;
	evidencePolicy: EvidencePolicy;
	evidenceRetentionDays: number;
	scepticRolesEnabled: boolean;
	scepticRoles: ScepticRoleKey[];
	/** People who must sign off before a feature reaches Done. 0 = no gate. */
	requiredQaSignOffs: number;
	defaultEnvironmentId: string | null;
	pipelineSyncEnabled: boolean;
	pipelineSyncIntervalMinutes: number;
};

/**
 * A comparison key for "has anything actually changed since the last save".
 *
 * The three list fields are sets in everything but type — `toggleIn` drops a
 * value and re-appends it at the end — so they are sorted before comparison.
 * Without that, toggling a chip off and back on would leave the form claiming
 * unsaved changes it does not have.
 */
function draftFingerprint(draft: Draft): string {
	return JSON.stringify({
		...draft,
		resolutions: [...draft.resolutions].sort(),
		browsers: [...draft.browsers].sort(),
		scepticRoles: [...draft.scepticRoles].sort(),
		requiredTestTypes: [...draft.requiredTestTypes].sort(),
	});
}

/** Sentinel for "no default target" — Radix Select cannot hold an empty value. */
const NO_ENVIRONMENT = "__none__";

/**
 * Settings ▸ Testing — the project's default QA policy.
 *
 * One form, saved as a whole: rigor, the confidence needed to record a verdict,
 * coverage tracking and its target, the devices/browsers to exercise, the rules
 * and evidence expected of automation, and which adversarial sceptic roles may
 * append cases. Environments are shown read-only here and edited in Settings ▸
 * Environments, so a base URL keeps one source of truth.
 */
export function ProjectQaSettingsForm({
	projectId,
	canEdit,
	onManageEnvironments,
	section,
}: {
	projectId: string;
	canEdit: boolean;
	onManageEnvironments?: () => void;
	/**
	 * Render only this section's controls. The component stays MOUNTED across
	 * section changes — the parent renders it in the same position and only
	 * changes this prop — so the one shared draft, and any unsaved edits in it,
	 * survive moving between sections. Unset renders every section, which is how
	 * the form behaved before it was sectioned and what its tests exercise.
	 */
	section?: TestingSectionId;
}) {
	const queryClient = useQueryClient();

	const settingsQuery = useQuery(
		orpc.projects.qaSettings.get.queryOptions({ input: { projectId } }),
	);
	const environmentsQuery = useQuery(
		orpc.projects.environments.list.queryOptions({ input: { projectId } }),
	);

	const [draft, setDraft] = useState<Draft | null>(null);
	// The last known-saved values, kept beside the draft so the action bar can
	// say whether anything is genuinely unsaved — and so Discard has something
	// to return to.
	const [saved, setSaved] = useState<Draft | null>(null);

	// Seed the draft from the server once it arrives (and whenever a save
	// returns), so the form always reflects what is actually stored.
	const loaded = settingsQuery.data;
	useEffect(() => {
		if (!loaded) {
			return;
		}
		const fromServer: Draft = {
			strategyDepth: loaded.strategyDepth as StrategyDepth,
			// Unknown values are dropped rather than shown as chips nothing can
			// select, matching how `knownScepticRoles` treats its own list.
			requiredTestTypes: QA_TEST_TYPES.filter((type) =>
				(loaded.requiredTestTypes ?? []).includes(type),
			),
			confidenceThreshold: loaded.confidenceThreshold,
			indexCoverageEnabled: loaded.indexCoverageEnabled,
			prReviewQaLensEnabled: loaded.prReviewQaLensEnabled,
			prReviewArchitectureLensEnabled:
				loaded.prReviewArchitectureLensEnabled,
			prReviewAutoReviewEnabled: loaded.prReviewAutoReviewEnabled,
			architectureRules: loaded.architectureRules ?? "",
			coverageTarget: loaded.coverageTarget,
			resolutions: loaded.resolutions,
			browsers: loaded.browsers as Browser[],
			rulesMarkdown: loaded.rulesMarkdown ?? "",
			implementationNotes: loaded.implementationNotes ?? "",
			evidencePolicy: loaded.evidencePolicy as EvidencePolicy,
			evidenceRetentionDays: loaded.evidenceRetentionDays,
			scepticRolesEnabled: loaded.scepticRolesEnabled,
			scepticRoles: knownScepticRoles(loaded.scepticRoles),
			requiredQaSignOffs: loaded.requiredQaSignOffs,
			defaultEnvironmentId: loaded.defaultEnvironmentId,
			pipelineSyncEnabled: loaded.pipelineSyncEnabled,
			pipelineSyncIntervalMinutes: loaded.pipelineSyncIntervalMinutes,
		};
		setDraft(fromServer);
		setSaved(fromServer);
	}, [loaded]);

	const saveMutation = useMutation(
		orpc.projects.qaSettings.update.mutationOptions({
			onSuccess: () => {
				toast.success("Testing settings saved");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.qaSettings.get.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	if (settingsQuery.isLoading || !draft) {
		return (
			<div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				Loading testing settings…
			</div>
		);
	}

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((d) => (d ? { ...d, [key]: value } : d));

	const toggleIn = (list: string[], value: string) =>
		list.includes(value)
			? list.filter((v) => v !== value)
			: [...list, value];

	const environments = environmentsQuery.data ?? [];
	const isDirty =
		saved !== null && draftFingerprint(draft) !== draftFingerprint(saved);

	/** Whether `id`'s controls belong on screen right now. */
	const show = (id: TestingSectionId) =>
		section === undefined || section === id;

	// Which sections hold unsaved edits — the save bar names them, so "Save
	// changes" never asks a reader to commit an edit they made three sections
	// ago and have since forgotten.
	// Which enabled roles this project's depth is currently silencing. Derived
	// from the DRAFT, not the saved policy, so the answer moves as the reader
	// changes depth rather than after they save and reload.
	// Parsed from the DRAFT so a malformed line is named while the author is
	// still typing it, rather than after a save they then have to undo.
	const ruleErrors = parseArchitectureRules(draft.architectureRules).errors;
	const suppressed = new Set(
		scepticRolesSuppressedByDepth({
			depth: draft.strategyDepth,
			requiredTestTypes: draft.requiredTestTypes,
			scepticRoles: draft.scepticRoles,
			scepticRolesEnabled: draft.scepticRolesEnabled,
		}),
	);
	const dirty = dirtySections(draft, saved);
	const dirtyLabels = TESTING_SECTIONS.filter((s) =>
		dirty.includes(s.id),
	).map((s) => s.label);

	// What the project actually requires right now: its own list, or the tier's
	// when it has never set one. The chips render the RESOLVED set, so a reader
	// following the tier still sees which types that means rather than an empty
	// row they have to infer from the tier bullets.
	const effectiveTestTypes = resolveRequiredTestTypes(
		draft.strategyDepth,
		draft.requiredTestTypes,
	);
	const overridingDepthDefault = isOverridingDepthDefault(
		draft.strategyDepth,
		draft.requiredTestTypes,
	);

	return (
		<div className="space-y-4">
			{/* Only shown on the all-sections rendering. When the page supplies a
			    section, the panel around it prints the title and blurb, and a
			    second heading here would just repeat it. */}
			{section === undefined && (
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<p className="app-editorial-label">
							Testing configuration
						</p>
						<h3 className="mt-2 font-semibold text-foreground text-xl">
							Testing
						</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							Default testing policy for this project — rigor,
							evidence, and sceptic roles.
							{!settingsQuery.data?.configured && (
								<span className="ml-1 italic">
									Currently using Fabric defaults.
								</span>
							)}
						</p>
					</div>
					{canEdit && (
						// Everything in this block is a draft until the bar at
						// the bottom is used. Said out loud because the
						// generation controls save each toggle instantly — two
						// save models on one page, previously with nothing to
						// tell them apart.
						<p className="text-muted-foreground text-xs">
							Draft — nothing here applies until you save.
						</p>
					)}
				</div>
			)}

			{/* Strategy & depth */}
			{show("depth") && (
				<Section
					title="Strategy & depth"
					description="The default rigor applied when planning or running tests. This decides what Fabric writes as TEST CASES — Settings ▸ AI Assistant has a similarly-named depth that decides how deep the Testing Strategy document goes. Two settings, two artifacts."
				>
					<div className="grid gap-2">
						{STRATEGY_DEPTHS.map((depth) => {
							const info = STRATEGY_DEPTH_INFO[depth];
							const selected = draft.strategyDepth === depth;
							return (
								<button
									key={depth}
									type="button"
									disabled={!canEdit}
									aria-pressed={selected}
									onClick={() => set("strategyDepth", depth)}
									className={cn(
										"rounded-lg border p-3 text-left motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
										selected
											? "border-primary bg-primary/5"
											: "hover:bg-accent/50",
										!canEdit &&
											"cursor-not-allowed opacity-70",
									)}
								>
									<div className="flex items-center gap-2">
										<span
											aria-hidden="true"
											className={cn(
												"flex size-4 shrink-0 items-center justify-center rounded-full border",
												selected
													? "border-primary bg-primary text-primary-foreground"
													: "border-muted-foreground/40",
											)}
										>
											{selected && (
												<CheckIcon className="size-2.5" />
											)}
										</span>
										<span className="font-medium text-sm">
											{info.label}
										</span>
									</div>
									<ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-6 text-muted-foreground text-xs">
										{info.bullets.map((b) => (
											<li key={b}>· {b}</li>
										))}
									</ul>
								</button>
							);
						})}
					</div>

					{/* Which kinds of test the tier above actually asks for.
					    Before this control the answer existed only inside the
					    drafting prompt, so a reader could pick a tier and had no
					    way to see — let alone change — what it meant. */}
					<div className="mt-4 border-t pt-4">
						<Label>Required test types</Label>
						<p className="text-muted-foreground text-xs">
							Every drafted suite gives each of these at least one
							case.{" "}
							{overridingDepthDefault
								? "This project has set its own list, so the tier above no longer decides it."
								: "Following the tier above — change any chip to set your own list."}
						</p>
						<div className="mt-2 flex flex-wrap gap-2">
							{QA_TEST_TYPES.map((type) => {
								const checked =
									effectiveTestTypes.includes(type);
								return (
									<button
										key={type}
										type="button"
										disabled={!canEdit}
										aria-pressed={checked}
										onClick={() =>
											set(
												"requiredTestTypes",
												QA_TEST_TYPES.filter((t) =>
													t === type
														? !checked
														: effectiveTestTypes.includes(
																t,
															),
												),
											)
										}
										className={cn(
											"rounded-full border px-3 py-1 text-xs motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
											checked
												? "border-primary bg-primary/5 font-medium"
												: "text-muted-foreground hover:bg-accent/50",
											!canEdit &&
												"cursor-not-allowed opacity-70",
										)}
									>
										{REQUIRED_TEST_TYPE_LABELS[type]}
									</button>
								);
							})}
						</div>
						{overridingDepthDefault && canEdit && (
							<button
								type="button"
								onClick={() => set("requiredTestTypes", [])}
								className="mt-2 text-primary text-xs underline underline-offset-2"
							>
								Follow the depth tier again
							</button>
						)}
					</div>
				</Section>
			)}

			{/* Pull-request review lenses */}
			{show("reviewLenses") && (
				<Section
					title="Pull-request review"
					description="Which lenses run when someone reviews a pull request Fabric has read."
				>
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<Label htmlFor="pr-lens-qa">Test coverage</Label>
							<p className="text-muted-foreground text-xs">
								Checks a change against this project's features
								and the cases already covering them. Uses AI and
								spends credits.
							</p>
						</div>
						<Switch
							id="pr-lens-qa"
							checked={draft.prReviewQaLensEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("prReviewQaLensEnabled", v)
							}
						/>
					</div>

					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
						<div className="min-w-0">
							<Label htmlFor="pr-lens-architecture">
								Circular imports
							</Label>
							<p className="text-muted-foreground text-xs">
								Computed from the indexed import graph — no AI,
								no credits. Needs an Atlas analysis for the
								repository.
							</p>
						</div>
						<Switch
							id="pr-lens-architecture"
							checked={draft.prReviewArchitectureLensEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("prReviewArchitectureLensEnabled", v)
							}
						/>
					</div>

					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
						<div className="min-w-0">
							<Label htmlFor="pr-auto-review">
								Review every pull request automatically
							</Label>
							<p className="text-muted-foreground text-xs">
								When a pull request is opened or updated, Fabric
								runs the lenses above and leaves the result as a
								comment on it, edited in place on later pushes.
								Off by default, and it blocks no merge. Needs
								the repository's webhook pointed at Fabric.
							</p>
						</div>
						<Switch
							id="pr-auto-review"
							checked={draft.prReviewAutoReviewEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("prReviewAutoReviewEnabled", v)
							}
						/>
					</div>

					<div className="mt-4 space-y-1.5 border-t pt-4">
						<Label htmlFor="architecture-rules">
							Forbidden imports
						</Label>
						<p className="text-muted-foreground text-xs">
							The imports your architecture forbids, and the ones
							it requires, one rule per line. Use{" "}
							<code className="font-mono">-&gt;</code> for an
							import that must not happen and{" "}
							<code className="font-mono">=&gt;</code> for one
							that must, then a colon and your reason. Fabric
							checks your import graph against these — nothing is
							inferred from folder names, so a project that lists
							nothing gets no findings.
						</p>
						<Textarea
							id="architecture-rules"
							rows={5}
							className="font-mono text-xs"
							placeholder={[
								"src/ui/** -> src/db/** : the UI must not reach the database directly",
								"src/routes/** => src/auth/guard.ts : every route checks the session",
							].join("\n")}
							value={draft.architectureRules}
							disabled={!canEdit}
							onChange={(e) =>
								set("architectureRules", e.target.value)
							}
						/>
						{ruleErrors.length > 0 && (
							// Named per line rather than rejecting the box. The
							// author has to be able to find the one that is
							// wrong without hunting for it.
							<ul className="space-y-0.5 text-destructive text-xs">
								{ruleErrors.map(
									(err: {
										line: number;
										problem: string;
									}) => (
										<li key={err.line}>
											Line {err.line}: {err.problem}
										</li>
									),
								)}
							</ul>
						)}
					</div>

					<p className="mt-4 border-t pt-4 text-muted-foreground text-xs">
						Turning a lens off stops new runs. Findings it already
						produced stay readable — switching a lens off is not the
						same as deleting somebody's accepted findings.
					</p>
				</Section>
			)}

			{/* Confidence + coverage */}
			{show("coverage") && (
				<Section
					title="Confidence & coverage"
					description="The bar a verdict must clear, and how much of the suite you expect to be covered."
				>
					<PercentField
						id="confidence-threshold"
						label="Confidence threshold"
						hint="How sure Fabric must be about a step to record a pass or fail. Below this it reports Needs review instead. Set to 0 to always take the verdict."
						value={draft.confidenceThreshold}
						disabled={!canEdit}
						onChange={(v) => set("confidenceThreshold", v)}
					/>

					<div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
						<div className="min-w-0">
							<Label htmlFor="index-coverage">
								Index coverage
							</Label>
							<p className="text-muted-foreground text-xs">
								Measures the automation figure on the Testing
								tab against the target below. Turn it off and
								the rings report coverage without a target to
								clear.
							</p>
						</div>
						<Switch
							id="index-coverage"
							checked={draft.indexCoverageEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("indexCoverageEnabled", v)
							}
						/>
					</div>

					{draft.indexCoverageEnabled && (
						<div className="mt-4">
							<PercentField
								id="coverage-target"
								label="Coverage target"
								hint="The level the coverage rings are measured against."
								value={draft.coverageTarget}
								disabled={!canEdit}
								onChange={(v) => set("coverageTarget", v)}
							/>
						</div>
					)}
				</Section>
			)}

			{/* Environments (read-only reference) */}
			{show("environments") && (
				<Section
					title="Environments"
					description="Run targets are defined once in Settings ▸ Environments and reused here."
					action={
						onManageEnvironments && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={onManageEnvironments}
							>
								Manage
							</Button>
						)
					}
				>
					{environmentsQuery.isError ? (
						/*
						 * A failed load must not read as "none defined": that sends
						 * the reader to Settings ▸ Environments to re-create targets
						 * that already exist, and it silently hides the
						 * default-environment picker below.
						 */
						<p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-destructive text-sm">
							Couldn't load this project's environments.
						</p>
					) : environments.length === 0 ? (
						<p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-muted-foreground text-sm">
							No environments defined yet.
						</p>
					) : (
						<div className="space-y-3">
							<ul className="divide-y divide-border rounded-md border">
								{environments.map((env) => (
									<li
										key={env.id}
										className="flex items-center gap-3 px-3 py-2"
									>
										<span className="w-20 shrink-0 text-muted-foreground text-xs uppercase">
											{env.type}
										</span>
										<span className="min-w-0 flex-1 truncate text-sm">
											{env.name}
										</span>
										<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
											{env.baseUrl}
										</span>
									</li>
								))}
							</ul>
							<div className="space-y-1.5">
								<Label htmlFor="default-env">
									Default environment for planned runs
								</Label>
								<Select
									value={
										draft.defaultEnvironmentId ??
										NO_ENVIRONMENT
									}
									disabled={!canEdit}
									onValueChange={(value) =>
										set(
											"defaultEnvironmentId",
											value === NO_ENVIRONMENT
												? null
												: value,
										)
									}
								>
									<SelectTrigger id="default-env">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={NO_ENVIRONMENT}>
											No default
										</SelectItem>
										{environments.map((env) => (
											<SelectItem
												key={env.id}
												value={env.id}
											>
												{env.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					)}
					<p className="mt-2 text-muted-foreground text-xs">
						Read-only reference — edits are made in Settings ▸
						Environments so every surface shares one source of
						truth.
					</p>
				</Section>
			)}

			{/* Devices & browsers */}
			{show("devices") && (
				<Section
					title="Devices & browsers"
					description="Default resolutions and browser engines."
				>
					<Label>Default resolution</Label>
					<div className="mt-1.5 flex flex-wrap gap-2">
						{[
							...new Set([
								...SUGGESTED_RESOLUTIONS,
								...draft.resolutions,
							]),
						].map((res) => (
							<Chip
								key={res}
								label={res}
								selected={draft.resolutions.includes(res)}
								disabled={!canEdit}
								onClick={() =>
									set(
										"resolutions",
										toggleIn(draft.resolutions, res),
									)
								}
							/>
						))}
					</div>

					<Label className="mt-4 block">Default browser</Label>
					<div className="mt-1.5 flex flex-wrap gap-2">
						{BROWSERS.map((browser) => (
							<Chip
								key={browser}
								label={BROWSER_LABEL[browser]}
								selected={draft.browsers.includes(browser)}
								disabled={!canEdit}
								onClick={() =>
									set(
										"browsers",
										toggleIn(
											draft.browsers,
											browser,
										) as Browser[],
									)
								}
							/>
						))}
					</div>
				</Section>
			)}

			{/* Rules & evidence */}
			{show("rules") && (
				<Section
					title="Rules & evidence"
					description="Policy enforced by automation."
				>
					<div className="space-y-1.5">
						<Label htmlFor="rules-markdown">Rules (markdown)</Label>
						<Textarea
							id="rules-markdown"
							rows={4}
							disabled={!canEdit}
							value={draft.rulesMarkdown}
							placeholder="e.g. Every acceptance criterion needs a negative-path case."
							onChange={(e) =>
								set("rulesMarkdown", e.target.value)
							}
						/>
					</div>
					<div className="mt-3 space-y-1.5">
						<Label htmlFor="impl-notes">Implementation notes</Label>
						<Textarea
							id="impl-notes"
							rows={3}
							disabled={!canEdit}
							value={draft.implementationNotes}
							placeholder="Anything an agent should know before writing tests here."
							onChange={(e) =>
								set("implementationNotes", e.target.value)
							}
						/>
					</div>
					<div className="mt-3 space-y-1.5">
						<Label htmlFor="evidence-policy">Evidence policy</Label>
						<Select
							value={draft.evidencePolicy}
							disabled={!canEdit}
							onValueChange={(v) =>
								set("evidencePolicy", v as EvidencePolicy)
							}
						>
							<SelectTrigger id="evidence-policy">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{EVIDENCE_POLICIES.map((policy) => (
									<SelectItem key={policy} value={policy}>
										{EVIDENCE_POLICY_LABEL[policy]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="mt-3 space-y-1.5">
						<Label htmlFor="evidence-retention-days">
							Keep evidence for
						</Label>
						<Input
							id="evidence-retention-days"
							type="number"
							inputMode="numeric"
							min={0}
							max={3650}
							step={1}
							value={draft.evidenceRetentionDays}
							disabled={!canEdit}
							onChange={(e) => {
								// Clamped here as well as server-side, for the same
								// reason the sign-off count is: a value the API will
								// reject should not sit in the form looking saved.
								const next = Number.parseInt(
									e.target.value,
									10,
								);
								set(
									"evidenceRetentionDays",
									Number.isNaN(next)
										? 0
										: Math.max(0, Math.min(3650, next)),
								);
							}}
						/>
						<p className="text-muted-foreground text-xs">
							Days a run's screenshots are kept. They outlive the
							run, the test case and the project, so deleting a
							case does not erase the proof of what it once did.
							Set to 0 to keep them indefinitely.
						</p>
					</div>
				</Section>
			)}

			{/* Automatic result sync */}
			{show("sync") && (
				<Section
					title="Automatic result sync"
					description="Fabric checks your connected repositories for new CI test results on its own."
					action={
						<Switch
							aria-label="Enable automatic result sync"
							checked={draft.pipelineSyncEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("pipelineSyncEnabled", v)
							}
						/>
					}
				>
					<div className="space-y-2">
						<Label htmlFor="pipeline-sync-interval">
							Check at most every
						</Label>
						<Select
							value={String(draft.pipelineSyncIntervalMinutes)}
							disabled={!canEdit || !draft.pipelineSyncEnabled}
							onValueChange={(v) =>
								set("pipelineSyncIntervalMinutes", Number(v))
							}
						>
							<SelectTrigger
								id="pipeline-sync-interval"
								className="w-56"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PIPELINE_SYNC_INTERVAL_OPTIONS.map(
									(option) => (
										<SelectItem
											key={option.minutes}
											value={String(option.minutes)}
										>
											{option.label}
										</SelectItem>
									),
								)}
							</SelectContent>
						</Select>
						{/*
						 * Says what OFF actually costs. The sweep exists because
						 * "the tab is empty" and "the tab is stale" look identical,
						 * and a toggle re-introduces that on request — so the
						 * consequence is stated rather than left to be discovered.
						 */}
						<p className="text-muted-foreground text-xs">
							{draft.pipelineSyncEnabled
								? "A floor, not a schedule: Fabric never checks more often than this, and may check less often when it is busy. Results can still be older than the interval if your pipeline is slow to publish."
								: "Automatic checking is off. Results will only appear when someone presses “Sync now” — until then the tab shows the last results Fabric saw, which may be old."}
						</p>
					</div>
				</Section>
			)}

			{/* Sign-off */}
			{show("signOff") && (
				<Section
					title="Sign-off"
					description="How many people must record a QA sign-off before a feature can move to Done. The gate counts distinct people per feature, so the same person signing twice does not clear a threshold of two."
				>
					<div className="max-w-xs">
						<Label htmlFor="required-qa-sign-offs">
							Required sign-offs
						</Label>
						<p className="text-muted-foreground text-xs">
							Zero disables the gate. A feature that has not
							collected enough sign-offs is refused the move to
							Done, and the refusal names how many it has.
						</p>
						<Input
							id="required-qa-sign-offs"
							type="number"
							inputMode="numeric"
							min={0}
							max={10}
							step={1}
							className="mt-2"
							value={draft.requiredQaSignOffs}
							disabled={!canEdit}
							onChange={(e) => {
								// Clamped here as well as server-side: the input
								// lets a reader type 40, and a value the API will
								// reject should not sit in the form looking saved.
								const next = Number.parseInt(
									e.target.value,
									10,
								);
								set(
									"requiredQaSignOffs",
									Number.isNaN(next)
										? 0
										: Math.max(0, Math.min(10, next)),
								);
							}}
						/>
					</div>
				</Section>
			)}

			{/* Sceptic roles */}
			{show("sceptics") && (
				<Section
					title="Sceptic roles"
					description="Adversarial AI personas that append extra cases during planning. Each one reviews the feature through its own lens and its cases arrive as Proposed, for a person to accept or reject. Which kinds of test the project requires is set under Depth & scope."
					action={
						<Switch
							aria-label="Enable sceptic roles"
							checked={draft.scepticRolesEnabled}
							disabled={!canEdit}
							onCheckedChange={(v) =>
								set("scepticRolesEnabled", v)
							}
						/>
					}
				>
					{/* Depth and these roles both decide what gets written, so a
				    reader picking Easy with the Security Reviewer left on needs
				    to know which one governs. An enabled role wins. */}
					<p className="mb-3 text-muted-foreground text-xs">
						{SCEPTIC_DEPTH_INTERACTION_NOTE}
					</p>
					<ul
						className={cn(
							"space-y-2",
							!draft.scepticRolesEnabled && "opacity-50",
						)}
					>
						{SCEPTIC_ROLES.map((role) => {
							const checked = draft.scepticRoles.includes(
								role.key,
							);
							return (
								<li
									key={role.key}
									className="flex items-start justify-between gap-3 rounded-md border p-3"
								>
									<div className="min-w-0">
										<p className="font-medium text-sm">
											{role.label}
										</p>
										<p className="text-muted-foreground text-xs">
											{role.description}
										</p>
										{/* Named rather than left silent. A chip
										    shown as on while its depth stops it
										    producing anything is the failure this
										    whole change replaced, so the page has
										    to say which roles are currently
										    capped and how to get one back. */}
										{checked &&
											suppressed.has(role.key) && (
												<p className="mt-1 text-highlight text-xs">
													Silenced by this project's
													depth. Tick its dimension
													under Depth &amp; scope to
													keep it.
												</p>
											)}
									</div>
									<Switch
										aria-label={role.label}
										checked={checked}
										disabled={
											!canEdit ||
											!draft.scepticRolesEnabled
										}
										onCheckedChange={() =>
											set(
												"scepticRoles",
												knownScepticRoles(
													toggleIn(
														draft.scepticRoles,
														role.key,
													),
												),
											)
										}
									/>
								</li>
							);
						})}
					</ul>
				</Section>
			)}

			{canEdit && (
				// Sticky, and it names WHERE the unsaved change is. Sectioning
				// the page made that necessary: an edit made under Depth & scope
				// is no longer on screen once the reader moves to CI & sync, so
				// "Unsaved changes" alone would ask them to commit something
				// they can no longer see. A run also refuses to dispatch until a
				// default environment is *saved*, which is exactly the trap this
				// bar exists to keep out of.
				<div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-3">
					<p
						className="text-muted-foreground text-xs"
						role="status"
						aria-live="polite"
					>
						{isDirty
							? dirtyLabels.length > 0
								? `Unsaved changes in ${dirtyLabels.join(", ")}`
								: "Unsaved changes"
							: "All changes saved"}
					</p>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="ghost"
							disabled={!isDirty || saveMutation.isPending}
							onClick={() => setDraft(saved)}
						>
							Discard
						</Button>
						<Button
							type="button"
							disabled={!isDirty || saveMutation.isPending}
							onClick={() =>
								saveMutation.mutate({
									projectId,
									...draft,
									rulesMarkdown: draft.rulesMarkdown || null,
									implementationNotes:
										draft.implementationNotes || null,
								})
							}
							className="gap-1.5"
						>
							{saveMutation.isPending && (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							)}
							Save changes
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function Section({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-lg border bg-card p-4">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h4 className="font-medium text-sm">{title}</h4>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{description}
					</p>
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/** A 0–100 slider with its live value — used by both percentage settings. */
function PercentField({
	id,
	label,
	hint,
	value,
	disabled,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	value: number;
	disabled: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<div>
			<div className="flex items-baseline justify-between gap-3">
				<Label htmlFor={id}>{label}</Label>
				<span className="font-semibold text-sm tabular-nums">
					{value}%
				</span>
			</div>
			<p className="text-muted-foreground text-xs">{hint}</p>
			<div className="mt-2 flex items-center gap-3">
				<Slider
					id={id}
					min={0}
					max={100}
					step={5}
					disabled={disabled}
					value={[value]}
					onValueChange={([next]) => onChange(next ?? value)}
					className="flex-1"
				/>
				<Input
					type="number"
					min={0}
					max={100}
					disabled={disabled}
					value={value}
					aria-label={`${label} value`}
					onChange={(e) => {
						const next = Number.parseInt(e.target.value, 10);
						if (Number.isFinite(next)) {
							onChange(Math.max(0, Math.min(100, next)));
						}
					}}
					className="w-20"
				/>
			</div>
		</div>
	);
}

function Chip({
	label,
	selected,
	disabled,
	onClick,
}: {
	label: string;
	selected: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={selected}
			onClick={onClick}
			className={cn(
				"rounded-full border px-3 py-1 text-xs motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				selected
					? "border-primary bg-primary/10 text-foreground"
					: "text-muted-foreground hover:bg-accent/50",
				disabled && "cursor-not-allowed opacity-70",
			)}
		>
			{label}
		</button>
	);
}
