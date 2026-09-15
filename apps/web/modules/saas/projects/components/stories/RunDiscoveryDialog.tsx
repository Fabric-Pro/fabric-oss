"use client";

/**
 * RunDiscoveryDialog (plan Slice 4)
 *
 * Source picker for a Discovery run on a DISCOVERY-track feature:
 *   - repository (when the project has one linked)
 *   - OpenAPI: an uploaded JSON/YAML context or a pasted URL
 *   - MCP servers: the caller's own configs (multi-select)
 *
 * Preflights the AI provider (`aiConfig.resolution.getStatus`) so the user
 * gets a clear message instead of a failed workflow, then calls
 * `projects.discovery.start`.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
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
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { AlertCircleIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { InfoTip } from "./InfoTip";
import { invalidateStoryReadiness } from "./useStoryReadiness";

type OpenApiMode = "none" | "context" | "url";

export type DiscoveryStartInput = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	sources: {
		repo?: boolean;
		openApi?: { contextId: string } | { url: string };
		mcpConfigIds?: string[];
	};
};

type Props = {
	projectId: string;
	storyId: string;
	storyIdentifier?: string;
	hasRepository: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onStarted?: (result: { discoveryRunId: string }) => void;
};

const OPENAPI_FILE_PATTERN = /\.(json|ya?ml)$/i;
const OPENAPI_MIME_PATTERN = /(json|yaml)/i;

type ContextRow = {
	id: string;
	type: string;
	originalFilename?: string | null;
	mimeType?: string | null;
	sourceTitle?: string | null;
	extractionStatus?: string | null;
};

/** Uploaded contexts that look like an OpenAPI document (JSON / YAML). */
export function filterOpenApiContexts<T extends ContextRow>(rows: T[]): T[] {
	return rows.filter((row) => {
		const name = row.originalFilename ?? row.sourceTitle ?? "";
		return (
			OPENAPI_FILE_PATTERN.test(name) ||
			(row.mimeType ? OPENAPI_MIME_PATTERN.test(row.mimeType) : false)
		);
	});
}

