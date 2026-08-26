"use client";

/**
 * Unified wizard "Connect a backlog" section (unified-project-setup spec §4.3,
 * D1–D3).
 *
 * A plain section (like the other Brief-step sections — not an accordion)
 * presenting the FULL inline PM configuration folded from `ExistingProjectFlow`
 * step 2 — no "configure later" shortcut:
 *   - `PMToolSelect` (backed by `mcp.availablePmTools.list`)
 *   - board / container selection (`projectManagementContainerId` / `…Name`)
 *   - the Azure DevOps project → team cascade (its data model is
 *     project → team → area path), shown only when the detected PM type is
 *     `azure-devops`
 *
 * Leaving it untouched (nothing configured) ⇒ the project still creates (AC#3).
 * Selections are lifted into the wizard form state and mapped to the
 * `projects.create` PM block by the wizard submit handler.
 *
 * Validation lives in the wizard submit handler (mirrors the Existing flow):
 * a selected PM tool (not the `__none__` sentinel) requires a container, and
 * Azure DevOps additionally requires a board/team — surfaced via toast there.
 */

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	ExternalLinkIcon,
	Link2Icon,
	Loader2Icon,
	PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	analyzePMToolCapabilities,
	containerIdFieldHint,
	fetchContainersWithHierarchy,
	type McpTool,
} from "../../lib/pm-tool-analyzer";
import { PMToolSelect } from "../pm-tool-select";

interface WizardBacklogValue {
	projectManagementMcpConfigId: string | null;
	projectManagementMcpServerId: string | null;
	projectManagementContainerId: string | null;
	projectManagementContainerName: string | null;
	projectManagementAdditionalContext: Record<string, unknown> | null;
	/**
	 * PM type detected from the selected MCP server's tool schema (e.g.
	 * `azure-devops`). Lifted so the wizard submit handler can apply the
	 * ADO-specific board/team validation without re-detecting.
	 */
	projectManagementDetectedType: string | null;
}

interface WizardBacklogCardProps {
	value: WizardBacklogValue;
	onChange: (patch: Partial<WizardBacklogValue>) => void;
	organizationId?: string | null;
}

