"use client";

import { MIN_DESCRIPTION_LENGTH } from "@repo/api/modules/projects/lib/readiness/thresholds";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckIcon,
	HelpCircleIcon,
	Loader2Icon,
	PlusIcon,
	SparklesIcon,
	Undo2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import type { SlackChannelSelection } from "../../lib/integration-selection-types";
import { PROJECT_TYPES } from "../../lib/project-constants";
import { ContextUploaderDialog } from "../ContextUploaderDialog";
import { ContextPendingItemsList } from "./ContextPendingItemsList";
import { WizardBacklogCard } from "./WizardBacklogCard";
// `WizardIntegrationsSection` renders the "Code Repository" section as a plain
// section (GitHub + GitLab + Azure DevOps provider cards). `AzureDevOpsRepo`
// flows through `onAzureDevOpsReposChange` so the wizard captures the PAT into
// transient state and connects repos post-create.
import {
	type AzureDevOpsRepo,
	type GitHubRepo,
	type GitLabProject,
	type NotionPageSelection,
	type TeamsChatSelection,
	WizardIntegrationsSection,
} from "./WizardIntegrationsSection";

type ProjectFormData = {
	name: string;
	description: string;
	projectPhase: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION" | "";
	expectedDevelopmentStartDate: string;
	projectTypes: string[];
	icon: string;
	color: string;
	tags: string[];
	techStack: string[];
	features: string[];
	customRequirements: string;
	documents: string[];
	previousDescription: string | null;
	tempContextIds: string[];
	/**
	 * @deprecated post-2026-05-23 wizard refactor (unified context uploader spec
	 * §7.4 + Group 9). The wizard no longer collects Teams chats from its UI —
	 * the Add Context dialog writes directly to `ProjectContext`. Field retained
	 * for back-compat with persisted `wizardState` blobs on in-flight DRAFTs.
	 * Remove after the 14-day cron sweep per §17 follow-up.
	 */
	selectedTeamsChats: TeamsChatSelection[];
	/**
	 * @deprecated post-2026-05-23 wizard refactor — see `selectedTeamsChats`
	 * above. Retained for back-compat with persisted `wizardState` blobs.
	 */
	selectedNotionPages: NotionPageSelection[];
	selectedGitHubRepos: GitHubRepo[];
	selectedGitLabRepos: GitLabProject[];
	selectedAzureDevOpsRepos: AzureDevOpsRepo[];
	/**
	 * @deprecated post-2026-05-23 wizard refactor — see `selectedTeamsChats`
	 * above. Retained for back-compat with persisted `wizardState` blobs.
	 */
	selectedSlackChannels: SlackChannelSelection[];
	// Unified-project-setup spec §4.3/§4.4/§4.5 (D2/D9) — folded from the
	// Existing flow. The Brief step now hosts the optional Backlog + Repository
	// cards and website URLs.
	codebaseRepoUrls: string[];
	primaryWebsiteUrl: string;
	additionalWebsiteUrls: string[];
	projectManagementMcpConfigId: string | null;
	projectManagementMcpServerId: string | null;
	projectManagementContainerId: string | null;
	projectManagementContainerName: string | null;
	projectManagementAdditionalContext: Record<string, unknown> | null;
	projectManagementDetectedType: string | null;
	documentPrompts: Record<
		string,
		{ promptId?: string; customInstructions?: string }
	>;
};

interface BasicInfoStepProps {
	formData: ProjectFormData;
	updateFormData: (updates: Partial<ProjectFormData>) => void;
	wizardSessionId: string;
	organizationId?: string;
	draftKey?: string;
	isEditMode?: boolean;
	onDuplicateNameChange?: (isDuplicate: boolean) => void;
	/**
	 * Azure DevOps selection handler. The wizard owns this (not `updateFormData`)
	 * because the PAT in `creds` must be captured into wizard-only state and
	 * NEVER written to the persisted `formData` snapshot.
	 */
	onAzureDevOpsReposChange?: (
		repos: AzureDevOpsRepo[],
		creds?: { pat: string; azureOrganization: string },
	) => void;
	/** Pass for edit mode — enables team credential fallback in GitHub repo picker */
	projectId?: string;
	/** "saving" / "saved" / "error" badge driven by the wizard-root autosave mutation */
	draftSaveState?: "idle" | "saving" | "saved" | "error";
}

