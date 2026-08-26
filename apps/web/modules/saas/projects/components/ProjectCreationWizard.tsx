"use client";

import { MIN_DESCRIPTION_LENGTH } from "@repo/api/modules/projects/lib/readiness/thresholds";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ClockIcon,
	CodeIcon,
	FileTextIcon,
	GitBranchIcon,
	GithubIcon,
	Loader2Icon,
	RocketIcon,
	Trash2Icon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { useWizardSessionPersistence } from "../hooks/use-wizard-session-persistence";
import { getBacklogValidationError } from "../lib/backlog-validation";
import {
	createBacklogIntegrationContext,
	createIntegrationContexts,
} from "../lib/create-integration-contexts";
import type { SlackChannelSelection } from "../lib/integration-selection-types";
import { ReviewPromptsStep } from "./wizard/ReviewPromptsStep";
import type {
	AzureDevOpsRepo,
	GitHubRepo,
	GitLabProject,
	NotionPageSelection,
	TeamsChatSelection,
} from "./wizard/WizardIntegrationsSection";

// Dynamic imports for wizard step components to reduce initial bundle size
// Each step is ~50-100KB, loading only when needed improves TTI significantly
const BasicInfoStep = dynamic(
	() => import("./wizard/BasicInfoStep").then((m) => m.BasicInfoStep),
	{
		loading: () => <StepSkeleton />,
		ssr: false,
	},
);

const TechStackStep = dynamic(
	() => import("./wizard/TechStackStep").then((m) => m.TechStackStep),
	{
		loading: () => <StepSkeleton />,
		ssr: false,
	},
);

const FeaturesStep = dynamic(
	() => import("./wizard/FeaturesStep").then((m) => m.FeaturesStep),
	{
		loading: () => <StepSkeleton />,
		ssr: false,
	},
);

const DocumentsStep = dynamic(
	() => import("./wizard/DocumentsStep").then((m) => m.DocumentsStep),
	{
		loading: () => <StepSkeleton />,
		ssr: false,
	},
);

const DocumentGenerationStep = dynamic(
	() =>
		import("./wizard/DocumentGenerationStep").then(
			(m) => m.DocumentGenerationStep,
		),
	{
		loading: () => <StepSkeleton showProgress />,
		ssr: false,
	},
);

// Post-create finish-setup step (D4, spec §4.6). Hosts meeting-transcript
// linking against the real projectId; loaded only when reached, like the
// other steps, to keep the initial bundle lean.
const WizardFinishStep = dynamic(
	() => import("./wizard/WizardFinishStep").then((m) => m.WizardFinishStep),
	{
		loading: () => <StepSkeleton />,
		ssr: false,
	},
);

// Skeleton component for step loading states with fixed height to prevent CLS
function StepSkeleton({ showProgress = false }: { showProgress?: boolean }) {
	return (
		<div className="space-y-6" style={{ minHeight: "400px" }}>
			<Skeleton className="h-8 w-48" />
			<Skeleton className="h-4 w-96" />
			<div className="space-y-4 pt-4">
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
				{showProgress && <Skeleton className="h-2 w-full" />}
				<Skeleton className="h-32 w-full" />
			</div>
		</div>
	);
}

/**
 * Wizard form-state shape.
 *
 * The `selectedTeamsChats` / `selectedNotionPages` / `selectedSlackChannels`
 * fields are **deprecated post-2026-05-23 wizard refactor** (unified context
 * uploader spec §7.4 + Group 9). The wizard UI no longer collects these
 * selections — the new Add Context dialog in `BasicInfoStep.tsx` writes
 * Teams / Slack / Notion items directly to `ProjectContext` against the
 * DRAFT projectId.
 *
 * Retained for **back-compat with persisted `wizardState` JSON blobs on
 * already-saved DRAFTs** — a DRAFT created before this spec ships could
 * have non-empty arrays under these keys. The DRAFT-resume path at
 * `:780-810` (see `wizardState` parse block) reads them; the activation
 * flow at `:914-933` (`handleCreateIntegrationContexts`) still emits them
 * as `ProjectContext` rows on project creation so legacy DRAFTs activate
 * cleanly.
 *
 * **Remove after 14-day cron sweep per §17 follow-up.** Tracked in
 * `fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md` §17.
 */
type ProjectFormData = {
	name: string;
	description: string;
	/**
	 * Collected here because the readiness checklist grades against it and the
	 * sheet expects creation to own the question (Fizzy #2165). Optional on the
	 * create route by design — the public API, the v1 API, the CLI and the agent
	 * tool all create projects and none of them can be made to ask — so the
	 * wizard is where the requirement actually lives.
	 */
	projectPhase: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION" | "";
	/** Asked only for Discovery: it is what quiets codebase items until then. */
	expectedDevelopmentStartDate: string;
	projectTypes: string[]; // Changed from projectType: string
	icon: string;
	color: string;
	tags: string[];
	techStack: string[];
	features: string[];
	customRequirements: string;
	documents: string[];
	previousDescription: string | null; // For undo functionality
	tempContextIds: string[]; // Track uploaded temp context IDs
	/** @deprecated post-2026-05-23 wizard refactor — see ProjectFormData jsdoc above. */
	selectedTeamsChats: TeamsChatSelection[];
	/** @deprecated post-2026-05-23 wizard refactor — see ProjectFormData jsdoc above. */
	selectedNotionPages: NotionPageSelection[];
	selectedGitHubRepos: GitHubRepo[]; // GitHub repos for code-based setup
	selectedGitLabRepos: GitLabProject[]; // GitLab repos for code-based setup
	selectedAzureDevOpsRepos: AzureDevOpsRepo[]; // Azure DevOps repos for code-based setup
	/** @deprecated post-2026-05-23 wizard refactor — see ProjectFormData jsdoc above. */
	selectedSlackChannels: SlackChannelSelection[];
	/**
	 * Repository URLs entered directly or via the ADO/GitHub/GitLab pickers in
	 * the unified Repository card. Mirrors the Existing flow's
	 * multi-repo entry and drives `repoUrls` for `existingSetup.start` (TG3).
	 * Any non-empty entry counts as "a repo connected" for the code-based
	 * collapse (D13) and the post-create workflow routing.
	 */
	codebaseRepoUrls: string[];
	/** Primary website URL carried from the Existing flow (D9). */
	primaryWebsiteUrl: string;
	/** Additional website URLs carried from the Existing flow (D9). */
	additionalWebsiteUrls: string[];
	/**
	 * Backlog (PM tool) selection from the unified Backlog card.
	 * Maps to the `projects.create` PM block. Collapsed / unconfigured leaves
	 * all of these at their empty defaults so no PM block is sent (AC#3).
	 */
	projectManagementMcpConfigId: string | null;
	projectManagementMcpServerId: string | null;
	projectManagementContainerId: string | null;
	projectManagementContainerName: string | null;
	projectManagementAdditionalContext: Record<string, unknown> | null;
	/**
	 * The PM type the Backlog card detected from the selected MCP server's tool
	 * schema (e.g. `azure-devops`). Drives ADO-specific validation in the
	 * wizard submit handler (the card owns detection; the wizard owns the
	 * submit gate). `null` when no PM tool is connected.
	 */
	projectManagementDetectedType: string | null;
	/**
	 * Per-document prompt customization carried from the Existing flow's Review
	 * step (D10). Flows to `existingSetup.start({ documentPrompts })` in the
	 * connected case (TG3).
	 */
	documentPrompts: Record<
		string,
		{ promptId?: string; customInstructions?: string }
	>;
};

