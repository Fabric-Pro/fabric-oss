"use client";

import type { WorkflowIntegrationProvider } from "@repo/database";
import { toFriendlyPermissionError } from "@saas/data-connections/lib/permission-error-copy";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
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
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	EyeIcon,
	EyeOffIcon,
	FolderCogIcon,
	Loader2Icon,
	LogOutIcon,
	SearchIcon,
	SettingsIcon,
	ShieldCheckIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	getAllIntegrations,
	type IntegrationFormField,
	type IntegrationPlugin,
	type IntegrationType,
} from "../../lib/plugins";
import { IntegrationBrandIcon } from "./IntegrationBrandIcon";

const ACCOUNT_SETTINGS_INTEGRATIONS: IntegrationType[] = [
	"AI_GATEWAY",
	"FIRECRAWL",
];

const OAUTH_INTEGRATIONS: IntegrationType[] = [
	"ASANA",
	"GITHUB",
	"GOOGLE_DRIVE",
	"HUBSPOT",
	"INTERCOM",
	"LINEAR",
	"MICROSOFT_GRAPH",
	"SLACK",
	"NOTION",
];

function hasOnlyMaskedCredentials(creds: Record<string, unknown>): boolean {
	if (!creds || Object.keys(creds).length === 0) {
		return false;
	}
	const apiKey = creds.apiKey as string | undefined;
	if (!apiKey) {
		return false;
	}
	return apiKey.includes("•") || apiKey === "oauth_connected";
}

function isOAuthIntegration(type: IntegrationType): boolean {
	return OAUTH_INTEGRATIONS.includes(type);
}

function isUsingOAuthCredentials(
	type: IntegrationType,
	credentials: Record<string, unknown>,
): boolean {
	if (!isOAuthIntegration(type)) {
		return false;
	}

	return Boolean(
		credentials.access_token ||
			credentials.refresh_token ||
			credentials.apiKey === "oauth_connected",
	);
}

interface IntegrationCategory {
	id: string;
	label: string;
	integrations: IntegrationType[];
}

const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
	{
		id: "ai",
		label: "AI & Search",
		integrations: ["AI_GATEWAY", "PERPLEXITY"],
	},
	{
		id: "web",
		label: "Web & Data",
		integrations: ["FIRECRAWL", "GITHUB", "FAL"],
	},
	{
		id: "dev-platforms",
		label: "Dev Platforms",
		integrations: ["GITLAB", "BITBUCKET"],
	},
	{
		id: "knowledge",
		label: "Knowledge & Docs",
		integrations: [
			"NOTION",
			"CONFLUENCE",
			"GOOGLE_DRIVE",
			"DATABRICKS_VECTOR_SEARCH",
		],
	},
	{
		id: "communication",
		label: "Communication",
		integrations: ["MICROSOFT_GRAPH", "SLACK", "INTERCOM", "RESEND"],
	},
	{
		id: "productivity",
		label: "Productivity",
		integrations: ["LINEAR", "ASANA", "CLICKUP", "JIRA"],
	},
	{
		id: "support",
		label: "Support",
		integrations: ["ZENDESK", "FRONT", "FRESHSERVICE"],
	},
	{
		id: "sales",
		label: "Sales & CRM",
		integrations: ["HUBSPOT", "SALESFORCE"],
	},
	{ id: "data", label: "Data & Reference", integrations: ["NHTSA_VPIC"] },
	{ id: "tools", label: "Tools & Custom", integrations: ["MCP"] },
];

