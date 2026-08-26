/**
 * MCP Settings State Hook
 *
 * Manages all state for MCP settings forms.
 */

import { useCallback, useEffect, useState } from "react";
import type {
	ApiKeyMethod,
	AuthType,
	McpConfig,
	McpConfigFormState,
	McpDeleteState,
	McpDialogState,
	McpLoadingState,
	McpServer,
	McpServerFormState,
	OAuthStatus,
	Transport,
} from "../types";
import { getDefaultAuthTypeFromServer } from "../types";

export interface UseMcpSettingsStateReturn {
	// Dialog states
	dialogState: McpDialogState;
	setConfigDialogOpen: (open: boolean) => void;
	setCustomServerDialogOpen: (open: boolean) => void;
	setDeleteConfigDialogOpen: (open: boolean) => void;
	setDeleteServerDialogOpen: (open: boolean) => void;

	// Config form state
	configForm: McpConfigFormState;
	setSelectedServer: (server: McpServer | null) => void;
	setDisplayName: (name: string) => void;
	setBaseUrl: (url: string) => void;
	setAuthType: (type: AuthType) => void;
	setApiKeyMethod: (method: ApiKeyMethod) => void;
	setApiKey: (key: string) => void;
	setShowApiKey: (show: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	setOauthClientId: (id: string) => void;
	setOauthClientSecret: (secret: string) => void;
	setShowOAuthSecret: (show: boolean) => void;
	setScopes: (scopes: string) => void;
	setUseDcr: (useDcr: boolean) => void;
	setDcrRegisteredAt: (date: string | null) => void;

	// Server form state
	serverForm: McpServerFormState;
	setCName: (name: string) => void;
	setCDescription: (desc: string) => void;
	setCDefaultUrl: (url: string) => void;
	setCDocsUrl: (url: string) => void;
	setCTransport: (transport: Transport) => void;
	setCAuthType: (type: AuthType) => void;
	setCApiKeyMethod: (method: ApiKeyMethod) => void;
	setCAutoDiscoverOAuth: (auto: boolean) => void;
	setCDiscoveryUrl: (url: string) => void;
	setCDcrRegistrationEndpoint: (endpoint: string) => void;

	// Delete state
	deleteState: McpDeleteState;
	setConfigToDelete: (config: McpConfig | null) => void;
	setServerToDelete: (server: McpServer | null) => void;

	// Loading states
	loadingState: McpLoadingState;
	setIsTesting: (testing: boolean) => void;
	setTestingConfigId: (configId: string | null) => void;
	setIsConnecting: (connecting: boolean) => void;
	setIsRegisteringDcr: (registering: boolean) => void;
	setIsDiscoveringEndpoints: (discovering: boolean) => void;

	// OAuth status
	oauthStatuses: Record<string, OAuthStatus>;
	setOAuthStatuses: (statuses: Record<string, OAuthStatus>) => void;
	currentConfigOAuthStatus: OAuthStatus | null;
	setCurrentConfigOAuthStatus: (status: OAuthStatus | null) => void;

	// Editing state
	editingConfig: McpConfig | null;
	setEditingConfig: (config: McpConfig | null) => void;
	editingServer: McpServer | null;
	setEditingServer: (server: McpServer | null) => void;

	// Search and view
	registrySearchQuery: string;
	setRegistrySearchQuery: (query: string) => void;
	viewMode: "grid" | "list";
	setViewMode: (mode: "grid" | "list") => void;

	// Actions
	resetConfigForm: () => void;
	resetServerForm: () => void;
	openAddConfigDialog: (server: McpServer) => void;
	populateConfigFormFromEdit: (config: McpConfig) => void;
	populateServerFormFromEdit: (server: McpServer) => void;
}

export function useMcpSettingsState(): UseMcpSettingsStateReturn {
	// Dialog states
	const [dialogState, setDialogState] = useState<McpDialogState>({
		configDialogOpen: false,
		customServerDialogOpen: false,
		deleteConfigDialogOpen: false,
		deleteServerDialogOpen: false,
	});

	// Config form state
	const [configForm, setConfigForm] = useState<McpConfigFormState>({
		selectedServer: null,
		displayName: "",
		baseUrl: "",
		authType: "NONE",
		apiKeyMethod: "BEARER",
		apiKey: "",
		showApiKey: false,
		enabled: true,
		oauthClientId: "",
		oauthClientSecret: "",
		showOAuthSecret: false,
		scopes: "",
		useDcr: false,
		dcrRegisteredAt: null,
	});

	// Server form state
	const [serverForm, setServerForm] = useState<McpServerFormState>({
		name: "",
		description: "",
		defaultUrl: "",
		docsUrl: "",
		transport: "HTTP",
		authType: "NONE",
		apiKeyMethod: "BEARER",
		autoDiscoverOAuth: true,
		discoveryUrl: "",
		dcrRegistrationEndpoint: "",
	});

	// Delete state
	const [deleteState, setDeleteState] = useState<McpDeleteState>({
		configToDelete: null,
		serverToDelete: null,
	});

	// Loading states
	const [loadingState, setLoadingState] = useState<McpLoadingState>({
		isTesting: false,
		testingConfigId: null,
		isConnecting: false,
		isRegisteringDcr: false,
		isDiscoveringEndpoints: false,
	});

	// OAuth status tracking
	const [oauthStatuses, setOAuthStatuses] = useState<
		Record<string, OAuthStatus>
	>({});
	const [currentConfigOAuthStatus, setCurrentConfigOAuthStatus] =
		useState<OAuthStatus | null>(null);

	// Editing state
	const [editingConfig, setEditingConfig] = useState<McpConfig | null>(null);
	const [editingServer, setEditingServer] = useState<McpServer | null>(null);

	// Search and view
	const [registrySearchQuery, setRegistrySearchQuery] = useState("");
	const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

	// Auto-detect transport for custom servers based on default URL
	useEffect(() => {
		if (!serverForm.defaultUrl) {
			return;
		}
		const lower = serverForm.defaultUrl.trim().toLowerCase();
		if (lower.endsWith("/mcp")) {
			setServerForm((prev) => ({ ...prev, transport: "HTTP" }));
		} else if (lower.endsWith("/sse")) {
			setServerForm((prev) => ({ ...prev, transport: "SSE" }));
		}
	}, [serverForm.defaultUrl]);

	// Populate form when editing a custom server
	useEffect(() => {
		if (editingServer) {
			setServerForm({
				name: editingServer.name || "",
				description: editingServer.description || "",
				defaultUrl: editingServer.defaultUrl || "",
				docsUrl: editingServer.docsUrl || "",
				transport: editingServer.transport || "HTTP",
				authType: editingServer.authMethods?.[0] || "NONE",
				apiKeyMethod: editingServer.apiKeyMethod || "BEARER",
				autoDiscoverOAuth:
					!editingServer.oauthDiscoveryUrl &&
					!editingServer.dcrRegistrationEndpoint,
				discoveryUrl: editingServer.oauthDiscoveryUrl || "",
				dcrRegistrationEndpoint:
					editingServer.dcrRegistrationEndpoint || "",
			});
			setDialogState((prev) => ({
				...prev,
				customServerDialogOpen: true,
			}));
		}
	}, [editingServer]);

	// Populate form when editing a config
	useEffect(() => {
		if (editingConfig) {
			populateConfigFormFromEdit(editingConfig);
		}
	}, [editingConfig]);

	// Dialog setters
	const setConfigDialogOpen = useCallback((open: boolean) => {
		setDialogState((prev) => ({ ...prev, configDialogOpen: open }));
	}, []);

	const setCustomServerDialogOpen = useCallback((open: boolean) => {
		setDialogState((prev) => ({ ...prev, customServerDialogOpen: open }));
		if (!open) {
			setEditingServer(null);
		}
	}, []);

	const setDeleteConfigDialogOpen = useCallback((open: boolean) => {
		setDialogState((prev) => ({ ...prev, deleteConfigDialogOpen: open }));
	}, []);

	const setDeleteServerDialogOpen = useCallback((open: boolean) => {
		setDialogState((prev) => ({ ...prev, deleteServerDialogOpen: open }));
	}, []);

	// Config form setters
	const setSelectedServer = useCallback((server: McpServer | null) => {
		setConfigForm((prev) => ({ ...prev, selectedServer: server }));
	}, []);

	const setDisplayName = useCallback((name: string) => {
		setConfigForm((prev) => ({ ...prev, displayName: name }));
	}, []);

	const setBaseUrl = useCallback((url: string) => {
		setConfigForm((prev) => ({ ...prev, baseUrl: url }));
	}, []);

	const setAuthType = useCallback((type: AuthType) => {
		setConfigForm((prev) => ({ ...prev, authType: type }));
	}, []);

	const setApiKeyMethod = useCallback((method: ApiKeyMethod) => {
		setConfigForm((prev) => ({ ...prev, apiKeyMethod: method }));
	}, []);

	const setApiKey = useCallback((key: string) => {
		setConfigForm((prev) => ({ ...prev, apiKey: key }));
	}, []);

	const setShowApiKey = useCallback((show: boolean) => {
		setConfigForm((prev) => ({ ...prev, showApiKey: show }));
	}, []);

	const setEnabled = useCallback((enabled: boolean) => {
		setConfigForm((prev) => ({ ...prev, enabled }));
	}, []);

	const setOauthClientId = useCallback((id: string) => {
		setConfigForm((prev) => ({ ...prev, oauthClientId: id }));
	}, []);

	const setOauthClientSecret = useCallback((secret: string) => {
		setConfigForm((prev) => ({ ...prev, oauthClientSecret: secret }));
	}, []);

	const setShowOAuthSecret = useCallback((show: boolean) => {
		setConfigForm((prev) => ({ ...prev, showOAuthSecret: show }));
	}, []);

	const setScopes = useCallback((scopes: string) => {
		setConfigForm((prev) => ({ ...prev, scopes }));
	}, []);

	const setUseDcr = useCallback((useDcr: boolean) => {
		setConfigForm((prev) => ({ ...prev, useDcr }));
	}, []);

	const setDcrRegisteredAt = useCallback((date: string | null) => {
		setConfigForm((prev) => ({ ...prev, dcrRegisteredAt: date }));
	}, []);

	// Server form setters
	const setCName = useCallback((name: string) => {
		setServerForm((prev) => ({ ...prev, name }));
	}, []);

	const setCDescription = useCallback((desc: string) => {
		setServerForm((prev) => ({ ...prev, description: desc }));
	}, []);

	const setCDefaultUrl = useCallback((url: string) => {
		setServerForm((prev) => ({ ...prev, defaultUrl: url }));
	}, []);

	const setCDocsUrl = useCallback((url: string) => {
		setServerForm((prev) => ({ ...prev, docsUrl: url }));
	}, []);

	const setCTransport = useCallback((transport: Transport) => {
		setServerForm((prev) => ({ ...prev, transport }));
	}, []);

	const setCAuthType = useCallback((type: AuthType) => {
		setServerForm((prev) => ({ ...prev, authType: type }));
	}, []);

	const setCApiKeyMethod = useCallback((method: ApiKeyMethod) => {
		setServerForm((prev) => ({ ...prev, apiKeyMethod: method }));
	}, []);

	const setCAutoDiscoverOAuth = useCallback((auto: boolean) => {
		setServerForm((prev) => ({ ...prev, autoDiscoverOAuth: auto }));
	}, []);

	const setCDiscoveryUrl = useCallback((url: string) => {
		setServerForm((prev) => ({ ...prev, discoveryUrl: url }));
	}, []);

	const setCDcrRegistrationEndpoint = useCallback((endpoint: string) => {
		setServerForm((prev) => ({
			...prev,
			dcrRegistrationEndpoint: endpoint,
		}));
	}, []);

	// Delete state setters
	const setConfigToDelete = useCallback((config: McpConfig | null) => {
		setDeleteState((prev) => ({ ...prev, configToDelete: config }));
	}, []);

	const setServerToDelete = useCallback((server: McpServer | null) => {
		setDeleteState((prev) => ({ ...prev, serverToDelete: server }));
	}, []);

	// Loading state setters
	const setIsTesting = useCallback((testing: boolean) => {
		setLoadingState((prev) => ({ ...prev, isTesting: testing }));
	}, []);

	const setTestingConfigId = useCallback((configId: string | null) => {
		setLoadingState((prev) => ({ ...prev, testingConfigId: configId }));
	}, []);

	const setIsConnecting = useCallback((connecting: boolean) => {
		setLoadingState((prev) => ({ ...prev, isConnecting: connecting }));
	}, []);

	const setIsRegisteringDcr = useCallback((registering: boolean) => {
		setLoadingState((prev) => ({ ...prev, isRegisteringDcr: registering }));
	}, []);

	const setIsDiscoveringEndpoints = useCallback((discovering: boolean) => {
		setLoadingState((prev) => ({
			...prev,
			isDiscoveringEndpoints: discovering,
		}));
	}, []);

	// Reset functions
	const resetConfigForm = useCallback(() => {
		setConfigForm({
			selectedServer: null,
			displayName: "",
			baseUrl: "",
			authType: "NONE",
			apiKeyMethod: "BEARER",
			apiKey: "",
			showApiKey: false,
			enabled: true,
			oauthClientId: "",
			oauthClientSecret: "",
			showOAuthSecret: false,
			scopes: "",
			useDcr: false,
			dcrRegisteredAt: null,
		});
		setEditingConfig(null);
		setCurrentConfigOAuthStatus(null);
	}, []);

	const resetServerForm = useCallback(() => {
		setServerForm({
			name: "",
			description: "",
			defaultUrl: "",
			docsUrl: "",
			transport: "HTTP",
			authType: "NONE",
			apiKeyMethod: "BEARER",
			autoDiscoverOAuth: true,
			discoveryUrl: "",
			dcrRegistrationEndpoint: "",
		});
		setEditingServer(null);
	}, []);

	// Open add dialog with server preselected
	const openAddConfigDialog = useCallback((server: McpServer) => {
		setConfigForm({
			selectedServer: server,
			displayName: "",
			baseUrl: server.defaultUrl ?? "",
			authType: getDefaultAuthTypeFromServer(server),
			apiKeyMethod: server.apiKeyMethod ?? "BEARER",
			apiKey: "",
			showApiKey: false,
			enabled: true,
			oauthClientId: "",
			oauthClientSecret: "",
			showOAuthSecret: false,
			scopes: "",
			useDcr: !!server.dcrRegistrationEndpoint,
			dcrRegisteredAt: null,
		});
		setEditingConfig(null);
		setCurrentConfigOAuthStatus(null);
		setDialogState((prev) => ({ ...prev, configDialogOpen: true }));
	}, []);

	// Populate config form from existing config
	const populateConfigFormFromEdit = useCallback((config: McpConfig) => {
		const serverDefaultAuth = getDefaultAuthTypeFromServer(
			config.mcpServer as McpServer,
		);
		setConfigForm({
			selectedServer: config.mcpServer as McpServer,
			displayName: config.displayName ?? "",
			baseUrl: config.baseUrl ?? "",
			authType: config.authType ?? serverDefaultAuth ?? "NONE",
			apiKeyMethod:
				config.apiKeyMethod ??
				config.mcpServer?.apiKeyMethod ??
				"BEARER",
			apiKey: config.encryptedApiKey ? "••••••••••••••••" : "",
			showApiKey: false,
			enabled: !!config.enabled,
			oauthClientId: config.oauthClientId ?? "",
			oauthClientSecret: config.encryptedOauthClientSecret
				? "••••••••••••••••"
				: "",
			showOAuthSecret: false,
			scopes: Array.isArray(config.scopes) ? config.scopes.join(" ") : "",
			useDcr:
				!!config.dcrRegistrationEndpoint ||
				!!config.dcrClientMetadata ||
				!!config.dcrRegisteredAt ||
				!!config.mcpServer?.dcrRegistrationEndpoint,
			dcrRegisteredAt: config.dcrRegisteredAt
				? String(config.dcrRegisteredAt)
				: null,
		});
		setLoadingState((prev) => ({ ...prev, isRegisteringDcr: false }));
		setDialogState((prev) => ({ ...prev, configDialogOpen: true }));
	}, []);

	// Populate server form from existing server
	const populateServerFormFromEdit = useCallback((server: McpServer) => {
		setServerForm({
			name: server.name || "",
			description: server.description || "",
			defaultUrl: server.defaultUrl || "",
			docsUrl: server.docsUrl || "",
			transport: server.transport || "HTTP",
			authType: server.authMethods?.[0] || "NONE",
			apiKeyMethod: server.apiKeyMethod || "BEARER",
			autoDiscoverOAuth:
				!server.oauthDiscoveryUrl && !server.dcrRegistrationEndpoint,
			discoveryUrl: server.oauthDiscoveryUrl || "",
			dcrRegistrationEndpoint: server.dcrRegistrationEndpoint || "",
		});
		setEditingServer(server);
	}, []);

	return {
		// Dialog states
		dialogState,
		setConfigDialogOpen,
		setCustomServerDialogOpen,
		setDeleteConfigDialogOpen,
		setDeleteServerDialogOpen,

		// Config form
		configForm,
		setSelectedServer,
		setDisplayName,
		setBaseUrl,
		setAuthType,
		setApiKeyMethod,
		setApiKey,
		setShowApiKey,
		setEnabled,
		setOauthClientId,
		setOauthClientSecret,
		setShowOAuthSecret,
		setScopes,
		setUseDcr,
		setDcrRegisteredAt,

		// Server form
		serverForm,
		setCName,
		setCDescription,
		setCDefaultUrl,
		setCDocsUrl,
		setCTransport,
		setCAuthType,
		setCApiKeyMethod,
		setCAutoDiscoverOAuth,
		setCDiscoveryUrl,
		setCDcrRegistrationEndpoint,

		// Delete state
		deleteState,
		setConfigToDelete,
		setServerToDelete,

		// Loading states
		loadingState,
		setIsTesting,
		setTestingConfigId,
		setIsConnecting,
		setIsRegisteringDcr,
		setIsDiscoveringEndpoints,

		// OAuth status
		oauthStatuses,
		setOAuthStatuses,
		currentConfigOAuthStatus,
		setCurrentConfigOAuthStatus,

		// Editing state
		editingConfig,
		setEditingConfig,
		editingServer,
		setEditingServer,

		// Search and view
		registrySearchQuery,
		setRegistrySearchQuery,
		viewMode,
		setViewMode,

		// Actions
		resetConfigForm,
		resetServerForm,
		openAddConfigDialog,
		populateConfigFormFromEdit,
		populateServerFormFromEdit,
	};
}
