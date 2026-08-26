"use client";

import {
	type DataSourceDefinition,
	DataSourceDefinitionBuilder,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	ArrowLeftIcon,
	BrainCircuitIcon,
	LayoutListIcon,
	PlusIcon,
	SaveIcon,
	ServerIcon,
	SparklesIcon,
	TrashIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type EvidenceConfig,
	EvidenceConfigSection,
} from "./EvidenceConfigSection";
import {
	FabricAiConfigSection,
	type FabricConfig,
} from "./FabricAiConfigSection";
import {
	ReportTemplateSkillsSection,
	type ReportTemplateSkillsSectionRef,
} from "./ReportTemplateSkillsSection";

const templateTypes = [
	{ value: "GANTT_CHART", label: "Gantt Chart" },
	{ value: "BURNDOWN", label: "Burndown Chart" },
	{ value: "SPRINT_COMPLETION", label: "Sprint Completion" },
	{ value: "FEATURE_SUMMARY", label: "Feature Summary" },
	{ value: "MONTHLY_REPORT", label: "Monthly Report" },
	{ value: "QUARTERLY_REPORT", label: "Quarterly Report" },
	{ value: "INTEGRATION_ACTIVITY", label: "Integration Activity" },
	{ value: "CUSTOM", label: "Custom" },
];

const outputFormats = [
	{ value: "MARKDOWN", label: "Markdown" },
	{ value: "HTML", label: "HTML" },
	{ value: "PDF", label: "PDF" },
	{ value: "EVIDENCE_EMBED", label: "Evidence.dev Dashboard" },
	{ value: "MULTI_FORMAT", label: "Multi-Format (MD + HTML + Evidence)" },
];

const scopeOptions = [
	{ value: "USER", label: "Personal" },
	{ value: "ORGANIZATION", label: "Organization" },
	{ value: "SYSTEM", label: "System (Pre-seeded)" },
];

type AiAgent = {
	agentId: string;
	task: string;
	outputVariable: string;
};

type Section = {
	id: string;
	title: string;
	type: "text" | "chart" | "table" | "ai-generated";
	config: Record<string, unknown>;
};

type Props = {
	templateId?: string;
	organizationId?: string;
	basePath?: string;
};

