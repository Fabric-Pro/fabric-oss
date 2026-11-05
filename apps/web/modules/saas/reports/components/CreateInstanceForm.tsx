"use client";

import {
	getProjectReportSetupReason,
	hasProjectKnowledgeSource,
	type ReportEvidenceConfig,
	reportEvidenceConfigSchema,
} from "@repo/database/prisma/queries/lib/report-evidence";
import { useOrganizationContext } from "@saas/organizations/hooks";
import { useInstanceDataSourceSetup } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	generateProblem,
	useReportSuiteCreation,
} from "@saas/reports/hooks/use-report-suite-creation";
import { withProjectContext } from "@saas/reports/lib/project-report-suite";
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
import { Card, CardContent } from "@ui/components/card";
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
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ArrowLeftIcon,
	CheckCircle2Icon,
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	ServerIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
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

type Props = {
	templateId: string;
	organizationId?: string | null;
	basePath?: string;
	/** The project whose Reports tab the new report belongs to. */
	projectId?: string;
};

export function CreateInstanceForm({
	templateId,
	organizationId: propOrgId,
	basePath = "/app/report-templates",
	projectId: requestedProjectId,
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId: contextOrgId, loaded: orgContextLoaded } =
		useOrganizationContext();
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");
	const projectId = reportSuite ? requestedProjectId : undefined;

	// Use prop if explicitly provided, otherwise fall back to context
	// IMPORTANT: Must be string | null, never undefined (undefined causes session fallback)
	const organizationId: string | null =
		propOrgId !== undefined ? propOrgId : contextOrgId;

	// Fetch template data - wait for organization context to load first
	const { data: template, isLoading: templateLoading } = useQuery({
		...orpc.reports.templates.get.queryOptions({
			input: { id: templateId, organizationId },
		}),
		// Only fetch when org context is loaded to avoid race condition
		enabled: orgContextLoaded,
	});

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [reporting, setReporting] = useState<ReportEvidenceConfig>();
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
	// Shown pre-filled with the template's prompt; saved only once edited.
	const [promptOverride, setPromptOverride] = useState("");
	const [promptDefaults, setPromptDefaults] =
		useState<ReportPromptDefaults | null>(null);
	// Max iterations for agentic data gathering
	const [maxIterations, setMaxIterations] = useState<number | undefined>(
		undefined,
	);

	const definition = useMemo(
		() => parseTemplateDefinition(template?.definition, { reportSuite }),
		[template?.definition, reportSuite],
	);
	const workspaces = useMemo(
		() => parseTemplateWorkspaces(template?.connections),
		[template?.connections],
	);
	const { dataSources } = definition;
	const requiresProjectKnowledge = hasProjectKnowledgeSource({ dataSources });

	useEffect(() => {
		if (requiresProjectKnowledge && !reporting) {
			setReporting(
				reportEvidenceConfigSchema.parse({
					version: 1,
					period: "weekly",
					...(projectId ? { projectId } : {}),
				}),
			);
		}
	}, [requiresProjectKnowledge, reporting, projectId]);

	// Initialize form when template loads
	useEffect(() => {
		if (template) {
			setName(`My ${template.name}`);
			if (definition.userPrompt) {
				setPromptOverride(definition.userPrompt);
			}
		}
	}, [template, definition.userPrompt]);

	const setup = useInstanceDataSourceSetup({
		dataSources,
		organizationId,
		enabled: orgContextLoaded,
		autoDetect: reportSuite,
		suggestDefaults: reportSuite,
		projectId,
	});

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery({
		...orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
		enabled: orgContextLoaded,
	});
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

	const suite = Boolean(projectId);
	const creation = useReportSuiteCreation({
		suite,
		dataSources,
		bindings: setup.bindings,
		organizationId,
		basePath,
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
				router.push(`${basePath}/instances/${data.id}`);
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
			? !setup.allConfigured || creation.blocked
			: !setup.allConfigured && !reporting?.projectId) ||
		!name.trim();
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
				nameMissing: !name.trim(),
			})
		: null;
	const problemId = useId();

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
			templateId,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			projectId,
			reporting,
			...(suite ? { parameterDefaults: creation.parameters.toSave } : {}),
			connections: {
				mcpConfigs,
				mcpBindings,
				resourceBindings,
				context,
				...promptOverrideFields(promptOverride, definition.userPrompt),
				maxIterations: maxIterations || undefined,
				workflows: [],
				agents: [],
				workspaces: selectedWorkspaces,
				integrations: [],
				integrationBindings: {},
			},
		});
	};

	if (!orgContextLoaded || templateLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2Icon className="h-8 w-8 motion-safe:animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!template) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground">Template not found</p>
				<Button asChild variant="outline" className="mt-4">
					<Link href={basePath}>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Back to Templates
					</Link>
				</Button>
			</div>
		);
	}

	const emoji = template.heroEmojis?.[0] || "📊";

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-4">
				<span className="text-3xl">{emoji}</span>
				<div>
					<h1 className="text-2xl font-bold">
						{suite ? "Generate report" : "Create Instance"}:{" "}
						{template.name}
					</h1>
					<p className="text-muted-foreground">
						Configure your data sources and parameters for this
						report instance.
					</p>
				</div>
			</div>

			<div className="grid gap-6 lg:grid-cols-3">
				{/* Main Form */}
				<div className="lg:col-span-2 space-y-6">
					{projectId && (
						<ReportTemplatePreview
							templateId={templateId}
							projectId={projectId}
							organizationId={organizationId}
						/>
					)}

					{/* Instance Name */}
					<Card>
						<CardContent className="pt-6 space-y-4">
							<InstanceNameField
								value={name}
								onChange={setName}
								invalid={suite && !name.trim()}
							/>

							<div className="space-y-2">
								<Label htmlFor="instance-description">
									Description
								</Label>
								<Textarea
									id="instance-description"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									placeholder="Optional description..."
									rows={2}
								/>
							</div>
						</CardContent>
					</Card>

					{/* Data Source Configuration */}
					{dataSources.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div>
									<h3 className="font-medium flex items-center gap-2">
										<ServerIcon className="h-4 w-4" />
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
							</CardContent>
						</Card>
					)}

					{/* Context Fields */}
					{setup.contextFields.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div>
									<h3 className="font-medium flex items-center gap-2">
										<SettingsIcon className="h-4 w-4" />
										Report Context
									</h3>
									<p className="text-sm text-muted-foreground">
										Provide context for the AI to find the
										right data.
									</p>
								</div>
								<InstanceContextFields setup={setup} />
							</CardContent>
						</Card>
					)}

					{projectId && (
						<Card>
							<CardContent className="pt-6">
								<ReportParameterFields
									templateId={templateId}
									parameters={template.parameters}
									projectId={projectId}
									organizationId={organizationId}
									onChange={creation.setParameters}
									onContextDefaults={setup.offerContext}
									onPromptDefaults={setPromptDefaults}
								/>
							</CardContent>
						</Card>
					)}

					{/* Prompt Override & Advanced Settings */}
					{dataSources.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
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
												organizationId={
													organizationId ?? null
												}
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
										placeholder="Add specific instructions to customize how data is gathered and analyzed..."
										rows={
											suite
												? promptFieldRows(
														promptOverride,
													)
												: 4
										}
									/>
									<p className="text-xs text-muted-foreground">
										Override or add to the default data
										gathering instructions
									</p>
								</div>

								<div className="space-y-2">
									<Label
										htmlFor="max-iterations"
										className="text-sm"
									>
										Max Iterations
									</Label>
									<Input
										id="max-iterations"
										type="number"
										min={1}
										max={50}
										value={maxIterations ?? ""}
										onChange={(e) => {
											const parsed = Number.parseInt(
												e.target.value,
												10,
											);
											setMaxIterations(
												Number.isFinite(parsed)
													? parsed
													: undefined,
											);
										}}
										placeholder="15 (default)"
										className="w-32"
									/>
									<p className="text-xs text-muted-foreground">
										Maximum number of AI reasoning
										iterations for data gathering. Each
										iteration can call multiple tools
										(1-50).
									</p>
								</div>
							</CardContent>
						</Card>
					)}

					{suite && (
						<Card>
							<CardContent className="pt-6">
								<TemplatePromptPreview
									definition={template.definition}
									fabricConfig={template.fabricConfig}
									promptDefaults={promptDefaults}
								/>
							</CardContent>
						</Card>
					)}

					<Card>
						<CardContent className="pt-6 space-y-4">
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
						</CardContent>
					</Card>

					{/* Workspaces */}
					{workspaces.enabled && userWorkspaces.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
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
										setSelectedWorkspaces(
											value ? [value] : [],
										)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a workspace (optional)..." />
									</SelectTrigger>
									<SelectContent>
										{userWorkspaces.map((ws) => (
											<SelectItem
												key={ws.id}
												value={ws.id}
											>
												{ws.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</CardContent>
						</Card>
					)}
				</div>

				{/* Sidebar */}
				<div className="space-y-4">
					{suite && (
						<CreateReportReadiness
							templateId={templateId}
							dataSources={dataSources}
							setup={setup}
							requiredParams={creation.parameters.requiredParams}
							outputFormat={template.outputFormat}
							onConnectionFailure={creation.setConnectionFailure}
						/>
					)}
					<Card>
						<CardContent className="pt-6 space-y-4">
							<h3 className="font-medium">Actions</h3>
							{suite && (
								<p
									id={problemId}
									aria-live="polite"
									className={cn(
										"text-sm",
										!problem && "sr-only",
										problem?.urgent === true &&
											"text-destructive",
										problem?.urgent === false &&
											"text-muted-foreground",
									)}
								>
									{problem?.message}
								</p>
							)}
							<div className="space-y-2">
								<Button
									onClick={handleCreate}
									disabled={!suite && generateOff}
									aria-disabled={
										(suite && generateOff) || undefined
									}
									aria-describedby={
										problem ? problemId : undefined
									}
									className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
								<Button
									variant="outline"
									className="w-full"
									asChild
								>
									<Link
										href={withProjectContext(
											`${basePath}/${templateId}`,
											projectId,
										)}
									>
										<ArrowLeftIcon className="mr-2 h-4 w-4" />
										{creation.missingSources.length > 0 &&
										setup.connectionsState === "answered"
											? "Abandon setup"
											: "Back to Template"}
									</Link>
								</Button>
							</div>
						</CardContent>
					</Card>

					{/* Status Card */}
					<Card>
						<CardContent className="pt-6 space-y-3">
							<h3 className="font-medium">
								Configuration Status
							</h3>
							<div className="space-y-2 text-sm">
								<div className="flex items-center gap-2">
									{name.trim() ? (
										<CheckCircle2Icon className="h-4 w-4 text-success" />
									) : (
										<AlertCircleIcon className="h-4 w-4 text-highlight" />
									)}
									<span>Instance name</span>
								</div>
								{dataSources.length > 0 && (
									<div className="flex items-center gap-2">
										{setup.allConfigured ? (
											<CheckCircle2Icon className="h-4 w-4 text-success" />
										) : (
											<AlertCircleIcon className="h-4 w-4 text-highlight" />
										)}
										<span>Data sources configured</span>
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