export function WorkflowIntegrationSettingsPageContent({
	organizationId,
	settingsBasePath,
	initialIntegration,
}: {
	organizationId: string | null;
	settingsBasePath: string;
	initialIntegration?: IntegrationType;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const allIntegrations = getAllIntegrations();
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchArmed, setIsSearchArmed] = useState(false);
	const [showPassword, setShowPassword] = useState<Record<string, boolean>>(
		{},
	);
	const [credentials, setCredentials] = useState<
		Record<IntegrationType, Record<string, unknown>>
	>({} as Record<IntegrationType, Record<string, unknown>>);
	const [isSaving, setIsSaving] = useState(false);
	const [isTesting, setIsTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		success: boolean;
		message?: string;
	} | null>(null);

	const fallbackIntegration =
		initialIntegration ?? allIntegrations[0]?.type ?? "LINEAR";
	const [activeIntegration, setActiveIntegration] =
		useState<IntegrationType>(fallbackIntegration);

	useEffect(() => {
		if (initialIntegration) {
			setActiveIntegration(initialIntegration);
		}
	}, [initialIntegration]);

	// OAuth completes in a popup and posts a success message back to this
	// page, so the component never remounts — without this listener, a
	// pre-reauth "Connection Failed: GitLab returned status 401" banner
	// stays on screen even though the user just reconnected successfully.
	// Plugin-specific listeners (GitLabSettings, GitHubSettings, the generic
	// OAuthSettings) handle their own query invalidation; this listener only
	// owns the test-result UI state that lives in the parent.
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}
			const type = event.data?.type;
			if (typeof type === "string" && type.endsWith("oauth_success")) {
				setTestResult(null);
			}
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const { data: configuredData } = useQuery({
		queryKey: ["workflow-integrations", organizationId],
		queryFn: async () => {
			const result = await orpcClient.workflows.integrations.list({
				organizationId,
			});
			return result.integrations;
		},
		// Was staleTime:0 + refetchOnMount:"always" + refetchOnWindowFocus:true,
		// which re-fetched the whole list on every mount/provider-switch and
		// every window focus. The save/disconnect mutations already invalidate
		// this key, so a short staleTime is enough.
		staleTime: 30_000,
	});

	const disconnectMutation = useMutation({
		mutationFn: async (type: IntegrationType) => {
			if (isOAuthIntegration(type)) {
				await orpcClient.integrations.oauth.disconnect({
					provider: type as
						| "ASANA"
						| "GITHUB"
						| "GOOGLE_DRIVE"
						| "LINEAR"
						| "MICROSOFT_GRAPH"
						| "SLACK"
						| "NOTION",
					organizationId,
				});
			}
			return await orpcClient.workflows.integrations.disconnectByType({
				type: type as WorkflowIntegrationProvider,
				organizationId,
			});
		},
		onSuccess: (_, type) => {
			toast.success(`${type} disconnected`);
			setCredentials((prev) => {
				const next = { ...prev };
				delete next[type];
				return next;
			});
			// Any "Connection Failed: …" banner left over from a Test Connection
			// on the now-disconnected credential would otherwise outlive the
			// credential itself.
			setTestResult(null);
			void queryClient.invalidateQueries({
				queryKey: ["workflow-integrations"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["github-oauth-status"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["data-connections"],
			});
			void queryClient.refetchQueries({
				queryKey: ["workflow-integrations"],
			});
		},
		onError: (error) => {
			toast.error(
				toFriendlyPermissionError(
					error,
					"Failed to disconnect integration",
				),
			);
		},
	});

	const configuredMap = useMemo(() => {
		const map: Record<
			string,
			{ hasCredentials: boolean; lastUsedAt?: Date }
		> = {};
		if (configuredData && Array.isArray(configuredData)) {
			for (const integration of configuredData) {
				map[integration.provider] = {
					hasCredentials: integration.hasCredentials,
					lastUsedAt: integration.lastUsedAt ?? undefined,
				};
			}
		}
		return map;
	}, [configuredData]);

	useEffect(() => {
		const nextCredentials =
			configuredData?.reduce(
				(acc, integration) => {
					if (integration.hasCredentials) {
						acc[integration.provider as IntegrationType] = {
							apiKey: "••••••••",
						};
					}
					return acc;
				},
				{} as Record<IntegrationType, Record<string, unknown>>,
			) ?? ({} as Record<IntegrationType, Record<string, unknown>>);
		setCredentials(nextCredentials);
	}, [configuredData]);

	const { data: accountSettings } = useQuery({
		queryKey: ["account-settings-integrations", organizationId],
		queryFn: async () => {
			const configs: Record<
				IntegrationType,
				{ configured: boolean; source: string }
			> = {} as Record<
				IntegrationType,
				{ configured: boolean; source: string }
			>;

			try {
				const aiConfigStatus =
					await orpcClient.aiConfig.resolution.getStatus({
						organizationId,
					});
				if (aiConfigStatus?.isConfigured) {
					configs.AI_GATEWAY = {
						configured: true,
						source: aiConfigStatus.hasOrgConfig
							? "Organization Settings"
							: aiConfigStatus.hasUserConfig
								? "Account Settings"
								: "System Default",
					};
				}
			} catch {}

			try {
				const userFirecrawlConfig =
					await orpcClient.users.firecrawl.getConfig({});
				if (userFirecrawlConfig?.configured) {
					configs.FIRECRAWL = {
						configured: true,
						source: "Account Settings",
					};
				}
			} catch {}

			for (const type of Object.keys(credentials) as IntegrationType[]) {
				const creds = credentials[type];
				if (creds && Object.keys(creds).length > 0 && !configs[type]) {
					configs[type] = { configured: true, source: "Workflow" };
				}
			}

			return configs;
		},
		staleTime: 30000,
	});

	const filteredIntegrations = useMemo(() => {
		if (!searchQuery.trim()) {
			return allIntegrations;
		}
		const query = searchQuery.toLowerCase();
		return allIntegrations.filter(
			(plugin) =>
				plugin.label.toLowerCase().includes(query) ||
				plugin.description.toLowerCase().includes(query) ||
				plugin.type.toLowerCase().includes(query),
		);
	}, [allIntegrations, searchQuery]);

	const activePlugin = useMemo(
		() =>
			allIntegrations.find((plugin) => plugin.type === activeIntegration),
		[activeIntegration, allIntegrations],
	);
	const goToIntegration = (type: IntegrationType) => {
		setActiveIntegration(type);
		setTestResult(null);
		router.replace(`${settingsBasePath}/actions/${type}`);
	};

	const handleFieldChange = useCallback(
		(type: IntegrationType, fieldId: string, value: string) => {
			setCredentials((prev) => ({
				...prev,
				[type]: {
					...prev[type],
					[fieldId]: value,
				},
			}));
			setTestResult(null);
		},
		[],
	);

	const togglePasswordVisibility = useCallback((fieldId: string) => {
		setShowPassword((prev) => ({ ...prev, [fieldId]: !prev[fieldId] }));
	}, []);

	const handleTestConnection = useCallback(async () => {
		if (!activePlugin) {
			return;
		}
		setIsTesting(true);
		setTestResult(null);
		try {
			const creds = credentials[activePlugin.type] || {};
			let result: { success: boolean; message?: string; error?: string };
			if (
				hasOnlyMaskedCredentials(creds) ||
				isUsingOAuthCredentials(activePlugin.type, creds)
			) {
				result =
					await orpcClient.workflows.integrations.testSavedConnection(
						{
							type: activePlugin.type as WorkflowIntegrationProvider,
							organizationId,
						},
					);
			} else {
				result = await orpcClient.workflows.integrations.testConnection(
					{
						type: activePlugin.type as WorkflowIntegrationProvider,
						credentials: creds as Record<string, string>,
					},
				);
			}
			setTestResult({
				success: result.success,
				message: result.success ? result.message : result.error,
			});
		} catch (error) {
			setTestResult({
				success: false,
				message:
					error instanceof Error
						? error.message
						: "Connection test failed",
			});
		} finally {
			setIsTesting(false);
		}
	}, [activePlugin, credentials, organizationId]);

	const handleSave = useCallback(async () => {
		if (!activePlugin) {
			return;
		}

		// For OAuth-managed integrations the credentials form has nothing
		// to submit via the manual save flow \u2014 the OAuth callback already
		// stored real values. Short-circuit when:
		//  - credentials carry an OAuth marker (access_token / refresh_token / "oauth_connected"),
		//  - the apiKey is a masked placeholder (user didn't edit it), or
		//  - the credentials object is empty (OAuth not started yet \u2014 nothing
		//    to save; would otherwise trigger a manual-credential error).
		if (isOAuthIntegration(activePlugin.type)) {
			const creds = credentials[activePlugin.type] || {};
			const apiKey = creds.apiKey as string | undefined;
			const isMasked = !!apiKey && /^[\u2022]+$/.test(apiKey);
			const hasOAuthMarker = Boolean(
				creds.access_token ||
					creds.refresh_token ||
					apiKey === "oauth_connected",
			);
			const hasNoCredentialFields =
				!apiKey && !creds.access_token && !creds.refresh_token;

			if (hasOAuthMarker || isMasked || hasNoCredentialFields) {
				await queryClient.invalidateQueries({
					queryKey: ["workflow-integrations", organizationId],
				});
				await queryClient.refetchQueries({
					queryKey: ["workflow-integrations", organizationId],
				});
				return;
			}
		}

		setIsSaving(true);
		try {
			await orpcClient.workflows.integrations.save({
				type: activePlugin.type as WorkflowIntegrationProvider,
				credentials: (credentials[activePlugin.type] || {}) as Record<
					string,
					string
				>,
				organizationId,
			});
			await queryClient.invalidateQueries({
				queryKey: ["workflow-integrations", organizationId],
			});
			await queryClient.refetchQueries({
				queryKey: ["workflow-integrations", organizationId],
			});
			setTestResult(null);
			toast.success("Integration settings saved");
		} catch (error) {
			toast.error(
				toFriendlyPermissionError(error, "Failed to save settings"),
			);
		} finally {
			setIsSaving(false);
		}
	}, [activePlugin, credentials, organizationId, queryClient]);

	const renderFormField = (
		plugin: IntegrationPlugin,
		field: IntegrationFormField,
	) => {
		const creds = credentials[plugin.type] || {};
		const value = (creds[field.configKey || field.id] as string) || "";
		const fieldId = `${plugin.type}-${field.id}`;
		const isPasswordVisible = showPassword[fieldId];
		const isMaskedCredential = value === "••••••••" || /^•+$/.test(value);

		return (
			<div key={field.id} className="space-y-2">
				<Label htmlFor={fieldId}>
					{field.label}
					{field.required ? (
						<span className="ml-1 text-destructive">*</span>
					) : null}
				</Label>
				<div className="relative">
					<Input
						id={fieldId}
						type={
							field.type === "password" && !isPasswordVisible
								? "password"
								: "text"
						}
						value={value}
						onChange={(event) =>
							handleFieldChange(
								plugin.type,
								field.configKey || field.id,
								event.target.value,
							)
						}
						placeholder={
							isMaskedCredential
								? "Enter new value to replace"
								: field.placeholder
						}
						className={field.type === "password" ? "pr-10" : ""}
						autoComplete="off"
						data-lpignore="true"
						data-1p-ignore
						data-form-type="other"
						name={`${plugin.type.toLowerCase()}-${field.id}`}
					/>
					{field.type === "password" && !isMaskedCredential ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
							onClick={() => togglePasswordVisibility(fieldId)}
						>
							{isPasswordVisible ? (
								<EyeOffIcon className="h-4 w-4 text-muted-foreground" />
							) : (
								<EyeIcon className="h-4 w-4 text-muted-foreground" />
							)}
						</Button>
					) : null}
				</div>
				{isMaskedCredential ? (
					<p className="text-xs text-highlight">
						Saved credentials are hidden for security. Enter a new
						value to replace.
					</p>
				) : null}
				{field.helpText && !isMaskedCredential ? (
					<p className="text-xs text-muted-foreground">
						{field.helpText}
					</p>
				) : null}
				{field.helpLink ? (
					<a
						href={field.helpLink.url}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
					>
						{field.helpLink.text}
						<ExternalLinkIcon className="h-3 w-3" />
					</a>
				) : null}
			</div>
		);
	};

	const isConfiguredViaSettings = (type: IntegrationType) =>
		accountSettings?.[type]?.configured || false;
	const getConfigSource = (type: IntegrationType) =>
		accountSettings?.[type]?.source || null;
	const isConfiguredInWorkflow = (type: IntegrationType) => {
		const creds = credentials[type];
		return !!creds && Object.keys(creds).length > 0;
	};

	if (!activePlugin) {
		return (
			<div className="py-10 text-sm text-muted-foreground">
				No integration found.
			</div>
		);
	}

	const configuredViaSettings = isConfiguredViaSettings(activePlugin.type);
	const configSource = getConfigSource(activePlugin.type);
	const hasFormFields =
		activePlugin.formFields && activePlugin.formFields.length > 0;
	const skipClientTest = activePlugin.testConfig?.skipClientTest === true;
	const canConfigureViaSettings = ACCOUNT_SETTINGS_INTEGRATIONS.includes(
		activePlugin.type,
	);
	const ActiveIcon =
		typeof activePlugin.icon === "function"
			? activePlugin.icon
			: WrenchIcon;
	const _configuredCount = Object.values(configuredMap).filter(
		(integration) => integration.hasCredentials,
	).length;
	const isDetailRoute = Boolean(initialIntegration);
	const visibleCategories = searchQuery
		? [
				{
					id: "filtered",
					label: "Matching providers",
					integrations: filteredIntegrations.map(
						(plugin) => plugin.type,
					),
				},
			]
		: INTEGRATION_CATEGORIES;

	return (
		<div className="space-y-6 px-6 pb-6 pt-2 md:px-8">
			<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
				<div className="flex items-start gap-4">
					<IntegrationBrandIcon
						icon={ActiveIcon}
						label={activePlugin.label}
						color={activePlugin.color}
						brandColor={activePlugin.brandColor}
						size={56}
						className="rounded-2xl"
					/>
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="text-2xl font-semibold tracking-tight">
								{activePlugin.label}
							</h2>
							<Badge variant="outline" className="capitalize">
								{activePlugin.category}
							</Badge>
							{configuredViaSettings ? (
								<Badge variant="secondary" className="gap-1">
									<SettingsIcon className="h-3 w-3" />
									{configSource}
								</Badge>
							) : null}
							{isConfiguredInWorkflow(activePlugin.type) &&
							!configuredViaSettings ? (
								<Badge>Workflow configured</Badge>
							) : null}
						</div>
						<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
							{activePlugin.description}
						</p>
						<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
							<span className="rounded-full border px-3 py-1">
								{activePlugin.actions.length} available actions
							</span>
							<span className="rounded-full border px-3 py-1">
								{hasFormFields
									? `${activePlugin.formFields.length} credential field${activePlugin.formFields.length === 1 ? "" : "s"}`
									: "No credentials required"}
							</span>
						</div>
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					{isDetailRoute ? (
						<Button variant="outline" asChild>
							<Link href={`${settingsBasePath}/actions`}>
								<ArrowLeftIcon className="mr-2 h-4 w-4" />
								All providers
							</Link>
						</Button>
					) : null}
					<Button variant="outline" asChild>
						<Link href={settingsBasePath}>
							Back to Integrations
						</Link>
					</Button>
				</div>
			</div>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>
								Credentials & runtime settings
							</CardTitle>
							<CardDescription>
								Save action credentials here when this provider
								should run inside workflows or agent actions.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
							{configuredViaSettings ? (
								<div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/30">
									<div className="flex items-start gap-3">
										<CheckCircle2Icon className="mt-0.5 h-5 w-5 shrink-0 text-success dark:text-green-400" />
										<div className="flex-1">
											<p className="text-sm font-medium text-success">
												Configured via {configSource}
											</p>
											<p className="mt-1 text-xs text-green-700 dark:text-green-300">
												This integration is already
												configured in your{" "}
												{configSource?.toLowerCase()}.
												You can override it here for
												this workflow only, or use the
												existing configuration.
											</p>
											{canConfigureViaSettings ? (
												<Link
													href={`${settingsBasePath}/../ai-providers`}
													className="mt-2 inline-flex items-center gap-1 text-xs text-green-700 hover:underline dark:text-green-300"
												>
													Manage in Settings
													<ExternalLinkIcon className="h-3 w-3" />
												</Link>
											) : null}
										</div>
									</div>
								</div>
							) : null}

							{canConfigureViaSettings &&
							!configuredViaSettings ? (
								<div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
									<div className="flex items-start gap-3">
										<SettingsIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
										<div className="flex-1">
											<p className="text-sm font-medium text-foreground/70">
												Tip: Configure in Account
												Settings
											</p>
											<p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
												You can configure{" "}
												{activePlugin.label} in account
												or organization settings to use
												it across workflows, or
												configure it below for
												workflow-only use.
											</p>
										</div>
									</div>
								</div>
							) : null}

							<div className="space-y-6">
								{activePlugin.SettingsComponent ||
								activePlugin.settingsComponent ? (
									(() => {
										const SettingsComp =
											activePlugin.SettingsComponent ||
											activePlugin.settingsComponent;
										if (!SettingsComp) {
											return null;
										}
										return (
											<SettingsComp
												apiKey={
													(credentials[
														activePlugin.type
													]?.apiKey as string) || ""
												}
												hasKey={
													!!credentials[
														activePlugin.type
													]?.apiKey
												}
												onApiKeyChange={(
													value: string,
												) =>
													handleFieldChange(
														activePlugin.type,
														"apiKey",
														value,
													)
												}
												config={
													credentials[
														activePlugin.type
													] || {}
												}
												onConfigChange={(
													config: Record<
														string,
														unknown
													>,
												) =>
													setCredentials((prev) => ({
														...prev,
														[activePlugin.type]:
															config,
													}))
												}
												organizationId={organizationId}
											/>
										);
									})()
								) : hasFormFields ? (
									<div className="space-y-4">
										{activePlugin.formFields.map((field) =>
											renderFormField(
												activePlugin,
												field,
											),
										)}
									</div>
								) : (
									<div className="space-y-2 py-8 text-center">
										<p className="text-sm font-medium">
											No credentials required
										</p>
										<p className="text-sm text-muted-foreground">
											This is a free public API. Save to
											enable it.
										</p>
									</div>
								)}

								{testResult ? (
									<div
										className={`rounded-lg border p-4 text-sm ${
											testResult.success
												? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
												: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
										}`}
									>
										<div className="flex items-center gap-2">
											{testResult.success ? (
												<CheckCircle2Icon className="h-4 w-4" />
											) : null}
											<span className="font-medium">
												{testResult.success
													? "Connection Successful"
													: "Connection Failed"}
											</span>
										</div>
										{testResult.message ? (
											<p className="mt-1 text-xs">
												{testResult.message}
											</p>
										) : null}
									</div>
								) : null}
							</div>

							<div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex flex-wrap gap-2">
									{skipClientTest ? null : (
										<Button
											variant="outline"
											onClick={handleTestConnection}
											loading={isTesting}
											disabled={isTesting}
										>
											{isTesting
												? "Testing..."
												: "Test Connection"}
										</Button>
									)}
									{isConfiguredInWorkflow(
										activePlugin.type,
									) &&
									!isOAuthIntegration(activePlugin.type) ? (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button
													variant="outline"
													disabled={
														disconnectMutation.isPending
													}
													className="text-destructive hover:bg-red-50 hover:text-red-700"
												>
													{disconnectMutation.isPending ? (
														<Loader2Icon className="h-4 w-4 animate-spin" />
													) : (
														<>
															<LogOutIcon className="mr-1 h-4 w-4" />
															Disconnect
														</>
													)}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														Disconnect{" "}
														{activePlugin.label}?
													</AlertDialogTitle>
													<AlertDialogDescription>
														This removes the stored
														credentials. Any
														workflow or agent that
														uses{" "}
														{activePlugin.label}{" "}
														will fail until you
														reconnect. This action
														cannot be undone.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>
														Cancel
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() =>
															disconnectMutation.mutate(
																activePlugin.type,
															)
														}
														variant="destructive"
													>
														Disconnect
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									) : null}
								</div>
								<div className="flex flex-wrap gap-2">
									<Button variant="outline" asChild>
										<Link href={settingsBasePath}>
											Back
										</Link>
									</Button>
									<Button
										onClick={handleSave}
										loading={isSaving}
										disabled={isSaving}
									>
										{isSaving ? "Saving..." : "Save"}
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Available actions</CardTitle>
							<CardDescription>
								These are the operations Fabric can run through{" "}
								{activePlugin.label}
								once this integration is connected.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{activePlugin.actions.length > 0 ? (
								<div className="grid gap-3 md:grid-cols-2">
									{activePlugin.actions.map((action) => (
										<div
											key={action.slug}
											className="rounded-xl border p-4"
										>
											<div className="flex items-center gap-2">
												<p className="font-medium">
													{action.label}
												</p>
												<Badge
													variant="outline"
													className="text-[10px] uppercase tracking-[0.15em]"
												>
													{action.category}
												</Badge>
											</div>
											<p className="mt-2 text-sm leading-6 text-muted-foreground">
												{action.description}
											</p>
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									No runtime actions are registered for this
									integration yet.
								</p>
							)}
						</CardContent>
					</Card>
				</div>

				<div className="space-y-6">
					<Card className="self-start">
						<CardHeader className="pb-3">
							<CardTitle className="text-base">
								Capability status
							</CardTitle>
							<CardDescription>
								Review runtime actions for this provider.
							</CardDescription>
						</CardHeader>
						<CardContent className="grid gap-3">
							<div className="rounded-xl border bg-muted/20 p-4">
								<div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
									Actions
								</div>
								<div className="mt-2 flex items-center justify-between gap-3">
									<div className="text-xl font-semibold">
										{isConfiguredInWorkflow(
											activePlugin.type,
										) || configuredViaSettings
											? "Connected"
											: "Not connected"}
									</div>
									<Badge
										variant={
											isConfiguredInWorkflow(
												activePlugin.type,
											) || configuredViaSettings
												? "default"
												: "outline"
										}
									>
										Runtime
									</Badge>
								</div>
							</div>
							<div className="rounded-xl border p-4">
								<div className="flex items-center gap-2 text-sm font-medium">
									<ShieldCheckIcon className="h-4 w-4 text-primary" />
									Configuration scope
								</div>
								<p className="mt-2 text-sm text-muted-foreground">
									{configuredViaSettings
										? `Inherited from ${configSource?.toLowerCase()}.`
										: isConfiguredInWorkflow(
													activePlugin.type,
												)
											? "Saved for workflow and agent runtime use."
											: "Not configured yet."}
								</p>
							</div>
						</CardContent>
					</Card>

					<Card className="self-start">
						<CardHeader>
							<div className="flex items-start justify-between gap-3">
								<div>
									<CardTitle>
										{isDetailRoute
											? "Switch provider"
											: "Browse providers"}
									</CardTitle>
									<CardDescription>
										Choose the connected system Fabric
										should call at runtime.
									</CardDescription>
								</div>
								<FolderCogIcon className="mt-1 h-5 w-5 text-muted-foreground" />
							</div>
							<div className="relative pt-2">
								<SearchIcon className="absolute left-3 top-[calc(50%+0.25rem)] h-4 w-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									type="search"
									placeholder="Search providers..."
									value={searchQuery}
									onChange={(event) =>
										setSearchQuery(event.target.value)
									}
									onPointerDown={() => setIsSearchArmed(true)}
									onFocus={() => setIsSearchArmed(true)}
									className="pl-9"
									readOnly={!isSearchArmed}
									autoComplete="new-password"
									autoCorrect="off"
									autoCapitalize="none"
									spellCheck={false}
									name="action-provider-filter"
									data-lpignore="true"
									data-1p-ignore
									data-form-type="other"
								/>
							</div>
						</CardHeader>
						<CardContent
							className={cn(
								"space-y-5",
								isDetailRoute && "max-h-[60vh] overflow-y-auto",
							)}
						>
							{visibleCategories.map((category) => {
								const items = allIntegrations.filter((plugin) =>
									category.integrations.includes(plugin.type),
								);
								if (items.length === 0) {
									return null;
								}
								return (
									<div
										key={category.id}
										className="space-y-2"
									>
										<h3 className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
											{category.label}
										</h3>
										<div className="space-y-2">
											{items.map((plugin) => {
												const Icon =
													typeof plugin.icon ===
													"function"
														? plugin.icon
														: WrenchIcon;
												const configured =
													isConfiguredViaSettings(
														plugin.type,
													) ||
													isConfiguredInWorkflow(
														plugin.type,
													);
												const isActive =
													activeIntegration ===
													plugin.type;

												return (
													<button
														key={plugin.type}
														type="button"
														onClick={() =>
															goToIntegration(
																plugin.type,
															)
														}
														className={cn(
															"flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
															isActive
																? "border-primary bg-primary/5 shadow-sm"
																: "hover:border-border hover:bg-muted/40",
														)}
													>
														<IntegrationBrandIcon
															icon={Icon}
															label={plugin.label}
															color={plugin.color}
															brandColor={
																plugin.brandColor
															}
															size={40}
														/>
														<div className="min-w-0 flex-1">
															<div className="flex items-center gap-2">
																<span className="truncate text-sm font-medium">
																	{
																		plugin.label
																	}
																</span>
																{configured ? (
																	<CheckCircle2Icon className="h-3.5 w-3.5 shrink-0 text-success" />
																) : null}
															</div>
															<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
																{
																	plugin.description
																}
															</p>
														</div>
													</button>
												);
											})}
										</div>
									</div>
								);
							})}
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
