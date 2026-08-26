"use client";

import { useReturnToRedirect } from "@saas/settings/hooks/use-return-to-redirect";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
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
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
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
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	CloudIcon,
	DatabaseIcon,
	EyeIcon,
	EyeOffIcon,
	InfoIcon,
	LoaderIcon,
	PlayIcon,
	ServerIcon,
	SettingsIcon,
	StarIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type AuthMode,
	canProviderSupportEmbeddings,
	GATEWAY_SUB_PROVIDERS,
	getCloudProviders,
	getDirectProviders,
	getGatewayProviders,
	hasCompleteCredentials,
	isServicePrincipalMode,
	type ProviderWithIcon,
} from "../lib/ai-providers";

export function AiProvidersSettingsForm() {
	const queryClient = useQueryClient();
	const { triggerReturn } = useReturnToRedirect();
	const [selectedProvider, setSelectedProvider] =
		useState<ProviderWithIcon | null>(null);
	const [showApiKey, setShowApiKey] = useState(false);
	const [apiKey, setApiKey] = useState("");
	// Providers flagged `supportsServicePrincipal` (Databricks) can authenticate
	// with an OAuth M2M service principal instead of a static key. The two modes
	// are exclusive — the server rejects a payload carrying both.
	const [authMode, setAuthMode] = useState<AuthMode>("apiKey");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [showClientSecret, setShowClientSecret] = useState(false);
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [deploymentName, setDeploymentName] = useState("");
	const [isTesting, setIsTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		success: boolean;
		message: string;
		latencyMs?: number;
	} | null>(null);
	// Monotonic revision of the dialog's credential state, bumped by every edit.
	// `testedRevision` records the revision a passing test actually exercised.
	const [formRevision, setFormRevision] = useState(0);
	const [testedRevision, setTestedRevision] = useState<number | null>(null);
	const [enabledProvidersDialogOpen, setEnabledProvidersDialogOpen] =
		useState(false);
	const [selectedGatewayForProviders, setSelectedGatewayForProviders] =
		useState<string | null>(null);
	const [enabledProviders, setEnabledProviders] = useState<string[]>([]);
	const [embeddingChangeConfirmOpen, setEmbeddingChangeConfirmOpen] =
		useState(false);
	const [pendingEmbeddingProvider, setPendingEmbeddingProvider] = useState<
		string | null
	>(null);
	const [testingProviderId, setTestingProviderId] = useState<string | null>(
		null,
	);
	// Provider currently pending delete confirmation. Null when the
	// confirmation dialog is closed. We hold the full provider object
	// (not just the id) so the dialog can show the human-readable name.
	const [providerToDelete, setProviderToDelete] =
		useState<ProviderWithIcon | null>(null);

	// Query AI configuration status
	const { data: configStatus, isLoading: isLoadingStatus } = useQuery({
		queryKey: ["aiConfigStatus"],
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId: null,
			});
		},
	});

	// Test connection mutation (for new configurations)
	const testConnectionMutation = useMutation({
		mutationFn: async (data: {
			provider: string;
			apiKey?: string;
			clientId?: string;
			clientSecret?: string;
			baseUrl?: string;
		}) => {
			// Cast to any to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.testConnection({
				provider: data.provider as never,
				apiKey: data.apiKey,
				clientId: data.clientId,
				clientSecret: data.clientSecret,
				baseUrl: data.baseUrl,
			});
		},
	});

	// Test saved connection mutation (for existing configurations)
	const testSavedConnectionMutation = useMutation({
		mutationFn: async (provider: string) => {
			return await orpcClient.aiConfig.providers.testSavedConnection({
				provider: provider as never,
				organizationId: null, // Personal context
			});
		},
		onSuccess: (result, _provider) => {
			setTestingProviderId(null);
			if (result.success) {
				toast.success("Connection verified", {
					description: `${result.message}${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}`,
				});
			} else {
				toast.error("Connection failed", {
					description: result.message,
				});
			}
		},
		onError: (error) => {
			setTestingProviderId(null);
			toast.error("Test failed", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const handleTestSavedConnection = (providerId: string) => {
		setTestingProviderId(providerId);
		testSavedConnectionMutation.mutate(providerId);
	};

	// Save provider mutation
	const saveProviderMutation = useMutation({
		mutationFn: async (data: {
			provider: string;
			apiKey?: string;
			clientId?: string;
			clientSecret?: string;
			baseUrl?: string;
			deploymentName?: string;
			isDefault?: boolean;
		}) => {
			// Cast to never to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.upsert({
				provider: data.provider as never,
				apiKey: data.apiKey,
				clientId: data.clientId,
				clientSecret: data.clientSecret,
				baseUrl: data.baseUrl,
				deploymentName: data.deploymentName,
				isDefault: data.isDefault,
				organizationId: null, // Explicit null for personal context - prevents session fallback
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			// Invalidate AI chat queries so model selector updates immediately
			// Use null/undefined for personal context
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", undefined],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", undefined],
			});
		},
	});

	// Set default provider mutation
	const setDefaultMutation = useMutation({
		mutationFn: async (provider: string) => {
			// Cast to never to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.setDefault({
				provider: provider as never,
				organizationId: null, // Explicit null for personal context
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			// Invalidate AI chat queries so model selector updates immediately
			// Use null for organizationId since this is personal context
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", undefined],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", undefined],
			});
		},
	});

	// Set embedding provider mutation
	const setEmbeddingMutation = useMutation({
		mutationFn: async (provider: string) => {
			// Cast to never to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.setEmbedding({
				provider: provider as never,
				organizationId: null, // Explicit null for personal context
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			toast.success("Embedding provider updated");
		},
	});

	// Delete provider mutation. Mirrors the invalidation set used by
	// `saveProviderMutation` so the UI (model picker, configured-providers
	// list, task defaults) reflects the removal immediately.
	const deleteProviderMutation = useMutation({
		mutationFn: async (provider: string) => {
			// Cast to never to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.delete({
				provider: provider as never,
				organizationId: null, // Explicit null for personal context
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiAvailableModels", undefined],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", null],
			});
			queryClient.invalidateQueries({
				queryKey: ["aiTaskDefaults", undefined],
			});
		},
	});

	// Two-step delete: open the confirmation dialog first, then execute the
	// mutation only after the user confirms. Holding the full provider
	// object lets the dialog show the friendly display name.
	const handleConfirmDelete = async () => {
		if (!providerToDelete) {
			return;
		}
		try {
			await deleteProviderMutation.mutateAsync(providerToDelete.id);
			toast.success("Provider removed", {
				description: `${providerToDelete.name} has been removed from your profile.`,
			});
			setProviderToDelete(null);
		} catch (error) {
			toast.error("Failed to remove provider", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	// Query gateway config for enabled providers
	const { data: gatewayConfig } = useQuery({
		queryKey: ["gatewayConfig", selectedGatewayForProviders],
		queryFn: async () => {
			if (!selectedGatewayForProviders) {
				return null;
			}
			// Cast to never to satisfy API type (API validates on server)
			return await orpcClient.aiConfig.providers.getConfig({
				provider: selectedGatewayForProviders as never,
				organizationId: null, // Explicit null for personal context
			});
		},
		enabled: !!selectedGatewayForProviders,
	});

	// Update enabled providers when dialog opens
	useEffect(() => {
		if (gatewayConfig?.enabledProviders) {
			setEnabledProviders(gatewayConfig.enabledProviders);
		}
	}, [gatewayConfig]);

	// Update enabled providers mutation
	const updateEnabledMutation = useMutation({
		mutationFn: async (data: {
			provider: string;
			enabledProviders: string[];
		}) => {
			return await orpcClient.aiConfig.providers.updateEnabled({
				provider: data.provider,
				enabledProviders: data.enabledProviders,
				organizationId: null, // Explicit null for personal context
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			queryClient.invalidateQueries({
				queryKey: ["ai-config", "gateway-models"],
			});
			toast.success("Enabled providers updated");
		},
	});

	const handleOpenEnabledProviders = (provider: string) => {
		setSelectedGatewayForProviders(provider);
		setEnabledProvidersDialogOpen(true);
	};

	const handleSaveEnabledProviders = async () => {
		if (!selectedGatewayForProviders) {
			return;
		}
		try {
			await updateEnabledMutation.mutateAsync({
				provider: selectedGatewayForProviders,
				enabledProviders,
			});
			setEnabledProvidersDialogOpen(false);
			setSelectedGatewayForProviders(null);
		} catch (error) {
			toast.error("Failed to update enabled providers", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	const toggleProvider = (providerId: string) => {
		setEnabledProviders((prev) =>
			prev.includes(providerId)
				? prev.filter((p) => p !== providerId)
				: [...prev, providerId],
		);
	};

	/**
	 * Monotonic id for the "prefill the dialog from the saved config" request.
	 * Bumped by every reset (open, close, cancel, save, provider switch), so a
	 * slow in-flight response can be recognised as superseded and dropped
	 * instead of overwriting whatever the user has since typed — or mutating a
	 * dialog that has already closed or moved to a different provider.
	 */
	const prefillRequestRef = useRef(0);

	/**
	 * Mark any in-flight prefill as superseded.
	 *
	 * Called by EVERY deliberate edit in the dialog, not just the lifecycle
	 * resets: once the user has typed, they own the form, and a late
	 * `getConfig` response must not overwrite their input or flip the auth mode
	 * under them.
	 */
	// Authoritative counter lives in a ref so an in-flight test can compare
	// against the CURRENT revision when it resolves; the state mirror exists
	// only to re-render the Save button.
	const formRevisionRef = useRef(0);
	const supersedePrefill = () => {
		prefillRequestRef.current += 1;
		formRevisionRef.current += 1;
		setFormRevision(formRevisionRef.current);
	};

	// Field handlers that supersede the prefill before updating state. Used by
	// every input in the configure dialog so no edit path can forget to.
	const handleApiKeyChange = (value: string) => {
		supersedePrefill();
		setApiKey(value);
	};
	const handleClientIdChange = (value: string) => {
		supersedePrefill();
		setClientId(value);
	};
	const handleClientSecretChange = (value: string) => {
		supersedePrefill();
		setClientSecret(value);
	};
	const handleBaseUrlChange = (value: string) => {
		supersedePrefill();
		setCustomBaseUrl(value);
	};
	const handleDeploymentNameChange = (value: string) => {
		supersedePrefill();
		setDeploymentName(value);
	};

	/**
	 * Clear every credential field in the configure dialog. Called from all
	 * open/close/save paths so a secret typed for one provider can never leak
	 * into the next provider's dialog.
	 */
	const resetCredentialFields = () => {
		// Bumps BOTH counters: supersedes an in-flight prefill and invalidates
		// any passing test, so a reset can never leave a stale green check.
		supersedePrefill();
		setApiKey("");
		setAuthMode("apiKey");
		setClientId("");
		setClientSecret("");
		setShowApiKey(false);
		setShowClientSecret(false);
		setCustomBaseUrl("");
		setDeploymentName("");
		setTestResult(null);
		setTestedRevision(null);
	};

	// Whether the dialog is currently collecting a service principal rather than
	// an API key. Derived (not stored) so it can never disagree with the
	// provider's capability flag.
	const usingServicePrincipal = isServicePrincipalMode(
		selectedProvider,
		authMode,
	);
	const credentialsComplete = hasCompleteCredentials({
		provider: selectedProvider,
		authMode,
		apiKey,
		clientId,
		clientSecret,
	});

	/** The credential payload for the current mode — exactly one is populated. */
	const credentialPayload = usingServicePrincipal
		? { clientId, clientSecret }
		: { apiKey };

	/**
	 * True only when the passing test covered the values currently in the form.
	 *
	 * Identity is tracked as a monotonic REVISION rather than a hash or
	 * serialization of the credentials: an earlier version fingerprinted the
	 * field values, which meant the plaintext PAT or client secret sat in a
	 * memo AND in the "last tested" state, the latter outliving the credential
	 * it described. A counter has identical semantics — any edit invalidates a
	 * prior pass — while retaining nothing.
	 *
	 * Without this you could test a valid credential, edit it to garbage, and
	 * still Save; that was already true for the API key and base URL before
	 * service principals existed, and is fixed here for every field at once.
	 */
	const testPassedForCurrentInput =
		testResult?.success === true && testedRevision === formRevision;

	const handleTestConnection = async () => {
		if (!selectedProvider || !credentialsComplete) {
			return;
		}
		// For providers requiring base URL, validate it's provided
		if (selectedProvider.requiresBaseUrl && !customBaseUrl) {
			toast.error("Base URL required", {
				description: `${selectedProvider.name} requires a custom base URL to be configured.`,
			});
			return;
		}

		// Snapshot which revision of the form this test exercises.
		const revisionUnderTest = formRevisionRef.current;

		setIsTesting(true);
		setTestResult(null);
		setTestedRevision(null);
		try {
			const result = await testConnectionMutation.mutateAsync({
				provider: selectedProvider.id,
				...credentialPayload,
				baseUrl: selectedProvider.requiresBaseUrl
					? customBaseUrl
					: undefined,
			});

			// The user may have edited a field while the request was in flight;
			// a result for superseded input says nothing about what is on screen
			// now, so drop it rather than show a stale green check.
			if (formRevisionRef.current !== revisionUnderTest) {
				return;
			}

			setTestResult(result);
			setTestedRevision(result.success ? revisionUnderTest : null);
			if (result.success) {
				toast.success("Connection successful", {
					description: `${result.message}${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}`,
				});
			} else {
				toast.error("Connection failed", {
					description: result.message,
				});
			}
		} catch (error) {
			toast.error("Connection test failed", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsTesting(false);
		}
	};

	const handleSaveProvider = async () => {
		// Belt-and-braces alongside the disabled Save button: never persist a
		// credential that the passing test did not actually exercise.
		if (
			!selectedProvider ||
			!credentialsComplete ||
			!testPassedForCurrentInput
		) {
			return;
		}

		try {
			const result = await saveProviderMutation.mutateAsync({
				provider: selectedProvider.id,
				...credentialPayload,
				baseUrl: selectedProvider.requiresBaseUrl
					? customBaseUrl
					: undefined,
				// For Azure AI Foundry - pass the deployment name
				deploymentName:
					selectedProvider.id === "AZURE_AI_FOUNDRY" && deploymentName
						? deploymentName
						: undefined,
				// First provider is automatically set as default
				isDefault: !configStatus?.isConfigured,
			});

			toast.success("Provider saved", {
				description: `${result.displayName || selectedProvider.name} has been configured${result.isDefault ? " as default" : ""}`,
			});

			setSelectedProvider(null);
			resetCredentialFields();

			// Auto-redirect back to project setup if we came from there
			triggerReturn();
		} catch (error) {
			toast.error("Failed to save provider", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	const handleConfigureProvider = (provider: ProviderWithIcon) => {
		setSelectedProvider(provider);
		resetCredentialFields();

		// Reconfiguring an existing provider: restore the saved auth mode and
		// prefill the non-secret fields, so a service-principal config doesn't
		// silently reopen in API-key mode and get overwritten with a PAT. The
		// secret is never returned by the API and stays blank — the user must
		// re-enter it, matching how the API key field already behaves.
		if (!isProviderConfigured(provider.id)) {
			return;
		}

		// `resetCredentialFields` above bumped the generation, so read it AFTER
		// the reset — this request owns the dialog until something else resets.
		const requestId = prefillRequestRef.current;
		void (async () => {
			try {
				const saved = await orpcClient.aiConfig.providers.getConfig({
					provider: provider.id as never,
					organizationId: null, // Explicit null for personal context
				});

				// Drop a superseded response: the dialog may have closed,
				// switched provider, or the user may already be typing. Applying
				// it here would silently overwrite their input.
				if (prefillRequestRef.current !== requestId) {
					return;
				}

				if (saved.baseUrl) {
					setCustomBaseUrl(saved.baseUrl);
				}
				if (saved.deploymentName) {
					setDeploymentName(saved.deploymentName);
				}
				if (saved.hasServicePrincipal) {
					setAuthMode("servicePrincipal");
					setClientId(saved.clientId ?? "");
				}
			} catch {
				// Prefill is a convenience — fall back to the blank form rather
				// than blocking reconfiguration on a failed lookup.
			}
		})();
	};

	const isProviderConfigured = (providerId: string) => {
		return (
			configStatus?.configuredProviders.some(
				(p) => p.provider === providerId,
			) ?? false
		);
	};

	const isProviderDefault = (providerId: string) => {
		return (
			configStatus?.configuredProviders.some(
				(p) => p.provider === providerId && p.isDefault,
			) ?? false
		);
	};

	const isProviderEmbedding = (providerId: string) => {
		return (
			configStatus?.configuredProviders.some(
				(p) => p.provider === providerId && p.isEmbeddingProvider,
			) ?? false
		);
	};

	const handleSetDefault = async (providerId: string) => {
		try {
			await setDefaultMutation.mutateAsync(providerId);
			toast.success("Default provider updated");
		} catch (error) {
			toast.error("Failed to set default provider", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	const handleSetEmbedding = async (providerId: string) => {
		// If there's already an embedding provider set and it's different, show warning
		if (
			configStatus?.embeddingProvider &&
			configStatus.embeddingProvider !== providerId
		) {
			setPendingEmbeddingProvider(providerId);
			setEmbeddingChangeConfirmOpen(true);
			return;
		}

		// No existing embedding provider, set directly
		await confirmSetEmbedding(providerId);
	};

	const confirmSetEmbedding = async (providerId: string) => {
		try {
			await setEmbeddingMutation.mutateAsync(providerId);
		} catch (error) {
			toast.error("Failed to set embedding provider", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setEmbeddingChangeConfirmOpen(false);
			setPendingEmbeddingProvider(null);
		}
	};

	// Use memoized provider lists from centralized config
	const gatewayProviders = useMemo(() => getGatewayProviders(), []);
	const directProviders = useMemo(() => getDirectProviders(), []);
	const cloudProviders = useMemo(() => getCloudProviders(), []);

	return (
		<>
			<SettingsItem
				title="AI Providers"
				description="Configure AI providers to enable AI-powered features. You can use AI gateways for unified access or connect directly to providers."
			>
				<div className="space-y-6">
					{/* Status Overview */}
					{isLoadingStatus ? (
						<div className="flex items-center justify-center py-4">
							<LoaderIcon className="size-5 animate-spin text-muted-foreground" />
						</div>
					) : configStatus?.isConfigured ? (
						<div className="rounded-md border border-success/20 bg-success/5 p-4">
							<div className="flex items-start gap-3">
								<CheckCircleIcon className="size-5 shrink-0 text-success" />
								<div className="space-y-1">
									<p className="font-medium text-foreground">
										AI Providers Configured
									</p>
									<p className="text-success/80 text-sm">
										{configStatus.message}
									</p>
									{configStatus.configuredProviders.length >
										0 && (
										<div className="mt-2 space-y-2">
											<div className="flex flex-wrap gap-2">
												{configStatus.configuredProviders.map(
													(p) => (
														<div
															key={p.provider}
															className="flex items-center gap-1"
														>
															<Badge
																variant={
																	p.isDefault
																		? "default"
																		: "secondary"
																}
																className="text-xs"
															>
																{p.displayName ||
																	p.provider.replace(
																		/_/g,
																		" ",
																	)}
																{p.isDefault &&
																	" (Default)"}
															</Badge>
															{!p.isDefault &&
																configStatus
																	.configuredProviders
																	.length >
																	1 && (
																	<Button
																		variant="ghost"
																		size="sm"
																		className="h-5 px-1 text-xs text-muted-foreground hover:text-foreground"
																		onClick={() => {
																			setDefaultMutation.mutate(
																				p.provider,
																			);
																			toast.success(
																				"Default provider updated",
																			);
																		}}
																	>
																		Set
																		Default
																	</Button>
																)}
														</div>
													),
												)}
											</div>
											{/* Embedding Provider Status */}
											<div className="flex items-center gap-2 text-sm flex-wrap">
												<DatabaseIcon className="size-4 text-success" />
												<span className="text-success/80">
													Document Search:
												</span>
												{configStatus.embeddingProvider ? (
													<div className="flex items-center gap-1.5">
														<Badge
															variant="outline"
															className="text-xs border-secondary/30 bg-secondary/10 text-secondary"
														>
															{configStatus.configuredProviders.find(
																(p) =>
																	p.provider ===
																	configStatus.embeddingProvider,
															)?.displayName ||
																configStatus.embeddingProvider.replace(
																	/_/g,
																	" ",
																)}
														</Badge>
														{configStatus.embeddingModel && (
															<>
																<span className="text-muted-foreground">
																	→
																</span>
																{configStatus
																	.embeddingModel
																	.subProvider && (
																	<Badge
																		variant="secondary"
																		className="text-xs"
																	>
																		{
																			configStatus
																				.embeddingModel
																				.subProvider
																		}
																	</Badge>
																)}
																<span className="text-success/80 text-xs">
																	{
																		configStatus
																			.embeddingModel
																			.displayName
																	}
																</span>
															</>
														)}
													</div>
												) : (
													<span className="text-highlight text-xs">
														Not configured - set a
														provider below
													</span>
												)}
											</div>
										</div>
									)}
								</div>
							</div>
						</div>
					) : (
						<div className="rounded-md border border-highlight/20 bg-highlight/5 p-4">
							<div className="flex items-start gap-3">
								<AlertCircleIcon className="size-5 shrink-0 text-highlight" />
								<div className="space-y-1">
									<p className="font-medium text-foreground">
										No AI Provider Configured
									</p>
									<p className="text-highlight/80 text-sm">
										Configure at least one AI provider below
										to enable AI-powered features.
									</p>
								</div>
							</div>
						</div>
					)}

					{/* Info Banner */}
					<div className="rounded-md border border-border bg-muted/40 p-4">
						<div className="flex gap-3">
							<InfoIcon className="size-5 shrink-0 text-muted-foreground" />
							<div className="space-y-1 text-sm">
								<p className="font-medium text-foreground">
									Choose Your Provider
								</p>
								<p className="text-muted-foreground">
									<strong>AI Gateways</strong> provide unified
									access to multiple models with caching and
									analytics. <strong>Direct providers</strong>{" "}
									connect straight to the source for
									potentially lower costs.
								</p>
							</div>
						</div>
					</div>

					{/* Embedding Provider Info Banner */}
					{configStatus?.isConfigured &&
						!configStatus?.embeddingProvider && (
							<div className="rounded-md border border-secondary/20 bg-secondary/5 p-4">
								<div className="flex gap-3">
									<DatabaseIcon className="size-5 shrink-0 text-secondary" />
									<div className="space-y-1 text-sm">
										<p className="font-medium text-foreground">
											Set an Embedding Provider for
											Document Search
										</p>
										<p className="text-secondary/80">
											When you upload documents, they are
											converted into searchable vectors
											using an{" "}
											<strong>embedding model</strong>. To
											ensure your documents remain
											searchable even if you change your
											default AI provider, set a dedicated
											embedding provider below.
										</p>
										<p className="text-secondary/80 mt-1">
											<strong>Recommended:</strong> OpenAI
											or Vercel Gateway (with OpenAI
											enabled) for best results.
										</p>
									</div>
								</div>
							</div>
						)}

					{/* AI Gateways Section */}
					<div>
						<h3 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
							<CloudIcon className="size-4" />
							AI Gateways
						</h3>
						<div className="grid gap-4 md:grid-cols-2">
							{gatewayProviders.map((provider) => {
								const isConfigured = isProviderConfigured(
									provider.id,
								);
								const isDefault = isProviderDefault(
									provider.id,
								);
								const isEmbedding = isProviderEmbedding(
									provider.id,
								);
								const Icon = provider.icon;

								return (
									<Card
										key={provider.id}
										className={`relative p-4 transition-colors hover:border-primary/50 ${isDefault ? "border-primary/50 bg-primary/5" : ""}`}
									>
										<div className="space-y-3">
											<div className="flex items-start gap-3">
												<div className="rounded-lg bg-primary/10 p-2">
													<Icon className="size-5 text-primary" />
												</div>
												<div className="flex-1">
													<div className="flex items-center gap-2 flex-wrap">
														<h4 className="font-semibold">
															{provider.name}
														</h4>
														{isDefault && (
															<Badge
																variant="default"
																className="text-xs bg-primary text-primary-foreground"
															>
																<StarIcon className="mr-1 size-3" />
																Default
															</Badge>
														)}
														{isEmbedding && (
															<Badge
																variant="default"
																className="text-xs bg-secondary text-secondary-foreground"
															>
																<DatabaseIcon className="mr-1 size-3" />
																Embeddings
															</Badge>
														)}
														{isConfigured &&
															!isDefault &&
															!isEmbedding && (
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	<CheckCircleIcon className="mr-1 size-3" />
																	Active
																</Badge>
															)}
													</div>
													<p className="mt-1 text-muted-foreground text-xs">
														{provider.description}
													</p>
												</div>
											</div>

											<div className="flex gap-2 flex-wrap">
												<Button
													variant="outline"
													size="sm"
													className="flex-1"
													onClick={() =>
														handleConfigureProvider(
															provider,
														)
													}
												>
													<SettingsIcon className="mr-2 size-4" />
													{isConfigured
														? "Reconfigure"
														: "Configure"}
												</Button>
												{isConfigured && (
													<Button
														variant="secondary"
														size="sm"
														type="button"
														autoLoading={false}
														onClick={() =>
															handleOpenEnabledProviders(
																provider.id,
															)
														}
													>
														Providers
													</Button>
												)}
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																type="button"
																autoLoading={
																	false
																}
																onClick={() =>
																	handleTestSavedConnection(
																		provider.id,
																	)
																}
																disabled={
																	testingProviderId ===
																	provider.id
																}
															>
																{testingProviderId ===
																provider.id ? (
																	<LoaderIcon className="mr-1 size-3 animate-spin" />
																) : (
																	<PlayIcon className="mr-1 size-3" />
																)}
																Test
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Verify the
																connection is
																working
															</p>
														</TooltipContent>
													</Tooltip>
												)}
												{isConfigured && !isDefault && (
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															handleSetDefault(
																provider.id,
															)
														}
														disabled={
															setDefaultMutation.isPending
														}
													>
														<StarIcon className="mr-1 size-3" />
														Set Default
													</Button>
												)}
												{isConfigured &&
													!isEmbedding &&
													canProviderSupportEmbeddings(
														provider.id,
														configStatus,
													) && (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	variant="outline"
																	size="sm"
																	onClick={() =>
																		handleSetEmbedding(
																			provider.id,
																		)
																	}
																	disabled={
																		setEmbeddingMutation.isPending
																	}
																>
																	<DatabaseIcon className="mr-1 size-3" />
																	Use for
																	Documents
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="bottom"
																className="max-w-xs"
															>
																<p>
																	Use this
																	provider to
																	index and
																	search your
																	documents.
																	Documents
																	are
																	converted to
																	vectors for
																	semantic
																	search.
																</p>
															</TooltipContent>
														</Tooltip>
													)}
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																type="button"
																autoLoading={
																	false
																}
																onClick={() =>
																	setProviderToDelete(
																		provider,
																	)
																}
																disabled={
																	deleteProviderMutation.isPending &&
																	deleteProviderMutation.variables ===
																		provider.id
																}
																className="text-destructive hover:bg-destructive/10 hover:text-destructive"
															>
																<Trash2Icon className="mr-1 size-3" />
																Delete
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Remove this
																provider from
																your profile
															</p>
														</TooltipContent>
													</Tooltip>
												)}
											</div>
										</div>
									</Card>
								);
							})}
						</div>
					</div>

					{/* Direct Providers Section */}
					<div>
						<h3 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
							<ServerIcon className="size-4" />
							Direct Providers
						</h3>
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{directProviders.map((provider) => {
								const isConfigured = isProviderConfigured(
									provider.id,
								);
								const isDefault = isProviderDefault(
									provider.id,
								);
								const isEmbedding = isProviderEmbedding(
									provider.id,
								);
								const Icon = provider.icon;

								return (
									<Card
										key={provider.id}
										className={`relative p-4 transition-colors hover:border-primary/50 ${isDefault ? "border-primary/50 bg-primary/5" : ""}`}
									>
										<div className="space-y-3">
											<div className="flex items-start gap-3">
												<div
													className={`rounded-lg p-2 ${isDefault ? "bg-primary/10" : "bg-muted"}`}
												>
													<Icon
														className={`size-4 ${isDefault ? "text-primary" : "text-muted-foreground"}`}
													/>
												</div>
												<div className="flex-1">
													<div className="flex items-center gap-2 flex-wrap">
														<h4 className="font-semibold text-sm">
															{provider.name}
														</h4>
														{isDefault && (
															<Badge
																variant="default"
																className="text-xs bg-primary text-primary-foreground"
															>
																<StarIcon className="mr-1 size-3" />
																Default
															</Badge>
														)}
														{isEmbedding && (
															<Badge
																variant="default"
																className="text-xs bg-secondary text-secondary-foreground"
															>
																<DatabaseIcon className="mr-1 size-3" />
																Embeddings
															</Badge>
														)}
														{isConfigured &&
															!isDefault &&
															!isEmbedding && (
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	Active
																</Badge>
															)}
													</div>
													<p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
														{provider.description}
													</p>
												</div>
											</div>

											<div className="flex gap-2 flex-wrap">
												<Button
													variant="outline"
													size="sm"
													className="flex-1"
													onClick={() =>
														handleConfigureProvider(
															provider,
														)
													}
												>
													<SettingsIcon className="mr-2 size-3" />
													{isConfigured
														? "Reconfigure"
														: "Configure"}
												</Button>
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																onClick={() =>
																	handleTestSavedConnection(
																		provider.id,
																	)
																}
																disabled={
																	testingProviderId ===
																	provider.id
																}
															>
																{testingProviderId ===
																provider.id ? (
																	<LoaderIcon className="mr-1 size-3 animate-spin" />
																) : (
																	<PlayIcon className="mr-1 size-3" />
																)}
																Test
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Verify the
																connection is
																working
															</p>
														</TooltipContent>
													</Tooltip>
												)}
												{isConfigured && !isDefault && (
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															handleSetDefault(
																provider.id,
															)
														}
														disabled={
															setDefaultMutation.isPending
														}
													>
														<StarIcon className="mr-1 size-3" />
														Set Default
													</Button>
												)}
												{isConfigured &&
													!isEmbedding &&
													canProviderSupportEmbeddings(
														provider.id,
														configStatus,
													) && (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	variant="outline"
																	size="sm"
																	onClick={() =>
																		handleSetEmbedding(
																			provider.id,
																		)
																	}
																	disabled={
																		setEmbeddingMutation.isPending
																	}
																>
																	<DatabaseIcon className="mr-1 size-3" />
																	Use for
																	Documents
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="bottom"
																className="max-w-xs"
															>
																<p>
																	Use this
																	provider to
																	index and
																	search your
																	documents.
																	Documents
																	are
																	converted to
																	vectors for
																	semantic
																	search.
																</p>
															</TooltipContent>
														</Tooltip>
													)}
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																type="button"
																autoLoading={
																	false
																}
																onClick={() =>
																	setProviderToDelete(
																		provider,
																	)
																}
																disabled={
																	deleteProviderMutation.isPending &&
																	deleteProviderMutation.variables ===
																		provider.id
																}
																className="text-destructive hover:bg-destructive/10 hover:text-destructive"
															>
																<Trash2Icon className="mr-1 size-3" />
																Delete
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Remove this
																provider from
																your profile
															</p>
														</TooltipContent>
													</Tooltip>
												)}
											</div>
										</div>
									</Card>
								);
							})}
						</div>
					</div>

					{/* Cloud Providers Section */}
					<div>
						<h3 className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
							<CloudIcon className="size-4" />
							Cloud Providers
						</h3>
						<p className="mb-3 text-muted-foreground text-xs">
							Enterprise cloud AI services that require additional
							configuration like resource endpoints.
						</p>
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{cloudProviders.map((provider) => {
								const isConfigured = isProviderConfigured(
									provider.id,
								);
								const isDefault = isProviderDefault(
									provider.id,
								);
								const isEmbedding = isProviderEmbedding(
									provider.id,
								);
								const Icon = provider.icon;

								return (
									<Card
										key={provider.id}
										className={`relative p-4 transition-colors hover:border-primary/50 ${isDefault ? "border-primary/50 bg-primary/5" : ""}`}
									>
										<div className="space-y-3">
											<div className="flex items-start gap-3">
												<div
													className={`rounded-lg p-2 ${isDefault ? "bg-primary/10" : "bg-muted"}`}
												>
													<Icon
														className={`size-4 ${isDefault ? "text-primary" : "text-muted-foreground"}`}
													/>
												</div>
												<div className="flex-1">
													<div className="flex items-center gap-2 flex-wrap">
														<h4 className="font-semibold text-sm">
															{provider.name}
														</h4>
														{isDefault && (
															<Badge
																variant="default"
																className="text-xs bg-primary text-primary-foreground"
															>
																<StarIcon className="mr-1 size-3" />
																Default
															</Badge>
														)}
														{isEmbedding && (
															<Badge
																variant="default"
																className="text-xs bg-secondary text-secondary-foreground"
															>
																<DatabaseIcon className="mr-1 size-3" />
																Embeddings
															</Badge>
														)}
														{isConfigured &&
															!isDefault &&
															!isEmbedding && (
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	Active
																</Badge>
															)}
													</div>
													<p className="mt-1 line-clamp-2 text-muted-foreground text-xs">
														{provider.description}
													</p>
												</div>
											</div>

											<div className="flex gap-2 flex-wrap">
												<Button
													variant="outline"
													size="sm"
													className="flex-1"
													onClick={() =>
														handleConfigureProvider(
															provider,
														)
													}
												>
													<SettingsIcon className="mr-2 size-3" />
													{isConfigured
														? "Reconfigure"
														: "Configure"}
												</Button>
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																onClick={() =>
																	handleTestSavedConnection(
																		provider.id,
																	)
																}
																disabled={
																	testingProviderId ===
																	provider.id
																}
															>
																{testingProviderId ===
																provider.id ? (
																	<LoaderIcon className="mr-1 size-3 animate-spin" />
																) : (
																	<PlayIcon className="mr-1 size-3" />
																)}
																Test
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Verify the
																connection is
																working
															</p>
														</TooltipContent>
													</Tooltip>
												)}
												{isConfigured && !isDefault && (
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															handleSetDefault(
																provider.id,
															)
														}
														disabled={
															setDefaultMutation.isPending
														}
													>
														<StarIcon className="mr-1 size-3" />
														Set Default
													</Button>
												)}
												{isConfigured &&
													!isEmbedding &&
													canProviderSupportEmbeddings(
														provider.id,
														configStatus,
													) && (
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	variant="outline"
																	size="sm"
																	onClick={() =>
																		handleSetEmbedding(
																			provider.id,
																		)
																	}
																	disabled={
																		setEmbeddingMutation.isPending
																	}
																>
																	<DatabaseIcon className="mr-1 size-3" />
																	Use for
																	Documents
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="bottom"
																className="max-w-xs"
															>
																<p>
																	Use this
																	provider to
																	index and
																	search your
																	documents.
																	Documents
																	are
																	converted to
																	vectors for
																	semantic
																	search.
																</p>
															</TooltipContent>
														</Tooltip>
													)}
												{isConfigured && (
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="outline"
																size="sm"
																type="button"
																autoLoading={
																	false
																}
																onClick={() =>
																	setProviderToDelete(
																		provider,
																	)
																}
																disabled={
																	deleteProviderMutation.isPending &&
																	deleteProviderMutation.variables ===
																		provider.id
																}
																className="text-destructive hover:bg-destructive/10 hover:text-destructive"
															>
																<Trash2Icon className="mr-1 size-3" />
																Delete
															</Button>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															<p>
																Remove this
																provider from
																your profile
															</p>
														</TooltipContent>
													</Tooltip>
												)}
											</div>
										</div>
									</Card>
								);
							})}
						</div>
					</div>
				</div>
			</SettingsItem>

			{/* Delete confirmation — opened from any of the per-provider
			    Delete buttons. Two-step confirm: clicking Delete sets
			    `providerToDelete` (which opens this dialog), then the
			    user must explicitly confirm before the API call fires.
			    Closing the dialog (cancel / outside-click) clears the
			    pending provider without calling the delete mutation. */}
			<AlertDialog
				open={!!providerToDelete}
				onOpenChange={(open) => {
					if (!open) {
						setProviderToDelete(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove {providerToDelete?.name}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {providerToDelete?.name} from your
							profile. The stored API key is deleted and the
							provider will no longer appear in your model picker.
							You can add it back later by configuring it again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							disabled={deleteProviderMutation.isPending}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								// Prevent the default close-on-action behavior
								// so the dialog stays open while the request is
								// in flight; `handleConfirmDelete` closes it on
								// success and the catch leaves it open with the
								// error toast surfaced.
								event.preventDefault();
								void handleConfirmDelete();
							}}
							disabled={deleteProviderMutation.isPending}
							variant="destructive"
						>
							{deleteProviderMutation.isPending ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Removing…
								</>
							) : (
								<>
									<Trash2Icon className="mr-2 size-4" />
									Remove provider
								</>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Configuration Dialog */}
			<Dialog
				open={!!selectedProvider}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedProvider(null);
						resetCredentialFields();
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>
							Configure {selectedProvider?.name}
						</DialogTitle>
						<DialogDescription>
							{selectedProvider?.description}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						{/* Authentication mode — only for providers that support
						    an OAuth M2M service principal (Databricks). Others
						    keep the single API-key field unchanged. */}
						{selectedProvider?.supportsServicePrincipal && (
							<div className="space-y-2">
								<Label className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									Authentication
								</Label>
								<RadioGroup
									value={authMode}
									onValueChange={(value) => {
										supersedePrefill();
										setAuthMode(value as AuthMode);
										// Clear the other mode's fields so a
										// half-filled credential can't be sent.
										setApiKey("");
										setClientId("");
										setClientSecret("");
										setTestResult(null);
									}}
									className="grid gap-2"
								>
									<div
										className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
											authMode === "apiKey"
												? "border-primary bg-primary/5"
												: "border-border hover:bg-muted/50"
										}`}
									>
										<RadioGroupItem
											value="apiKey"
											id="auth-mode-api-key"
											className="mt-0.5"
										/>
										<Label
											htmlFor="auth-mode-api-key"
											className="flex-1 cursor-pointer"
										>
											<div className="font-medium">
												Personal access token
											</div>
											<div className="text-muted-foreground text-xs">
												A long-lived workspace token.
											</div>
										</Label>
									</div>
									<div
										className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
											authMode === "servicePrincipal"
												? "border-primary bg-primary/5"
												: "border-border hover:bg-muted/50"
										}`}
									>
										<RadioGroupItem
											value="servicePrincipal"
											id="auth-mode-service-principal"
											className="mt-0.5"
										/>
										<Label
											htmlFor="auth-mode-service-principal"
											className="flex-1 cursor-pointer"
										>
											<div className="font-medium">
												Service principal
											</div>
											<div className="text-muted-foreground text-xs">
												OAuth client credentials. Tokens
												are minted on demand and rotate
												automatically.
											</div>
										</Label>
									</div>
								</RadioGroup>
							</div>
						)}

						{/* API Key Input */}
						{!usingServicePrincipal && (
							<div className="space-y-2">
								<Label htmlFor="apiKey">API Key</Label>
								<div className="relative">
									<Input
										id="apiKey"
										type={showApiKey ? "text" : "password"}
										value={apiKey}
										onChange={(e) =>
											handleApiKeyChange(e.target.value)
										}
										placeholder={
											selectedProvider?.keyPlaceholder ||
											"Enter API key"
										}
										className="pr-10"
									/>
									<button
										type="button"
										onClick={() =>
											setShowApiKey(!showApiKey)
										}
										aria-label={
											showApiKey
												? "Hide API key"
												: "Show API key"
										}
										className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									>
										{showApiKey ? (
											<EyeOffIcon className="size-4" />
										) : (
											<EyeIcon className="size-4" />
										)}
									</button>
								</div>
								{selectedProvider?.docsUrl && (
									<p className="text-muted-foreground text-xs">
										Get your API key from{" "}
										<a
											href={selectedProvider.docsUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-primary hover:underline"
										>
											{selectedProvider.name} dashboard
										</a>
									</p>
								)}
							</div>
						)}

						{/* Service Principal Inputs */}
						{usingServicePrincipal && (
							<>
								<div className="space-y-2">
									<Label htmlFor="clientId">
										Service Principal Client ID
									</Label>
									<Input
										id="clientId"
										type="text"
										value={clientId}
										onChange={(e) =>
											handleClientIdChange(e.target.value)
										}
										placeholder={
											selectedProvider?.clientIdPlaceholder ||
											"Enter client ID"
										}
									/>
									<p className="text-muted-foreground text-xs">
										The service principal's application ID.
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="clientSecret">
										Service Principal Client Secret
									</Label>
									<div className="relative">
										<Input
											id="clientSecret"
											type={
												showClientSecret
													? "text"
													: "password"
											}
											value={clientSecret}
											onChange={(e) =>
												handleClientSecretChange(
													e.target.value,
												)
											}
											placeholder={
												selectedProvider?.clientSecretPlaceholder ||
												"Enter client secret"
											}
											className="pr-10"
										/>
										<button
											type="button"
											onClick={() =>
												setShowClientSecret(
													!showClientSecret,
												)
											}
											aria-label={
												showClientSecret
													? "Hide client secret"
													: "Show client secret"
											}
											className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
										>
											{showClientSecret ? (
												<EyeOffIcon className="size-4" />
											) : (
												<EyeIcon className="size-4" />
											)}
										</button>
									</div>
									<p className="text-muted-foreground text-xs">
										Stored encrypted and never shown again
										after saving.
									</p>
								</div>
							</>
						)}

						{/* Base URL Input (for providers that require custom base URL) */}
						{selectedProvider?.requiresBaseUrl && (
							<div className="space-y-2">
								<Label htmlFor="baseUrl">Gateway URL</Label>
								<Input
									id="baseUrl"
									type="text"
									value={customBaseUrl}
									onChange={(e) =>
										handleBaseUrlChange(e.target.value)
									}
									placeholder={
										selectedProvider.baseUrlPlaceholder ||
										"Enter gateway URL"
									}
								/>
								{selectedProvider.baseUrlHelp && (
									<p className="text-muted-foreground text-xs">
										{selectedProvider.baseUrlHelp}
									</p>
								)}
							</div>
						)}

						{/* Deployment Name Input (for Azure AI Foundry) */}
						{selectedProvider?.id === "AZURE_AI_FOUNDRY" && (
							<div className="space-y-2">
								<Label htmlFor="deploymentName">
									Deployment Name{" "}
									<span className="text-destructive">*</span>
								</Label>
								<Input
									id="deploymentName"
									type="text"
									value={deploymentName}
									onChange={(e) =>
										handleDeploymentNameChange(
											e.target.value,
										)
									}
									placeholder="e.g., gpt-4o, my-gpt4-deployment"
									required
								/>
								<p className="text-muted-foreground text-xs">
									<strong>Required.</strong> The name of your
									Azure OpenAI deployment. This is the name
									you gave when deploying a model in Azure AI
									Foundry (e.g., "gpt-4o" or
									"my-custom-deployment").
								</p>
							</div>
						)}

						{/* Test Result */}
						{testResult && (
							<div
								className={`rounded-lg border p-3 ${
									testResult.success
										? "border-success/20 bg-success/5"
										: "border-destructive/20 bg-destructive/5"
								}`}
							>
								<div className="flex items-center gap-2">
									{testResult.success ? (
										<CheckCircleIcon className="size-4 text-success" />
									) : (
										<AlertCircleIcon className="size-4 text-destructive" />
									)}
									<span
										className={`text-sm ${
											testResult.success
												? "text-foreground"
												: "text-foreground"
										}`}
									>
										{testResult.message}
									</span>
								</div>
								{testResult.latencyMs && (
									<p className="mt-1 text-muted-foreground text-xs">
										Latency: {testResult.latencyMs}ms
									</p>
								)}
							</div>
						)}

						{/* Test Connection Button */}
						<Button
							variant="outline"
							className="w-full"
							type="button"
							autoLoading={false}
							onClick={handleTestConnection}
							disabled={!credentialsComplete || isTesting}
						>
							{isTesting ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Testing Connection...
								</>
							) : (
								"Test Connection"
							)}
						</Button>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							type="button"
							autoLoading={false}
							onClick={() => {
								setSelectedProvider(null);
								resetCredentialFields();
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							autoLoading={false}
							onClick={handleSaveProvider}
							disabled={
								!credentialsComplete ||
								// Not merely "a test passed" — it must have
								// passed for the values currently in the form.
								!testPassedForCurrentInput ||
								saveProviderMutation.isPending ||
								(selectedProvider?.requiresBaseUrl &&
									!customBaseUrl) ||
								// Azure AI Foundry requires deployment name
								(selectedProvider?.id === "AZURE_AI_FOUNDRY" &&
									!deploymentName)
							}
						>
							{saveProviderMutation.isPending ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Saving...
								</>
							) : (
								"Save Configuration"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Enabled Providers Dialog */}
			<Dialog
				open={enabledProvidersDialogOpen}
				onOpenChange={(open) => {
					if (!open) {
						setEnabledProvidersDialogOpen(false);
						setSelectedGatewayForProviders(null);
						setEnabledProviders([]);
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Configure Enabled Providers</DialogTitle>
						<DialogDescription>
							Select which AI providers you have configured in
							your gateway. Only models from enabled providers
							will be shown in the model selector.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 max-h-[400px] overflow-y-auto">
						{GATEWAY_SUB_PROVIDERS.map((provider) => (
							// biome-ignore lint/a11y/noStaticElementInteractions: contains nested Checkbox; cannot use <button>
							// biome-ignore lint/a11y/useKeyWithClickEvents: contains nested Checkbox; cannot use <button>
							<div
								key={provider.id}
								className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors cursor-pointer"
								onClick={() => toggleProvider(provider.id)}
							>
								<Checkbox
									id={`provider-${provider.id}`}
									checked={enabledProviders.includes(
										provider.id,
									)}
									onClick={(e) => e.stopPropagation()}
									onCheckedChange={() =>
										toggleProvider(provider.id)
									}
								/>
								<div className="flex-1">
									<Label
										htmlFor={`provider-${provider.id}`}
										className="font-medium cursor-pointer"
									>
										{provider.name}
									</Label>
									<p className="text-muted-foreground text-xs mt-0.5">
										{provider.description}
									</p>
								</div>
							</div>
						))}
					</div>

					{enabledProviders.length === 0 && (
						<div className="rounded-md border border-highlight/20 bg-highlight/5 p-3">
							<p className="text-highlight/80 text-sm">
								Select at least one provider to see models in
								the model selector.
							</p>
						</div>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							type="button"
							autoLoading={false}
							onClick={() => {
								setEnabledProvidersDialogOpen(false);
								setSelectedGatewayForProviders(null);
								setEnabledProviders([]);
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							autoLoading={false}
							onClick={handleSaveEnabledProviders}
							disabled={updateEnabledMutation.isPending}
						>
							{updateEnabledMutation.isPending ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Saving...
								</>
							) : (
								"Save Changes"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Embedding Provider Change Confirmation Dialog */}
			<Dialog
				open={embeddingChangeConfirmOpen}
				onOpenChange={(open) => {
					if (!open) {
						setEmbeddingChangeConfirmOpen(false);
						setPendingEmbeddingProvider(null);
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-highlight">
							<AlertCircleIcon className="size-5" />
							Change Embedding Provider?
						</DialogTitle>
						<DialogDescription asChild>
							<div className="space-y-3 text-sm text-muted-foreground">
								<p>
									You're about to change your embedding
									provider from{" "}
									<strong>
										{configStatus?.embeddingProvider?.replace(
											/_/g,
											" ",
										)}
									</strong>{" "}
									to{" "}
									<strong>
										{pendingEmbeddingProvider?.replace(
											/_/g,
											" ",
										)}
									</strong>
									.
								</p>
								<div className="rounded-md border border-highlight/20 bg-highlight/5 p-3">
									<p className="text-highlight text-sm">
										<strong>Warning:</strong> Different
										embedding providers produce incompatible
										vectors. Documents indexed with the
										previous provider may not be searchable
										correctly.
									</p>
									<p className="text-highlight/80 text-sm mt-2">
										Consider re-indexing your documents
										after changing the embedding provider.
									</p>
								</div>
							</div>
						</DialogDescription>
					</DialogHeader>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setEmbeddingChangeConfirmOpen(false);
								setPendingEmbeddingProvider(null);
							}}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() =>
								pendingEmbeddingProvider &&
								confirmSetEmbedding(pendingEmbeddingProvider)
							}
							disabled={setEmbeddingMutation.isPending}
						>
							{setEmbeddingMutation.isPending ? (
								<>
									<LoaderIcon className="mr-2 size-4 animate-spin" />
									Changing...
								</>
							) : (
								"Change Embedding Provider"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
