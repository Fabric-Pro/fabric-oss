/**
 * MCP Settings Form Base
 *
 * Base component that composes all MCP settings functionality.
 * This is used by both UserMcpSettingsForm and OrgMcpSettingsForm.
 */

"use client";

import { useActiveOrganization } from "@saas/organizations/hooks";
import { useReturnToRedirect } from "@saas/settings/hooks/use-return-to-redirect";
import { Button } from "@ui/components/button";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect } from "react";
import {
	McpConfigDialog,
	McpConfigList,
	McpDeleteConfigDialog,
	McpDeleteServerDialog,
	McpServerDialog,
	McpServerList,
} from "./components";
import {
	checkOAuthStatuses,
	useMcpActions,
	useMcpMutations,
	useMcpQueries,
	useMcpSettingsState,
} from "./hooks";
import type { McpConfig, McpServer, McpSettingsScope } from "./types";

export interface McpSettingsFormBaseProps {
	scope: McpSettingsScope;
	organizationId?: string;
	disabled?: boolean;
	/** Separately disable server registry controls (add/edit/delete custom servers). Defaults to `disabled`. */
	registryDisabled?: boolean;
	showHero?: React.ReactNode;
	serverListTitle?: string;
	serverListDescription?: string;
	configListTitle?: string;
	configListDescription?: string;
}