export function WizardBacklogCard({
	value,
	onChange,
	organizationId: organizationIdProp,
}: WizardBacklogCardProps) {
	const { organizationId: contextOrgId, organizationName } =
		useOrganizationContext();
	const effectiveOrgId = organizationIdProp ?? contextOrgId ?? null;
	const mcpSettingsUrlRaw = useContextPath("settings/mcp");
	const buildReturnUrl = useSettingsReturnUrl();
	const mcpSettingsUrl = buildReturnUrl(mcpSettingsUrlRaw);

	const regionId = useId();

	// Board/container selection state (mirrors ExistingProjectFlow step 2).
	const [containers, setContainers] = useState<
		Array<{ id: string; name: string }>
	>([]);
	const [containersAdditionalContext, setContainersAdditionalContext] =
		useState<Record<string, string>>({});
	const [isLoadingContainers, setIsLoadingContainers] = useState(false);
	const [containersError, setContainersError] = useState<string | null>(null);

	// ADO project → team cascade state.
	const [detectedPMType, setDetectedPMType] = useState<string | undefined>();
	const [pmToolNames, setPmToolNames] = useState<string[]>([]);
	const [adoTeams, setAdoTeams] = useState<
		Array<{ id: string; name: string }>
	>([]);
	const [isLoadingAdoTeams, setIsLoadingAdoTeams] = useState(false);

	const selectedAdoTeam =
		(value.projectManagementAdditionalContext?.team as
			| string
			| undefined) ?? null;

	// `onChange` is recreated on every parent render (BasicInfoStep passes an
	// inline `(patch) => updateFormData(patch)`). Read it through a ref so the
	// data-fetching effects below key only on their real triggers. Keeping
	// `onChange` in their dependency arrays made `fetchContainers` (and thus the
	// "fetch containers" effect) re-run every render and, with a backlog already
	// connected, loop onChange → wizard re-render → onChange — i.e. React #185
	// "Maximum update depth exceeded" when editing an active project.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// Lift the detected PM type into wizard form-state so the submit handler can
	// apply ADO-specific validation. Guarded so it only fires on an actual change.
	const detectedTypeForParent = detectedPMType ?? null;
	useEffect(() => {
		if (value.projectManagementDetectedType !== detectedTypeForParent) {
			onChangeRef.current({
				projectManagementDetectedType: detectedTypeForParent,
			});
		}
	}, [detectedTypeForParent, value.projectManagementDetectedType]);

	const fetchContainers = useCallback(
		async (mcpConfigId: string) => {
			setIsLoadingContainers(true);
			setContainersError(null);
			setContainers([]);
			setContainersAdditionalContext({});
			onChangeRef.current({
				projectManagementContainerId: null,
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});
			setDetectedPMType(undefined);
			setPmToolNames([]);
			setAdoTeams([]);
			try {
				let { tools: toolsList, errors: toolErrors } =
					await orpcClient.mcp.tools.list({
						serverIds: [mcpConfigId],
						organizationId: effectiveOrgId,
					});
				// Retry with forceRefresh if cache was empty.
				if (
					(!toolsList || toolsList.length === 0) &&
					!toolErrors?.length
				) {
					const refreshResult = await orpcClient.mcp.tools.list({
						serverIds: [mcpConfigId],
						organizationId: effectiveOrgId,
						forceRefresh: true,
					});
					toolsList = refreshResult.tools;
					toolErrors = refreshResult.errors;
				}
				if (!toolsList || toolsList.length === 0) {
					setContainersError(
						toolErrors?.[0]?.error ||
							"No tools available from this MCP server",
					);
					return;
				}
				const tools: McpTool[] = toolsList.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema as McpTool["inputSchema"],
					parameters: t.parameters as McpTool["parameters"],
				}));
				const capabilities = analyzePMToolCapabilities(tools);
				setDetectedPMType(capabilities.detectedType);
				setPmToolNames(tools.map((t) => t.name));
				if (
					!capabilities.hasPMCapabilities ||
					capabilities.containerHierarchy.length === 0
				) {
					setContainersError(
						"This MCP server does not appear to have project management capabilities",
					);
					return;
				}
				const {
					containers: fetchedContainers,
					additionalContext: context,
				} = await fetchContainersWithHierarchy(
					mcpConfigId,
					capabilities.containerHierarchy,
					effectiveOrgId,
					{
						cloudIdResolverTool: capabilities.cloudIdResolverTool,
						idFieldHint: containerIdFieldHint(
							capabilities.taskCreation?.containerParam,
						),
					},
				);
				if (fetchedContainers.length === 0) {
					setContainersError(
						"No boards/projects found. Please check your MCP server configuration.",
					);
					return;
				}
				setContainers(fetchedContainers);
				setContainersAdditionalContext(context);
			} catch (err) {
				setContainersError(
					err instanceof Error
						? err.message
						: "Failed to load boards/projects",
				);
			} finally {
				setIsLoadingContainers(false);
			}
		},
		[effectiveOrgId],
	);

	// Fetch containers when the PM tool changes.
	useEffect(() => {
		const configId = value.projectManagementMcpConfigId;
		if (configId && configId !== "__none__") {
			fetchContainers(configId);
		} else {
			setContainers([]);
			setContainersAdditionalContext({});
			setContainersError(null);
			setDetectedPMType(undefined);
			setPmToolNames([]);
			setAdoTeams([]);
		}
	}, [value.projectManagementMcpConfigId, fetchContainers]);

	// Fetch ADO teams once an ADO project (container) is selected.
	useEffect(() => {
		const containerId = value.projectManagementContainerId;
		const configId = value.projectManagementMcpConfigId;
		if (detectedPMType !== "azure-devops" || !containerId || !configId) {
			setAdoTeams([]);
			return;
		}

		const teamsToolName = pmToolNames.find((t) =>
			/list[_-]?project[_-]?teams?$/i.test(t),
		);
		if (!teamsToolName) {
			return;
		}

		const fetchTeams = async () => {
			setIsLoadingAdoTeams(true);
			setAdoTeams([]);
			try {
				const response = await fetch("/api/pipeline/mcp-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mcpConfigId: configId,
						toolName: teamsToolName,
						params: { project: containerId },
						organizationId: effectiveOrgId,
					}),
				});
				const data = await response.json();
				if (response.ok && !data.error) {
					const results = Array.isArray(data.result)
						? data.result
						: [];
					setAdoTeams(
						results.map((item: Record<string, unknown>) => ({
							id: String(item.id ?? item.name ?? ""),
							name: String(
								item.name ?? item.displayName ?? item.id ?? "",
							),
						})),
					);
				}
			} catch (err) {
				console.error(
					"[WizardBacklogCard] Failed to fetch ADO teams:",
					err,
				);
			} finally {
				setIsLoadingAdoTeams(false);
			}
		};

		fetchTeams();
	}, [
		value.projectManagementContainerId,
		value.projectManagementMcpConfigId,
		detectedPMType,
		pmToolNames,
		effectiveOrgId,
	]);

	const hasSelection =
		!!value.projectManagementMcpConfigId &&
		value.projectManagementMcpConfigId !== "__none__";

	return (
		<div
			className="rounded-2xl border border-border bg-card p-5"
			data-testid="backlog-card"
		>
			<div className="flex items-center gap-3">
				<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
					<Link2Icon className="h-5 w-5 text-muted-foreground" />
				</span>
				<div className="min-w-0 flex-1">
					<h4 className="font-medium text-foreground">
						Connect a backlog
					</h4>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Optional. Sync stories from Jira, Linear, Azure DevOps,
						GitLab, and more.
					</p>
				</div>
			</div>
			<div className="mt-5 space-y-4">
				<PMToolSelect
					organizationId={effectiveOrgId}
					organizationName={organizationName ?? null}
					selectedMcpConfigId={value.projectManagementMcpConfigId}
					selectedMcpServerId={value.projectManagementMcpServerId}
					onChange={(next) => {
						onChange({
							projectManagementMcpConfigId: next.mcpConfigId,
							projectManagementMcpServerId: next.mcpServerId,
							// Clear container when the PM tool changes.
							projectManagementContainerId: null,
							projectManagementContainerName: null,
							projectManagementAdditionalContext: null,
						});
					}}
					mcpSettingsUrl={mcpSettingsUrl}
				/>

				{hasSelection && (
					<div className="space-y-2">
						<Label htmlFor={`${regionId}-container`}>
							{detectedPMType === "azure-devops"
								? "Project"
								: "Board / Project"}
						</Label>
						{isLoadingContainers ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2Icon className="h-4 w-4 animate-spin" />
								{detectedPMType === "azure-devops"
									? "Loading projects..."
									: "Loading boards..."}
							</div>
						) : containersError ? (
							<p className="text-sm text-destructive">
								{containersError}
							</p>
						) : (
							<Select
								value={
									value.projectManagementContainerId ||
									"__none__"
								}
								onValueChange={(v) => {
									if (v === "__none__") {
										onChange({
											projectManagementContainerId: null,
											projectManagementContainerName:
												null,
											projectManagementAdditionalContext:
												null,
										});
									} else {
										const c = containers.find(
											(x) => x.id === v,
										);
										onChange({
											projectManagementContainerId: v,
											projectManagementContainerName:
												c?.name ?? null,
											projectManagementAdditionalContext:
												Object.keys(
													containersAdditionalContext,
												).length > 0
													? (containersAdditionalContext as Record<
															string,
															unknown
														>)
													: null,
										});
									}
								}}
							>
								<SelectTrigger id={`${regionId}-container`}>
									<SelectValue
										placeholder={
											detectedPMType === "azure-devops"
												? "Select a project..."
												: "Select a board..."
										}
									/>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">
										None
									</SelectItem>
									{containers.map((c) => (
										<SelectItem key={c.id} value={c.id}>
											{c.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</div>
				)}

				{/* ADO: Board / Team dropdown (shown after project selection). */}
				{detectedPMType === "azure-devops" &&
					value.projectManagementContainerId && (
						<div className="space-y-2">
							<Label htmlFor={`${regionId}-ado-team`}>
								Board / Team
							</Label>
							{isLoadingAdoTeams ? (
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2Icon className="h-4 w-4 animate-spin" />
									Loading teams...
								</div>
							) : adoTeams.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No teams found for this project.
								</p>
							) : (
								<Select
									value={selectedAdoTeam ?? "__none__"}
									onValueChange={(v) => {
										if (v === "__none__") {
											onChange({
												projectManagementAdditionalContext:
													Object.keys(
														containersAdditionalContext,
													).length > 0
														? (containersAdditionalContext as Record<
																string,
																unknown
															>)
														: null,
											});
										} else {
											onChange({
												projectManagementAdditionalContext:
													{
														...containersAdditionalContext,
														team: v,
													},
											});
										}
									}}
								>
									<SelectTrigger id={`${regionId}-ado-team`}>
										<SelectValue placeholder="Select a board/team..." />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none__">
											None
										</SelectItem>
										{adoTeams.map((t) => (
											<SelectItem
												key={t.id}
												value={t.name}
											>
												{t.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					)}

				<Button asChild variant="outline" size="sm" className="gap-2">
					<Link
						href={mcpSettingsUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<PlusIcon className="h-4 w-4" />
						Create new MCP connection
						<ExternalLinkIcon className="h-3 w-3" />
					</Link>
				</Button>
				<p className="text-xs text-muted-foreground">
					Connect Jira, Linear, Azure DevOps, GitLab, or another PM
					tool to sync stories and tasks. Select a board to enable
					sync.
				</p>
			</div>
		</div>
	);
}
