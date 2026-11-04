"use client";

import { useOrganizationContext } from "@saas/organizations/hooks";
import { useInstanceDataSourceSetup } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	parseTemplateDefinition,
	parseTemplateWorkspaces,
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
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	InstanceContextFields,
	InstanceDataSourcePicker,
} from "./InstanceDataSourceFields";

type Props = {
	templateId: string;
	organizationId?: string | null;
	basePath?: string;
};

export function CreateInstanceForm({
	templateId,
	organizationId: propOrgId,
	basePath = "/app/report-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId: contextOrgId, loaded: orgContextLoaded } =
		useOrganizationContext();
	const reportSuite = useFeatureFlag("REPORT_SUITE_V2");

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
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
	// Optional prompt override - pre-populated from template
	const [promptOverride, setPromptOverride] = useState("");
	// Max iterations for agentic data gathering
	const [maxIterations, setMaxIterations] = useState<number | undefined>(
		undefined,
	);

	const definition = useMemo(
		() => parseTemplateDefinition(template?.definition),
		[template?.definition],
	);
	const workspaces = useMemo(
		() => parseTemplateWorkspaces(template?.connections),
		[template?.connections],
	);
	const { dataSources } = definition;

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
	});

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery({
		...orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
		enabled: orgContextLoaded,
	});
	const userWorkspaces = workspacesData?.workspaces ?? [];

	const createMutation = useMutation(
		orpc.reports.instances.create.mutationOptions({
			onSuccess: (data) => {
				toast.success("Instance created successfully");
				queryClient.invalidateQueries({
					queryKey: ["reports", "instances"],
				});
				router.push(`${basePath}/instances/${data.id}`);
			},
			onError: (error) => {
				toast.error(error.message || "Failed to create instance");
			},
		}),
	);

	const handleCreate = () => {
		if (!name.trim()) {
			toast.error("Please enter a name for the instance");
			return;
		}

		if (!setup.allConfigured) {
			toast.error(
				"Please configure MCP servers and fill required context fields",
			);
			return;
		}

		const { mcpConfigs, mcpBindings, context } = setup.buildConnections();

		createMutation.mutate({
			templateId,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			connections: {
				mcpConfigs,
				mcpBindings,
				context,
				promptOverride: promptOverride.trim() || undefined,
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
				<Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
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
						Create Instance: {template.name}
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
					{/* Instance Name */}
					<Card>
						<CardContent className="pt-6 space-y-4">
							<div className="space-y-2">
								<Label htmlFor="instance-name">
									Instance Name *
								</Label>
								<Input
									id="instance-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="e.g., My Weekly Sprint Report"
								/>
								<p className="text-xs text-muted-foreground">
									Give this instance a name to identify it in
									your reports list
								</p>
							</div>

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
										Select your MCP server for each data
										source.
									</p>
								</div>
								<InstanceDataSourcePicker
									setup={setup}
									dataSources={dataSources}
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

					{/* Prompt Override & Advanced Settings */}
					{dataSources.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div className="space-y-2">
									<Label
										htmlFor="instance-prompt"
										className="text-sm"
									>
										Custom Instructions (Optional)
									</Label>
									<Textarea
										id="instance-prompt"
										value={promptOverride}
										onChange={(e) =>
											setPromptOverride(e.target.value)
										}
										placeholder="Add specific instructions to customize how data is gathered and analyzed..."
										rows={4}
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

					{/* Workspaces */}
					{workspaces.enabled && userWorkspaces.length > 0 && (
						<Card>
							<CardContent className="pt-6 space-y-4">
								<div>
									<h3 className="font-medium flex items-center gap-2">
										<FolderOpenIcon className="h-4 w-4" />
										Document Libraries
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
										<SelectValue placeholder="Select a library (optional)..." />
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
					<Card>
						<CardContent className="pt-6 space-y-4">
							<h3 className="font-medium">Actions</h3>
							<div className="space-y-2">
								<Button
									onClick={handleCreate}
									disabled={
										createMutation.isPending ||
										!setup.allConfigured ||
										!name.trim()
									}
									className="w-full"
								>
									{createMutation.isPending ? (
										<>
											<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
											Creating...
										</>
									) : (
										<>
											<PlusIcon className="mr-2 h-4 w-4" />
											Create Instance
										</>
									)}
								</Button>
								<Button
									variant="outline"
									className="w-full"
									asChild
								>
									<Link href={`${basePath}/${templateId}`}>
										<ArrowLeftIcon className="mr-2 h-4 w-4" />
										Back to Template
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
