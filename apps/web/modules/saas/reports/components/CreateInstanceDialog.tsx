"use client";

import {
	getProjectReportSetupReason,
	hasProjectKnowledgeSource,
	type ReportEvidenceConfig,
	reportEvidenceConfigSchema,
} from "@repo/database/prisma/queries/lib/report-evidence";
import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { useDialogFocusReturn } from "@saas/reports/hooks/use-dialog-focus-return";
import { useInstanceDataSourceSetup } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	generateProblem,
	useReportSuiteCreation,
} from "@saas/reports/hooks/use-report-suite-creation";
import { promptFieldRows } from "@saas/reports/lib/report-parameter-values";
import type { ReportPromptDefaults } from "@saas/reports/lib/report-template-defaults";
import {
	parseTemplateDefinition,
	parseTemplateWorkspaces,
	promptOverrideFields,
} from "@saas/reports/lib/report-template-definition";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	SettingsIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateReportReadiness } from "./CreateReportReadiness";
import {
	InstanceContextFields,
	InstanceDataSourcePicker,
} from "./InstanceDataSourceFields";
import { InstanceNameField } from "./InstanceNameField";
import { RefinePromptButton } from "./RefinePromptButton";
import { ReportEvidenceSettings } from "./ReportEvidenceSettings";
import { ReportParameterFields } from "./ReportParameterFields";
import { ReportTemplatePreview } from "./ReportTemplatePreview";
import { TemplatePromptPreview } from "./TemplatePromptPreview";

type ReportTemplate = {
	id: string;
	name: string;
	description: string | null;
	heroEmojis?: string[];
	templateType: string;
	outputFormat: string;
	/** Template definition JSON: data sources, user prompt, agents, sections. */
	definition?: unknown;
	/** Connection requirements JSON (legacy, derived from definition). */
	connections?: unknown;
	/** The parameters' JSON Schema. */
	parameters?: unknown;
	/** Fabric settings JSON, the system prompt among them. */
	fabricConfig?: unknown;
};

type Props = {
	template: ReportTemplate;
	/**
	 * Organization ID for filtering data.
	 * - `string`: Show data for this organization
	 * - `null`: Show personal data only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
	/** The project whose Reports tab the new report belongs to. */
	projectId?: string;
	onClose: () => void;
	onSuccess?: (instanceId: string) => void;
	basePath?: string;
};