export function RunDiscoveryDialog({
	projectId,
	storyId,
	storyIdentifier,
	hasRepository,
	open,
	onOpenChange,
	onStarted,
}: Props) {
	const t = useTranslations("projects.stories.discovery");
	const tTips = useTranslations("tooltips.stories");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const [useRepo, setUseRepo] = useState(hasRepository);
	const [openApiMode, setOpenApiMode] = useState<OpenApiMode>("none");
	const [contextId, setContextId] = useState<string>("");
	const [openApiUrl, setOpenApiUrl] = useState("");
	const [mcpConfigIds, setMcpConfigIds] = useState<string[]>([]);

	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () =>
			await orpcClient.aiConfig.resolution.getStatus({ organizationId }),
		staleTime: 30_000,
		enabled: open,
	});
	const isAiNotConfigured =
		!isLoadingAiConfig &&
		aiConfigStatus !== undefined &&
		!aiConfigStatus.isConfigured;

	const { data: contextsData } = useQuery({
		...orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});
	const openApiContexts = useMemo(() => {
		const rows = (contextsData?.contexts ?? []) as ContextRow[];
		return filterOpenApiContexts(rows);
	}, [contextsData]);

	const { data: mcpData } = useQuery({
		...orpc.mcp.configs.list.queryOptions({ input: { organizationId } }),
		enabled: open,
	});
	const mcpConfigs = useMemo(() => {
		const rows = (Array.isArray(mcpData) ? mcpData : []) as Array<{
			id: string;
			enabled: boolean;
			displayName?: string | null;
			mcpServer?: { name?: string | null } | null;
		}>;
		return rows.filter((row) => row.enabled);
	}, [mcpData]);

	const startMutation = useMutation({
		mutationFn: async (input: DiscoveryStartInput) =>
			await orpcClient.projects.discovery.start(input),
		onSuccess: async (data) => {
			toast.success(t("toasts.started"));
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.discovery.list.queryKey({
						input: { projectId, storyId, organizationId },
					}),
				}),
				invalidateStoryReadiness(queryClient, { projectId, storyId }),
			]);
			onOpenChange(false);
			onStarted?.({ discoveryRunId: data.discoveryRunId });
		},
		onError: (error) => {
			toast.error(t("toasts.startFailed"), {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	const urlLooksValid = (() => {
		if (openApiMode !== "url") {
			return true;
		}
		try {
			const parsed = new URL(openApiUrl.trim());
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	})();

	const hasAnySource =
		(hasRepository && useRepo) ||
		(openApiMode === "context" && contextId !== "") ||
		(openApiMode === "url" && openApiUrl.trim() !== "") ||
		mcpConfigIds.length > 0;

	const canSubmit =
		hasAnySource &&
		urlLooksValid &&
		!isAiNotConfigured &&
		!startMutation.isPending;

	const handleSubmit = () => {
		if (!canSubmit) {
			return;
		}
		const sources: DiscoveryStartInput["sources"] = {};
		if (hasRepository && useRepo) {
			sources.repo = true;
		}
		if (openApiMode === "context" && contextId) {
			sources.openApi = { contextId };
		} else if (openApiMode === "url" && openApiUrl.trim()) {
			sources.openApi = { url: openApiUrl.trim() };
		}
		if (mcpConfigIds.length > 0) {
			sources.mcpConfigIds = mcpConfigIds;
		}
		startMutation.mutate({
			projectId,
			storyId,
			organizationId: organizationId ?? null,
			sources,
		});
	};

	const toggleMcp = (id: string, checked: boolean) => {
		setMcpConfigIds((prev) =>
			checked
				? prev.includes(id)
					? prev
					: [...prev, id]
				: prev.filter((value) => value !== id),
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="font-serif text-2xl font-normal">
						<span className="inline-flex items-center gap-2">
							{t("dialog.title")}
							<InfoTip label={tTips("discoveryRunHelp")}>
								<p>{tTips("discoveryRun")}</p>
								<p className="mt-1">
									{tTips("discoveryMarkComplete")}
								</p>
							</InfoTip>
						</span>
					</DialogTitle>
					<DialogDescription>
						{storyIdentifier
							? t("dialog.descriptionWithId", {
									id: storyIdentifier,
								})
							: t("dialog.description")}
					</DialogDescription>
				</DialogHeader>

				{isAiNotConfigured && (
					<output className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
						<AlertCircleIcon
							className="mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
						<span>{t("dialog.aiNotConfigured")}</span>
					</output>
				)}

				<div className="space-y-5">
					{/* Repository */}
					<section aria-labelledby="discovery-source-repo">
						<span
							id="discovery-source-repo"
							className="editorial-label mb-2 inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground"
						>
							<span
								aria-hidden="true"
								className="inline-block h-3 w-px bg-primary"
							/>
							{t("sources.repo.label")}
						</span>
						<div className="flex items-start gap-3">
							<Checkbox
								id="discovery-repo"
								checked={hasRepository && useRepo}
								disabled={!hasRepository}
								onCheckedChange={(checked) =>
									setUseRepo(checked === true)
								}
							/>
							<Label
								htmlFor="discovery-repo"
								className="text-sm leading-5"
							>
								{hasRepository
									? t("sources.repo.hint")
									: t("sources.repo.noRepository")}
							</Label>
						</div>
					</section>

					{/* OpenAPI */}
					<section aria-labelledby="discovery-source-openapi">
						<span
							id="discovery-source-openapi"
							className="editorial-label mb-2 inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground"
						>
							<span
								aria-hidden="true"
								className="inline-block h-3 w-px bg-primary"
							/>
							{t("sources.openApi.label")}
						</span>
						<RadioGroup
							value={openApiMode}
							onValueChange={(value) =>
								setOpenApiMode(value as OpenApiMode)
							}
							className="space-y-2"
						>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									value="none"
									id="openapi-none"
								/>
								<Label
									htmlFor="openapi-none"
									className="text-sm"
								>
									{t("sources.openApi.none")}
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									value="context"
									id="openapi-context"
									disabled={openApiContexts.length === 0}
								/>
								<Label
									htmlFor="openapi-context"
									className="text-sm"
								>
									{openApiContexts.length === 0
										? t("sources.openApi.noContexts")
										: t("sources.openApi.fromContext")}
								</Label>
							</div>
							{openApiMode === "context" && (
								<Select
									value={contextId}
									onValueChange={setContextId}
								>
									<SelectTrigger
										aria-label={t(
											"sources.openApi.selectContext",
										)}
										className="ml-6 w-[calc(100%-1.5rem)]"
									>
										<SelectValue
											placeholder={t(
												"sources.openApi.selectContext",
											)}
										/>
									</SelectTrigger>
									<SelectContent>
										{openApiContexts.map((context) => (
											<SelectItem
												key={context.id}
												value={context.id}
											>
												{context.originalFilename ??
													context.sourceTitle ??
													context.id}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
							<div className="flex items-center gap-2">
								<RadioGroupItem value="url" id="openapi-url" />
								<Label
									htmlFor="openapi-url"
									className="text-sm"
								>
									{t("sources.openApi.fromUrl")}
								</Label>
							</div>
							{openApiMode === "url" && (
								<div className="ml-6 space-y-1">
									<Input
										type="url"
										inputMode="url"
										placeholder="https://api.example.com/openapi.json"
										aria-label={t(
											"sources.openApi.urlLabel",
										)}
										value={openApiUrl}
										onChange={(event) =>
											setOpenApiUrl(event.target.value)
										}
									/>
									<p className="text-xs text-muted-foreground">
										{t("sources.openApi.urlHint")}
									</p>
									{openApiUrl.trim() !== "" &&
										!urlLooksValid && (
											<p className="text-xs text-destructive">
												{t(
													"sources.openApi.urlInvalid",
												)}
											</p>
										)}
								</div>
							)}
						</RadioGroup>
					</section>

					{/* MCP servers */}
					<section aria-labelledby="discovery-source-mcp">
						<span
							id="discovery-source-mcp"
							className="editorial-label mb-2 inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground"
						>
							<span
								aria-hidden="true"
								className="inline-block h-3 w-px bg-primary"
							/>
							{t("sources.mcp.label")}
						</span>
						{mcpConfigs.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								{t("sources.mcp.none")}
							</p>
						) : (
							<ul className="space-y-2">
								{mcpConfigs.map((config) => {
									const id = `discovery-mcp-${config.id}`;
									const name =
										config.displayName ||
										config.mcpServer?.name ||
										config.id;
									return (
										<li
											key={config.id}
											className="flex items-center gap-3"
										>
											<Checkbox
												id={id}
												checked={mcpConfigIds.includes(
													config.id,
												)}
												onCheckedChange={(checked) =>
													toggleMcp(
														config.id,
														checked === true,
													)
												}
											/>
											<Label
												htmlFor={id}
												className="text-sm"
											>
												{name}
											</Label>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={startMutation.isPending}
					>
						{t("dialog.cancel")}
					</Button>
					<Button
						onClick={handleSubmit}
						disabled={!canSubmit}
						className="gap-2"
					>
						{startMutation.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<SearchIcon className="size-4" aria-hidden="true" />
						)}
						{t("dialog.submit")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
