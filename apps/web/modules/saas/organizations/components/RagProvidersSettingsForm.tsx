"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
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
import { Switch } from "@ui/components/switch";
import {
	CheckCircleIcon,
	EyeIcon,
	EyeOffIcon,
	InfoIcon,
	LoaderIcon,
	LockIcon,
	SettingsIcon,
	StarIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface Provider {
	name: string;
	displayName: string;
	description: string;
	supportedFileTypes: string[];
	requiresApiKey: boolean;
	costPerPage: number;
	features: string[];
}

interface ProviderConfig {
	id: string;
	providerName: string;
	maskedApiKey: string | null;
	endpoint: string | null;
	isDefault: boolean;
	priority: number;
	enabled: boolean;
	documentsProcessed: number;
	totalCost: number;
}

export function RagProvidersSettingsForm({
	readOnly = false,
}: {
	readOnly?: boolean;
}) {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	const [selectedProvider, setSelectedProvider] = useState<Provider | null>(
		null,
	);
	const [showApiKey, setShowApiKey] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [isDefault, setIsDefault] = useState(false);
	const [isTesting, setIsTesting] = useState(false);

	// Query available providers
	const { data: availableProviders = [], isLoading: isLoadingProviders } =
		useQuery({
			queryKey: ["availableRagProviders"],
			queryFn: async () => {
				return await orpcClient.ragProviders.listAvailableProviders();
			},
		});

	// Query organization provider configurations
	const { data: providerConfigs = [], isLoading: isLoadingConfigs } =
		useQuery({
			queryKey: ["organizationRagProviders", organizationId],
			queryFn: async () => {
				if (!organizationId) {
					return [];
				}
				return await orpcClient.ragProviders.getOrganizationProviders({
					organizationId,
				});
			},
			enabled: !!organizationId,
		});

	const isLoading = isLoadingProviders || isLoadingConfigs;

	// Mutation to update provider
	const updateMutation = useMutation({
		mutationFn: async (data: {
			providerName: string;
			apiKey?: string;
			endpoint?: string | null;
			enabled: boolean;
			isDefault: boolean;
		}) => {
			if (!organizationId) {
				throw new Error("No active organization");
			}
			return await orpcClient.ragProviders.updateOrganizationProvider({
				organizationId,
				providerName: data.providerName,
				apiKey: data.apiKey,
				endpoint: data.endpoint,
				enabled: data.enabled,
				isDefault: data.isDefault,
			});
		},
		onSuccess: () => {
			toast.success("Provider configuration saved successfully");
			queryClient.invalidateQueries({
				queryKey: ["organizationRagProviders", organizationId],
			});
			setSelectedProvider(null);
			setApiKey("");
			setEndpoint("");
		},
		onError: (error) => {
			toast.error("Failed to save provider configuration", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Test connection mutation
	const testConnectionMutation = useMutation({
		mutationFn: async (data: {
			providerName: string;
			apiKey: string;
			endpoint?: string;
		}) => {
			return await orpcClient.ragProviders.testProviderConnection(data);
		},
		onSuccess: (result) => {
			toast.success("Connection successful", {
				description: result.message,
			});
		},
		onError: (error) => {
			toast.error("Connection failed", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleTestConnection = async () => {
		if (!selectedProvider || !apiKey) {
			return;
		}

		setIsTesting(true);
		try {
			await testConnectionMutation.mutateAsync({
				providerName: selectedProvider.name,
				apiKey,
				endpoint: endpoint || undefined,
			});
		} finally {
			setIsTesting(false);
		}
	};

	const handleSave = () => {
		if (!selectedProvider) {
			return;
		}

		updateMutation.mutate({
			providerName: selectedProvider.name,
			apiKey: apiKey || undefined,
			endpoint: endpoint || null,
			enabled,
			isDefault,
		});
	};

	const handleConfigureProvider = (provider: Provider) => {
		setSelectedProvider(provider);
		const existingConfig = providerConfigs.find(
			(c) => c.providerName === provider.name,
		);
		setApiKey("");
		setEndpoint(existingConfig?.endpoint || "");
		setEnabled(existingConfig?.enabled ?? false);
		setIsDefault(existingConfig?.isDefault ?? false);
	};

	const getProviderConfig = (providerName: string): ProviderConfig | null => {
		return (
			providerConfigs.find((c) => c.providerName === providerName) || null
		);
	};

	const getProviderCategory = (provider: Provider): string => {
		if (!provider.requiresApiKey) {
			return "Local Providers";
		}
		if (provider.name === "unstructured") {
			return "Cloud OCR";
		}
		return "Advanced Extraction";
	};

	// Group providers by category
	const groupedProviders = availableProviders.reduce(
		(acc, provider) => {
			const category = getProviderCategory(provider);
			if (!acc[category]) {
				acc[category] = [];
			}
			acc[category].push(provider);
			return acc;
		},
		{} as Record<string, Provider[]>,
	);

	return (
		<>
			<SettingsItem
				title="RAG Extraction Providers"
				description="Configure document extraction providers for your organization. These providers are used to extract text from uploaded documents."
			>
				<div className="space-y-6">
					{/* Read-Only Banner */}
					{readOnly && (
						<div className="rounded-md border border-highlight/20 bg-highlight/5 p-4">
							<div className="flex gap-3">
								<LockIcon className="size-5 shrink-0 text-highlight" />
								<div className="space-y-1 text-sm">
									<p className="font-medium text-foreground">
										View Only
									</p>
									<p className="text-highlight/80">
										Only organization administrators can
										modify RAG provider settings.
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
									How it works
								</p>
								<p className="text-muted-foreground">
									Providers are tried in priority order (lower
									number = higher priority). If one fails, the
									next provider is automatically used as
									fallback.
								</p>
							</div>
						</div>
					</div>

					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<LoaderIcon className="size-6 animate-spin text-muted-foreground" />
						</div>
					) : (
						<div className="space-y-6">
							{Object.entries(groupedProviders).map(
								([category, providers]) => (
									<div key={category}>
										<h3 className="mb-3 font-semibold text-sm">
											{category}
										</h3>
										<div className="grid gap-4 md:grid-cols-2">
											{providers.map((provider) => {
												const config =
													getProviderConfig(
														provider.name,
													);
												const isConfigured = !!config;
												const isEnabled =
													config?.enabled ?? false;

												return (
													<Card
														key={provider.name}
														className="relative p-4 transition-colors hover:border-primary/50"
													>
														{/* Default Badge */}
														{config?.isDefault && (
															<div className="absolute top-2 right-2">
																<Badge
																	variant="default"
																	className="flex items-center gap-1"
																>
																	<StarIcon className="size-3" />
																	Default
																</Badge>
															</div>
														)}

														<div className="space-y-3">
															{/* Provider Header */}
															<div>
																<div className="flex items-start justify-between">
																	<h4 className="font-semibold">
																		{
																			provider.displayName
																		}
																	</h4>
																</div>
																<p className="mt-1 text-muted-foreground text-xs">
																	{
																		provider.description
																	}
																</p>
															</div>

															{/* Cost */}
															<div className="flex items-center gap-2">
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	{provider.costPerPage ===
																	0
																		? "Free"
																		: `$${provider.costPerPage}/page`}
																</Badge>
																{isConfigured && (
																	<Badge
																		variant={
																			isEnabled
																				? "default"
																				: "outline"
																		}
																		className="text-xs"
																	>
																		{isEnabled ? (
																			<>
																				<CheckCircleIcon className="mr-1 size-3" />
																				Enabled
																			</>
																		) : (
																			"Disabled"
																		)}
																	</Badge>
																)}
															</div>

															{/* Features */}
															<div className="flex flex-wrap gap-1">
																{provider.features
																	.slice(0, 3)
																	.map(
																		(
																			feature,
																		) => (
																			<Badge
																				key={
																					feature
																				}
																				variant="outline"
																				className="text-xs"
																			>
																				{
																					feature
																				}
																			</Badge>
																		),
																	)}
															</div>

															{/* Usage Stats */}
															{config && (
																<div className="text-muted-foreground text-xs">
																	<p>
																		Documents:{" "}
																		{
																			config.documentsProcessed
																		}{" "}
																		| Cost:
																		$
																		{config.totalCost.toFixed(
																			4,
																		)}
																	</p>
																</div>
															)}

															{/* Configure Button */}
															<Button
																variant="outline"
																size="sm"
																className="w-full"
																onClick={() =>
																	handleConfigureProvider(
																		provider,
																	)
																}
																disabled={
																	readOnly
																}
															>
																<SettingsIcon className="mr-2 size-4" />
																{readOnly
																	? "View Details"
																	: isConfigured
																		? "Edit Configuration"
																		: "Configure"}
															</Button>
														</div>
													</Card>
												);
											})}
										</div>
									</div>
								),
							)}
						</div>
					)}
				</div>
			</SettingsItem>

			{/* Configuration Dialog */}
			<Dialog
				open={!!selectedProvider}
				onOpenChange={(open) => !open && setSelectedProvider(null)}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>
							Configure {selectedProvider?.displayName}
						</DialogTitle>
						<DialogDescription>
							{selectedProvider?.description}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						{/* API Key Input */}
						{selectedProvider?.requiresApiKey && (
							<div className="space-y-2">
								<Label htmlFor="apiKey">API Key</Label>
								<div className="relative">
									<Input
										id="apiKey"
										type={showApiKey ? "text" : "password"}
										value={apiKey}
										onChange={(e) =>
											setApiKey(e.target.value)
										}
										placeholder="Enter API key"
										className="pr-10"
									/>
									<button
										type="button"
										onClick={() =>
											setShowApiKey(!showApiKey)
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
							</div>
						)}

						{/* Endpoint Input (for Azure) */}
						{selectedProvider?.name ===
							"azure-document-intelligence" && (
							<div className="space-y-2">
								<Label htmlFor="endpoint">Endpoint URL</Label>
								<Input
									id="endpoint"
									type="url"
									value={endpoint}
									onChange={(e) =>
										setEndpoint(e.target.value)
									}
									placeholder="https://your-resource.cognitiveservices.azure.com/"
								/>
							</div>
						)}

						{/* Test Connection Button */}
						{selectedProvider?.requiresApiKey && (
							<Button
								variant="outline"
								className="w-full"
								onClick={handleTestConnection}
								disabled={!apiKey || isTesting}
							>
								{isTesting ? (
									<>
										<LoaderIcon className="mr-2 size-4 animate-spin" />
										Testing...
									</>
								) : (
									"Test Connection"
								)}
							</Button>
						)}

						{/* Enable/Disable Toggle */}
						<div className="flex items-center justify-between">
							<Label htmlFor="enabled">Enable Provider</Label>
							<Switch
								id="enabled"
								checked={enabled}
								onCheckedChange={setEnabled}
							/>
						</div>

						{/* Set as Default Toggle */}
						<div className="flex items-center justify-between">
							<Label htmlFor="isDefault">Set as Default</Label>
							<Switch
								id="isDefault"
								checked={isDefault}
								onCheckedChange={setIsDefault}
							/>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setSelectedProvider(null)}
						>
							Cancel
						</Button>
						<Button
							onClick={handleSave}
							disabled={
								updateMutation.isPending ||
								(selectedProvider?.requiresApiKey && !apiKey)
							}
						>
							{updateMutation.isPending ? (
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
		</>
	);
}
