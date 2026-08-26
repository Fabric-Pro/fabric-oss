"use client";

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
	ExternalLinkIcon,
	EyeIcon,
	EyeOffIcon,
	FlameIcon,
	GlobeIcon,
	InfoIcon,
	LoaderIcon,
	SearchIcon,
	SettingsIcon,
	StarIcon,
	VideoIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface Provider {
	name: string;
	displayName: string;
	description: string;
	docsUrl?: string;
	requiresApiKey: boolean;
	supportsContentRetrieval: boolean;
	supportsImageSearch: boolean;
	supportedCategories: string[];
	costPerSearch: number;
}

interface ProviderConfig {
	id: string;
	providerName: string;
	maskedApiKey: string | null;
	endpoint: string | null;
	isDefault: boolean;
	priority: number;
	enabled: boolean;
	lastUsedAt: Date | null;
	searchesCount: number;
	totalCost: number;
}

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
	exa: <SearchIcon className="size-5" />,
	tavily: <GlobeIcon className="size-5" />,
	youtube: <VideoIcon className="size-5" />,
	firecrawl: <FlameIcon className="size-5" />,
	jina: <GlobeIcon className="size-5" />,
};

export function SearchProvidersSettingsForm() {
	const queryClient = useQueryClient();
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
			queryKey: ["availableSearchProviders"],
			queryFn: async () => {
				return await orpcClient.searchProviders.listAvailableProviders();
			},
		});

	// Query user provider configurations
	const { data: providerConfigs = [], isLoading: isLoadingConfigs } =
		useQuery({
			queryKey: ["userSearchProviders"],
			queryFn: async () => {
				return await orpcClient.searchProviders.getUserProviders();
			},
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
			return await orpcClient.searchProviders.updateUserProvider({
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
				queryKey: ["userSearchProviders"],
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
			return await orpcClient.searchProviders.testProviderConnection(
				data,
			);
		},
		onSuccess: (result) => {
			if (result.success) {
				toast.success("Connection successful", {
					description: `Response time: ${result.responseTime}ms`,
				});
			} else {
				toast.error("Connection failed", {
					description: result.error || "Unknown error",
				});
			}
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
		if (provider.name === "youtube") {
			return "Video Search";
		}
		if (provider.supportedCategories.includes("academic")) {
			return "Academic Search";
		}
		return "Web Search";
	};

	const getProviderFeatures = (provider: Provider): string[] => {
		const features: string[] = [];
		if (provider.supportsContentRetrieval) {
			features.push("Content Extraction");
		}
		if (provider.supportsImageSearch) {
			features.push("Image Search");
		}
		provider.supportedCategories.forEach((cat) => {
			if (cat !== "general") {
				features.push(cat.charAt(0).toUpperCase() + cat.slice(1));
			}
		});
		return features;
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
				title="Personal Search Providers"
				description="Configure your personal web search providers. These settings override organization-level configurations."
			>
				<div className="space-y-6">
					{/* Info Banner */}
					<div className="rounded-md border border-border bg-muted/40 p-4">
						<div className="flex gap-3">
							<InfoIcon className="size-5 shrink-0 text-muted-foreground" />
							<div className="space-y-1 text-sm">
								<p className="font-medium text-foreground">
									Search Provider Settings
								</p>
								<p className="text-muted-foreground">
									Configure API keys for web search providers
									to enable AI-powered search capabilities in
									chats and agents. Your personal settings
									will override organization defaults.
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
															<div className="flex items-start gap-3">
																<div className="text-muted-foreground">
																	{PROVIDER_ICONS[
																		provider
																			.name
																	] || (
																		<SearchIcon className="size-5" />
																	)}
																</div>
																<div className="flex-1">
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
															</div>

															{/* Status Badges */}
															<div className="flex items-center gap-2">
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
																<Badge
																	variant="secondary"
																	className="text-xs"
																>
																	{provider.costPerSearch ===
																	0
																		? "Free"
																		: `$${provider.costPerSearch}/search`}
																</Badge>
															</div>

															{/* Features */}
															<div className="flex flex-wrap gap-1">
																{getProviderFeatures(
																	provider,
																)
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
																		Searches:{" "}
																		{
																			config.searchesCount
																		}{" "}
																		| Cost:
																		$
																		{config.totalCost.toFixed(
																			4,
																		)}
																	</p>
																</div>
															)}

															{/* Action Buttons */}
															<div className="flex gap-2">
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
																		? "Edit"
																		: "Configure"}
																</Button>
																{provider.docsUrl && (
																	<Button
																		variant="ghost"
																		size="sm"
																		asChild
																	>
																		<a
																			href={
																				provider.docsUrl
																			}
																			target="_blank"
																			rel="noopener noreferrer"
																		>
																			<ExternalLinkIcon className="size-4" />
																		</a>
																	</Button>
																)}
															</div>
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
						<div className="space-y-2">
							<Label htmlFor="apiKey">API Key</Label>
							<div className="relative">
								<Input
									id="apiKey"
									type={showApiKey ? "text" : "password"}
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="Enter API key"
									className="pr-10"
								/>
								<button
									type="button"
									onClick={() => setShowApiKey(!showApiKey)}
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
										{selectedProvider.displayName} Console
									</a>
								</p>
							)}
						</div>

						{/* Endpoint Input (for custom endpoints) */}
						<div className="space-y-2">
							<Label htmlFor="endpoint">
								Custom Endpoint (Optional)
							</Label>
							<Input
								id="endpoint"
								type="url"
								value={endpoint}
								onChange={(e) => setEndpoint(e.target.value)}
								placeholder="https://api.example.com"
							/>
							<p className="text-muted-foreground text-xs">
								Leave empty to use the default endpoint
							</p>
						</div>

						{/* Test Connection Button */}
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
							<div>
								<Label htmlFor="isDefault">
									Set as Default
								</Label>
								<p className="text-muted-foreground text-xs">
									Use this provider for all search operations
								</p>
							</div>
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
							disabled={updateMutation.isPending || !apiKey}
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