function createWizardSessionId(): string {
	return `wiz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function createDraftKey(): string {
	return crypto.randomUUID
		? crypto.randomUUID()
		: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
				const r = (Math.random() * 16) | 0;
				const v = c === "x" ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			});
}

const STANDARD_STEPS = [
	{ id: 1, name: "Brief", description: "Project foundation" },
	{ id: 2, name: "Tech Stack", description: "Technologies" },
	{ id: 3, name: "Modules", description: "Capabilities" },
	{ id: 4, name: "Review", description: "Review & Create" },
	{ id: 5, name: "Generate", description: "AI Documents" },
];

/**
 * Post-create finish-setup step id (D4, spec §4.6). NOT part of the stepper
 * arrays above — it is a terminal view reached only AFTER `projects.create`
 * resolves (so it has a real `projectId` for transcript linking), like the
 * doc-gen step (5) is only reachable post-create. The stepper circles and the
 * Next/Back nav are hidden while on it.
 */
const FINISH_STEP_ID = 6;

// Code-based review step: shows selected repos + which documents will be generated
function CodeBasedReviewStep({ formData }: { formData: ProjectFormData }) {
	const allRepos = [
		...formData.selectedGitHubRepos.map((r) => ({
			fullName: r.fullName,
			description: r.description,
			language: r.language,
			defaultBranch: r.defaultBranch,
			isPrivate: r.isPrivate,
			provider: "github" as const,
		})),
		...formData.selectedGitLabRepos.map((r) => ({
			fullName: r.fullName,
			description: r.description,
			language: r.language,
			defaultBranch: r.defaultBranch,
			isPrivate: r.isPrivate,
			provider: "gitlab" as const,
		})),
	];
	if (allRepos.length === 0) {
		return null;
	}

	const primaryRepo = allRepos[0];
	const additionalRepos = allRepos.slice(1);

	const docsToGenerate = [
		{
			type: "PRD",
			title: "Product Requirements Document",
			description:
				"Product overview, features, and requirements derived from your codebase",
		},
		{
			type: "Architecture",
			title: "Technical Architecture",
			description:
				"System design, patterns, data flow, and infrastructure analysis",
		},
		{
			type: "Tech Spec",
			title: "Technical Specification",
			description:
				"Detailed technical implementation, APIs, data models, and integrations",
		},
		{
			type: "API Spec",
			title: "API Specification",
			description:
				"All endpoints, request/response schemas, and authentication patterns",
		},
	];

	return (
		<div className="space-y-8">
			<div>
				<h2 className="text-2xl font-bold">Review & Create</h2>
				<p className="text-muted-foreground mt-1">
					We'll analyze your {allRepos.length > 1 ? "primary " : ""}
					repository and generate documentation automatically.
				</p>
			</div>

			{/* Primary Repository */}
			<div className="rounded-2xl border border-border bg-card p-5">
				<div className="flex items-center gap-3">
					<div className="rounded-xl border border-border bg-muted p-2.5">
						{primaryRepo.provider === "gitlab" ? (
							<GitBranchIcon className="size-5 text-orange-500" />
						) : (
							<GithubIcon className="size-5" />
						)}
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<p className="font-semibold">
								{primaryRepo.fullName}
							</p>
							{allRepos.length > 1 && (
								<span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-primary text-xs">
									Primary
								</span>
							)}
						</div>
						{primaryRepo.description && (
							<p className="text-sm text-muted-foreground truncate mt-0.5">
								{primaryRepo.description}
							</p>
						)}
						<div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
							{primaryRepo.language && (
								<span>{primaryRepo.language}</span>
							)}
							<span>Branch: {primaryRepo.defaultBranch}</span>
							{primaryRepo.isPrivate ? (
								<span>Private</span>
							) : (
								<span>Public</span>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Additional Repositories */}
			{additionalRepos.length > 0 && (
				<div className="space-y-2">
					<h3 className="text-sm font-medium text-muted-foreground">
						Additional Repositories ({additionalRepos.length})
					</h3>
					<div className="space-y-2">
						{additionalRepos.map((repo) => (
							<div
								key={repo.fullName}
								className="flex items-center gap-2 rounded-xl border border-border bg-muted p-3"
							>
								{repo.provider === "gitlab" ? (
									<GitBranchIcon className="size-4 text-orange-500 shrink-0" />
								) : (
									<GithubIcon className="size-4 text-muted-foreground shrink-0" />
								)}
								<span className="text-sm font-medium truncate">
									{repo.fullName}
								</span>
								{repo.language && (
									<span className="text-xs text-muted-foreground shrink-0">
										({repo.language})
									</span>
								)}
							</div>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						The primary repository will be analyzed first.
						Additional repositories will be available as project
						context.
					</p>
				</div>
			)}

			{/* Documents to Generate */}
			<div className="space-y-3">
				<div className="flex items-center gap-2">
					<FileTextIcon className="size-4 text-muted-foreground" />
					<h3 className="font-medium">Documents to Generate</h3>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					{docsToGenerate.map((doc) => (
						<div
							key={doc.type}
							className="rounded-xl border border-border bg-muted p-4"
						>
							<div className="flex items-center gap-2">
								<CodeIcon className="size-4 text-primary" />
								<span className="font-medium text-sm">
									{doc.title}
								</span>
							</div>
							<p className="text-xs text-muted-foreground mt-1.5">
								{doc.description}
							</p>
						</div>
					))}
				</div>
			</div>

			{/* Time Estimate */}
			<div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
				<ClockIcon className="mt-0.5 size-5 shrink-0 text-primary" />
				<div>
					<p className="font-medium text-sm">
						Analysis takes about 10 minutes
					</p>
					<p className="text-xs text-muted-foreground mt-0.5">
						The AI orchestrator will scan your repository structure,
						code, APIs, and dependencies to generate comprehensive
						documentation. You'll be redirected to your project page
						where you can track progress.
					</p>
				</div>
			</div>

			{/* Additional Context Note */}
			<div className="flex items-start gap-3 rounded-lg border border-highlight/20 bg-highlight/5 p-4">
				<RocketIcon className="size-5 text-highlight shrink-0 mt-0.5" />
				<div>
					<p className="font-medium text-sm">
						Add more context later
					</p>
					<p className="text-xs text-muted-foreground mt-0.5">
						After initial document generation, you can enrich your
						project by adding Notion pages, Teams chats, or file
						uploads as additional context.
					</p>
				</div>
			</div>
		</div>
	);
}

function ProjectReviewSummary({
	title = "Project Summary",
	description,
	projectName,
	projectBrief,
	projectTypes,
	techStack,
	features,
}: {
	title?: string;
	description?: string;
	projectName: string;
	projectBrief: string;
	projectTypes: string[];
	techStack: string[];
	features: string[];
}) {
	const topTech = techStack.slice(0, 8);
	const topFeatures = features.slice(0, 5);

	return (
		<div className="rounded-[26px] border border-border bg-card p-6">
			<div className="mb-6">
				<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
					Review
				</p>
				<h2 className="mt-2 text-2xl font-semibold tracking-tight">
					{title}
				</h2>
				{description && (
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						{description}
					</p>
				)}
			</div>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
				<div className="overflow-hidden rounded-[22px] border border-border bg-muted/40">
					<div className="border-b border-border px-5 py-4">
						<p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
							Project Brief
						</p>
						<p className="mt-2 text-lg font-semibold text-foreground">
							{projectName || "Untitled project"}
						</p>
					</div>
					<div className="px-5 py-5">
						<p className="text-sm leading-7 text-foreground/85 whitespace-pre-wrap">
							{projectBrief.trim() ||
								"No brief provided yet. Add one to improve recommendations and generated documents."}
						</p>
					</div>
				</div>

				<div className="space-y-4">
					<div className="rounded-2xl border border-border bg-muted/40 p-4">
						<p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
							Project Shape
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{projectTypes.length > 0 ? (
								projectTypes.map((type) => (
									<span
										key={type}
										className="rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground"
									>
										{type}
									</span>
								))
							) : (
								<p className="text-sm italic text-foreground/40">
									No project shape selected.
								</p>
							)}
						</div>
					</div>

					<div className="rounded-2xl border border-border bg-muted/40 p-4">
						<div className="flex items-center justify-between gap-3">
							<p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
								Tech Stack
							</p>
							<p className="text-xs text-muted-foreground">
								{techStack.length} items
							</p>
						</div>
						<div className="mt-3 flex flex-wrap gap-2">
							{topTech.length > 0 ? (
								topTech.map((item) => (
									<span
										key={item}
										className="rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground"
									>
										{item}
									</span>
								))
							) : (
								<p className="text-sm italic text-foreground/40">
									No stack items selected yet.
								</p>
							)}
						</div>
					</div>

					<div className="rounded-2xl border border-border bg-muted/40 p-4">
						<div className="flex items-center justify-between gap-3">
							<p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
								Feature Snapshot
							</p>
							<p className="text-xs text-muted-foreground">
								{features.length} total
							</p>
						</div>
						<div className="mt-3 space-y-2">
							{topFeatures.length > 0 ? (
								topFeatures.map((feature, index) => (
									<div
										key={`${feature}-${index}`}
										className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground/85"
									>
										{feature}
									</div>
								))
							) : (
								<p className="text-sm italic text-foreground/40">
									No features listed yet.
								</p>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

interface ProjectCreationWizardProps {
	organizationId?: string;
	projectId?: string;
	initialStep?: number;
	/**
	 * Explicit "start fresh" entry from `projects/new` (no `?step` / valid
	 * `?projectId`). Drops any stale wizard sessionStorage snapshot on mount so
	 * it can't race `draftKey` into a duplicate DRAFT. The page
	 * sets this only on a genuine fresh visit — resume/edit and
	 * return-from-settings (which preserve `?step` / `?projectId`) leave it
	 * unset so progress is restored.
	 */
	freshStart?: boolean;
}

export function ProjectCreationWizard({
	organizationId: propsOrganizationId,
	projectId,
	initialStep,
	freshStart = false,
}: ProjectCreationWizardProps = {}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const pathname = usePathname();
	const _sp = useSearchParams();
	const { organizationId: contextOrgId, basePath } = useOrganizationContext();
	const { confirm } = useConfirmationAlert();

	// Use provided organizationId or get from active organization context
	const effectiveOrganizationId = propsOrganizationId || contextOrgId;

	const projectsBasePath = `${basePath}/projects`;

	const [currentStep, setCurrentStep] = useState(
		initialStep && initialStep >= 1 && initialStep <= 5 ? initialStep : 1,
	);
	const [createdProjectId, setCreatedProjectId] = useState<string | null>(
		projectId ?? null,
	);
	const [hasDuplicateName, setHasDuplicateName] = useState(false);

	// Wizard session ID for temp file storage (in-memory only)
	const [wizardSessionId, setWizardSessionId] = useState<string>("");

	// Client-generated UUID for idempotent draft auto-save (in-memory only)
	const [draftKey, setDraftKey] = useState<string>("");

	useEffect(() => {
		// Idempotent setters: if sessionStorage restore (or a prior strict-mode
		// double-invocation) already set these, leave them alone. Calling
		// `createDraftKey()` unconditionally was racing with the restore and
		// stamping a fresh key over the recovered one, which then materialized
		// as a duplicate DRAFT row in the DB on the next autosave.
		setWizardSessionId((prev) => prev || createWizardSessionId());
		setDraftKey((prev) => prev || createDraftKey());
	}, []);

	// True when resuming a DRAFT project (via DraftProjectBanner), as opposed to editing an ACTIVE project
	const [isDraftResume, setIsDraftResume] = useState(false);

	const initialNameFromUrl = _sp?.get?.("name")?.trim() ?? "";
	const [formData, setFormData] = useState<ProjectFormData>({
		name: initialNameFromUrl,
		description: "",
		projectPhase: "",
		expectedDevelopmentStartDate: "",
		projectTypes: [],
		icon: "📁",
		color: "#3b82f6",
		tags: [],
		techStack: [],
		features: [],
		customRequirements: "",
		documents: [],
		previousDescription: null,
		tempContextIds: [],
		selectedTeamsChats: [],
		selectedNotionPages: [],
		selectedGitHubRepos: [],
		selectedGitLabRepos: [],
		selectedAzureDevOpsRepos: [],
		selectedSlackChannels: [],
		codebaseRepoUrls: [],
		primaryWebsiteUrl: "",
		additionalWebsiteUrls: [],
		projectManagementMcpConfigId: null,
		projectManagementMcpServerId: null,
		projectManagementContainerId: null,
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
		projectManagementDetectedType: null,
		documentPrompts: {},
	});

	// Azure DevOps PAT captured from the picker, held in component state ONLY
	// (NEVER persisted to sessionStorage / the server draft — see spec §6, R3).
	// Used as a fallback to call `repositoryIntegrations.connect` in the create
	// success handler when no DRAFT projectId existed at picker-confirm time.
	const azureDevOpsCredsRef = useRef<{
		pat: string;
		azureOrganization: string;
	} | null>(null);

	// Check if this is an edit mode (projectId in URL params)
	const isEditMode = !!projectId || !!_sp?.get?.("projectId");
	const projectIdToFetch = projectId || _sp?.get?.("projectId") || null;

	// Persist wizard state to sessionStorage so navigating to Settings and back
	// doesn't lose progress. Restore on mount if a snapshot exists.
	const { save: saveWizardSession, clear: clearWizardSession } =
		useWizardSessionPersistence({
			pathname,
			isEditMode,
			freshStart,
			onRestore: (snapshot) => {
				const fd = snapshot.formData as ProjectFormData;
				if (fd) {
					setFormData(fd);
				}
				if (snapshot.currentStep) {
					setCurrentStep(snapshot.currentStep);
				}
				if (snapshot.createdProjectId) {
					setCreatedProjectId(snapshot.createdProjectId);
				}
				if (snapshot.wizardSessionId) {
					setWizardSessionId(snapshot.wizardSessionId);
				}
				if (snapshot.draftKey) {
					setDraftKey(snapshot.draftKey);
				}
			},
		});

	// Auto-save wizard state to sessionStorage on every form change
	useEffect(() => {
		if (isEditMode || !formData.name) {
			return;
		}
		saveWizardSession({
			formData: formData as unknown as Record<string, unknown>,
			currentStep,
			createdProjectId,
			wizardSessionId,
			draftKey,
		});
	}, [
		formData,
		currentStep,
		createdProjectId,
		wizardSessionId,
		draftKey,
		isEditMode,
		saveWizardSession,
	]);

	// A repo connected during NEW project creation (GitHub, GitLab, Azure
	// DevOps, or a repo URL entered directly in the unified Repository card)
	// means the project will be analyzed on create. `isCodeBased` selects the
	// analysis-flavored Review pane and the "Create & Analyze" CTA below — it no
	// longer changes the step set. In edit mode the project already has these
	// fields, so the standard Review pane is always used.
	const hasAnyRepoConnected =
		formData.selectedGitHubRepos.length > 0 ||
		formData.selectedGitLabRepos.length > 0 ||
		formData.selectedAzureDevOpsRepos.length > 0 ||
		formData.codebaseRepoUrls.some((u) => u.trim().length > 0);
	const isCodeBased = !isEditMode && hasAnyRepoConnected;
	// The stepper is invariant: always the full 5-step standard flow regardless
	// of repo connection. A connected repo changes only the Review pane content
	// and CTA label (above), never the number of steps — this is what keeps the
	// counter from intermittently collapsing to 2.
	const steps = STANDARD_STEPS;

	// Track if we've already hydrated from the server to avoid overwriting user changes
	const hasHydratedFromServer = useRef(false);

	// Set once the project is activated (create/update succeeds). After that the
	// project is no longer a DRAFT, so the debounced auto-save must stop firing —
	// otherwise a trailing `saveDraft` lands on a non-draft and the server
	// (correctly) rejects it with 400. Activation can keep the wizard mounted on
	// the finish step (D4) or the Generate step, where that trailing call would
	// otherwise surface; a ref (not state) avoids an extra render on the hot path.
	const hasActivatedRef = useRef(false);

	// Fetch existing project data when editing
	const { data: existingProjectData, isLoading: isLoadingProject } = useQuery(
		{
			queryKey: ["project", projectIdToFetch, effectiveOrganizationId],
			queryFn: () => {
				// projectIdToFetch is guaranteed non-null by enabled option
				const id = projectIdToFetch as string;
				return orpc.projects.get.call({
					id,
					organizationId: effectiveOrganizationId ?? null,
				});
			},
			enabled: !!projectIdToFetch && !hasHydratedFromServer.current,
		},
	);

	// Hydrate form data from fetched project (only once)
	useEffect(() => {
		if (existingProjectData?.project && !hasHydratedFromServer.current) {
			const project = existingProjectData.project;
			hasHydratedFromServer.current = true;

			// Detect draft resume: project exists but is still DRAFT status
			if (project.status === "DRAFT") {
				setIsDraftResume(true);
				setCreatedProjectId(project.id);
			}

			// Wizard-only ephemera lives in wizardState for drafts created after
			// the schema migration. Fall back to legacy "Custom: …" extraction
			// from features for older drafts (wizardState is null on those rows).
			const wizardState =
				(project as { wizardState?: Record<string, unknown> | null })
					.wizardState ?? null;

			const legacyCustomFeature = project.features?.find((f: string) =>
				f.startsWith("Custom: "),
			);
			const customRequirementsFromWizard =
				typeof wizardState?.customRequirements === "string"
					? (wizardState.customRequirements as string)
					: undefined;
			const customRequirements =
				customRequirementsFromWizard ??
				(legacyCustomFeature
					? legacyCustomFeature.replace("Custom: ", "")
					: "");
			const standardFeatures =
				project.features?.filter(
					(f: string) => !f.startsWith("Custom: "),
				) || [];

			// Extract existing integration contexts for Teams and Notion
			const contexts = (project.contexts || []) as Array<{
				id: string;
				type: string;
				sourceTitle?: string | null;
				sourceUrl?: string | null;
				metadata?: Record<string, any> | null;
			}>;

			const existingTeamsChatsRaw = contexts
				.filter((ctx) => {
					const meta = ctx.metadata;
					return (
						ctx.type === "INTEGRATION" &&
						meta?.provider === "MICROSOFT_TEAMS"
					);
				})
				.map((ctx) => {
					const meta = ctx.metadata as Record<string, any>;
					if (
						meta.chatType === "channel" &&
						meta.teamId &&
						meta.channelId
					) {
						return {
							selectionType: "channel" as const,
							teamId: meta.teamId,
							channelId: meta.channelId,
							channelName: meta.channelName,
							teamName: meta.teamName,
							topic:
								meta.chatTopic ||
								`${meta.teamName} - ${meta.channelName}`,
							mcpConfigId: meta.mcpConfigId || "",
						};
					}
					return {
						selectionType: "chat" as const,
						chatId: meta.chatId || ctx.id,
						topic: meta.chatTopic || "Teams Chat",
						memberCount: meta.memberCount,
						mcpConfigId: meta.mcpConfigId || "",
					};
				});
			// Deduplicate by chatId/channelId to avoid React key warnings
			const seen = new Set<string>();
			const existingTeamsChats: TeamsChatSelection[] =
				existingTeamsChatsRaw.filter((chat) => {
					const key =
						chat.selectionType === "channel"
							? `channel:${chat.channelId}`
							: `chat:${chat.chatId}`;
					if (seen.has(key)) {
						return false;
					}
					seen.add(key);
					return true;
				});

			const existingNotionPages: NotionPageSelection[] = contexts
				.filter((ctx) => {
					const meta = ctx.metadata;
					return (
						ctx.type === "INTEGRATION" &&
						meta?.provider === "notion"
					);
				})
				.map((ctx) => {
					const meta = ctx.metadata as Record<string, any>;
					return {
						pageId: meta.notionPageId || ctx.id,
						title:
							meta.sourceTitle ||
							ctx.sourceTitle ||
							"Notion Page",
						url: meta.sourceUrl || ctx.sourceUrl || undefined,
						mcpConfigId: meta.mcpConfigId || "",
						documentTag: meta.documentTag || null,
					};
				});

			const existingSlackChannelsRaw: SlackChannelSelection[] = contexts
				.filter((ctx) => {
					const meta = ctx.metadata as
						| Record<string, any>
						| undefined;
					return (
						ctx.type === "INTEGRATION" &&
						meta?.provider === "SLACK" &&
						!!meta?.channelId
					);
				})
				.map((ctx) => {
					const meta = ctx.metadata as Record<string, any>;
					return {
						channelId: meta.channelId,
						channelName:
							meta.channelName ||
							meta.sourceTitle ||
							ctx.sourceTitle ||
							"Slack Channel",
						mcpConfigId: meta.mcpConfigId || "",
					};
				});
			// Deduplicate by channelId (same pattern as Teams chats above)
			const seenSlack = new Set<string>();
			const existingSlackChannels: SlackChannelSelection[] =
				existingSlackChannelsRaw.filter((ch) => {
					if (seenSlack.has(ch.channelId)) {
						return false;
					}
					seenSlack.add(ch.channelId);
					return true;
				});

			// Hydrate GitHub repos from project's repository URL
			const existingGitHubRepos: GitHubRepo[] = [];
			if (
				project.repositoryUrl &&
				project.repositoryOwner &&
				project.repositoryName
			) {
				existingGitHubRepos.push({
					name: project.repositoryName,
					fullName: `${project.repositoryOwner}/${project.repositoryName}`,
					description: null,
					isPrivate: false,
					htmlUrl: project.repositoryUrl,
					language: null,
					defaultBranch: project.defaultBranch || "main",
					updatedAt: new Date().toISOString(),
					stars: 0,
					isFork: false,
					owner: project.repositoryOwner,
				});
			}

			// wizardState is the source of truth for selections/uploads/documents
			// when present; otherwise fall back to contexts-derived hydration above.
			const wizardTeamsChats = Array.isArray(
				wizardState?.selectedTeamsChats,
			)
				? (wizardState.selectedTeamsChats as TeamsChatSelection[])
				: null;
			const wizardNotionPages = Array.isArray(
				wizardState?.selectedNotionPages,
			)
				? (wizardState.selectedNotionPages as NotionPageSelection[])
				: null;
			const wizardSlackChannels = Array.isArray(
				wizardState?.selectedSlackChannels,
			)
				? (wizardState.selectedSlackChannels as SlackChannelSelection[])
				: null;
			const wizardGitHubRepos = Array.isArray(
				wizardState?.selectedGitHubRepos,
			)
				? (wizardState.selectedGitHubRepos as GitHubRepo[])
				: null;
			const wizardGitLabRepos = Array.isArray(
				wizardState?.selectedGitLabRepos,
			)
				? (wizardState.selectedGitLabRepos as GitLabProject[])
				: null;
			// ADO repos hydrate from wizardState only (no typed Project columns
			// distinguish provider; the PAT is never persisted so a resumed
			// draft re-prompts for it on next connect).
			const wizardAzureDevOpsRepos = Array.isArray(
				wizardState?.selectedAzureDevOpsRepos,
			)
				? (wizardState.selectedAzureDevOpsRepos as AzureDevOpsRepo[])
				: null;
			const wizardDocuments = Array.isArray(wizardState?.documents)
				? (wizardState.documents as string[])
				: null;
			const wizardTempContextIds = Array.isArray(
				wizardState?.tempContextIds,
			)
				? (wizardState.tempContextIds as string[])
				: null;

			// Unified-project-setup wizard ephemera (Backlog/Repository cards,
			// website URLs, per-document prompts) round-tripped via wizardState.
			const wizardCodebaseRepoUrls = Array.isArray(
				wizardState?.codebaseRepoUrls,
			)
				? (wizardState.codebaseRepoUrls as string[])
				: null;
			const wizardPrimaryWebsiteUrl =
				typeof wizardState?.primaryWebsiteUrl === "string"
					? (wizardState.primaryWebsiteUrl as string)
					: null;
			const wizardAdditionalWebsiteUrls = Array.isArray(
				wizardState?.additionalWebsiteUrls,
			)
				? (wizardState.additionalWebsiteUrls as string[])
				: null;
			const wizardDetectedPmType =
				typeof wizardState?.projectManagementDetectedType === "string"
					? (wizardState.projectManagementDetectedType as string)
					: null;
			const wizardDocumentPrompts =
				wizardState?.documentPrompts &&
				typeof wizardState.documentPrompts === "object"
					? (wizardState.documentPrompts as Record<
							string,
							{ promptId?: string; customInstructions?: string }
						>)
					: null;
			// PM block lives on the project's typed columns (saveDraft persists
			// them there); hydrate from the project row for a connected backlog.
			const projectPm = project as {
				projectManagementMcpServerId?: string | null;
				projectManagementMcpConfigId?: string | null;
				projectManagementContainerId?: string | null;
				projectManagementContainerName?: string | null;
				projectManagementAdditionalContext?: Record<
					string,
					unknown
				> | null;
			};

			setFormData((prev) => ({
				...prev,
				name: project.name || "",
				description: project.description || "",
				projectTypes: project.projectTypes || [],
				icon: project.icon || "📁",
				color: project.color || "#3b82f6",
				tags: project.tags || [],
				techStack: project.techStack || [],
				features: standardFeatures,
				customRequirements,
				documents:
					wizardDocuments ??
					(prev.documents.length > 0 ? prev.documents : []),
				previousDescription: null,
				tempContextIds: wizardTempContextIds ?? prev.tempContextIds,
				selectedTeamsChats: wizardTeamsChats ?? existingTeamsChats,
				selectedNotionPages: wizardNotionPages ?? existingNotionPages,
				selectedSlackChannels:
					wizardSlackChannels ?? existingSlackChannels,
				selectedGitHubRepos:
					wizardGitHubRepos ??
					(existingGitHubRepos.length > 0
						? existingGitHubRepos
						: prev.selectedGitHubRepos),
				selectedGitLabRepos:
					wizardGitLabRepos ?? prev.selectedGitLabRepos,
				// ADO repos hydrate from wizardState only (PAT never persisted —
				// a resumed draft re-prompts for it on next connect, spec §6).
				selectedAzureDevOpsRepos:
					wizardAzureDevOpsRepos ?? prev.selectedAzureDevOpsRepos,
				// Optional Backlog/Repository cards + website URLs (resume).
				codebaseRepoUrls:
					wizardCodebaseRepoUrls ?? prev.codebaseRepoUrls,
				primaryWebsiteUrl:
					wizardPrimaryWebsiteUrl ??
					project.primaryWebsiteUrl ??
					prev.primaryWebsiteUrl,
				additionalWebsiteUrls:
					wizardAdditionalWebsiteUrls ??
					project.additionalWebsiteUrls ??
					prev.additionalWebsiteUrls,
				projectManagementMcpConfigId:
					projectPm.projectManagementMcpConfigId ??
					prev.projectManagementMcpConfigId,
				projectManagementMcpServerId:
					projectPm.projectManagementMcpServerId ??
					prev.projectManagementMcpServerId,
				projectManagementContainerId:
					projectPm.projectManagementContainerId ??
					prev.projectManagementContainerId,
				projectManagementContainerName:
					projectPm.projectManagementContainerName ??
					prev.projectManagementContainerName,
				projectManagementAdditionalContext:
					projectPm.projectManagementAdditionalContext ??
					prev.projectManagementAdditionalContext,
				projectManagementDetectedType:
					wizardDetectedPmType ?? prev.projectManagementDetectedType,
				documentPrompts: wizardDocumentPrompts ?? prev.documentPrompts,
			}));

			// Restore step from wizardState only when the URL hasn't already
			// pinned one — explicit ?step= takes precedence over remembered state.
			const urlStepParam = _sp?.get?.("step");
			if (
				!urlStepParam &&
				typeof wizardState?.currentStep === "number" &&
				wizardState.currentStep >= 1 &&
				wizardState.currentStep <= 5
			) {
				setCurrentStep(wizardState.currentStep as number);
			}

			// Hydrate draftKey from server so subsequent auto-saves target the same draft
			if (project.draftKey) {
				setDraftKey(project.draftKey);
			}
		}
	}, [existingProjectData]);

	function updateUrlStep(nextStep: number, pid?: string | null) {
		const base = pathname || "";
		const query = new URLSearchParams();
		query.set("step", String(nextStep));
		if (pid) {
			query.set("projectId", pid);
		}
		router.replace(`${base}?${query.toString()}`, { scroll: false });
	}

	// If props are missing, hydrate from client search params to support direct URL visits
	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		// Only hydrate from URL if not explicitly provided by props
		const stepParam = _sp?.get?.("step");
		const pidParam = _sp?.get?.("projectId");
		if (!projectId && pidParam && !createdProjectId) {
			setCreatedProjectId(pidParam);
		}
		if (!initialStep && stepParam) {
			const parsed = Number.parseInt(stepParam, 10);
			// Allow steps 1–5 always; allow the post-create finish step (6) only
			// when a projectId is present (it has no meaning without a real
			// project — a stale ?step=6 with no project falls through to step 1).
			if (parsed >= 1 && parsed <= 5) {
				setCurrentStep(parsed);
			} else if (parsed === FINISH_STEP_ID && (projectId || pidParam)) {
				setCurrentStep(FINISH_STEP_ID);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Scroll to top when the step changes
	useEffect(() => {
		if (typeof window !== "undefined") {
			window.scrollTo({ top: 0, behavior: "smooth" });
		}
	}, [currentStep]);

	// Helper function to create integration contexts after project creation
	const handleCreateIntegrationContexts = async (projectId: string) => {
		const { successCount, failCount } = await createIntegrationContexts({
			projectId,
			organizationId: effectiveOrganizationId,
			selectedTeamsChats: formData.selectedTeamsChats,
			selectedNotionPages: formData.selectedNotionPages,
			selectedSlackChannels: formData.selectedSlackChannels,
		});

		if (successCount > 0) {
			toast.success(
				`Added ${successCount} integration${successCount !== 1 ? "s" : ""} to project`,
			);
		}
		if (failCount > 0) {
			toast.warning(
				`${failCount} integration${failCount !== 1 ? "s" : ""} failed to sync`,
			);
		}
	};

	/**
	 * D8 / AC#4: when a backlog was connected, emit exactly ONE
	 * idempotent, tenant-scoped INTEGRATION ProjectContext row so the backlog
	 * also renders in `ProjectContextsList` (it already surfaces in
	 * `ProjectManagementSettings` via the persisted PM block). No-op when no
	 * backlog was connected (AC#3 path untouched). Reuses `contexts.create` via
	 * the shared `createBacklogIntegrationContext` helper (idempotency guard +
	 * the 30-cap + realtime/embedding all handled there / by the procedure).
	 *
	 * The 30-cap `BAD_REQUEST` (and any other failure) is surfaced as a warning
	 * toast rather than swallowed (§11, `global/error-handling.md`); it never
	 * blocks the post-create redirect — the project is already created.
	 *
	 * NOTE for TG3 (O1 workflow routing, which also edits these `onSuccess`
	 * handlers): this emission is gated on `hasBacklogConnected` and is
	 * independent of the repo/workflow-start branches. Keep calling it before the
	 * branch-specific redirects so the row lands regardless of which redirect
	 * fires. It is idempotent, so re-running it (e.g. on a draft-resume create)
	 * will not duplicate the row.
	 */
	const handleCreateBacklogContext = async (projectId: string) => {
		if (!hasBacklogConnected) {
			return;
		}
		try {
			await createBacklogIntegrationContext({
				projectId,
				organizationId: effectiveOrganizationId,
				detectedType: formData.projectManagementDetectedType,
				mcpConfigId: formData.projectManagementMcpConfigId,
				mcpServerId: formData.projectManagementMcpServerId,
				containerId: formData.projectManagementContainerId,
				containerName: formData.projectManagementContainerName,
			});
		} catch (err) {
			console.error("Failed to create backlog integration context:", err);
			toast.warning(
				err instanceof Error
					? err.message
					: "Backlog connected, but it could not be added to the context list.",
			);
		}
	};

	const createMutation = useMutation(
		orpc.projects.create.mutationOptions({
			onSuccess: async (data) => {
				// Project is now activated (no longer a DRAFT) — stop the debounced
				// auto-save before any await or step change so no trailing
				// `saveDraft` lands on the activated project.
				hasActivatedRef.current = true;
				toast.success("Project created successfully");
				setCreatedProjectId(data.project.id);
				clearWizardSession();

				// Create integration contexts (Teams/Notion) if any selected
				await handleCreateIntegrationContexts(data.project.id);

				// D8 / AC#4: surface a connected backlog as one INTEGRATION row.
				await handleCreateBacklogContext(data.project.id);

				// O1: a connected repo and/or backlog routes through
				// the single `existingProjectSetupWorkflow` (Phase 1A code +
				// Phase 1B backlog), NOT the retired GitHub/GitLab/ADO
				// `startCodeSetup` paths. `skipAutoSync: true` was set on the
				// create payload so the workflow is the sole owner of story sync
				// (no double-pull). For Azure DevOps we first create one
				// `ProjectRepositoryIntegration` per repo via `connect` (PR #1219
				// pre-create path) so the encrypted PAT is captured BEFORE setup
				// runs; the connects + the workflow start are fire-and-forget and
				// never block the redirect.
				if (hasConnectedIntegration) {
					const adoConnected = await connectAzureDevOpsRepos(
						data.project.id,
					);
					if (adoConnected) {
						await startExistingProjectSetup(data.project.id);
					}
					router.push(`${projectsBasePath}/${data.project.id}`);
					return;
				}

				// D4: the brief-only terminal path (no connected
				// repo/backlog, no documents queued for generation) lands on the
				// in-wizard finish-setup step instead of redirecting straight to
				// the project. That step offers optional meeting-transcript
				// linking against the now-real projectId and a "Go to project"
				// primary action. The doc-gen path (documents selected) below
				// keeps its own terminal flow and is NOT routed here.
				if (formData.documents.length === 0) {
					setCurrentStep(FINISH_STEP_ID);
					updateUrlStep(FINISH_STEP_ID, data.project.id);
					return;
				}

				// Move to Step 5 (Document Generation)
				setCurrentStep(5);
				// Update URL for bookmarking
				updateUrlStep(5, data.project.id);
			},
			onError: (error) => {
				toast.error(`Failed to create project: ${error.message}`);
			},
		}),
	);

	const updateMutation = useMutation(
		orpc.projects.update.mutationOptions({
			onSuccess: async () => {
				// Project is now activated (no longer a DRAFT) — stop the debounced
				// auto-save before any await or step change so no trailing
				// `saveDraft` lands on the activated project.
				hasActivatedRef.current = true;
				toast.success("Project updated successfully");
				clearWizardSession();

				// Create integration contexts (Teams/Notion) if any selected
				if (projectIdToFetch) {
					await handleCreateIntegrationContexts(projectIdToFetch);
					// D8 / AC#4: surface a connected backlog as one INTEGRATION
					// row. Idempotent — a draft-resume re-run won't duplicate it.
					await handleCreateBacklogContext(projectIdToFetch);
				}

				// O1: a connected repo and/or backlog routes through
				// the single `existingProjectSetupWorkflow`, NOT the retired
				// `startCodeSetup` paths. `skipAutoSync: true` was set on the
				// update payload so the workflow is the sole owner of story sync.
				// ADO repos re-connected in this session connect first (PAT held
				// transiently); a pure draft-resume has no PAT so the no-op path
				// in `connectAzureDevOpsRepos` returns true. Fire-and-forget:
				// never blocks the redirect.
				if (projectIdToFetch && hasConnectedIntegration) {
					const adoConnected =
						await connectAzureDevOpsRepos(projectIdToFetch);
					if (adoConnected) {
						await startExistingProjectSetup(projectIdToFetch);
					}
					router.push(`${projectsBasePath}/${projectIdToFetch}`);
					return;
				}

				// D4: brief-only terminal path lands on the in-wizard
				// finish-setup step (optional transcript linking + "Go to
				// project") instead of redirecting straight to the project, with
				// the now-real projectId. Mirrors the create path above.
				if (formData.documents.length === 0 && projectIdToFetch) {
					setCurrentStep(FINISH_STEP_ID);
					updateUrlStep(FINISH_STEP_ID, projectIdToFetch);
					return;
				}

				// Move to Step 5 (Document Generation)
				setCurrentStep(5);
				// Update URL for bookmarking
				updateUrlStep(5, projectIdToFetch);
			},
			onError: (error) => {
				toast.error(`Failed to update project: ${error.message}`);
			},
		}),
	);

	const updateFormData = (data: Partial<ProjectFormData>) => {
		setFormData((prev) => ({ ...prev, ...data }));
	};

	// Azure DevOps selection handler. Captures the PAT into a ref (in-memory
	// only — never persisted to sessionStorage / the server draft, see spec §6)
	// and stores repo metadata in formData. Mutually exclusive with GitHub /
	// GitLab so only one provider drives the code-based flow (matches the
	// GitHub↔GitLab clearing in BasicInfoStep). When the picker connected the
	// repos itself (a DRAFT projectId was present) `creds` may be undefined;
	// the create success handler treats a missing ref as "already connected".
	const handleAzureDevOpsReposChange = useCallback(
		(
			repos: AzureDevOpsRepo[],
			creds?: {
				pat: string;
				azureOrganization: string;
			},
		) => {
			if (creds) {
				azureDevOpsCredsRef.current = creds;
			}
			if (repos.length === 0) {
				// Selection cleared — drop the held PAT too.
				azureDevOpsCredsRef.current = null;
			}
			updateFormData({
				selectedAzureDevOpsRepos: repos,
				...(repos.length > 0
					? { selectedGitHubRepos: [], selectedGitLabRepos: [] }
					: {}),
			});
		},
		[],
	);

	/**
	 * True when the user connected a backlog in the unified Backlog card — a PM
	 * tool was actually picked (not the `__none__` sentinel). Drives the PM
	 * block mapping below and, in TG3, `skipAutoSync` + `existingSetup.start`.
	 */
	const hasBacklogConnected =
		!!formData.projectManagementMcpConfigId ||
		!!formData.projectManagementMcpServerId;

	/**
	 * True when a repo and/or backlog was connected. Drives the O1 post-create
	 * routing: the connected case sets `skipAutoSync: true` on
	 * `create`/`update` (so `create-project.ts` does NOT kick off
	 * `storySyncWorkflow`) and then fires a single `existingSetup.start`, making
	 * `existingProjectSetupWorkflow` the sole owner of story sync — no
	 * double-pull. The blank-optionals case leaves `skipAutoSync` unset and makes
	 * no workflow call (AC#3).
	 */
	const hasConnectedIntegration = hasAnyRepoConnected || hasBacklogConnected;

	/**
	 * Repo-URL union for `existingSetup.start({ repoUrls })`. The Code Repository
	 * section (`WizardIntegrationsSection`) populates the typed
	 * `selectedGitHubRepos` / `selectedGitLabRepos` / `selectedAzureDevOpsRepos`
	 * arrays, whose `htmlUrl`s we union here. `codebaseRepoUrls` is also unioned
	 * to cover legacy/resumed DRAFTs (or a project whose `repositoryUrl`
	 * hydrated the typed arrays) that carry repo URLs without a live selection.
	 * The `Set` dedups any overlap; blanks are filtered.
	 */
	const buildRepoUrls = (): string[] =>
		Array.from(
			new Set(
				[
					...formData.codebaseRepoUrls,
					...formData.selectedGitHubRepos.map((r) => r.htmlUrl),
					...formData.selectedGitLabRepos.map((r) => r.htmlUrl),
					...formData.selectedAzureDevOpsRepos.map((r) => r.htmlUrl),
				].filter((u) => u.trim().length > 0),
			),
		);

	/**
	 * O1: start `existingProjectSetupWorkflow` for the connected
	 * repo and/or backlog case. Fire-and-forget — a failure surfaces a warning
	 * toast and NEVER blocks the post-create redirect (the project already
	 * exists; setup is retryable from the project page). The backlog's PM config
	 * is read server-side from the project record (persisted by `projects.create`
	 * / `saveDraft`), so no PM fields are passed here. `selectedDocumentTypes`
	 * mirrors the Existing flow (`formData.documents`, possibly empty).
	 */
	const startExistingProjectSetup = async (projectId: string) => {
		try {
			const repoTags: Record<string, string> = {};
			for (const r of formData.selectedGitHubRepos) {
				if (r.roleTag?.trim()) {
					repoTags[r.htmlUrl] = r.roleTag.trim();
				}
			}
			for (const r of formData.selectedGitLabRepos) {
				if (r.roleTag?.trim()) {
					repoTags[r.htmlUrl] = r.roleTag.trim();
				}
			}
			for (const r of formData.selectedAzureDevOpsRepos) {
				if (r.roleTag?.trim()) {
					repoTags[r.htmlUrl] = r.roleTag.trim();
				}
			}

			const result = await orpcClient.projects.existingSetup.start({
				projectId,
				organizationId: effectiveOrganizationId ?? null,
				repoUrls: buildRepoUrls(),
				repoTags:
					Object.keys(repoTags).length > 0 ? repoTags : undefined,
				selectedDocumentTypes: formData.documents,
				projectTypes: formData.projectTypes,
				projectName: formData.name.trim(),
				documentPrompts: formData.documentPrompts,
			});
			if (result?.skippedRepos && result.skippedRepos.length > 0) {
				toast.warning(
					`Project created & valid repos connected, but skipped: ${result.skippedRepos.join(", ")}. You can re-add them in Settings.`,
				);
			}
		} catch (err) {
			console.error(
				"[UnifiedSetup] existingSetup.start failed (fire-and-forget):",
				err,
			);
			toast.warning(
				"Project created but setup could not start — retry from the project page",
			);
		}
	};

	/**
	 * Maps the unified Backlog card selection to the `projects.create` PM block.
	 * Returns an empty object when no backlog was connected so the create
	 * payload carries NO PM fields (AC#3). Never returns a half-configured
	 * block — the submit-handler validation gate below blocks that case first.
	 */
	const buildPmBlock = (): {
		projectManagementMcpServerId?: string | null;
		projectManagementMcpConfigId?: string | null;
		projectManagementContainerId?: string | null;
		projectManagementContainerName?: string | null;
		projectManagementAdditionalContext?: Record<string, unknown> | null;
	} => {
		if (!hasBacklogConnected) {
			return {};
		}
		return {
			projectManagementMcpServerId:
				formData.projectManagementMcpServerId ?? undefined,
			projectManagementMcpConfigId:
				formData.projectManagementMcpConfigId ?? undefined,
			projectManagementContainerId:
				formData.projectManagementContainerId ?? undefined,
			projectManagementContainerName:
				formData.projectManagementContainerName ?? undefined,
			projectManagementAdditionalContext:
				formData.projectManagementAdditionalContext ?? undefined,
		};
	};

	/**
	 * Website URLs for the create payload. Empty values flow through unchanged —
	 * `create-project.ts` normalizes blanks (`?.trim() || undefined`,
	 * `?.filter((u) => u?.trim())`) and the schema accepts `""`, so a
	 * brief-only create never throws (§11).
	 */
	const buildWebsiteUrls = (): {
		primaryWebsiteUrl?: string;
		additionalWebsiteUrls?: string[];
	} => ({
		primaryWebsiteUrl: formData.primaryWebsiteUrl.trim() || undefined,
		additionalWebsiteUrls:
			formData.additionalWebsiteUrls.length > 0
				? formData.additionalWebsiteUrls
				: undefined,
	});

	/**
	 * Azure DevOps post-create connect (folded in from PR #1219, adapted to O1).
	 * ADO has no OAuth, so a `ProjectRepositoryIntegration` (encrypted PAT + org)
	 * must be created per repo via `repositoryIntegrations.connect` BEFORE the
	 * unified `existingSetup.start` runs. The shared `AzureDevOpsPatRepoPicker`
	 * already connects per repo at confirm time when a DRAFT projectId is present
	 * (the preferred path — `azureDevOpsCredsRef` is null here, nothing to do).
	 * Fallback: if no DRAFT projectId existed at confirm time the PAT is held in
	 * the ref and we connect each repo NOW.
	 *
	 * Returns `true` when setup may proceed (no ADO repos, picker already
	 * connected, or at least one connect succeeded) and `false` when ALL ADO
	 * connects failed — the caller then skips `existingSetup.start` but keeps the
	 * project so the user can retry from Settings. The in-memory PAT is cleared as
	 * soon as the connects resolve.
	 */
	const connectAzureDevOpsRepos = async (
		projectId: string,
	): Promise<boolean> => {
		const repos = formData.selectedAzureDevOpsRepos;
		const creds = azureDevOpsCredsRef.current;
		// No ADO repos, or the picker already created the integrations (DRAFT
		// projectId path): nothing to connect, proceed with setup.
		if (repos.length === 0 || !creds) {
			return true;
		}

		const failedRepos: string[] = [];
		for (const repo of repos) {
			try {
				await orpcClient.projects.repositoryIntegrations.connect({
					projectId,
					organizationId: effectiveOrganizationId ?? null,
					provider: "AZURE_DEVOPS",
					authMethod: "PAT",
					repositoryUrl: repo.htmlUrl,
					repositoryOwner: creds.azureOrganization,
					repositoryName: repo.name,
					defaultBranch: repo.defaultBranch,
					pat: creds.pat,
					azureOrganization: creds.azureOrganization,
					roleTag: repo.roleTag
						? repo.roleTag.trim() || undefined
						: undefined,
				});
			} catch (err: unknown) {
				const isAlreadyConnected =
					(err as { code?: string })?.code === "CONFLICT";
				if (!isAlreadyConnected) {
					console.error(
						"[UnifiedSetup] Failed to connect Azure DevOps repo:",
						repo.name,
						err,
					);
					failedRepos.push(`${repo.projectName}/${repo.name}`);
				}
			}
		}
		// Clear the in-memory PAT as soon as the connects resolve.
		azureDevOpsCredsRef.current = null;

		if (failedRepos.length === repos.length) {
			// Nothing connected — keep the project but skip setup and surface the
			// failure so the user can retry from Settings.
			toast.error(
				`Project created, but no Azure DevOps repositories could be connected: ${failedRepos.join(", ")}. You can retry from the project page.`,
			);
			return false;
		}

		if (failedRepos.length > 0) {
			// Partial failure — keep the successes + the project and name the
			// ones that failed (parity with the GitHub/GitLab failCount toast).
			toast.warning(
				`Some Azure DevOps repositories could not be connected: ${failedRepos.join(", ")}. The others were connected.`,
			);
		}

		return true;
	};

	const handleDraftSaved = useCallback((projectId: string) => {
		setCreatedProjectId(projectId);
	}, []);

	// Get the effective project ID (for edit mode or after creation)
	const effectiveProjectId = projectIdToFetch || createdProjectId;

	// Discard-draft state — only true while the cancel + soft-delete pipeline is
	// in flight, so the footer button can render a loading affordance.
	const [isDiscarding, setIsDiscarding] = useState(false);

	/**
	 * handleDiscardDraft — Group 10 of the unified context-uploader wizard spec
	 * (§6.2, §7.3, §6.4).
	 *
	 * Pipeline (in order):
	 *   1. Best-effort cancel of any in-flight URL crawls on the DRAFT via
	 *      `projects.contexts.cancelDraftCrawls`. Errors here are LOGGED and
	 *      swallowed — they must not block the actual delete (spec §6.2 step
	 *      1 + 2). No user-facing toast on cancel outcome — silent per §6.4.
	 *   2. Soft-delete the DRAFT via the existing `projects.delete`
	 *      procedure (`delete-project.ts`).
	 *   3. Invalidate draft / projects caches + clear the wizard
	 *      sessionStorage snapshot, then redirect to the projects list.
	 *
	 * A delete failure DOES surface a toast — that's a legitimate error state
	 * (DRAFT survives, user needs to know), not cancellation noise. The
	 * silent contract in §6.4 covers cancellation outcomes only.
	 *
	 * The button is gated by the existence of a DRAFT (non-edit-mode OR
	 * draft-resume) with a non-null `effectiveProjectId`. Editing an ACTIVE
	 * project must not show this button — that boundary belongs to
	 * `ProjectGeneralSettings`, not the wizard.
	 */
	const canDiscardDraft =
		!!effectiveProjectId && (isDraftResume || !isEditMode);

	const handleDiscardDraft = useCallback(() => {
		if (!canDiscardDraft || !effectiveProjectId) {
			return;
		}

		const projectIdToDiscard = effectiveProjectId;
		const orgIdToDiscard = effectiveOrganizationId ?? null;

		confirm({
			title: "Discard draft?",
			message:
				"This deletes the draft and cancels any in-flight context indexing. You can't recover it.",
			confirmLabel: "Discard draft",
			cancelLabel: "Keep working",
			destructive: true,
			onConfirm: async () => {
				setIsDiscarding(true);
				try {
					// Step 1: best-effort cancel of any in-flight crawls. The
					// per-row procedure already tolerates "workflow not found"
					// races and never throws on cancel logic — but a genuine
					// network / 5xx failure must NOT block the delete (spec
					// §6.2). Log + continue.
					try {
						await orpcClient.projects.contexts.cancelDraftCrawls({
							projectId: projectIdToDiscard,
							organizationId: orgIdToDiscard,
						});
					} catch (cancelError) {
						console.warn(
							"[DiscardDraft] cancelDraftCrawls failed — proceeding with delete:",
							cancelError,
						);
					}

					// Step 2: soft-delete via the existing pipeline.
					await orpcClient.projects.delete({
						id: projectIdToDiscard,
						organizationId: orgIdToDiscard,
					});

					// Step 3: refresh caches + clear local wizard state.
					void queryClient.invalidateQueries({
						queryKey: orpc.projects.listDrafts.queryOptions({
							input: { organizationId: orgIdToDiscard },
						}).queryKey,
					});
					void queryClient.invalidateQueries({
						queryKey: ["projects"],
					});
					clearWizardSession();

					router.push(projectsBasePath);
				} catch (deleteError) {
					toast.error("Failed to discard draft", {
						description:
							deleteError instanceof Error
								? deleteError.message
								: String(deleteError),
					});
				} finally {
					setIsDiscarding(false);
				}
			},
		});
	}, [
		canDiscardDraft,
		effectiveProjectId,
		effectiveOrganizationId,
		confirm,
		queryClient,
		clearWizardSession,
		router,
		projectsBasePath,
	]);

	// Wizard-level draft auto-save: persists all form fields to the server draft
	const saveDraftMutation = useMutation(
		orpc.projects.saveDraft.mutationOptions({
			onSuccess: (data) => {
				if (data.created) {
					handleDraftSaved(data.project.id);
				}
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.listDrafts.queryOptions({
						input: {
							organizationId: effectiveOrganizationId ?? null,
						},
					}).queryKey,
				});
				void queryClient.invalidateQueries({ queryKey: ["projects"] });
			},
		}),
	);

	const saveDraftToServer = useCallback(
		// `overrideStep` lets navigation handlers (Next/Back) commit the new
		// step synchronously without waiting for the React state update + 1s
		// debounce — `currentStep` from the closure is still stale at the
		// moment those handlers fire setCurrentStep(next).
		(overrideStep?: number) => {
			if (
				(isEditMode && !isDraftResume) ||
				!draftKey ||
				!formData.name.trim() ||
				// Project already activated (create/update succeeded), or we're on
				// the post-create finish step — there is no DRAFT to save, and a
				// trailing autosave would hit a non-draft and 400. `currentStep`
				// covers a direct URL-resume onto `?step=6` (no onSuccess ran).
				hasActivatedRef.current ||
				currentStep === FINISH_STEP_ID
			) {
				return;
			}

			// Primary repo (if any) flows to typed columns so the activated project has
			// them populated; full repo lists also live in wizardState for resume.
			const primaryGitHubRepo = formData.selectedGitHubRepos[0] ?? null;
			const primaryGitLabRepo = formData.selectedGitLabRepos[0] ?? null;
			const primaryRepo = primaryGitHubRepo ?? primaryGitLabRepo;

			saveDraftMutation.mutate({
				draftKey,
				name: formData.name.trim(),
				organizationId: effectiveOrganizationId ?? null,
				description: formData.description.trim() || undefined,
				techStack:
					formData.techStack.length > 0
						? formData.techStack
						: undefined,
				// Send only the user-picked features. customRequirements travels in
				// wizardState; activation merges it back into features as "Custom: …".
				features:
					formData.features.length > 0
						? formData.features
						: undefined,
				projectTypes:
					formData.projectTypes.length > 0
						? formData.projectTypes
						: undefined,
				tags: formData.tags.length > 0 ? formData.tags : undefined,
				icon: formData.icon !== "📁" ? formData.icon : undefined,
				color:
					formData.color !== "#3b82f6" ? formData.color : undefined,
				// Repo connection (typed columns; meaningful post-activation)
				repositoryUrl: primaryRepo?.htmlUrl,
				repositoryOwner: primaryRepo?.owner,
				repositoryName: primaryRepo?.name,
				defaultBranch: primaryRepo?.defaultBranch,
				// Backlog (PM) block — typed columns, meaningful post-activation
				// so a resumed DRAFT keeps the connected backlog.
				projectManagementMcpServerId:
					formData.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					formData.projectManagementMcpConfigId,
				projectManagementContainerId:
					formData.projectManagementContainerId,
				projectManagementContainerName:
					formData.projectManagementContainerName,
				projectManagementAdditionalContext:
					formData.projectManagementAdditionalContext,
				// Wizard-only ephemera (server bundles into wizardState JSON)
				currentStep: overrideStep ?? currentStep,
				customRequirements:
					formData.customRequirements.trim() || undefined,
				documents: formData.documents,
				tempContextIds: formData.tempContextIds,
				wizardSessionId,
				selectedTeamsChats: formData.selectedTeamsChats,
				selectedNotionPages: formData.selectedNotionPages,
				selectedSlackChannels: formData.selectedSlackChannels,
				selectedGitHubRepos: formData.selectedGitHubRepos,
				selectedGitLabRepos: formData.selectedGitLabRepos,
				// Persisting repo metadata (URLs/names) is safe; the PAT is held
				// separately in `azureDevOpsCredsRef` and never sent to the draft.
				selectedAzureDevOpsRepos: formData.selectedAzureDevOpsRepos,
				// Unified-project-setup wizard ephemera (resume support)
				codebaseRepoUrls: formData.codebaseRepoUrls,
				primaryWebsiteUrl: formData.primaryWebsiteUrl || undefined,
				additionalWebsiteUrls: formData.additionalWebsiteUrls,
				projectManagementDetectedType:
					formData.projectManagementDetectedType,
				documentPrompts: formData.documentPrompts,
			});
		},
		[
			isEditMode,
			isDraftResume,
			draftKey,
			formData,
			currentStep,
			wizardSessionId,
			effectiveOrganizationId,
			saveDraftMutation.mutate,
		],
	);

	// Debounced auto-save at the wizard root: catches mid-step changes (selections,
	// uploads, picker dialogs) that the Next/Back-only triggers below would miss.
	// Using a ref for saveDraftToServer keeps the effect's dep array stable so
	// it only fires on debounced value changes — not on every formData mutation.
	// 500ms matches the convention used elsewhere in the wizard (e.g. the old
	// BasicInfoStep title-only debounce); short enough to keep the tab-close
	// loss window small, long enough to coalesce keystroke bursts and clicks.
	const [debouncedFormData] = useDebounceValue(formData, 500);
	const [debouncedStep] = useDebounceValue(currentStep, 500);
	const saveDraftRef = useRef(saveDraftToServer);
	saveDraftRef.current = saveDraftToServer;
	useEffect(() => {
		saveDraftRef.current();
		// debouncedFormData/debouncedStep are read by the ref'd callback, not used directly
	}, [debouncedFormData, debouncedStep]);

	// The Review step is always step 4 and the last in-stepper step is always 5
	// (Generate). The stepper is invariant across the standard and
	// repo-connected flows.
	const reviewStepId = 4;
	const maxStepId = 5;

	// Defensive clamp: keep currentStep within the 5-step stepper range. The
	// post-create finish step (6) is exempt — it is a valid terminal view above
	// maxStepId, reached only after a successful create. Guards against a
	// restored snapshot carrying an out-of-range step.
	useEffect(() => {
		if (currentStep > maxStepId && currentStep !== FINISH_STEP_ID) {
			setCurrentStep(maxStepId);
		}
	}, [currentStep, maxStepId]);

	/**
	 * Whether the project brief has been answered. Derived once and consulted by
	 * BOTH the Next button and the step circles — the circles let you jump to any
	 * step before the last, so a check that lived only in `handleNext` could be
	 * walked straight past. That is the same hole this validation exists to
	 * close: a project reaching the end with no description and no phase, graded
	 * afterwards against a guess.
	 */
	const basicsAnswered =
		formData.name.trim().length > 0 &&
		!hasDuplicateName &&
		formData.description.trim().length > MIN_DESCRIPTION_LENGTH &&
		!!formData.projectPhase &&
		(formData.projectPhase !== "DISCOVERY_PLANNING" ||
			(!!formData.expectedDevelopmentStartDate &&
				formData.expectedDevelopmentStartDate >=
					new Date().toLocaleDateString("en-CA")));

	const handleNext = () => {
		// Validate current step
		if (currentStep === 1 && !formData.name.trim()) {
			toast.error("Please enter a project name");
			return;
		}
		if (currentStep === 1 && hasDuplicateName) {
			toast.error("A project with this name already exists");
			return;
		}
		// The three Project Basics rows the checklist spreadsheet leaves off the
		// checklist on the grounds that creation collects them. It did not, so
		// they were required nowhere; this is where the sheet expects the
		// requirement to live.
		if (
			currentStep === 1 &&
			formData.description.trim().length <= MIN_DESCRIPTION_LENGTH
		) {
			toast.error(
				`Give the project a brief of more than ${MIN_DESCRIPTION_LENGTH} characters — it is the first thing Fabric reads`,
			);
			return;
		}
		if (currentStep === 1 && !formData.projectPhase) {
			toast.error("Choose which phase this project is in");
			return;
		}
		if (
			currentStep === 1 &&
			formData.projectPhase === "DISCOVERY_PLANNING" &&
			!formData.expectedDevelopmentStartDate
		) {
			toast.error("Choose when development is expected to start");
			return;
		}
		// The picker's `min` stops the calendar offering a past day; typing one
		// still gets through, and a start date in the past would immediately
		// un-quiet the codebase items the date exists to quiet (FR52/53/55).
		if (
			currentStep === 1 &&
			formData.projectPhase === "DISCOVERY_PLANNING" &&
			formData.expectedDevelopmentStartDate <
				new Date().toLocaleDateString("en-CA")
		) {
			toast.error(
				"Expected development start can't be in the past — pick today or later",
			);
			return;
		}

		if (currentStep < maxStepId) {
			const next = currentStep + 1;
			setCurrentStep(next);
			updateUrlStep(next, effectiveProjectId);
			// Fire-and-forget with explicit new step: setCurrentStep is async,
			// so the closure's `currentStep` is still the old value; passing
			// `next` ensures the immediate save records the destination step.
			saveDraftToServer(next);
		}
	};

	const handleBack = () => {
		if (currentStep > 1) {
			const next = currentStep - 1;
			setCurrentStep(next);
			updateUrlStep(next, effectiveProjectId);
			saveDraftToServer(next);
		}
	};

	const handleCreateOrUpdate = () => {
		if (!formData.name.trim()) {
			toast.error("Please enter a project name");
			return;
		}

		// Backlog validation (§4.3): a selected PM tool requires a container
		// (and, for ADO, a board/team). Block submit so a half-configured PM
		// block is never sent. Skipping the card entirely is always allowed.
		const backlogError = getBacklogValidationError({
			hasBacklogConnected,
			containerId: formData.projectManagementContainerId,
			detectedType: formData.projectManagementDetectedType,
			additionalContext: formData.projectManagementAdditionalContext,
		});
		if (backlogError) {
			toast.error(backlogError);
			return;
		}

		// Combine features and custom requirements
		const allFeatures = [...formData.features];
		if (formData.customRequirements.trim()) {
			allFeatures.push(`Custom: ${formData.customRequirements.trim()}`);
		}

		if (isEditMode && projectIdToFetch && !isDraftResume) {
			// Update existing ACTIVE project
			const primaryGitHubRepo = formData.selectedGitHubRepos[0] ?? null;
			const primaryGitLabRepo = formData.selectedGitLabRepos[0] ?? null;
			const repoFields = primaryGitHubRepo
				? {
						repositoryUrl: primaryGitHubRepo.htmlUrl,
						repositoryOwner: primaryGitHubRepo.owner,
						repositoryName: primaryGitHubRepo.name,
						defaultBranch: primaryGitHubRepo.defaultBranch,
					}
				: primaryGitLabRepo
					? {
							repositoryUrl: primaryGitLabRepo.htmlUrl,
							repositoryOwner: primaryGitLabRepo.owner,
							repositoryName: primaryGitLabRepo.name,
							defaultBranch: primaryGitLabRepo.defaultBranch,
						}
					: {};

			updateMutation.mutate({
				id: projectIdToFetch,
				name: formData.name.trim(),
				description: formData.description.trim() || undefined,
				projectTypes:
					formData.projectTypes.length > 0
						? formData.projectTypes
						: undefined,
				icon: formData.icon,
				color: formData.color,
				tags: formData.tags,
				techStack: formData.techStack,
				features: allFeatures,
				goals: formData.customRequirements.trim() || undefined,
				organizationId: effectiveOrganizationId,
				status: "ACTIVE",
				// Pass wizard session ID to migrate temp contexts after project update
				tempSessionId:
					formData.tempContextIds.length > 0
						? wizardSessionId
						: undefined,
				// Include GitHub repo fields (same as create path)
				...repoFields,
				// Backlog (PM) block + website URLs from the optional cards.
				...buildPmBlock(),
				...buildWebsiteUrls(),
				// O1: when a repo and/or backlog is connected, make
				// `existingProjectSetupWorkflow` the sole owner of story sync so
				// the create path does NOT also start `storySyncWorkflow`
				// (no double-pull). Left unset (default) when neither is
				// connected so the AC#3 path is untouched.
				...(hasConnectedIntegration ? { skipAutoSync: true } : {}),
			});
		} else {
			// Create new project — include primary repo fields if code-based
			const primaryGitHubRepo = formData.selectedGitHubRepos[0] ?? null;
			const primaryGitLabRepo = formData.selectedGitLabRepos[0] ?? null;
			const repoFields = primaryGitHubRepo
				? {
						repositoryUrl: primaryGitHubRepo.htmlUrl,
						repositoryOwner: primaryGitHubRepo.owner,
						repositoryName: primaryGitHubRepo.name,
						defaultBranch: primaryGitHubRepo.defaultBranch,
					}
				: primaryGitLabRepo
					? {
							repositoryUrl: primaryGitLabRepo.htmlUrl,
							repositoryOwner: primaryGitLabRepo.owner,
							repositoryName: primaryGitLabRepo.name,
							defaultBranch: primaryGitLabRepo.defaultBranch,
						}
					: {};

			createMutation.mutate({
				name: formData.name.trim(),
				description: formData.description.trim() || undefined,
				projectPhase: formData.projectPhase || undefined,
				expectedDevelopmentStartDate:
					formData.projectPhase === "DISCOVERY_PLANNING" &&
					formData.expectedDevelopmentStartDate
						? new Date(formData.expectedDevelopmentStartDate)
						: undefined,
				projectTypes:
					formData.projectTypes.length > 0
						? formData.projectTypes
						: undefined,
				icon: formData.icon,
				color: formData.color,
				tags: formData.tags,
				techStack: formData.techStack,
				features: allFeatures,
				goals: formData.customRequirements.trim() || undefined,
				organizationId: effectiveOrganizationId,
				// Pass draftKey so the backend can find and activate the DRAFT
				draftKey: draftKey || undefined,
				// Pass wizard session ID to migrate temp contexts after project creation
				tempSessionId:
					formData.tempContextIds.length > 0
						? wizardSessionId
						: undefined,
				...repoFields,
				// Backlog (PM) block + website URLs from the optional cards.
				// Empty/unconnected ⇒ these spread to nothing meaningful (PM
				// fields omitted, URLs normalized server-side) so AC#3 holds.
				...buildPmBlock(),
				...buildWebsiteUrls(),
				// O1: a connected repo and/or backlog makes
				// `existingProjectSetupWorkflow` the sole owner of story sync, so
				// `create-project.ts` must NOT also start `storySyncWorkflow`
				// (avoids the Phase 1B double-pull). Unset (default) on the
				// blank-optionals path so AC#3 is untouched.
				...(hasConnectedIntegration ? { skipAutoSync: true } : {}),
			});
		}
	};

	const handleCompleteGeneration = () => {
		const targetProjectId = effectiveProjectId;
		if (targetProjectId) {
			router.push(`${projectsBasePath}/${targetProjectId}`);
		} else {
			router.push(projectsBasePath);
		}
	};

	// D4: "Go to project" primary action / skip on the finish-setup
	// step. Identical target to handleCompleteGeneration; named separately so the
	// finish step reads clearly and so transcript-linking can stay optional.
	const handleGoToProject = () => {
		if (effectiveProjectId) {
			router.push(`${projectsBasePath}/${effectiveProjectId}`);
		} else {
			router.push(projectsBasePath);
		}
	};

	// True while on the post-create finish-setup step (D4). Hides the stepper
	// progress + Next/Back nav (it is a terminal view, like the doc-gen step).
	const isFinishStep = currentStep === FINISH_STEP_ID;

	return (
		<div className="mx-auto max-w-5xl space-y-8">
			{/* Header */}
			<div className="rounded-2xl border border-border bg-card px-6 py-7">
				<h1
					className="text-4xl tracking-tight"
					style={{
						fontFamily:
							"var(--font-sans, 'EB Garamond', Georgia, serif)",
						fontWeight: 400,
					}}
				>
					{isEditMode && !isDraftResume
						? "Edit Project"
						: "Create New Project"}
				</h1>
				<p className="text-muted-foreground mt-2 text-lg">
					{isEditMode && !isDraftResume
						? "Update your project details and regenerate documentation"
						: "Set up your project to generate AI-optimized documentation"}
				</p>
			</div>

			{/* Progress Steps — hidden on the post-create finish step (D4). */}
			{!isFinishStep && (
				<div className="rounded-2xl border border-border bg-card px-6 py-6">
					{/* Circles row - CSS Grid for equal-width columns */}
					<div
						className="grid items-center"
						style={{
							gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
						}}
					>
						{steps.map((step, index) => {
							const isCompleted = currentStep > step.id;
							const isCurrent = currentStep === step.id;
							const canGoTo = isEditMode
								? true
								: (step.id === 1 || basicsAnswered) &&
									(step.id < 5 ||
										(step.id === 5 && !!createdProjectId));
							const prevDone =
								index > 0 && currentStep > steps[index - 1].id;

							const circleClasses = cn(
								"relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors duration-200",
								isCompleted &&
									"border-secondary bg-secondary text-secondary-foreground shadow-sm",
								isCurrent &&
									!isCompleted &&
									"border-primary/30 bg-primary/90 text-primary-foreground shadow-lg shadow-primary/10",
								!isCompleted &&
									!isCurrent &&
									"border-border bg-muted text-muted-foreground",
							);

							return (
								<div
									key={step.id}
									className="flex items-center min-w-0"
								>
									{/* Connector line before (except first) */}
									{index > 0 ? (
										<div
											className="h-1 flex-1 min-w-0"
											aria-hidden
										>
											<div
												className={cn(
													"h-full rounded-full transition-colors duration-300",
													prevDone
														? "bg-secondary"
														: "bg-border",
												)}
											/>
										</div>
									) : (
										<div
											className="h-1 flex-1 min-w-0 opacity-0"
											aria-hidden
										/>
									)}

									<button
										type="button"
										disabled={!canGoTo}
										onClick={() => {
											if (!canGoTo) {
												return;
											}
											setCurrentStep(step.id);
											updateUrlStep(
												step.id,
												projectIdToFetch ||
													createdProjectId,
											);
										}}
										className={cn(
											"flex shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-full transition-opacity",
											!canGoTo &&
												"opacity-50 cursor-not-allowed",
											canGoTo &&
												"hover:opacity-90 cursor-pointer",
										)}
										aria-current={
											isCurrent ? "step" : undefined
										}
										aria-label={`${step.name}${isCompleted ? ", completed" : isCurrent ? ", current step" : ""}`}
									>
										<div className={circleClasses}>
											{isCompleted ? (
												<CheckIcon className="h-5 w-5" />
											) : (
												<span className="text-sm font-semibold tabular-nums">
													{step.id}
												</span>
											)}
										</div>
									</button>

									{/* Connector line after (except last) */}
									{index < steps.length - 1 ? (
										<div
											className="h-1 flex-1 min-w-0"
											aria-hidden
										>
											<div
												className={cn(
													"h-full rounded-full transition-colors duration-300",
													isCompleted
														? "bg-secondary"
														: "bg-border",
												)}
											/>
										</div>
									) : (
										<div
											className="h-1 flex-1 min-w-0 opacity-0"
											aria-hidden
										/>
									)}
								</div>
							);
						})}
					</div>

					{/* Labels row - same grid for alignment */}
					<div
						className="mt-4 grid gap-1"
						style={{
							gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
						}}
					>
						{steps.map((step) => {
							const isCompleted = currentStep > step.id;
							const isCurrent = currentStep === step.id;

							return (
								<div
									key={step.id}
									className="flex flex-col items-center gap-0.5 px-1"
								>
									<span
										className={cn(
											"text-xs font-medium text-center",
											isCurrent &&
												"text-foreground font-bold",
											isCompleted &&
												"text-secondary font-semibold",
											!isCurrent &&
												!isCompleted &&
												"text-muted-foreground",
										)}
									>
										{step.name}
									</span>
									<span className="text-[10px] text-muted-foreground text-center leading-tight">
										{step.description}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Step Content */}
			<Card className="rounded-2xl border border-border bg-card p-8">
				{/* Loading state for edit mode */}
				{isEditMode && isLoadingProject && (
					<div className="flex flex-col items-center justify-center py-16">
						<Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
						<p className="mt-4 text-muted-foreground">
							Loading project data...
						</p>
					</div>
				)}
				{(!isEditMode || !isLoadingProject) && currentStep === 1 && (
					<BasicInfoStep
						formData={formData}
						updateFormData={updateFormData}
						wizardSessionId={wizardSessionId}
						organizationId={effectiveOrganizationId ?? undefined}
						draftKey={draftKey}
						draftSaveState={
							saveDraftMutation.status === "pending"
								? "saving"
								: saveDraftMutation.status === "success"
									? "saved"
									: saveDraftMutation.status === "error"
										? "error"
										: "idle"
						}
						isEditMode={isEditMode && !isDraftResume}
						onDuplicateNameChange={setHasDuplicateName}
						onAzureDevOpsReposChange={handleAzureDevOpsReposChange}
						projectId={effectiveProjectId ?? undefined}
					/>
				)}
				{(!isEditMode || !isLoadingProject) && currentStep === 2 && (
					<TechStackStep
						formData={formData}
						updateFormData={updateFormData}
					/>
				)}
				{(!isEditMode || !isLoadingProject) && currentStep === 3 && (
					<FeaturesStep
						formData={formData}
						updateFormData={updateFormData}
					/>
				)}
				{(!isEditMode || !isLoadingProject) &&
					currentStep === reviewStepId &&
					(isCodeBased ? (
						<div className="space-y-6">
							<ProjectReviewSummary
								title="Review Before Analysis"
								description="Confirm the project brief and shape before Fabric analyzes your repository and generates documentation."
								projectName={formData.name}
								projectBrief={formData.description}
								projectTypes={formData.projectTypes}
								techStack={formData.techStack}
								features={formData.features}
							/>
							<CodeBasedReviewStep formData={formData} />
						</div>
					) : (
						<div className="space-y-6">
							<ProjectReviewSummary
								title="Review Before Creation"
								description="Check the brief, shape, stack, and feature direction before choosing which documents Fabric should generate."
								projectName={formData.name}
								projectBrief={formData.description}
								projectTypes={formData.projectTypes}
								techStack={formData.techStack}
								features={[
									...formData.features,
									...(formData.customRequirements.trim()
										? [formData.customRequirements.trim()]
										: []),
								]}
							/>
							<DocumentsStep
								formData={formData}
								updateFormData={updateFormData}
								projectId={effectiveProjectId ?? undefined}
								organizationId={
									effectiveOrganizationId ?? undefined
								}
							/>
							{/* Per-document prompt customization (D10) — only
							    relevant once documents are selected. */}
							{formData.documents.length > 0 && (
								<ReviewPromptsStep
									documents={formData.documents}
									documentPrompts={formData.documentPrompts}
									onDocumentPromptsChange={(prompts) =>
										updateFormData({
											documentPrompts: prompts,
										})
									}
								/>
							)}
						</div>
					))}
				{currentStep === 5 && effectiveProjectId && (
					<DocumentGenerationStep
						projectId={effectiveProjectId}
						selectedDocumentIds={formData.documents}
						onComplete={handleCompleteGeneration}
						onBack={() => {
							setCurrentStep(4);
							updateUrlStep(4, effectiveProjectId);
						}}
					/>
				)}
				{/* D4: post-create finish-setup step — optional
				    meeting-transcript linking against the real projectId + a
				    "Go to project" primary action. Only reachable after a
				    successful create (effectiveProjectId is set). */}
				{isFinishStep && effectiveProjectId && (
					<WizardFinishStep
						projectId={effectiveProjectId}
						organizationId={effectiveOrganizationId ?? null}
						projectsBasePath={projectsBasePath}
						projectName={formData.name}
						hasBacklogConnected={hasBacklogConnected}
						backlogContainerName={
							formData.projectManagementContainerName
						}
						hasRepoConnected={hasAnyRepoConnected}
						repoCount={buildRepoUrls().length}
						onGoToProject={handleGoToProject}
					/>
				)}
			</Card>

			{/* Navigation Buttons */}
			{currentStep < maxStepId && (
				<div className="rounded-2xl border border-border bg-card px-4 py-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							{currentStep > 1 ? (
								<Button
									variant="outline"
									onClick={handleBack}
									className="cursor-pointer border-border text-muted-foreground"
								>
									Back
								</Button>
							) : null}
							{/*
							 * Discard draft (Group 10, spec §6.2). Visible
							 * whenever a DRAFT exists in this wizard
							 * session (new flow with autosave OR
							 * draft-resume). Edit-mode on an ACTIVE
							 * project never shows it — that boundary
							 * lives in ProjectGeneralSettings.
							 */}
							{canDiscardDraft ? (
								<Button
									variant="outline"
									onClick={handleDiscardDraft}
									disabled={isDiscarding}
									aria-label="Discard draft"
									data-testid="discard-draft-button"
									className="cursor-pointer border-destructive/30 text-destructive hover:border-destructive/50 hover:bg-destructive/10"
								>
									{isDiscarding ? (
										<Loader2Icon className="size-4 animate-spin" />
									) : (
										<Trash2Icon className="size-4" />
									)}
									<span className="ml-2">
										{isDiscarding
											? "Discarding…"
											: "Discard draft"}
									</span>
								</Button>
							) : null}
						</div>

						<div className="flex flex-col items-end gap-2">
							{currentStep < reviewStepId ? (
								<Button
									onClick={handleNext}
									size="lg"
									variant="outline"
									className="cursor-pointer border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/[0.14]"
								>
									Continue
								</Button>
							) : (
								<>
									{!formData.name.trim() &&
										!createMutation.isPending &&
										!updateMutation.isPending && (
											<p className="text-sm text-amber-600 dark:text-highlight">
												Enter a project name in Basic
												Info to create your project.{" "}
												<button
													type="button"
													onClick={() => {
														setCurrentStep(1);
														updateUrlStep(
															1,
															effectiveProjectId,
														);
													}}
													className="font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
												>
													Go to Basic Info
												</button>
											</p>
										)}
									<Button
										onClick={handleCreateOrUpdate}
										disabled={
											createMutation.isPending ||
											updateMutation.isPending ||
											!formData.name.trim()
										}
										size="lg"
										variant="outline"
										className="cursor-pointer border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/[0.14]"
										title={
											!formData.name.trim()
												? "Enter a project name in Basic Info first"
												: undefined
										}
									>
										{createMutation.isPending ||
										updateMutation.isPending
											? isEditMode
												? "Updating..."
												: isCodeBased
													? "Creating & Analyzing..."
													: "Creating..."
											: isEditMode
												? "Update & Continue"
												: isCodeBased
													? "Create & Analyze"
													: "Create Project"}
									</Button>
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