export function McpSettingsFormBase({
	scope,
	organizationId,
	disabled = false,
	registryDisabled,
	showHero,
	serverListTitle,
	serverListDescription,
	configListTitle,
	configListDescription,
}: McpSettingsFormBaseProps) {
	const isRegistryDisabled = registryDisabled ?? disabled;
	const { triggerReturn } = useReturnToRedirect();

	// Admin gate for the Atlassian Cloud "needs workspace setup" hint
	// (State C of AtlassianCloudAttachmentBanner). Personal-scope configs
	// belong solely to the user, so they're always "admin" of their own
	// setup; org-scope configs follow the org-admin role.
	const { isOrganizationAdmin } = useActiveOrganization();
	const isAdmin = scope === "user" ? true : isOrganizationAdmin;

	// State management
	const state = useMcpSettingsState();

	// Queries
	const { servers, isLoadingServers, configs, isLoadingConfigs } =
		useMcpQueries({
			scope,
			organizationId,
		});

	// Mutations
	const mutations = useMcpMutations({
		scope,
		organizationId,
		onConfigSaved: () => {
			state.setConfigDialogOpen(false);
			state.resetConfigForm();
			// Auto-redirect back to project setup if we came from there
			triggerReturn();
		},
		onServerSaved: (server, mode) => {
			state.setCustomServerDialogOpen(false);
			state.resetServerForm();
			if (mode === "create") {
				state.openAddConfigDialog(server);
			}
		},
	});

	// Actions
	const actions = useMcpActions({ scope, organizationId });

	// Check OAuth statuses when configs are loaded
	useEffect(() => {
		if (configs && configs.length > 0) {
			checkOAuthStatuses(configs as McpConfig[], organizationId).then(
				(statuses) => {
					state.setOAuthStatuses(statuses);
				},
			);
		}
	}, [configs]);

	// Fetch OAuth status when editing an OAuth config
	useEffect(() => {
		if (state.editingConfig?.authType === "OAUTH2") {
			const orgParam = organizationId
				? `?organizationId=${organizationId}`
				: "?organizationId=";
			fetch(`/api/mcp/oauth/status/${state.editingConfig.id}${orgParam}`)
				.then((resp) => resp.json())
				.then((result) => {
					if (result.data) {
						state.setCurrentConfigOAuthStatus(result.data);
					}
				})
				.catch((error) => {
					console.error("Failed to fetch OAuth status:", error);
				});
		} else {
			state.setCurrentConfigOAuthStatus(null);
		}
	}, [state.editingConfig]);

	// Handlers for server list
	const handleConfigureServer = useCallback(
		(server: McpServer) => {
			state.openAddConfigDialog(server);
		},
		[state],
	);

	const handleEditServer = useCallback(
		(server: McpServer) => {
			state.populateServerFormFromEdit(server);
		},
		[state],
	);

	const handleDeleteServer = useCallback(
		(server: McpServer) => {
			state.setServerToDelete(server);
			state.setDeleteServerDialogOpen(true);
		},
		[state],
	);

	// Handlers for config list
	const handleEditConfig = useCallback(
		(config: McpConfig) => {
			state.setEditingConfig(config);
		},
		[state],
	);

	const handleDeleteConfig = useCallback(
		(config: McpConfig) => {
			state.setConfigToDelete(config);
			state.setDeleteConfigDialogOpen(true);
		},
		[state],
	);

	const handleTestConfig = useCallback(
		async (config: McpConfig) => {
			state.setTestingConfigId(config.id);
			try {
				await actions.testHealthForConfig(config);
			} finally {
				state.setTestingConfigId(null);
			}
		},
		[state, actions],
	);

	const handleToggleEnabled = useCallback(
		(config: McpConfig, enabled: boolean) => {
			mutations.toggleEnabled.mutate({
				mcpServerId: config.mcpServerId,
				authType: config.authType,
				baseUrl: config.baseUrl || "",
				enabled,
			});
		},
		[mutations.toggleEnabled],
	);

	// Config dialog handlers
	const handleSaveConfig = useCallback(() => {
		const { configForm } = state;
		if (!configForm.selectedServer) {
			return;
		}

		mutations.upsertConfig.mutate({
			mcpServerId: configForm.selectedServer.id,
			displayName: configForm.displayName || undefined,
			baseUrl: configForm.baseUrl,
			authType: configForm.authType,
			apiKeyMethod: configForm.apiKeyMethod,
			apiKey: configForm.apiKey || undefined,
			oauthClientId: configForm.oauthClientId || undefined,
			oauthClientSecret: configForm.oauthClientSecret || undefined,
			scopes: configForm.scopes.trim()
				? configForm.scopes.trim().split(/\s+/)
				: [],
			enabled: configForm.enabled,
		});
	}, [state, mutations.upsertConfig]);

	const handleTestConnection = useCallback(async () => {
		const { configForm } = state;
		state.setIsTesting(true);
		try {
			await actions.testConnection({
				baseUrl: configForm.baseUrl,
				transport: configForm.selectedServer?.transport,
				authType: configForm.authType,
				apiKeyMethod: configForm.apiKeyMethod,
				apiKey: configForm.apiKey,
				oauthClientSecret: configForm.oauthClientSecret,
			});
		} finally {
			state.setIsTesting(false);
		}
	}, [state, actions]);

	const handleConnectOAuth = useCallback(async () => {
		const { configForm, editingConfig } = state;
		if (!configForm.selectedServer) {
			return;
		}

		state.setIsConnecting(true);
		await actions.startOAuthFlow(
			{
				mcpServerId: configForm.selectedServer.id,
				displayName: configForm.displayName,
				baseUrl: configForm.baseUrl,
				authType: configForm.authType,
				scopes: configForm.scopes.trim()
					? configForm.scopes.trim().split(/\s+/)
					: [],
				enabled: configForm.enabled,
				oauthClientId: configForm.oauthClientId,
				oauthClientSecret: configForm.oauthClientSecret,
			},
			{
				onSuccess: () => {
					state.setConfigDialogOpen(false);
				},
				onPopupClosed: () => {
					state.setIsConnecting(false);
				},
				editingConfigId: editingConfig?.id,
				setCurrentConfigOAuthStatus: state.setCurrentConfigOAuthStatus,
			},
		);
		state.setIsConnecting(false);
	}, [state, actions]);

	const handleRegisterDcr = useCallback(async () => {
		const { configForm, editingConfig } = state;
		if (!configForm.selectedServer || !editingConfig) {
			return;
		}

		state.setIsRegisteringDcr(true);
		try {
			const result = await mutations.registerDcr.mutateAsync({
				configId: editingConfig.id,
				redirectUri: `${window.location.origin}/api/mcp/oauth/callback`,
				scopes: configForm.scopes.trim()
					? configForm.scopes.trim().split(/\s+/)
					: [],
			});
			state.setDcrRegisteredAt(
				(result as any).registeredAt
					? String((result as any).registeredAt)
					: new Date().toISOString(),
			);
		} finally {
			state.setIsRegisteringDcr(false);
		}
	}, [state, mutations.registerDcr]);

	const handleUnregisterDcr = useCallback(async () => {
		const { editingConfig } = state;
		if (!editingConfig) {
			return;
		}

		state.setIsRegisteringDcr(true);
		try {
			await mutations.unregisterDcr.mutateAsync(editingConfig.id);
			state.setDcrRegisteredAt(null);
		} finally {
			state.setIsRegisteringDcr(false);
		}
	}, [state, mutations.unregisterDcr]);

	// Server dialog handlers
	const handleSaveServer = useCallback(() => {
		const { serverForm, editingServer } = state;

		const payload = {
			name: serverForm.name,
			description: serverForm.description || null,
			defaultUrl: serverForm.defaultUrl,
			docsUrl: serverForm.docsUrl || null,
			transport: serverForm.transport,
			authMethods: [serverForm.authType],
			apiKeyMethod:
				serverForm.authType === "API_KEY"
					? serverForm.apiKeyMethod
					: null,
			oauthDiscoveryUrl:
				!serverForm.autoDiscoverOAuth && serverForm.discoveryUrl
					? serverForm.discoveryUrl
					: null,
			dcrRegistrationEndpoint:
				!serverForm.autoDiscoverOAuth &&
				serverForm.dcrRegistrationEndpoint
					? serverForm.dcrRegistrationEndpoint
					: null,
		};

		if (editingServer) {
			mutations.updateServer.mutate({ id: editingServer.id, ...payload });
		} else {
			mutations.createServer.mutate(payload);
		}
	}, [state, mutations.createServer, mutations.updateServer]);

	const handleDiscoverEndpoints = useCallback(async () => {
		const { serverForm } = state;
		state.setIsDiscoveringEndpoints(true);
		const result = await actions.discoverOAuthEndpoints(
			serverForm.discoveryUrl,
		);
		if (result?.registrationEndpoint) {
			state.setCDcrRegistrationEndpoint(result.registrationEndpoint);
		}
		state.setIsDiscoveringEndpoints(false);
	}, [state, actions]);

	// Delete confirmation handlers
	const handleConfirmDeleteConfig = useCallback(() => {
		const { deleteState } = state;
		if (deleteState.configToDelete) {
			mutations.deleteConfig.mutate(deleteState.configToDelete.id);
			state.setDeleteConfigDialogOpen(false);
			state.setConfigToDelete(null);
		}
	}, [state, mutations.deleteConfig]);

	const handleConfirmDeleteServer = useCallback(() => {
		const { deleteState } = state;
		if (deleteState.serverToDelete) {
			mutations.deleteServer.mutate(deleteState.serverToDelete.id);
			state.setDeleteServerDialogOpen(false);
			state.setServerToDelete(null);
		}
	}, [state, mutations.deleteServer]);

	return (
		<div className="space-y-8">
			{/* Optional Hero Section */}
			{showHero}

			{/* Add Custom Server Button */}
			<div className="flex items-center justify-between">
				<div />
				<Button
					size="sm"
					variant="secondary"
					disabled={isRegistryDisabled}
					onClick={() => state.setCustomServerDialogOpen(true)}
				>
					<PlusIcon className="mr-1 size-4" /> Add Custom MCP Server
				</Button>
			</div>

			{/* Server List */}
			<McpServerList
				servers={servers as McpServer[]}
				searchQuery={state.registrySearchQuery}
				onSearchChange={state.setRegistrySearchQuery}
				isLoading={isLoadingServers}
				disabled={isRegistryDisabled}
				onConfigure={handleConfigureServer}
				onEdit={handleEditServer}
				onDelete={handleDeleteServer}
				title={serverListTitle}
				description={serverListDescription}
			/>

			{/* Config List */}
			<McpConfigList
				configs={configs as McpConfig[]}
				oauthStatuses={state.oauthStatuses}
				isLoading={isLoadingConfigs}
				disabled={disabled}
				testingConfigId={state.loadingState.testingConfigId}
				isAdmin={isAdmin}
				onEdit={handleEditConfig}
				onDelete={handleDeleteConfig}
				onTest={handleTestConfig}
				onToggleEnabled={handleToggleEnabled}
				title={configListTitle}
				description={configListDescription}
			/>

			{/* Config Dialog */}
			<McpConfigDialog
				open={state.dialogState.configDialogOpen}
				onOpenChange={state.setConfigDialogOpen}
				form={state.configForm}
				editingConfig={state.editingConfig}
				currentOAuthStatus={state.currentConfigOAuthStatus}
				isLoading={mutations.upsertConfig.isPending}
				isTesting={state.loadingState.isTesting}
				isConnecting={state.loadingState.isConnecting}
				isRegisteringDcr={state.loadingState.isRegisteringDcr}
				disabled={disabled}
				onDisplayNameChange={state.setDisplayName}
				onBaseUrlChange={state.setBaseUrl}
				onApiKeyMethodChange={state.setApiKeyMethod}
				onApiKeyChange={state.setApiKey}
				onShowApiKeyToggle={() =>
					state.setShowApiKey(!state.configForm.showApiKey)
				}
				onEnabledChange={state.setEnabled}
				onOauthClientIdChange={state.setOauthClientId}
				onOauthClientSecretChange={state.setOauthClientSecret}
				onShowOAuthSecretToggle={() =>
					state.setShowOAuthSecret(!state.configForm.showOAuthSecret)
				}
				onScopesChange={state.setScopes}
				onUseDcrChange={state.setUseDcr}
				onTestConnection={handleTestConnection}
				onSave={handleSaveConfig}
				onConnectOAuth={handleConnectOAuth}
				onRegisterDcr={handleRegisterDcr}
				onUnregisterDcr={handleUnregisterDcr}
			/>

			{/* Server Dialog */}
			<McpServerDialog
				open={state.dialogState.customServerDialogOpen}
				onOpenChange={state.setCustomServerDialogOpen}
				form={state.serverForm}
				editingServer={state.editingServer}
				isLoading={
					mutations.createServer.isPending ||
					mutations.updateServer.isPending
				}
				isDiscovering={state.loadingState.isDiscoveringEndpoints}
				disabled={isRegistryDisabled}
				onNameChange={state.setCName}
				onDescriptionChange={state.setCDescription}
				onDefaultUrlChange={state.setCDefaultUrl}
				onDocsUrlChange={state.setCDocsUrl}
				onTransportChange={state.setCTransport}
				onAuthTypeChange={state.setCAuthType}
				onApiKeyMethodChange={state.setCApiKeyMethod}
				onAutoDiscoverOAuthChange={state.setCAutoDiscoverOAuth}
				onDiscoveryUrlChange={state.setCDiscoveryUrl}
				onDcrRegistrationEndpointChange={
					state.setCDcrRegistrationEndpoint
				}
				onDiscoverEndpoints={handleDiscoverEndpoints}
				onSave={handleSaveServer}
			/>

			{/* Delete Dialogs */}
			<McpDeleteConfigDialog
				open={state.dialogState.deleteConfigDialogOpen}
				onOpenChange={state.setDeleteConfigDialogOpen}
				config={state.deleteState.configToDelete}
				onConfirm={handleConfirmDeleteConfig}
			/>
			<McpDeleteServerDialog
				open={state.dialogState.deleteServerDialogOpen}
				onOpenChange={state.setDeleteServerDialogOpen}
				server={state.deleteState.serverToDelete}
				onConfirm={handleConfirmDeleteServer}
			/>
		</div>
	);
}
