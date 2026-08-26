"use client";

/**
 * ProjectWeaveConfigSettings - Configuration for fabric-weave per project
 *
 * Allows configuring:
 * - Agent behavior (requireReview, autoExecuteSimple)
 * - Complexity thresholds
 * - Enabled skills and MCP tools
 * - Category routing for Shuttle
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Separator } from "@ui/components/separator";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	BotIcon,
	CheckCircleIcon,
	CogIcon,
	Loader2Icon,
	SaveIcon,
	ShieldIcon,
	ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface ProjectWeaveConfigSettingsProps {
	projectId: string;
}

type ComplexityThreshold = "low" | "medium" | "high";

interface WeaveConfig {
	requireReview: boolean;
	requireSecurityReview: boolean;
	autoExecuteSimple: boolean;
	complexityThreshold: ComplexityThreshold;
	enabledSkills: string[];
	enabledMcpTools: string[];
	categoryRouting: Record<string, string> | null;
}

const COMPLEXITY_OPTIONS = [
	{ value: "low", label: "Low - Auto-execute most tasks" },
	{ value: "medium", label: "Medium - Require planning for complex tasks" },
	{ value: "high", label: "High - Always require planning" },
];

function normalizeComplexityThreshold(
	value: string | null | undefined,
): ComplexityThreshold {
	if (value === "low" || value === "medium" || value === "high") {
		return value;
	}

	return "medium";
}

// Skills are fetched from the database at runtime (see useQuery below)

const DEFAULT_CATEGORY_ROUTING: Record<string, string> = {
	frontend: "weave-shuttle",
	backend: "weave-shuttle",
	database: "weave-shuttle",
	devops: "weave-shuttle",
};

export function ProjectWeaveConfigSettings({
	projectId,
}: ProjectWeaveConfigSettingsProps) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	// Fetch current config
	const { data: configData, isLoading: isLoadingConfig } = useQuery({
		queryKey: ["weave-config", projectId, organizationId],
		queryFn: async () => {
			return await orpcClient.weave.config.get({
				projectId,
				organizationId: organizationId ?? null,
			});
		},
	});

	// Fetch available skills from the database
	const { data: skillsData } = useQuery({
		queryKey: ["skills", organizationId],
		queryFn: async () => {
			return await orpcClient.skills.list({
				organizationId: organizationId ?? null,
			});
		},
	});
	const availableSkills = (skillsData?.skills ?? []).map(
		(s: { id: string; name: string; description?: string | null }) => ({
			id: s.id,
			name: s.name,
			description: s.description || "",
		}),
	);

	// Form state
	const [config, setConfig] = useState<WeaveConfig>({
		requireReview: true,
		requireSecurityReview: true,
		autoExecuteSimple: false,
		complexityThreshold: "medium",
		enabledSkills: [],
		enabledMcpTools: [],
		categoryRouting: DEFAULT_CATEGORY_ROUTING,
	});

	// Update form when data loads
	useEffect(() => {
		if (configData) {
			setConfig({
				requireReview: configData.requireReview ?? true,
				requireSecurityReview: configData.requireSecurityReview ?? true,
				autoExecuteSimple: configData.autoExecuteSimple ?? false,
				complexityThreshold: normalizeComplexityThreshold(
					configData.complexityThreshold,
				),
				enabledSkills: configData.enabledSkills || [],
				enabledMcpTools: configData.enabledMcpTools || [],
				categoryRouting:
					configData.categoryRouting &&
					typeof configData.categoryRouting === "object"
						? (configData.categoryRouting as Record<string, string>)
						: DEFAULT_CATEGORY_ROUTING,
			});
		}
	}, [configData]);

	// Update config mutation
	const updateConfigMutation = useMutation({
		mutationFn: async (newConfig: Partial<WeaveConfig>) => {
			return await orpcClient.weave.config.update({
				projectId,
				organizationId: organizationId ?? null,
				config: newConfig,
			});
		},
		onSuccess: () => {
			toast.success("Configuration saved!");
			queryClient.invalidateQueries({
				queryKey: ["weave-config", projectId, organizationId],
			});
		},
		onError: (error) => {
			toast.error(`Failed to save: ${error.message}`);
		},
	});

	const handleSave = () => {
		updateConfigMutation.mutate(config);
	};

	const toggleSkill = (skillId: string) => {
		setConfig((prev) => ({
			...prev,
			enabledSkills: prev.enabledSkills.includes(skillId)
				? prev.enabledSkills.filter((id) => id !== skillId)
				: [...prev.enabledSkills, skillId],
		}));
	};

	const setCategoryRoute = (category: string, value: string) => {
		setConfig((prev) => ({
			...prev,
			categoryRouting: {
				...(prev.categoryRouting || {}),
				[category]: value,
			},
		}));
	};

	if (isLoadingConfig) {
		return (
			<div className="flex items-center justify-center h-64">
				<Loader2Icon className="size-8 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="space-y-6 max-w-4xl">
			{/* Header */}
			<div>
				<h1 className="text-2xl font-bold flex items-center gap-2">
					<CogIcon className="size-6 text-violet-500" />
					Weave Configuration
				</h1>
				<p className="text-muted-foreground">
					Customize how multi-agent orchestration works for this
					project
				</p>
			</div>

			{/* Execution Behavior */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<ZapIcon className="size-5" />
						Execution Behavior
					</CardTitle>
					<CardDescription>
						Control how agents execute tasks and when human approval
						is required
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Require Review */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="require-review">
								Require Review
							</Label>
							<p className="text-sm text-muted-foreground">
								Require human approval before executing plans
							</p>
						</div>
						<Switch
							id="require-review"
							checked={config.requireReview}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({
									...prev,
									requireReview: checked,
								}))
							}
						/>
					</div>

					<Separator />

					{/* Require Security Review */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="require-security-review">
								<span className="flex items-center gap-2">
									<ShieldIcon className="size-4" />
									Require Security Review
								</span>
							</Label>
							<p className="text-sm text-muted-foreground">
								Always have Warp agent review security-sensitive
								changes
							</p>
						</div>
						<Switch
							id="require-security-review"
							checked={config.requireSecurityReview}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({
									...prev,
									requireSecurityReview: checked,
								}))
							}
						/>
					</div>

					<Separator />

					{/* Auto Execute Simple */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="auto-execute-simple">
								Auto-Execute Simple Tasks
							</Label>
							<p className="text-sm text-muted-foreground">
								Automatically execute low-complexity tasks
								without approval
							</p>
						</div>
						<Switch
							id="auto-execute-simple"
							checked={config.autoExecuteSimple}
							onCheckedChange={(checked) =>
								setConfig((prev) => ({
									...prev,
									autoExecuteSimple: checked,
								}))
							}
						/>
					</div>

					<Separator />

					{/* Complexity Threshold */}
					<div className="space-y-2">
						<Label>Complexity Threshold</Label>
						<Select
							value={config.complexityThreshold}
							onValueChange={(value) =>
								setConfig((prev) => ({
									...prev,
									complexityThreshold:
										value as ComplexityThreshold,
								}))
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{COMPLEXITY_OPTIONS.map((option) => (
									<SelectItem
										key={option.value}
										value={option.value}
									>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-sm text-muted-foreground">
							Determines when Loom creates detailed plans vs.
							executing directly
						</p>
					</div>
				</CardContent>
			</Card>

			{/* Enabled Skills */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<BotIcon className="size-5" />
						Enabled Skills
					</CardTitle>
					<CardDescription>
						Select which AI skills are available for this project
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 gap-3">
						{availableSkills.length === 0 && (
							<p className="col-span-2 text-sm text-muted-foreground py-4">
								No skills available. Create skills via the CLI
								or API to enable them here.
							</p>
						)}
						{availableSkills.map(
							(skill: {
								id: string;
								name: string;
								description: string;
							}) => (
								<button
									type="button"
									key={skill.id}
									onClick={() => toggleSkill(skill.id)}
									className={`p-4 rounded-lg border text-left transition-all ${
										config.enabledSkills.includes(skill.id)
											? "border-violet-500 bg-violet-500/5"
											: "hover:bg-muted/50"
									}`}
								>
									<div className="flex items-start justify-between">
										<div>
											<p className="font-medium">
												{skill.name}
											</p>
											<p className="text-sm text-muted-foreground">
												{skill.description}
											</p>
										</div>
										{config.enabledSkills.includes(
											skill.id,
										) && (
											<CheckCircleIcon className="size-5 text-violet-500" />
										)}
									</div>
								</button>
							),
						)}
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>MCP Tool Configuration</CardTitle>
					<CardDescription>
						Provide MCP config IDs as a comma-separated list for
						this project.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2">
					<Label htmlFor="mcp-tools">Enabled MCP Config IDs</Label>
					<Input
						id="mcp-tools"
						value={config.enabledMcpTools.join(", ")}
						onChange={(e) =>
							setConfig((prev) => ({
								...prev,
								enabledMcpTools: e.target.value
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
							}))
						}
						placeholder="mcp-config-1, mcp-config-2"
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Shuttle Category Routing</CardTitle>
					<CardDescription>
						Control which agent handles each Shuttle category.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{Object.keys(DEFAULT_CATEGORY_ROUTING).map((category) => (
						<div key={category} className="space-y-2">
							<Label className="capitalize">{category}</Label>
							<Input
								value={config.categoryRouting?.[category] || ""}
								onChange={(e) =>
									setCategoryRoute(category, e.target.value)
								}
								placeholder="weave-shuttle"
							/>
						</div>
					))}
					<div className="space-y-2">
						<Label>Routing JSON Preview</Label>
						<Textarea
							value={JSON.stringify(
								config.categoryRouting || {},
								null,
								2,
							)}
							readOnly
							className="min-h-32 font-mono text-xs"
						/>
					</div>
				</CardContent>
			</Card>

			{/* Save Button */}
			<div className="flex justify-end">
				<Button
					onClick={handleSave}
					disabled={updateConfigMutation.isPending}
					size="lg"
				>
					{updateConfigMutation.isPending ? (
						<>
							<Loader2Icon className="size-4 mr-2 animate-spin" />
							Saving...
						</>
					) : (
						<>
							<SaveIcon className="size-4 mr-2" />
							Save Configuration
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