export function BasicInfoStep({
	formData,
	updateFormData,
	wizardSessionId,
	organizationId,
	draftKey: _draftKey,
	isEditMode,
	onDuplicateNameChange,
	onAzureDevOpsReposChange,
	projectId,
	draftSaveState = "idle",
}: BasicInfoStepProps) {
	// Warm-neutral editorial card surface (unified-project-setup spec §4.8 /
	// TG6 chrome cleanup): solid `bg-card` + `border-border`, no glassmorphism
	// (no blur, no semi-transparent card fill) and no glassy inner shadow.
	// Replaces the pre-redesign glassy chrome the 2026-05-23
	// unified-context-uploader spec (§7.7/§17) deferred to this follow-up.
	const sectionClassName = "rounded-2xl border border-border bg-card p-5";

	// Add Context dialog open state. Disabled until `formData.name` is
	// non-empty (DRAFT must exist before context items can be added per
	// spec §7.3). The CTA itself is keyboard-activatable + carries an
	// `aria-label` per §7.8 accessibility checklist.
	const [contextDialogOpen, setContextDialogOpen] = useState(false);

	// Debounced name only drives the duplicate-name check; the wizard-root
	// autosave handles persistence (including the name field).
	const [debouncedName] = useDebounceValue(formData.name, 500);

	// Duplicate name check (new wizard only) — uses a dedicated endpoint that
	// mirrors the exact same uniqueness rules as project creation (org-wide vs.
	// personal-owner-only), avoiding false positives/negatives from projects.list.
	const trimmedDebouncedName = debouncedName.trim();
	const { data: nameCheckData } = useQuery({
		...orpc.projects.checkName.queryOptions({
			input: {
				name: trimmedDebouncedName,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !isEditMode && trimmedDebouncedName.length >= 1,
	});
	const isDuplicateName =
		!isEditMode &&
		trimmedDebouncedName.length >= 1 &&
		nameCheckData?.available === false;

	// Notify parent when duplicate state changes
	useEffect(() => {
		onDuplicateNameChange?.(isDuplicateName);
	}, [isDuplicateName, onDuplicateNameChange]);

	// Toggle project type selection (multi-select)
	const toggleProjectType = (typeValue: string) => {
		const newTypes = formData.projectTypes.includes(typeValue)
			? formData.projectTypes.filter((t) => t !== typeValue)
			: [...formData.projectTypes, typeValue];
		updateFormData({ projectTypes: newTypes });
	};

	// Refine description mutation
	const refineMutation = useMutation(
		orpc.wizard.refineDescription.mutationOptions({
			onSuccess: (data) => {
				// Save previous description for undo
				updateFormData({
					previousDescription: formData.description,
					description: data.refinedDescription,
				});
				toast.success("Description refined!");
			},
			onError: (error) => {
				toast.error(`Failed to refine: ${error.message}`);
			},
		}),
	);

	// Query the DRAFT/project contexts so we can both (a) derive a list of
	// COMPLETED file/text titles to send as `attachmentSummaries` (defensive
	// fallback when RAG returns 0 — covers the "files added but still
	// embedding" race) and (b) pass `projectId` to the refine procedure so
	// the server-side path queries the project-contexts Qdrant collection.
	// TanStack Query dedupes with `ContextPendingItemsList`'s identical
	// query — no extra network cost.
	const refineContextsQuery = useQuery({
		...orpc.projects.contexts.list.queryOptions({
			input: { projectId: projectId ?? "", organizationId },
		}),
		enabled: !!projectId,
	});

	const handleRefineDescription = () => {
		if (!formData.description.trim()) {
			toast.error("Please enter a description first");
			return;
		}

		// Collect titles + content snippets from COMPLETED contexts as a
		// `attachmentSummaries` fallback. Activated server-side only when
		// both RAG paths return zero results (e.g., embeddings still in
		// flight). For LINK contexts the original URL is more useful than
		// the truncated content; for FILE/TEXT we prefer originalFilename
		// then a content snippet then the metadata title.
		const attachmentSummaries =
			refineContextsQuery.data?.contexts
				?.filter((ctx) => ctx.extractionStatus === "COMPLETED")
				.map((ctx) => {
					if (ctx.type === "LINK") {
						const meta = (ctx.metadata ?? {}) as Record<
							string,
							unknown
						>;
						return (
							(typeof meta.sourceUrl === "string"
								? meta.sourceUrl
								: undefined) ??
							(typeof meta.title === "string"
								? meta.title
								: undefined) ??
							ctx.originalFilename ??
							null
						);
					}
					return (
						ctx.originalFilename ??
						(typeof ctx.content === "string" &&
						ctx.content.length > 0
							? ctx.content.slice(0, 240)
							: null)
					);
				})
				.filter(
					(s): s is string => typeof s === "string" && s.length > 0,
				) ?? [];

		refineMutation.mutate({
			sessionId: wizardSessionId,
			description: formData.description,
			projectName: formData.name || undefined,
			projectTypes:
				formData.projectTypes.length > 0
					? formData.projectTypes
					: undefined,
			// Per the 2026-05-23 unified-context-uploader-wizard spec:
			// wizard-uploaded files now write to `ProjectContext` on the DRAFT.
			// Passing `projectId` lets refine query the project-contexts Qdrant
			// collection (not just wizard-contexts by sessionId) so attached
			// files actually influence the refined description.
			...(projectId ? { projectId } : {}),
			...(attachmentSummaries.length > 0 ? { attachmentSummaries } : {}),
			organizationId: organizationId ?? null,
		});
	};

	const handleUndoRefine = () => {
		if (formData.previousDescription !== null) {
			updateFormData({
				description: formData.previousDescription,
				previousDescription: null,
			});
			toast.info("Description restored");
		}
	};

	// Spec §7.3: CTA disabled until `formData.name.trim().length > 0`. The
	// inline hint is shown only when disabled (avoid noise once name exists).
	const isNameReady = formData.name.trim().length > 0;
	const briefLength = formData.description.trim().length;
	/** Local calendar day, so the picker's floor matches what the user sees. */
	const todayIso = new Date().toLocaleDateString("en-CA");
	const briefTooShort = briefLength <= MIN_DESCRIPTION_LENGTH;
	const canOpenContextDialog = isNameReady && !!projectId;

	return (
		<div className="space-y-8">
			<div className="rounded-[26px] border border-border bg-card p-6">
				<div className="mb-6 max-w-3xl">
					<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
						Step 1
					</p>
					<h2 className="mt-2 text-2xl font-semibold tracking-tight">
						Project brief
					</h2>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						Define the identity of the project and give the AI a
						strong brief to work from. This becomes part of the
						context used for recommendations and document
						generation.
					</p>
				</div>

				<div className="space-y-6">
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Label
								htmlFor="name"
								className="text-base font-medium"
							>
								Project Name
							</Label>
							{!isEditMode && draftSaveState !== "idle" && (
								<span
									className="text-xs text-muted-foreground"
									aria-live="polite"
								>
									{draftSaveState === "saving" && "Saving..."}
									{draftSaveState === "saved" &&
										"Draft saved"}
									{draftSaveState === "error" &&
										"Could not save draft"}
								</span>
							)}
						</div>
						<Input
							id="name"
							placeholder="My Awesome Project"
							value={formData.name}
							onChange={(e) =>
								updateFormData({ name: e.target.value })
							}
							className={`h-12 rounded-xl border-border bg-background ${isDuplicateName ? "border-destructive focus-visible:ring-destructive" : ""}`}
							autoFocus
						/>
						{isDuplicateName && (
							<p className="text-sm text-destructive">
								A project with this name already exists. Please
								choose a different name.
							</p>
						)}
					</div>

					<div className="overflow-hidden rounded-[24px] border border-border bg-muted/40">
						<div className="flex flex-col gap-4 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
							<div>
								<Label
									htmlFor="description"
									className="text-base font-medium"
								>
									Project Brief
								</Label>
								<p className="mt-1 text-sm text-muted-foreground">
									Write the narrative here. Paste rough notes,
									a long brief, or a few paragraphs. The AI
									will use this as core project context.
								</p>
							</div>
							<div className="flex items-center gap-2">
								{formData.previousDescription !== null && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={handleUndoRefine}
										className="text-muted-foreground"
									>
										<Undo2Icon className="mr-1 h-4 w-4" />
										Undo
									</Button>
								)}
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleRefineDescription}
									disabled={
										refineMutation.isPending ||
										!formData.description.trim()
									}
									className="border-border bg-background"
								>
									{refineMutation.isPending ? (
										<Loader2Icon className="mr-1 h-4 w-4 animate-spin" />
									) : (
										<SparklesIcon className="mr-1 h-4 w-4" />
									)}
									Refine Brief
								</Button>
							</div>
						</div>
						<Textarea
							id="description"
							placeholder="Example: We are building a fitness tracking app for busy professionals who want simple daily feedback from wearable data. The product should help users understand recovery, activity, and habits without needing to interpret raw metrics themselves..."
							value={formData.description}
							onChange={(e) =>
								updateFormData({
									description: e.target.value,
									previousDescription: null,
								})
							}
							rows={10}
							className="min-h-[240px] resize-y border-0 bg-transparent px-5 py-5 text-[15px] leading-7 shadow-none focus-visible:ring-0"
						/>
						<div className="flex items-center justify-between border-t border-border px-5 py-3">
							{/* The checklist grades this at over 50 characters and
							    a project that fails it is told so on its own
							    readiness panel. Say it here, where it can still
							    be fixed in a sentence. */}
							<p
								className={
									briefTooShort
										? "text-highlight text-xs"
										: "text-muted-foreground text-xs"
								}
							>
								{briefTooShort
									? `A little more — ${MIN_DESCRIPTION_LENGTH + 1 - briefLength} character${
											MIN_DESCRIPTION_LENGTH +
												1 -
												briefLength ===
											1
												? ""
												: "s"
										} to go. This is the first thing Fabric reads.`
									: "Long-form notes work well here. Keep it rough if needed."}
							</p>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-8 gap-1.5 px-2 text-muted-foreground"
										>
											<HelpCircleIcon className="h-4 w-4" />
											Brief tips
										</Button>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										align="end"
										className="max-w-xs"
									>
										<div className="space-y-1 text-xs">
											<p>Include:</p>
											<p>Problem to solve</p>
											<p>Primary audience</p>
											<p>Core workflow</p>
											<p>Success outcome</p>
										</div>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
					</div>

					{/* Phase, and the date that follows from it. The readiness
					    checklist grades a project against its phase, and the
					    spreadsheet expects creation to ask — until now nothing
					    did, so every project was graded against a guess. */}
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="project-phase">
								Where is this project now?
							</Label>
							<Select
								value={formData.projectPhase}
								onValueChange={(value) =>
									updateFormData({
										projectPhase:
											value as ProjectFormData["projectPhase"],
										// A development project has no expected
										// start date to give.
										...(value === "DEVELOPMENT_EXECUTION"
											? {
													expectedDevelopmentStartDate:
														"",
												}
											: {}),
									})
								}
							>
								<SelectTrigger
									id="project-phase"
									data-testid="wizard-project-phase"
								>
									<SelectValue placeholder="Choose a phase" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="DISCOVERY_PLANNING">
										Discovery / Planning
									</SelectItem>
									<SelectItem value="DEVELOPMENT_EXECUTION">
										Development / Execution
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								Fabric asks for different things in each phase.
								You can change this later.
							</p>
						</div>

						{formData.projectPhase === "DISCOVERY_PLANNING" && (
							<div className="space-y-2">
								<Label htmlFor="expected-dev-start">
									When is development expected to start?
								</Label>
								<Input
									id="expected-dev-start"
									type="date"
									// FR52/53/55: a development start that has
									// already passed is not a plan, and it would
									// immediately un-quiet the codebase items the
									// date exists to quiet.
									min={todayIso}
									aria-describedby="expected-dev-start-help"
									value={
										formData.expectedDevelopmentStartDate
									}
									onChange={(e) =>
										updateFormData({
											expectedDevelopmentStartDate:
												e.target.value,
										})
									}
									data-testid="wizard-expected-dev-start"
								/>
								<p
									id="expected-dev-start-help"
									className="text-muted-foreground text-xs"
								>
									Until then, Fabric will not ask you to
									connect a codebase.
								</p>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Supporting Context — Add Context CTA + inline pending list.
			    Spec §7.3 ordering: this section now lives directly under the
			    project basics, before the Code Repository section. */}
			<div
				className={sectionClassName}
				data-testid="supporting-context-section"
			>
				<div>
					<Label className="text-base font-medium">
						Supporting Context
					</Label>
					<p className="text-sm text-muted-foreground mt-1">
						Upload files, link sources, paste notes, or pull from
						integrations. Items are attached to the project
						immediately and indexed in the background.
					</p>
				</div>

				<div className="mt-4 space-y-3">
					{!canOpenContextDialog && (
						<p
							className="text-xs text-muted-foreground"
							data-testid="add-context-disabled-hint"
						>
							Name your project first — we'll save your context to
							a draft as you add it.
						</p>
					)}
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setContextDialogOpen(true)}
							disabled={!canOpenContextDialog}
							aria-label="Add project context"
							aria-disabled={!canOpenContextDialog}
							data-testid="add-context-cta"
							className="border-border bg-background"
						>
							<PlusIcon className="mr-1 h-4 w-4" />
							Add Context
						</Button>
					</div>

					{projectId && (
						<ContextPendingItemsList
							projectId={projectId}
							organizationId={organizationId ?? null}
						/>
					)}
				</div>
			</div>

			{/* Optional integrations — plain sections (like the rest of the
			    Brief step, not accordions). Both are skippable; the project
			    creates fine with neither touched (AC#3). Backlog hosts the full
			    PM/ADO config; Code Repository hosts the GitHub + GitLab + Azure
			    DevOps provider cards (unified-project-setup spec §4.3, §4.4). */}
			<div className="space-y-4" data-testid="optional-integrations">
				<WizardBacklogCard
					organizationId={organizationId ?? null}
					value={{
						projectManagementMcpConfigId:
							formData.projectManagementMcpConfigId,
						projectManagementMcpServerId:
							formData.projectManagementMcpServerId,
						projectManagementContainerId:
							formData.projectManagementContainerId,
						projectManagementContainerName:
							formData.projectManagementContainerName,
						projectManagementAdditionalContext:
							formData.projectManagementAdditionalContext,
						projectManagementDetectedType:
							formData.projectManagementDetectedType,
					}}
					onChange={(patch) => updateFormData(patch)}
				/>
				<div
					className={sectionClassName}
					data-testid="repository-section"
				>
					<WizardIntegrationsSection
						sessionId={projectId ?? ""}
						organizationId={organizationId ?? undefined}
						projectId={projectId}
						selectedGitHubRepos={formData.selectedGitHubRepos}
						onGitHubReposChange={(repos) =>
							updateFormData({ selectedGitHubRepos: repos })
						}
						selectedGitLabRepos={formData.selectedGitLabRepos}
						onGitLabReposChange={(repos) =>
							updateFormData({ selectedGitLabRepos: repos })
						}
						selectedAzureDevOpsRepos={
							formData.selectedAzureDevOpsRepos
						}
						onAzureDevOpsReposChange={onAzureDevOpsReposChange}
					/>
				</div>
			</div>

			{/* Project Type (Multi-select) */}
			<div className={sectionClassName}>
				<div>
					<Label className="text-base font-medium">
						Project Shape
					</Label>
					<p className="text-sm text-muted-foreground mt-1">
						Select one or more project types to shape
						recommendations and generated documentation.
					</p>
				</div>
				<div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
					{PROJECT_TYPES.map((type) => {
						const Icon = type.icon;
						const isSelected = formData.projectTypes.includes(
							type.value,
						);

						return (
							<button
								key={type.value}
								type="button"
								onClick={() => toggleProjectType(type.value)}
								className={`group relative flex items-center gap-4 rounded-2xl border px-4 py-3 text-left transition-colors ${
									isSelected
										? "border-primary bg-accent"
										: "border-border bg-muted/40 hover:border-primary/40 hover:bg-accent"
								}`}
							>
								<div
									className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
										isSelected
											? "border-primary/40 bg-primary/10"
											: "border-border bg-background"
									}`}
								>
									<Icon className={`h-5 w-5 ${type.color}`} />
								</div>
								<div className="min-w-0 flex-1">
									<p className="font-semibold text-foreground">
										{type.label}
									</p>
									<p className="mt-0.5 text-sm text-muted-foreground">
										{type.description}
									</p>
								</div>
								<div
									className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
										isSelected
											? "border-primary bg-primary text-primary-foreground"
											: "border-border bg-transparent text-transparent"
									}`}
								>
									<CheckIcon className="h-3.5 w-3.5" />
								</div>
							</button>
						);
					})}
				</div>
				{formData.projectTypes.length > 0 && (
					<div className="mt-4 flex flex-wrap gap-2">
						{formData.projectTypes.map((typeValue) => {
							const selectedType = PROJECT_TYPES.find(
								(type) => type.value === typeValue,
							);
							if (!selectedType) {
								return null;
							}
							return (
								<div
									key={typeValue}
									className="rounded-full border border-border bg-muted px-3 py-1.5 text-sm text-foreground"
								>
									{selectedType.label}
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Add Context dialog — mounted as a modal hosted by Step 1.
			    Bound to the DRAFT `projectId` so items write directly to
			    `ProjectContext` (the wizard surface no longer round-trips
			    through `WizardTempContext`). Spec §7.3 + §9.2.
			    `surface="wizard"` tags every
			    `project_context_added_during_wizard` event the dialog
			    emits with the wizard origin, so post-launch validation can
			    compare pre-creation vs post-creation attachment rates per
			    spec §9.2. The default `"post-creation"` covers the
			    project-detail / settings call sites. */}
			{projectId && (
				<ContextUploaderDialog
					projectId={projectId}
					open={contextDialogOpen}
					onOpenChange={setContextDialogOpen}
					surface="wizard"
				/>
			)}
		</div>
	);
}