export function CreateInstanceDialog({
	template,
	organizationId: propOrgId,
	projectId,
	onClose,
	onSuccess,
	basePath = "/app/report-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");
	const suiteProjectId = reportSuite ? projectId : undefined;
	const suite = Boolean(suiteProjectId);
	const [name, setName] = useState(`My ${template.name}`);
	const [description, setDescription] = useState("");
	const [reporting, setReporting] = useState<ReportEvidenceConfig>();
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);

	// Shown pre-filled with the template's prompt; saved only once edited.
	const [promptOverride, setPromptOverride] = useState("");
	const [promptDefaults, setPromptDefaults] =
		useState<ReportPromptDefaults | null>(null);

	const definition = useMemo(
		() => parseTemplateDefinition(template.definition, { reportSuite }),
		[template.definition, reportSuite],
	);
	const workspaces = useMemo(
		() => parseTemplateWorkspaces(template.connections),
		[template.connections],
	);
	const { dataSources } = definition;
	const requiresProjectKnowledge = hasProjectKnowledgeSource({ dataSources });

	useEffect(() => {
		if (requiresProjectKnowledge && !reporting) {
			setReporting(
				reportEvidenceConfigSchema.parse({
					version: 1,
					period: "weekly",
					...(reportSuite && projectId ? { projectId } : {}),
				}),
			);
		}
	}, [requiresProjectKnowledge, reporting, reportSuite, projectId]);

	// Pre-populate prompt from template on mount
	const templateUserPrompt = definition.userPrompt;
	useEffect(() => {
		if (templateUserPrompt) {
			setPromptOverride(templateUserPrompt);
		}
	}, [templateUserPrompt]);

	const setup = useInstanceDataSourceSetup({
		dataSources,
		organizationId,
		autoDetect: reportSuite,
		suggestDefaults: reportSuite,
		projectId: suiteProjectId,
	});

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
	);
	const userWorkspaces = workspacesData?.workspaces ?? [];

	const projectSetupReason = getProjectReportSetupReason(
		reporting ? { reporting } : undefined,
		{ dataSources },
		{
			mcpConfigs: Object.values(setup.bindings)
				.map((binding) => binding.mcpConfigId)
				.filter(Boolean),
			workspaces: selectedWorkspaces,
		},
	);

	const creation = useReportSuiteCreation({
		suite,
		dataSources,
		bindings: setup.bindings,
		organizationId,
		basePath,
		onLeave: onClose,
	});
	// A draft waits for its project sources; anything else runs once it exists.
	const generates = suite && !projectSetupReason;

	const createMutation = useMutation(
		orpc.reports.instances.create.mutationOptions({
			onSuccess: (data) => {
				queryClient.invalidateQueries({
					queryKey: ["reports", "instances"],
				});
				if (generates) {
					void creation.startGeneration(data.id);
					return;
				}
				toast.success(
					projectSetupReason
						? "Project report draft created; source setup required"
						: "Instance created successfully",
				);
				onClose();
				if (onSuccess) {
					onSuccess(data.id);
				} else {
					router.push(`${basePath}/instances/${data.id}`);
				}
			},
			onError: (error) => {
				toast.error(error.message || "Failed to create instance");
			},
		}),
	);

	const isWorking = createMutation.isPending || creation.isStarting;
	const generateOff =
		isWorking ||
		(requiresProjectKnowledge && !reporting?.projectId) ||
		(generates
			? !setup.allConfigured || creation.blocked || !name.trim()
			: !setup.allConfigured && !reporting?.projectId);
	const problem = suite
		? generateProblem({
				connections: setup.connectionsState,
				missingSources: creation.missingSources,
				connectionFailure: generates
					? creation.connectionFailure
					: null,
				missingParameters:
					generates && creation.parameters.missing.length > 0,
				setupIncomplete: generates && !setup.allConfigured,
				nameMissing: generates && !name.trim(),
			})
		: null;
	const problemId = useId();
	const focusReturn = useDialogFocusReturn();

	const handleCreate = () => {
		if (generateOff) {
			return;
		}
		if (requiresProjectKnowledge && !reporting?.projectId) {
			toast.error("Choose a project for Project knowledge");
			return;
		}
		if (!name.trim()) {
			toast.error("Please enter a name for the instance");
			return;
		}

		if (!setup.allConfigured && !reporting?.projectId) {
			toast.error(
				"Please configure MCP servers and fill required context fields",
			);
			return;
		}

		const { mcpConfigs, mcpBindings, resourceBindings, context } =
			setup.buildConnections();

		createMutation.mutate({
			templateId: template.id,
			reporting,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			projectId: suiteProjectId,
			...(suite ? { parameterDefaults: creation.parameters.toSave } : {}),
			connections: {
				mcpConfigs,
				mcpBindings,
				resourceBindings,
				context, // Human-readable context for AI
				...promptOverrideFields(promptOverride, templateUserPrompt),
				workflows: [],
				agents: [],
				workspaces: selectedWorkspaces,
				integrations: [],
				integrationBindings: {},
			},
		});
	};

	const emoji = template.heroEmojis?.[0] || "📊";

	return (
		<Dialog
			open
			onOpenChange={() => {
				// Closing now would look like cancelling a run that still starts.
				if (!suite || !isWorking) {
					onClose();
				}
			}}
		>
			<DialogContent
				className="max-w-2xl max-h-[90vh] overflow-y-auto"
				{...(suite ? focusReturn : {})}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<span className="text-xl">{emoji}</span>
						{suite ? "Generate report" : "Use Template"}:{" "}
						{template.name}
					</DialogTitle>
					<DialogDescription>
						{suite
							? "Check what is filled in, connect anything missing, and generate."
							: "Configure your data sources with connection and parameters for this report instance."}
					</DialogDescription>
				</DialogHeader>

				<div className="min-w-0 space-y-6 py-4">
					{suiteProjectId && (
						<ReportTemplatePreview
							templateId={template.id}
							projectId={suiteProjectId}
							organizationId={organizationId}
						/>
					)}

					<InstanceNameField
						value={name}
						onChange={setName}
						invalid={suite && !name.trim()}
					/>

					{/* Description */}
					<div className="space-y-2">
						<Label htmlFor="instance-description">
							Description
						</Label>
						<Textarea
							id="instance-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional description..."
							rows={2}
						/>
					</div>

					{/* Data Source Configuration */}
					{dataSources.length > 0 && (
						<div className="space-y-4">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<SettingsIcon className="h-4 w-4" />
									Data Source Configuration
								</h3>
								<p className="text-sm text-muted-foreground">
									Connect external sources, or use shared
									project knowledge.
								</p>
							</div>
							<InstanceDataSourcePicker
								setup={setup}
								dataSources={dataSources}
								generateProblemId={
									problem ? problemId : undefined
								}
							/>
						</div>
					)}

					{/* Context Fields - Human-readable values for AI */}
					{setup.contextFields.length > 0 && (
						<div className="space-y-4">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<SettingsIcon className="h-4 w-4" />
									Report Context
								</h3>
								<p className="text-sm text-muted-foreground">
									Provide context for the AI to find the right
									data.
								</p>
							</div>
							<InstanceContextFields setup={setup} />
						</div>
					)}

					{suiteProjectId && (
						<ReportParameterFields
							templateId={template.id}
							parameters={template.parameters}
							projectId={suiteProjectId}
							organizationId={organizationId}
							onChange={creation.setParameters}
							onContextDefaults={setup.offerContext}
							onPromptDefaults={setPromptDefaults}
						/>
					)}

					{/* Prompt Override */}
					{dataSources.length > 0 && (
						<div className="space-y-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<Label
									htmlFor="instance-prompt"
									className="text-sm"
								>
									Custom Instructions (Optional)
								</Label>
								{suite && (
									<RefinePromptButton
										id="report-custom-instructions"
										label="Custom Instructions"
										content={promptOverride}
										organizationId={organizationId ?? null}
										onApply={setPromptOverride}
									/>
								)}
							</div>
							<Textarea
								id="instance-prompt"
								value={promptOverride}
								onChange={(e) =>
									setPromptOverride(e.target.value)
								}
								placeholder="Add specific instructions to customize how data is gathered..."
								rows={
									suite ? promptFieldRows(promptOverride) : 2
								}
							/>
							<p className="text-xs text-muted-foreground">
								Override or add to the default data gathering
								instructions
							</p>
						</div>
					)}

					{suite && (
						<TemplatePromptPreview
							definition={template.definition}
							fabricConfig={template.fabricConfig}
							promptDefaults={promptDefaults}
						/>
					)}

					<div className="space-y-4 border-t pt-4">
						<h3 className="font-medium">
							Reporting period and audience
						</h3>
						<ReportEvidenceSettings
							value={reporting}
							sourceDefinition={{ dataSources }}
							requireProject={requiresProjectKnowledge}
							onChange={setReporting}
							organizationId={organizationId}
						/>
					</div>

					{/* Optional: document libraries for RAG context */}
					{workspaces.enabled && userWorkspaces.length > 0 && (
						<div className="space-y-3">
							<div>
								<h3 className="font-medium flex items-center gap-2">
									<FolderOpenIcon className="h-4 w-4" />
									Document Workspaces
								</h3>
								<p className="text-sm text-muted-foreground">
									{workspaces.description ||
										"Optionally select libraries to provide additional context via RAG."}
								</p>
							</div>

							<Select
								value={selectedWorkspaces[0] || ""}
								onValueChange={(value) =>
									setSelectedWorkspaces(value ? [value] : [])
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a workspace (optional)..." />
								</SelectTrigger>
								<SelectContent>
									{userWorkspaces.map((ws) => (
										<SelectItem key={ws.id} value={ws.id}>
											{ws.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* No data sources message */}
					{dataSources.length === 0 && !workspaces.enabled && (
						<div className="text-center py-4 text-muted-foreground">
							<p>
								This template doesn't require any data source
								configuration.
							</p>
							<p className="text-sm">
								You can create your instance right away.
							</p>
						</div>
					)}

					{suite && (
						<CreateReportReadiness
							templateId={template.id}
							dataSources={dataSources}
							setup={setup}
							requiredParams={creation.parameters.requiredParams}
							outputFormat={template.outputFormat}
							onConnectionFailure={creation.setConnectionFailure}
						/>
					)}
				</div>

				{/* Stays in view, so Generate is reachable after a long prompt. */}
				<div
					className={cn(
						suite &&
							"sticky bottom-0 z-10 -mx-6 -mb-6 space-y-2 border-t bg-popover px-6 py-4",
					)}
				>
					{suite && (
						<p
							id={problemId}
							aria-live="polite"
							className={cn(
								"text-sm",
								!problem && "sr-only",
								problem?.urgent === true && "text-destructive",
								problem?.urgent === false &&
									"text-muted-foreground",
							)}
						>
							{problem?.message}
						</p>
					)}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={onClose}
							disabled={suite && isWorking}
						>
							{creation.missingSources.length > 0 &&
							setup.connectionsState === "answered"
								? "Abandon setup"
								: "Cancel"}
						</Button>
						<Button
							onClick={handleCreate}
							disabled={!suite && generateOff}
							aria-disabled={(suite && generateOff) || undefined}
							aria-describedby={problem ? problemId : undefined}
							className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
						>
							{isWorking ? (
								<>
									<Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" />
									{generates
										? "Generating..."
										: "Creating..."}
								</>
							) : (
								<>
									<PlusIcon className="mr-2 h-4 w-4" />
									{projectSetupReason
										? "Create draft"
										: generates
											? "Generate report"
											: reporting?.projectId
												? "Create report"
												: "Create Instance"}
								</>
							)}
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
