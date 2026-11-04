"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { useInstanceDataSourceSetup } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	parseTemplateDefinition,
	parseTemplateWorkspaces,
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
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	SettingsIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	InstanceContextFields,
	InstanceDataSourcePicker,
} from "./InstanceDataSourceFields";

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
	const [name, setName] = useState(`My ${template.name}`);
	const [description, setDescription] = useState("");
	const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);

	// Optional prompt override - pre-populated from template
	const [promptOverride, setPromptOverride] = useState("");

	const definition = useMemo(
		() => parseTemplateDefinition(template.definition),
		[template.definition],
	);
	const workspaces = useMemo(
		() => parseTemplateWorkspaces(template.connections),
		[template.connections],
	);
	const { dataSources } = definition;

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
		autoDetect: true,
		suggestDefaults: reportSuite,
		projectId: reportSuite ? projectId : undefined,
	});

	// Fetch user's workspaces
	const { data: workspacesData } = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, limit: 50, status: "ACTIVE" },
		}),
	);
	const userWorkspaces = workspacesData?.workspaces ?? [];

	const createMutation = useMutation(
		orpc.reports.instances.create.mutationOptions({
			onSuccess: (data) => {
				toast.success("Instance created successfully");
				queryClient.invalidateQueries({
					queryKey: ["reports", "instances"],
				});
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
			templateId: template.id,
			name: name.trim(),
			description: description.trim() || undefined,
			organizationId,
			projectId: reportSuite ? projectId : undefined,
			connections: {
				mcpConfigs,
				mcpBindings,
				context, // Human-readable context for AI
				promptOverride: promptOverride.trim() || undefined,
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
		<Dialog open onOpenChange={onClose}>
			<DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<span className="text-xl">{emoji}</span>
						Use Template: {template.name}
					</DialogTitle>
					<DialogDescription>
						Configure your data sources with connection and
						parameters for this report instance.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-6 py-4">
					{/* Instance Name */}
					<div className="space-y-2">
						<Label htmlFor="instance-name">Instance Name *</Label>
						<Input
							id="instance-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g., My Weekly Sprint Report"
						/>
						<p className="text-xs text-muted-foreground">
							Give this instance a name to identify it in your
							reports list
						</p>
					</div>

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
									Select your MCP server and configure
									parameters for each data source.
								</p>
							</div>
							<InstanceDataSourcePicker
								setup={setup}
								dataSources={dataSources}
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

					{/* Prompt Override */}
					{dataSources.length > 0 && (
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
								placeholder="Add specific instructions to customize how data is gathered..."
								rows={2}
							/>
							<p className="text-xs text-muted-foreground">
								Override or add to the default data gathering
								instructions
							</p>
						</div>
					)}

					{/* Optional: document libraries for RAG context */}
					{workspaces.enabled && userWorkspaces.length > 0 && (
						<div className="space-y-3">
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
									setSelectedWorkspaces(value ? [value] : [])
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a library (optional)..." />
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
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={
							createMutation.isPending || !setup.allConfigured
						}
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
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