export function ReportTemplateForm({
	templateId,
	organizationId,
	basePath = "/app/reports",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const isEditing = Boolean(templateId);
	const skillsRef = useRef<ReportTemplateSkillsSectionRef>(null);

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [templateType, setTemplateType] = useState("CUSTOM");
	const [outputFormat, setOutputFormat] = useState("MARKDOWN");
	const [scope, setScope] = useState(
		organizationId ? "ORGANIZATION" : "USER",
	);
	const [category, setCategory] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [isScheduled, setIsScheduled] = useState(false);
	const [scheduleFrequency, setScheduleFrequency] = useState("weekly");
	const [aiAgents, setAiAgents] = useState<AiAgent[]>([]);
	const [dataSources, setDataSources] = useState<DataSourceDefinition[]>([]);
	const [sections, setSections] = useState<Section[]>([
		{
			id: "intro",
			title: "Introduction",
			type: "text",
			config: { template: "" },
		},
	]);
	const [fabricConfig, setFabricConfig] = useState<FabricConfig>({
		enableAutoDetection: true,
	});
	const [evidenceConfig, setEvidenceConfig] = useState<EvidenceConfig>({});
	// User prompt for the AI - defines the task/question
	const [userPrompt, setUserPrompt] = useState("");

	const templateQueryOptions = orpc.reports.templates.get.queryOptions({
		// biome-ignore lint/style/noNonNullAssertion: templateId is defined when isEditing is true
		input: { id: templateId!, organizationId: organizationId ?? null },
	});

	const { data: templateData, isLoading: isLoadingTemplate } = useQuery({
		...templateQueryOptions,
		enabled: isEditing,
	});

	// Check if this is a system template (read-only)
	const isSystemTemplate = (templateData as any)?.scope === "SYSTEM";

	useEffect(() => {
		if (templateData) {
			const t = templateData as any;
			setName(t.name);
			setDescription(t.description || "");
			setTemplateType(t.templateType);
			setOutputFormat(t.outputFormat || "MARKDOWN");
			setScope(t.scope);
			setCategory(t.category || "");
			setTags(t.tags || []);
			setIsScheduled(!!t.schedule);
			const def = t.definition as any;
			if (def) {
				setAiAgents(def.aiAgents || []);
				setDataSources(def.dataSources || []);
				setSections(def.sections || []);
				setUserPrompt(def.userPrompt || "");
			}

			// Load Fabric AI config
			if (t.fabricConfig) {
				setFabricConfig(t.fabricConfig);
			}

			// Load Evidence config
			if (t.evidenceConfig) {
				setEvidenceConfig(t.evidenceConfig);
			}
		}
	}, [templateData]);

	const createMutation = useMutation(
		orpc.reports.templates.create.mutationOptions({
			onSuccess: (data: any) => {
				toast.success("Template created");
				router.push(`${basePath}/${data.id}`);
			},
			onError: (error) => {
				toast.error(error.message || "Failed to create template");
			},
		}),
	);

	const updateMutation = useMutation(
		orpc.reports.templates.update.mutationOptions({
			onSuccess: async () => {
				try {
					await skillsRef.current?.saveSkills();
				} catch {
					// skill save error is toasted inside saveSkills
				}
				await queryClient.invalidateQueries({
					queryKey: templateQueryOptions.queryKey,
				});
				toast.success("Template updated");
			},
			onError: (error) => {
				toast.error(error.message || "Failed to update template");
			},
		}),
	);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();

		// Build definition with dataSources
		const definition = {
			dataSources,
			aiAgents,
			sections,
			// User prompt defines the task for the AI
			userPrompt: userPrompt.trim() || undefined,
		};

		// Derive connection requirements from dataSources
		// Extract unique providers and their types from the data source definitions
		const providerMap = new Map<
			string,
			{ type: "integration" | "mcp"; name: string }
		>();

		// Provider display names for better UX
		const providerNames: Record<string, string> = {
			microsoft_graph: "Microsoft Teams / Graph",
			slack: "Slack",
			github: "GitHub",
			linear: "Linear",
			jira: "Jira",
		};

		for (const ds of dataSources) {
			if (!providerMap.has(ds.provider)) {
				providerMap.set(ds.provider, {
					type: ds.type === "mcp" ? "mcp" : "integration",
					name: providerNames[ds.provider] || ds.provider,
				});
			}
		}

		// Build connection requirements from providers
		const integrationRequirements: Array<{
			key: string;
			name: string;
			description: string;
			required: boolean;
		}> = [];
		const mcpServerRequirements: Array<{
			key: string;
			name: string;
			description: string;
			required: boolean;
		}> = [];

		for (const [key, info] of providerMap) {
			const requirement = {
				key,
				name: info.name,
				description: `Requires ${info.name} connection`,
				required: true,
			};
			if (info.type === "mcp") {
				mcpServerRequirements.push(requirement);
			} else {
				integrationRequirements.push(requirement);
			}
		}

		const connections = {
			integrations:
				integrationRequirements.length > 0
					? integrationRequirements
					: undefined,
			mcpServers:
				mcpServerRequirements.length > 0
					? mcpServerRequirements
					: undefined,
		};

		// Only include fabricConfig if it has non-default values
		const hasFabricConfig =
			fabricConfig.strategy ||
			fabricConfig.context ||
			fabricConfig.pattern ||
			fabricConfig.variables ||
			fabricConfig.enableAutoDetection === false ||
			fabricConfig.defaultPrompt;

		// Only include evidenceConfig if output format is Evidence-related and has values
		const isEvidenceOutput =
			outputFormat === "EVIDENCE_EMBED" ||
			outputFormat === "MULTI_FORMAT";
		const hasEvidenceConfig =
			isEvidenceOutput &&
			(evidenceConfig.theme ||
				evidenceConfig.layout ||
				evidenceConfig.defaultChartType ||
				evidenceConfig.useDocker !== undefined);

		if (isEditing) {
			updateMutation.mutate({
				// biome-ignore lint/style/noNonNullAssertion: templateId is defined when isEditing is true
				id: templateId!,
				name,
				description: description || undefined,
				templateType: templateType as any,
				outputFormat: outputFormat as any,
				category: category || undefined,
				tags: tags.length > 0 ? tags : undefined,
				definition,
				connections,
				fabricConfig: hasFabricConfig ? fabricConfig : undefined,
				evidenceConfig: hasEvidenceConfig ? evidenceConfig : undefined,
				// On edit, send an explicit `null` when Auto-generate is OFF so the
				// template's schedule is cleared (SQL NULL) and future instances stop
				// inheriting it.
				schedule: isScheduled ? { frequency: scheduleFrequency } : null,
			});
		} else {
			createMutation.mutate({
				name,
				description: description || undefined,
				templateType: templateType as any,
				outputFormat: outputFormat as any,
				scope: scope as any,
				organizationId: organizationId ?? null,
				category: category || undefined,
				tags: tags.length > 0 ? tags : undefined,
				definition,
				connections,
				fabricConfig: hasFabricConfig ? fabricConfig : undefined,
				evidenceConfig: hasEvidenceConfig ? evidenceConfig : undefined,
				schedule: isScheduled
					? { frequency: scheduleFrequency }
					: undefined,
			});
		}
	};

	const addTag = () => {
		if (tagInput && !tags.includes(tagInput)) {
			setTags([...tags, tagInput]);
			setTagInput("");
		}
	};

	const removeTag = (tag: string) => setTags(tags.filter((t) => t !== tag));

	const _addAiAgent = () => {
		setAiAgents([
			...aiAgents,
			{
				agentId: "default",
				task: "",
				outputVariable: `analysis_${aiAgents.length + 1}`,
			},
		]);
	};

	const _removeAiAgent = (index: number) => {
		setAiAgents(aiAgents.filter((_, i) => i !== index));
	};

	const _updateAiAgent = (index: number, updates: Partial<AiAgent>) => {
		setAiAgents(
			aiAgents.map((a, i) => (i === index ? { ...a, ...updates } : a)),
		);
	};

	const addSection = () => {
		setSections([
			...sections,
			{
				id: `section-${Date.now()}`,
				title: "New Section",
				type: "text",
				config: {},
			},
		]);
	};

	const removeSection = (id: string) =>
		setSections(sections.filter((s) => s.id !== id));

	const updateSection = (id: string, updates: Partial<Section>) => {
		setSections(
			sections.map((s) => (s.id === id ? { ...s, ...updates } : s)),
		);
	};

	if (isEditing && isLoadingTemplate) {
		return (
			<div className="flex justify-center py-12">
				<div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-8">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Button variant="ghost" size="icon" asChild>
						<Link href={basePath}>
							<ArrowLeftIcon className="h-4 w-4" />
						</Link>
					</Button>
					<h1 className="text-2xl font-bold">
						{isEditing
							? name || "Edit Template"
							: "New Custom Template"}
					</h1>
					{isSystemTemplate && (
						<Badge variant="secondary">System Template</Badge>
					)}
				</div>
				<div className="flex items-center gap-2">
					{isEditing && (
						<Button asChild variant="default">
							<Link
								href={`${basePath}/${templateId}/instances/new`}
							>
								<PlusIcon className="mr-2 h-4 w-4" />
								Use Template
							</Link>
						</Button>
					)}
					{!isSystemTemplate && (
						<Button
							type="submit"
							disabled={
								createMutation.isPending ||
								updateMutation.isPending
							}
						>
							<SaveIcon className="mr-2 h-4 w-4" />
							{isEditing ? "Save" : "Create"}
						</Button>
					)}
				</div>
			</div>

			{/* What This Report Will Generate - Show prominently for system templates */}
			{isSystemTemplate && templateData && (
				<section className="space-y-4">
					<Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
						<CardContent className="pt-6 space-y-4">
							<div>
								<h3 className="text-lg font-semibold flex items-center gap-2 mb-2">
									<SparklesIcon className="h-5 w-5 text-purple-500" />
									What This Report Will Generate
								</h3>
								<p className="text-sm text-muted-foreground">
									{description ||
										"Automated report generation"}
								</p>
							</div>

							{/* AI Analysis Task */}
							{(() => {
								const def = (templateData as any)?.definition;
								const aiAgents = def?.aiAgents || [];
								const dataSources = def?.dataSources || [];
								const sections = def?.sections || [];

								return (
									<>
										{aiAgents.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<BrainCircuitIcon className="h-4 w-4 text-primary" />
													AI Analysis Task
												</h4>
												{aiAgents.map(
													(
														agent: {
															agentId: string;
															task: string;
															outputVariable?: string;
														},
														i: number,
													) => (
														<div
															key={i}
															className="bg-background/80 border rounded-lg p-3"
														>
															<p className="text-sm text-muted-foreground whitespace-pre-wrap">
																{agent.task
																	.length >
																600
																	? `${agent.task.slice(0, 600)}...`
																	: agent.task}
															</p>
														</div>
													),
												)}
											</div>
										)}

										{/* Data Sources */}
										{dataSources.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<ServerIcon className="h-4 w-4 text-blue-500" />
													Data Sources
												</h4>
												<div className="flex flex-wrap gap-2">
													{dataSources.map(
														(ds: {
															id: string;
															type: string;
															provider?: string;
															config?: Record<
																string,
																unknown
															>;
														}) => (
															<Badge
																key={ds.id}
																variant="secondary"
																className="text-xs"
															>
																{ds.type ===
																"integration"
																	? `${ds.provider || ds.id} API`
																	: ds.type ===
																			"mcp"
																		? `${(ds.config?.mcpServerKey as string) || "MCP"} → ${(ds.config?.toolName as string) || ds.id}`
																		: ds.id}
															</Badge>
														),
													)}
												</div>
											</div>
										)}

										{/* Output Sections */}
										{sections.length > 0 && (
											<div className="space-y-2">
												<h4 className="text-sm font-medium flex items-center gap-2">
													<LayoutListIcon className="h-4 w-4 text-success" />
													Output Sections
												</h4>
												<div className="flex flex-wrap gap-2">
													{sections.map(
														(section: {
															id: string;
															title: string;
															type: string;
														}) => (
															<Badge
																key={section.id}
																variant="outline"
																className="text-xs"
															>
																{section.title}
																{section.type ===
																	"ai-generated" && (
																	<SparklesIcon className="h-3 w-3 ml-1 text-purple-500" />
																)}
															</Badge>
														),
													)}
												</div>
											</div>
										)}
									</>
								);
							})()}

							{/* Output Format */}
							<div className="flex items-center gap-2 pt-2 border-t">
								<span className="text-xs text-muted-foreground">
									Output:
								</span>
								<Badge variant="outline" className="text-xs">
									{outputFormat}
								</Badge>
							</div>
						</CardContent>
					</Card>
				</section>
			)}

			{/* Basic Info Section */}
			<section className="space-y-4">
				<h2 className="text-lg font-semibold border-b pb-2">
					Basic Information
				</h2>
				<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
					<Label className="text-right">Name</Label>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Monthly Features Summary"
						required
						readOnly={isSystemTemplate}
						className={isSystemTemplate ? "bg-muted" : ""}
					/>
				</div>
				<div className="grid grid-cols-[160px_1fr] gap-4 items-start">
					<Label className="text-right pt-2">Description</Label>
					<Textarea
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="A monthly summary of all features shipped..."
						rows={2}
						readOnly={isSystemTemplate}
						className={isSystemTemplate ? "bg-muted" : ""}
					/>
				</div>
				<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
					<Label className="text-right">Type</Label>
					<Select
						value={templateType}
						onValueChange={setTemplateType}
						disabled={isSystemTemplate}
					>
						<SelectTrigger
							className={`max-w-xs ${isSystemTemplate ? "bg-muted" : ""}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{templateTypes.map((t) => (
								<SelectItem key={t.value} value={t.value}>
									{t.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
					<Label className="text-right">Output Format</Label>
					<Select
						value={outputFormat}
						onValueChange={setOutputFormat}
						disabled={isSystemTemplate}
					>
						<SelectTrigger
							className={`max-w-xs ${isSystemTemplate ? "bg-muted" : ""}`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{outputFormats.map((f) => (
								<SelectItem key={f.value} value={f.value}>
									{f.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</section>

			{/* Visibility Section */}
			{/* Visibility Section - hidden for system templates */}
			{!isSystemTemplate && (
				<section className="space-y-4">
					<h2 className="text-lg font-semibold border-b pb-2">
						Visibility
					</h2>
					<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
						<Label className="text-right">Scope</Label>
						<Select value={scope} onValueChange={setScope}>
							<SelectTrigger className="max-w-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{scopeOptions
									.filter((o) => o.value !== "SYSTEM")
									.map((o) => (
										<SelectItem
											key={o.value}
											value={o.value}
										>
											{o.label}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
						<Label className="text-right">Category</Label>
						<Input
							value={category}
							onChange={(e) => setCategory(e.target.value)}
							placeholder="Engineering, Product, etc."
							className="max-w-xs"
						/>
					</div>
					<div className="grid grid-cols-[160px_1fr] gap-4 items-start">
						<Label className="text-right pt-2">Tags</Label>
						<div className="space-y-2">
							<div className="flex gap-2 max-w-sm">
								<Input
									value={tagInput}
									onChange={(e) =>
										setTagInput(e.target.value)
									}
									placeholder="Add tag"
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											addTag();
										}
									}}
								/>
								<Button
									type="button"
									variant="outline"
									onClick={addTag}
								>
									Add
								</Button>
							</div>
							{tags.length > 0 && (
								<div className="flex flex-wrap gap-1">
									{tags.map((tag) => (
										<Badge
											key={tag}
											variant="secondary"
											className="gap-1"
										>
											{tag}
											<button
												type="button"
												onClick={() => removeTag(tag)}
											>
												<XIcon className="h-3 w-3" />
											</button>
										</Badge>
									))}
								</div>
							)}
						</div>
					</div>
				</section>
			)}

			{/* Data Sources - Define what data to fetch */}
			<section className="space-y-4">
				<DataSourceDefinitionBuilder
					dataSources={dataSources}
					onChange={setDataSources}
					readOnly={isSystemTemplate}
				/>
			</section>

			{/* Skills Section */}
			{isEditing && templateId ? (
				<ReportTemplateSkillsSection
					ref={skillsRef}
					templateId={templateId}
					readonly={isSystemTemplate}
				/>
			) : (
				<Card>
					<CardContent className="pt-6">
						<div className="flex items-center gap-2 mb-2">
							<SparklesIcon className="h-5 w-5 text-highlight" />
							<h3 className="font-semibold">Skills</h3>
						</div>
						<p className="text-sm text-muted-foreground">
							Save the template first, then you can attach skills
							to enhance AI report generation.
						</p>
					</CardContent>
				</Card>
			)}

			{/* Editable config sections - hidden for system templates */}
			{!isSystemTemplate && (
				<>
					{/* Fabric AI Enhancement Section */}
					<section className="space-y-4">
						<FabricAiConfigSection
							value={fabricConfig}
							onChange={setFabricConfig}
							organizationId={organizationId}
						/>
					</section>

					{/* Evidence.dev Configuration Section - only show for Evidence output formats */}
					{(outputFormat === "EVIDENCE_EMBED" ||
						outputFormat === "MULTI_FORMAT") && (
						<section className="space-y-4">
							<EvidenceConfigSection
								value={evidenceConfig}
								onChange={setEvidenceConfig}
							/>
						</section>
					)}
				</>
			)}

			{/* User Prompt - The task/question for the AI */}
			<section className="space-y-4">
				<div className="flex items-center gap-2 border-b pb-2">
					<BrainCircuitIcon className="h-5 w-5 text-purple-500" />
					<h2 className="text-lg font-semibold">AI Prompt</h2>
				</div>
				<div className="space-y-2">
					<Label>
						User Prompt <span className="text-destructive">*</span>
					</Label>
					<Textarea
						value={userPrompt}
						onChange={(e) => setUserPrompt(e.target.value)}
						placeholder="Analyze the sprint data and generate a comprehensive report covering: progress on committed items, blockers encountered, velocity trends, and recommendations for the next sprint..."
						rows={4}
						readOnly={isSystemTemplate}
						className={`font-mono text-sm ${isSystemTemplate ? "bg-muted" : ""}`}
					/>
					<p className="text-xs text-muted-foreground">
						This prompt tells the AI what to do with the gathered
						data. It will be sent as the user message. Instances can
						override this prompt if needed.
					</p>
				</div>
			</section>

			{/* Report Sections - visible for all, read-only for system templates */}
			<section className="space-y-4">
				<div className="flex items-center justify-between border-b pb-2">
					<h2 className="text-lg font-semibold">Report Sections</h2>
					{!isSystemTemplate && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={addSection}
						>
							<PlusIcon className="mr-1 h-4 w-4" />
							Add
						</Button>
					)}
				</div>
				{sections.length === 0 ? (
					<p className="text-muted-foreground text-sm py-4">
						No sections defined.
					</p>
				) : (
					<div className="space-y-4">
						{sections.map((section, idx) => (
							<div
								key={section.id}
								className={`border rounded-lg p-4 space-y-3 ${isSystemTemplate ? "bg-muted/30" : ""}`}
							>
								<div className="flex justify-between items-center">
									<span className="text-sm font-medium text-muted-foreground">
										Section {idx + 1}
									</span>
									{!isSystemTemplate && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() =>
												removeSection(section.id)
											}
											disabled={sections.length === 1}
										>
											<TrashIcon className="h-4 w-4 text-destructive" />
										</Button>
									)}
								</div>
								<div className="grid grid-cols-[120px_1fr] gap-3 items-center">
									<Label className="text-right text-sm">
										Title
									</Label>
									<Input
										value={section.title}
										onChange={(e) =>
											updateSection(section.id, {
												title: e.target.value,
											})
										}
										className={`max-w-xs ${isSystemTemplate ? "bg-muted" : ""}`}
										readOnly={isSystemTemplate}
									/>
								</div>
								<div className="grid grid-cols-[120px_1fr] gap-3 items-center">
									<Label className="text-right text-sm">
										Type
									</Label>
									{isSystemTemplate ? (
										<Input
											value={
												section.type === "ai-generated"
													? "AI Generated"
													: section.type === "text"
														? "Text / Template"
														: section.type
											}
											className="max-w-[200px] bg-muted"
											readOnly
										/>
									) : (
										<Select
											value={section.type}
											onValueChange={(v) =>
												updateSection(section.id, {
													type: v as any,
												})
											}
										>
											<SelectTrigger className="max-w-[200px]">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="text">
													Text / Template
												</SelectItem>
												<SelectItem value="ai-generated">
													AI Generated
												</SelectItem>
												<SelectItem value="table">
													Data Table
												</SelectItem>
												<SelectItem value="chart">
													Chart
												</SelectItem>
											</SelectContent>
										</Select>
									)}
								</div>
								{section.type === "text" && (
									<div className="grid grid-cols-[120px_1fr] gap-3 items-start">
										<Label className="text-right text-sm pt-2">
											Template
										</Label>
										<Textarea
											placeholder="Use {{variable}} placeholders..."
											value={
												(section.config
													.template as string) || ""
											}
											onChange={(e) =>
												updateSection(section.id, {
													config: {
														...section.config,
														template:
															e.target.value,
													},
												})
											}
											rows={2}
											className={
												isSystemTemplate
													? "bg-muted"
													: ""
											}
											readOnly={isSystemTemplate}
										/>
									</div>
								)}
								{section.type === "ai-generated" && (
									<div className="grid grid-cols-[120px_1fr] gap-3 items-center">
										<Label className="text-right text-sm">
											Output Var
										</Label>
										<Input
											placeholder="summary"
											value={
												(section.config
													.outputVariable as string) ||
												""
											}
											onChange={(e) =>
												updateSection(section.id, {
													config: {
														...section.config,
														outputVariable:
															e.target.value,
													},
												})
											}
											className={`max-w-[200px] ${isSystemTemplate ? "bg-muted" : ""}`}
											readOnly={isSystemTemplate}
										/>
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</section>

			{/* Schedule Section - hidden for system templates */}
			{!isSystemTemplate && (
				<section className="space-y-4">
					<h2 className="text-lg font-semibold border-b pb-2">
						Schedule
					</h2>
					<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
						<Label className="text-right">Auto-generate</Label>
						<Switch
							checked={isScheduled}
							onCheckedChange={setIsScheduled}
						/>
					</div>
					{isScheduled && (
						<div className="grid grid-cols-[160px_1fr] gap-4 items-center">
							<Label className="text-right">Frequency</Label>
							<Select
								value={scheduleFrequency}
								onValueChange={setScheduleFrequency}
							>
								<SelectTrigger className="max-w-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="daily">Daily</SelectItem>
									<SelectItem value="weekly">
										Weekly
									</SelectItem>
									<SelectItem value="biweekly">
										Bi-weekly
									</SelectItem>
									<SelectItem value="monthly">
										Monthly
									</SelectItem>
									<SelectItem value="quarterly">
										Quarterly
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}
				</section>
			)}
		</form>
	);
}
