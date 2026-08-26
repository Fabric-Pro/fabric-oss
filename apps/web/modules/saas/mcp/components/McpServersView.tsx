"use client";

import { Spinner } from "@shared/components/Spinner";
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
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	AlertTriangleIcon,
	CheckCircleIcon,
	EyeIcon,
	EyeOffIcon,
	GridIcon,
	KeyIcon,
	ListIcon,
	LoaderIcon,
	PlusIcon,
	SearchIcon,
	TestTube2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { useMcpConnection } from "../hooks/useMcpConnection";
import { MCPServersHero } from "./MCPServersHero";
import { McpChatDialog } from "./McpChatDialog";
import { McpConfigTile } from "./McpConfigTile";
import { McpServerCard } from "./McpServerCard";
import { McpServerIcon } from "./McpServerIcon";
import { McpServersListView } from "./McpServersListView";

type ViewMode = "grid" | "list";

type McpServersViewProps = {
	organizationId?: string | null;
};

function getDefaultSemanticMetadata(server: {
	name?: string | null;
	description?: string | null;
}) {
	const description = server.description?.trim() || "";
	const normalized = (server.name || "").toLowerCase().replace(/[_\s-]/g, "");

	if (
		normalized.includes("teams") ||
		normalized.includes("microsoft") ||
		normalized.includes("graph")
	) {
		return {
			description:
				description ||
				"Microsoft Teams integration for channels, messages, chats, and shared files",
			domainKeywords: [
				"teams",
				"microsoft",
				"chat",
				"channel",
				"message",
				"meeting",
				"collaboration",
			],
			exampleQueries: [
				"list teams channels",
				"search teams messages",
				"get recent teams chat",
				"find shared files in teams",
			],
		};
	}

	if (normalized.includes("gitlab")) {
		return {
			description:
				description ||
				"GitLab integration for projects, issues, merge requests, and code management",
			domainKeywords: [
				"gitlab",
				"project",
				"repository",
				"repo",
				"issue",
				"mr",
				"merge request",
				"epic",
				"code",
				"commit",
			],
			exampleQueries: [
				"list gitlab issues",
				"create gitlab merge request",
				"get project info",
				"list merge requests",
			],
		};
	}

	if (normalized.includes("github") || normalized.includes("git")) {
		return {
			description:
				description ||
				"GitHub integration for repositories, issues, pull requests, and code management",
			domainKeywords: [
				"github",
				"repository",
				"repo",
				"issue",
				"pr",
				"pull request",
				"code",
				"commit",
			],
			exampleQueries: [
				"list github issues",
				"create github pr",
				"get repository info",
				"list pull requests",
			],
		};
	}

	if (normalized.includes("drive") || normalized.includes("google")) {
		return {
			description:
				description ||
				"Google Drive integration for files, folders, and document management",
			domainKeywords: [
				"drive",
				"google",
				"file",
				"folder",
				"document",
				"doc",
				"sheet",
			],
			exampleQueries: [
				"list drive files",
				"search google drive",
				"get document content",
				"list folders",
			],
		};
	}

	if (normalized.includes("slack")) {
		return {
			description:
				description ||
				"Slack integration for channels, messages, and workspace communication",
			domainKeywords: [
				"slack",
				"channel",
				"message",
				"workspace",
				"dm",
				"thread",
			],
			exampleQueries: [
				"list slack channels",
				"search slack messages",
				"get channel history",
				"send slack message",
			],
		};
	}

	if (normalized.includes("notion")) {
		return {
			description:
				description ||
				"Notion integration for pages, databases, and knowledge management",
			domainKeywords: [
				"notion",
				"page",
				"database",
				"wiki",
				"knowledge",
				"notes",
			],
			exampleQueries: [
				"list notion pages",
				"search notion database",
				"get page content",
				"query notion",
			],
		};
	}

	return {
		description,
		domainKeywords: [] as string[],
		exampleQueries: [] as string[],
	};
}

export function McpServersView({ organizationId }: McpServersViewProps = {}) {
	const qc = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [viewMode, setViewMode] = useState<ViewMode>("grid");
	const [editingConfig, setEditingConfig] = useState<any | null>(null);
	const [deletingConfig, setDeletingConfig] = useState<any | null>(null);
	const [openAddDialog, setOpenAddDialog] = useState(false);
	const [chatConfig, setChatConfig] = useState<any | null>(null);
	const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
	const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
	const [toolsCache, setToolsCache] = useState<
		Record<string, Array<{ name: string; description?: string }>>
	>({});
	const [selectedServer, setSelectedServer] = useState<any | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [commandArgs, setCommandArgs] = useState<string[]>([]); // For STDIO servers (e.g., org name)
	const [authType, setAuthType] = useState<"NONE" | "API_KEY" | "OAUTH2">(
		"NONE",
	);
	const [apiKey, setApiKey] = useState("");
	const [apiKeyMethod, setApiKeyMethod] = useState<
		"BEARER" | "HEADER" | "PLAIN"
	>("BEARER");
	const [showApiKey, setShowApiKey] = useState(false);
	const [enabled, setEnabled] = useState(true);
	const [isTesting, setIsTesting] = useState(false);
	const [description, setDescription] = useState("");
	const [domainKeywordsInput, setDomainKeywordsInput] = useState("");
	const [exampleQueriesInput, setExampleQueriesInput] = useState("");
	const [isConnectingOAuth, setIsConnectingOAuth] = useState(false);
	const [authOverride, setAuthOverride] = useState(false); // User manually overrode auth type

	// Custom server dialog state
	const [openCustom, setOpenCustom] = useState(false);
	const [cName, setCName] = useState("");
	const [cDescription, setCDescription] = useState("");
	const [cDefaultUrl, setCDefaultUrl] = useState("");
	const [cDocsUrl, setCDocsUrl] = useState("");
	const [cTransport, setCTransport] = useState<"SSE" | "HTTP">("HTTP");
	const [cAuthType, setCAuthType] = useState<"NONE" | "API_KEY" | "OAUTH2">(
		"NONE",
	);
	const [cApiKeyMethod, setCApiKeyMethod] = useState<
		"BEARER" | "HEADER" | "PLAIN"
	>("BEARER");
	const [cApiKey, setCApiKey] = useState("");
	const [cShowApiKey, setCShowApiKey] = useState(false);
	const [cEnabled, setCEnabled] = useState(true);

	// Registry selection dialog state
	const [openRegistryDialog, setOpenRegistryDialog] = useState(false);
	const [registrySearchQuery, setRegistrySearchQuery] = useState("");
	const [debouncedRegistrySearch] = useDebounceValue(
		registrySearchQuery,
		300,
	);
	const [registryViewMode, setRegistryViewMode] = useState<ViewMode>("grid");
	// Transport filter state (multi-select checkboxes)
	const [transportFilters, setTransportFilters] = useState<
		Record<string, boolean>
	>({
		HTTP: true,
		SSE: true,
		STDIO: true,
	});

	// Use shared connection hook
	const {
		oauthStatuses,
		checkOAuthStatuses,
		testMutation,
		handleConnect,
		refreshMutation,
		revokeMutation,
		toggleMutation,
		refreshToolsMutation,
		loadingStates,
	} = useMcpConnection();

	// Fetch configs
	const { data: configs = [], isLoading } = useQuery({
		queryKey: ["mcp-configs", { organizationId: organizationId ?? "user" }],
		queryFn: async () => {
			const result = await orpcClient.mcp.configs.list({
				organizationId,
			});
			return result;
		},
	});

	// Fetch servers for add dialog — staleTime prevents re-fetching on every dialog open
	// since registry servers change infrequently (seeded data)
	const { data: servers = [] } = useQuery({
		queryKey: [
			"mcp-servers",
			{
				organizationId: organizationId ?? "user",
				includeAll: debouncedRegistrySearch.length > 0,
			},
		],
		queryFn: async () => {
			const result = await orpcClient.mcp.registry.list({
				organizationId,
				includeAll: debouncedRegistrySearch.length > 0,
			});
			return result;
		},
		staleTime: 5 * 60 * 1000, // 5 minutes — registry data rarely changes
		gcTime: 10 * 60 * 1000, // keep in cache for 10 minutes
	});

	// Check OAuth statuses when configs load
	// checkOAuthStatuses is memoized in the hook, so it's safe to include in deps
	useEffect(() => {
		if (configs && configs.length > 0) {
			checkOAuthStatuses(configs);
		}
	}, [configs, checkOAuthStatuses]);

	// Load tool counts for enabled configs using oRPC (same as workflow editor)
	const loadToolsForConfig = useCallback(
		async (configId: string) => {
			try {
				console.log("[MCP Tools] Loading tools for config:", configId);
				const result = await orpcClient.mcp.tools.list({
					serverIds: [configId],
					organizationId,
				});

				// Check for errors in the response
				if (result.errors && result.errors.length > 0) {
					const errorMsgs: string[] = [];
					for (const err of result.errors) {
						const msg = err.error || "Unknown error";
						console.warn(
							"[MCP Tools] Error for",
							err.serverName || err.serverId,
							":",
							msg,
						);
						errorMsgs.push(msg);
					}

					// If there are errors and no tools returned, track the error
					// and don't cache toolCounts so it can retry
					const tools = (result.tools || []).map((t: any) => ({
						name: t.name,
						description: t.description || "",
					}));

					if (tools.length === 0) {
						setToolErrors((prev) => ({
							...prev,
							[configId]: errorMsgs.join("; "),
						}));
						// Don't set toolCounts — allows retry on next render
						return;
					}

					// Had errors but also got some tools — show them but clear errors
					setToolErrors((prev) => {
						const next = { ...prev };
						delete next[configId];
						return next;
					});
					setToolCounts((prev) => ({
						...prev,
						[configId]: tools.length,
					}));
					setToolsCache((prev) => ({ ...prev, [configId]: tools }));
					return;
				}

				const tools = (result.tools || []).map((t: any) => ({
					name: t.name,
					description: t.description || "",
				}));

				console.log(
					"[MCP Tools] Loaded",
					tools.length,
					"tools for",
					configId,
				);
				// Clear any previous errors
				setToolErrors((prev) => {
					const next = { ...prev };
					delete next[configId];
					return next;
				});
				setToolCounts((prev) => ({
					...prev,
					[configId]: tools.length,
				}));
				setToolsCache((prev) => ({ ...prev, [configId]: tools }));
			} catch (error) {
				console.error(
					"[MCP Tools] Exception loading tools for",
					configId,
					":",
					error,
				);
				const errorMsg =
					error instanceof Error ? error.message : String(error);
				setToolErrors((prev) => ({ ...prev, [configId]: errorMsg }));
				// Don't set toolCounts — allows retry on next render
			}
		},
		[organizationId],
	);

	// Initial load of tool counts — fetch all eligible configs in PARALLEL.
	// Previously this awaited one config at a time, so on a slow connection it
	// cost one full round-trip per server back-to-back (N servers ≈ N×latency).
	useEffect(() => {
		const loadAllToolCounts = async () => {
			const eligibleConfigs = configs.filter((config: any) => {
				if (!config.enabled) {
					return false;
				}
				// Skip if already cached
				if (toolCounts[config.id] !== undefined) {
					return false;
				}
				// Skip servers that are marked unavailable
				if (config.status === "UNAVAILABLE") {
					return false;
				}
				// Skip OAuth servers that aren't authenticated yet
				if (config.authType === "OAUTH2") {
					const status = oauthStatuses[config.id];
					if (!status?.authenticated || status.tokenExpired) {
						return false;
					}
				}
				return true;
			});

			await Promise.all(
				eligibleConfigs.map((config: any) =>
					loadToolsForConfig(config.id),
				),
			);
		};

		if (configs && configs.length > 0) {
			loadAllToolCounts();
		}
	}, [configs, loadToolsForConfig, oauthStatuses]); // Added oauthStatuses to deps

	// Handle opening chat dialog
	const handleChat = (config: any) => {
		setChatConfig(config);
	};

	// Refresh tools after successful test
	const handleTestWithToolRefresh = useCallback(
		(config: any) => {
			testMutation.mutate(config, {
				onSuccess: () => {
					// Refresh tool count after successful test
					loadToolsForConfig(config.id);
				},
			});
		},
		[testMutation, loadToolsForConfig],
	);

	// GitLab fast-path: if the user already has a WorkflowIntegration row
	// (PM-side connect), we can populate the missing MCPConfig without a
	// second OAuth dance. See gitlab-oauth-unification spec §5.
	async function tryGitLabReconcile(): Promise<boolean> {
		try {
			const state = await orpcClient.integrations.gitlab.connectionState({
				organizationId: organizationId ?? null,
			});
			if (state.hasWorkflowIntegration && !state.hasMcpConfig) {
				const result = await orpcClient.integrations.gitlab.reconcile({
					organizationId: organizationId ?? null,
				});
				if (result.status === "RECONCILED") {
					toast.success("GitLab enabled for agents", {
						description:
							"Reused your existing GitLab connection — no second OAuth needed.",
					});
					await qc.invalidateQueries({
						queryKey: ["mcp", "registry"],
					});
					await qc.invalidateQueries({
						queryKey: ["mcp", "configs"],
					});
					return true;
				}
				if (result.status === "NEEDS_REAUTH") {
					toast.error("GitLab token needs re-authorization", {
						description:
							"Your existing GitLab connection is no longer valid. Reconnect to continue.",
					});
					// Fall through to normal install dialog so user can re-OAuth
					return false;
				}
			}
		} catch (err) {
			console.warn("[GitLab reconcile] failed; falling through", err);
		}
		return false;
	}

	// Handle installing a server from the registry dialog
	const handleRegistryInstall = async (s: any) => {
		if (s.key === "gitlab") {
			const reconciled = await tryGitLabReconcile();
			if (reconciled) {
				setOpenRegistryDialog(false);
				return;
			}
		}

		const semanticDefaults = getDefaultSemanticMetadata(s);
		if (s.transport === "STDIO" && !s.command) {
			toast.info("This server requires local setup", {
				description:
					"STDIO servers run via command line and cannot be configured from the web UI. Use Claude Desktop or view the docs.",
			});
			if (s.docsUrl || s.repositoryUrl) {
				window.open(
					s.docsUrl || s.repositoryUrl,
					"_blank",
					"noopener,noreferrer",
				);
			}
			return;
		}
		setSelectedServer(s);
		setDisplayName("");
		setBaseUrl(s.defaultUrl ?? "");
		setCommandArgs([]);
		setAuthType(getDefaultAuthTypeFromServer(s));
		setAuthOverride(false);
		setApiKey("");
		setApiKeyMethod(s.apiKeyMethod || "BEARER");
		setShowApiKey(false);
		setEnabled(true);
		setDescription(semanticDefaults.description);
		setDomainKeywordsInput(semanticDefaults.domainKeywords.join(", "));
		setExampleQueriesInput(semanticDefaults.exampleQueries.join(", "));
		setEditingConfig(null);
		setIsTesting(false);
		setOpenRegistryDialog(false);
		setOpenAddDialog(true);
	};

	// Reset registry dialog state when dialog closes
	useEffect(() => {
		if (!openRegistryDialog) {
			setRegistrySearchQuery("");
			// Reset filters to default (show all)
			setTransportFilters({
				HTTP: true,
				SSE: true,
				STDIO: true,
			});
		}
	}, [openRegistryDialog]);

	// Filter and sort configs by name
	const filteredConfigs = configs
		.filter((c: any) => {
			if (!debouncedSearch) {
				return true;
			}
			const searchLower = debouncedSearch.toLowerCase();
			const displayName = c.displayName || c.mcpServer?.name || "";
			const serverName = c.mcpServer?.name || "";
			const baseUrl = c.baseUrl || c.mcpServer?.defaultUrl || "";
			return (
				displayName.toLowerCase().includes(searchLower) ||
				serverName.toLowerCase().includes(searchLower) ||
				baseUrl.toLowerCase().includes(searchLower)
			);
		})
		.sort((a: any, b: any) => {
			const nameA = (
				a.displayName ||
				a.mcpServer?.name ||
				""
			).toLowerCase();
			const nameB = (
				b.displayName ||
				b.mcpServer?.name ||
				""
			).toLowerCase();
			return nameA.localeCompare(nameB);
		});

	// Filter and sort registry servers by search, transport type, and name
	const filteredRegistryServers = servers
		.filter((s: any) => {
			// Managed-default servers (Excalidraw and any future server with
			// `defaultEnabled = true`) are auto-installed for every tenant.
			// Hide them from the "Available MCP Servers" library so users
			// don't see an "Add" entry for something that's already on —
			// the existing managed config in the "Your MCP Configurations"
			// section carries the "Always on" pill that signals state.
			if (s.defaultEnabled) {
				return false;
			}

			// First filter by transport type
			const transport = s.transport || "HTTP";
			const anyFilterActive =
				Object.values(transportFilters).some(Boolean);
			if (anyFilterActive && !transportFilters[transport]) {
				return false;
			}

			// Then filter by search query
			if (!debouncedRegistrySearch) {
				return true;
			}
			const searchLower = debouncedRegistrySearch.toLowerCase();
			const name = s.name || "";
			const key = s.key || "";
			const description = s.description || "";
			const defaultUrl = s.defaultUrl || "";
			const command = s.command || "";
			return (
				name.toLowerCase().includes(searchLower) ||
				key.toLowerCase().includes(searchLower) ||
				description.toLowerCase().includes(searchLower) ||
				defaultUrl.toLowerCase().includes(searchLower) ||
				command.toLowerCase().includes(searchLower)
			);
		})
		.sort((a: any, b: any) => {
			const nameA = (a.name || "").toLowerCase();
			const nameB = (b.name || "").toLowerCase();
			return nameA.localeCompare(nameB);
		});

	// Count servers by transport type
	const transportCounts = servers.reduce(
		(acc: Record<string, number>, s: any) => {
			const transport = s.transport || "HTTP";
			acc[transport] = (acc[transport] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	// Delete mutation (not in shared hook since it's specific to this view)
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			await orpcClient.mcp.configs.delete({ id, organizationId });
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["mcp-configs"] });
			toast.success("MCP server deleted");
			setDeletingConfig(null);
		},
		onError: (e: any) => {
			toast.error("Failed to delete MCP server", {
				description: e?.message || String(e),
			});
		},
	});

	// Direct custom server add: create a private server definition and the user's config in one flow.
	const createServer = useMutation({
		mutationFn: async () => {
			if (!cName.trim()) {
				throw new Error("Name is required");
			}
			if (!cDefaultUrl.trim()) {
				throw new Error("Base URL is required");
			}

			let parsedDefaultUrl: URL;
			try {
				parsedDefaultUrl = new URL(cDefaultUrl.trim());
			} catch {
				throw new Error("Base URL must be a valid URL");
			}

			if (cAuthType === "API_KEY" && !cApiKey.trim()) {
				throw new Error(
					"API key is required for API Key authentication",
				);
			}

			const generatedKey = generateKeyFromName(cName);
			if (!generatedKey) {
				throw new Error("Could not generate a valid key from the name");
			}

			const server = await orpcClient.mcp.registry.create({
				organizationId,
				key: generatedKey,
				name: cName.trim(),
				description: cDescription.trim() || null,
				defaultUrl: parsedDefaultUrl.toString(),
				docsUrl: cDocsUrl.trim() || null,
				transport: cTransport,
				authMethods: [cAuthType],
				apiKeyMethod: cAuthType === "API_KEY" ? cApiKeyMethod : null,
			});

			const config = await orpcClient.mcp.configs.upsert({
				forceCreate: true,
				mcpServerId: server.id,
				organizationId,
				displayName: cName.trim(),
				baseUrl: parsedDefaultUrl.toString(),
				authType: cAuthType,
				apiKeyMethod:
					cAuthType === "API_KEY" ? cApiKeyMethod : undefined,
				apiKey: cAuthType === "API_KEY" ? cApiKey.trim() : undefined,
				enabled: cEnabled,
			});

			return { config };
		},
		onSuccess: async ({ config }) => {
			toast.success("Custom MCP server added");
			setOpenCustom(false);
			qc.invalidateQueries({
				queryKey: [
					"mcp-servers",
					{ organizationId: organizationId ?? "user" },
				],
			});
			qc.invalidateQueries({
				queryKey: [
					"mcp-configs",
					{ organizationId: organizationId ?? "user" },
				],
			});
			// Reset fields
			setCName("");
			setCDescription("");
			setCDefaultUrl("");
			setCDocsUrl("");
			setCTransport("HTTP");
			setCAuthType("NONE");
			setCApiKeyMethod("BEARER");
			setCApiKey("");
			setCShowApiKey(false);
			setCEnabled(true);
			if (cAuthType === "OAUTH2") {
				setIsConnectingOAuth(true);
				toast.success("Connecting via OAuth...");
				try {
					await handleConnect(config);
				} finally {
					setIsConnectingOAuth(false);
				}
			}
		},
		onError: (e: any) =>
			toast.error("Failed to add server", {
				description: e?.message || String(e),
			}),
	});

	// Helper function to get default auth type from server
	function getDefaultAuthTypeFromServer(
		server: any,
	): "NONE" | "API_KEY" | "OAUTH2" {
		if (!server || !Array.isArray(server.authMethods)) {
			return "NONE";
		}
		if (server.authMethods.includes("OAUTH2")) {
			return "OAUTH2";
		}
		if (server.authMethods.includes("API_KEY")) {
			return "API_KEY";
		}
		return "NONE";
	}

	// Helper function to generate key from name
	const generateKeyFromName = (name: string): string => {
		const base = name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");

		if (!base) {
			return "";
		}

		// 4-6 random lowercase alphanumeric chars for uniqueness
		const randomSuffix = Math.random().toString(36).slice(2, 8);
		return `${base}-${randomSuffix}`;
	};

	const handleEdit = (config: any) => {
		setEditingConfig(config);
		setSelectedServer(config.mcpServer);
		setDisplayName(config.displayName || "");

		// For API_KEY auth, try to extract the API key from the URL and show template
		let urlToShow = config.baseUrl || config.mcpServer?.defaultUrl || "";
		let extractedApiKey = "";

		if (config.authType === "API_KEY" && config.baseUrl) {
			// Check if the server has a template URL with {YOUR_API_KEY}
			const templateUrl = config.mcpServer?.defaultUrl;
			if (templateUrl?.includes("{YOUR_API_KEY}")) {
				// Try to extract the API key by comparing the template with the actual URL
				// For Firecrawl: template is https://mcp.firecrawl.dev/{YOUR_API_KEY}/v2/mcp
				// Actual URL might be https://mcp.firecrawl.dev/fc-abc123xyz/v2/mcp
				const templateParts = templateUrl.split("{YOUR_API_KEY}");
				if (templateParts.length === 2) {
					const [prefix, suffix] = templateParts;
					if (
						config.baseUrl.startsWith(prefix) &&
						config.baseUrl.endsWith(suffix)
					) {
						// Extract the API key from between prefix and suffix
						extractedApiKey = config.baseUrl.slice(
							prefix.length,
							-suffix.length || undefined,
						);
						// Show the template URL instead of the actual URL
						urlToShow = templateUrl;
					}
				}
			}
			// For Bearer token auth (like Fizzy), the API key is stored in encryptedApiKey
			// We don't show the actual key for security, but we indicate it's set
			// The user can leave the field empty to keep the existing key
		}

		setBaseUrl(urlToShow);
		setCommandArgs(config.commandArgs || []);
		setAuthType(config.authType || "NONE");
		setApiKeyMethod(config.apiKeyMethod || "BEARER");
		// Don't show the actual API key for security - only extracted from URL template
		// For Bearer token auth, user can leave empty to keep existing key
		setApiKey(extractedApiKey);
		setShowApiKey(false);
		setEnabled(config.enabled ?? true);
		setDescription(
			config.description || config.mcpServer?.description || "",
		);
		setDomainKeywordsInput((config.domainKeywords || []).join(", "));
		setExampleQueriesInput((config.exampleQueries || []).join(", "));
		setIsTesting(false);
		setOpenAddDialog(true);
	};

	// Test connection function
	async function handleTestConnection() {
		if (!baseUrl) {
			toast.error("Base URL is required", {
				description:
					"Please enter a base URL before testing the connection.",
			});
			return;
		}

		// For API_KEY auth, require either a new key or an existing stored key
		if (
			authType === "API_KEY" &&
			!apiKey &&
			!editingConfig?.encryptedApiKey
		) {
			toast.error("API Key is required", {
				description:
					"Please enter an API key before testing the connection.",
			});
			return;
		}

		setIsTesting(true);

		// Build test request - include configId if editing so server can use stored API key
		const testPayload: Record<string, unknown> = {
			baseUrl,
			transport:
				selectedServer?.transport ||
				editingConfig?.mcpServer?.transport ||
				"HTTP",
			authType,
		};

		// If we have a new API key, use it; otherwise use configId to retrieve stored key
		if (authType === "API_KEY") {
			testPayload.apiKeyMethod = apiKeyMethod;
			if (apiKey) {
				testPayload.apiKey = apiKey;
			} else if (editingConfig?.id) {
				testPayload.configId = editingConfig.id;
			}
		}

		let result: any;
		try {
			const resp = await fetch("/api/mcp/test-connection", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(testPayload),
				signal: AbortSignal.timeout(35_000), // 35s client timeout — stops spinner if server hangs
			});
			result = await resp.json();
		} catch (e: any) {
			setIsTesting(false);
			const msg = (e as any)?.message || String(e);
			setTimeout(
				() =>
					toast.error("Test connection failed", {
						description: msg,
						duration: 5000,
					}),
				0,
			);
			return;
		}

		// Stop spinner first — setTimeout defers the toast to the next tick so React
		// commits isTesting=false before Sonner's useSyncExternalStore update fires
		setIsTesting(false);
		setTimeout(() => {
			if (result.success) {
				const details = result.details;
				const parts: string[] = [];
				const serverName = details?.serverInfo?.name;
				const serverVersion = details?.serverInfo?.version;
				if (serverName) {
					parts.push(
						`Server: ${serverName}${serverVersion ? ` v${serverVersion}` : ""}`,
					);
				}
				if (details?.protocolVersion) {
					parts.push(`Protocol: ${details.protocolVersion}`);
				}
				if (typeof details?.responseTime === "number") {
					parts.push(`Response time: ${details.responseTime}ms`);
				}
				toast.success("Connection test successful!", {
					description:
						parts.join(" | ") || result.message || undefined,
					duration: 5000,
				});
			} else {
				const is401 =
					result.message?.includes("401") ||
					result.message?.toLowerCase().includes("unauthorized") ||
					result.error?.message?.includes("401") ||
					result.error?.message
						?.toLowerCase()
						.includes("unauthorized");

				// If server returned 401 but was marked as no-auth, auto-switch to API Key mode
				if (is401 && authType === "NONE") {
					setAuthType("API_KEY");
					setAuthOverride(true);
					toast.error("Authentication required", {
						description:
							"This server requires an API key despite being listed as public. Enter your API key below and test again.",
						duration: 8000,
					});
				} else {
					toast.error(`Connection test failed: ${result.message}`, {
						description: result.error?.message || "Unknown error",
						duration: 7000,
					});
				}
			}
		}, 0);
	}

	// Save mutation for add/edit
	const saveMutation = useMutation({
		mutationFn: async (options?: { startOAuth?: boolean }) => {
			if (!selectedServer && !editingConfig) {
				throw new Error("Please select a server");
			}

			// STDIO servers with a command don't need a baseUrl (they use the command)
			const isStdioWithCommand =
				(selectedServer?.transport === "STDIO" &&
					selectedServer?.command) ||
				(editingConfig?.mcpServer?.transport === "STDIO" &&
					editingConfig?.mcpServer?.command);

			if (!baseUrl && !isStdioWithCommand) {
				throw new Error("Base URL is required");
			}

			const serverId = editingConfig?.mcpServerId || selectedServer?.id;
			if (!serverId) {
				throw new Error("Server ID is missing");
			}

			// Validate API key if auth type is API_KEY
			// Require API key when: adding new config, OR editing but no existing key stored
			const hasExistingKey = !!editingConfig?.encryptedApiKey;
			if (authType === "API_KEY" && !apiKey && !hasExistingKey) {
				throw new Error(
					"API key is required for API Key authentication",
				);
			}

			// Validate command args for STDIO servers that require them
			const cmdStr =
				selectedServer?.command ||
				editingConfig?.mcpServer?.command ||
				"";
			if (cmdStr.includes("azure-devops") && commandArgs.length === 0) {
				throw new Error(
					"Organization name is required for Azure DevOps",
				);
			}

			// Replace {YOUR_API_KEY} placeholder in base URL with actual API key
			let finalBaseUrl = baseUrl;
			if (
				authType === "API_KEY" &&
				apiKey &&
				baseUrl.includes("{YOUR_API_KEY}")
			) {
				finalBaseUrl = baseUrl.replace("{YOUR_API_KEY}", apiKey);
			}

			const config = await orpcClient.mcp.configs.upsert({
				// When editing an existing config, pass its ID for a targeted update
				// When adding a new config, forceCreate ensures a new row is always created
				configId: editingConfig?.id ?? undefined,
				forceCreate: !editingConfig ? true : undefined,
				mcpServerId: serverId,
				organizationId,
				displayName: displayName.trim() || undefined,
				baseUrl: finalBaseUrl || undefined, // Optional for STDIO servers
				commandArgs: commandArgs.length > 0 ? commandArgs : undefined,
				authType: authType,
				apiKeyMethod: authType === "API_KEY" ? apiKeyMethod : undefined,
				apiKey: apiKey || undefined,
				enabled,
				description: description.trim() || undefined,
				domainKeywords: domainKeywordsInput.trim()
					? domainKeywordsInput
							.split(",")
							.map((keyword) => keyword.trim())
							.filter(Boolean)
					: undefined,
				exampleQueries: exampleQueriesInput.trim()
					? exampleQueriesInput
							.split(",")
							.map((query) => query.trim())
							.filter(Boolean)
					: undefined,
			});

			return { config, startOAuth: options?.startOAuth };
		},
		onSuccess: async ({ config, startOAuth }) => {
			if (startOAuth && authType === "OAUTH2") {
				// Start OAuth flow after saving
				setIsConnectingOAuth(true);
				toast.success("Connecting via OAuth...");
				try {
					await handleConnect(config);
				} finally {
					setIsConnectingOAuth(false);
				}
			} else {
				toast.success(
					editingConfig
						? "MCP server updated successfully"
						: "MCP server added successfully",
				);
			}
			setOpenAddDialog(false);
			setApiKey("");
			setApiKeyMethod("BEARER");
			setCommandArgs([]);
			setShowApiKey(false);
			setEnabled(true);
			qc.invalidateQueries({ queryKey: ["mcp-configs"] });
		},
		onError: (e: any) => {
			setIsConnectingOAuth(false);
			toast.error("Failed to save MCP server", {
				description: e?.message || String(e),
			});
		},
	});

	return (
		<div className="space-y-6">
			{/* Hero Section */}
			<MCPServersHero />

			{/* Header with Search and Add Button */}
			<div className="app-surface flex flex-col gap-3 rounded-2xl p-3 sm:flex-row sm:items-center sm:justify-between">
				<div
					data-onboarding-target="mcp-servers-search"
					className="relative w-full max-w-xl flex-1"
				>
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search MCP servers..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="h-10 rounded-xl border-border/70 bg-background/70 pl-9"
					/>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{/* View Toggle */}
					<div className="flex gap-1 rounded-xl border border-border/70 bg-muted/35 p-1">
						<Button
							variant={viewMode === "grid" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("grid")}
							aria-label="Grid view"
						>
							<GridIcon className="h-4 w-4" />
						</Button>
						<Button
							variant={viewMode === "list" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("list")}
							aria-label="List view"
						>
							<ListIcon className="h-4 w-4" />
						</Button>
					</div>

					<Button
						data-onboarding-target="mcp-servers-add-custom"
						variant="outline"
						onClick={() => setOpenCustom(true)}
					>
						<PlusIcon className="mr-2 size-4" />
						Add Custom Server
					</Button>
					<Button
						data-onboarding-target="mcp-servers-add-registry"
						onClick={() => setOpenRegistryDialog(true)}
						onMouseEnter={() => {
							qc.prefetchQuery({
								queryKey: [
									"mcp-servers",
									{
										organizationId:
											organizationId ?? "user",
									},
								],
								queryFn: () =>
									orpcClient.mcp.registry.list({
										organizationId,
									}),
								staleTime: 5 * 60 * 1000,
							});
						}}
					>
						<PlusIcon className="mr-2 size-4" />
						Add from Registry
					</Button>
				</div>
			</div>

			{/* Configurations Grid */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : filteredConfigs.length === 0 ? (
				<div className="app-surface rounded-2xl py-14 text-center">
					<p className="text-muted-foreground mb-4">
						{searchQuery
							? "No MCP servers found matching your search"
							: "No MCP servers yet. Add a custom MCP server to get started!"}
					</p>
					{!searchQuery && (
						<Button onClick={() => setOpenCustom(true)}>
							<PlusIcon className="mr-2 size-4" />
							Add Custom MCP Server
						</Button>
					)}
				</div>
			) : viewMode === "grid" ? (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
					{filteredConfigs.map((config: any) => (
						<McpConfigTile
							key={config.id}
							config={config}
							oauthStatus={oauthStatuses[config.id]}
							loadingState={loadingStates[config.id]}
							toolCount={toolCounts[config.id]}
							toolError={toolErrors[config.id]}
							tools={toolsCache[config.id]}
							onEdit={handleEdit}
							onDelete={(c) => setDeletingConfig(c)}
							onToggle={(c, enabled) =>
								toggleMutation.mutate({ config: c, enabled })
							}
							onConnect={handleConnect}
							onRefresh={(c) => refreshMutation.mutate(c)}
							onRefreshTools={(c) =>
								refreshToolsMutation.mutate(c)
							}
							onRevoke={(c) => revokeMutation.mutate(c)}
							onTest={handleTestWithToolRefresh}
							onChat={handleChat}
						/>
					))}
				</div>
			) : (
				<McpServersListView
					configs={filteredConfigs}
					oauthStatuses={oauthStatuses}
					loadingStates={loadingStates}
					onEdit={handleEdit}
					onDelete={(c) => setDeletingConfig(c)}
					onToggle={(c, enabled) =>
						toggleMutation.mutate({ config: c, enabled })
					}
					onConnect={handleConnect}
					onRefresh={(c) => refreshMutation.mutate(c)}
					onRefreshTools={(c) => refreshToolsMutation.mutate(c)}
					onRevoke={(c) => revokeMutation.mutate(c)}
					onTest={(c) => testMutation.mutate(c)}
					onChat={handleChat}
				/>
			)}

			{/* Add/Edit Dialog */}
			<Dialog
				open={openAddDialog}
				onOpenChange={(open) => {
					setOpenAddDialog(open);
					if (!open) {
						// Reset state when dialog is closed
						setSelectedServer(null);
						setDisplayName("");
						setBaseUrl("");
						setAuthType("NONE");
						setApiKey("");
						setApiKeyMethod("BEARER");
						setShowApiKey(false);
						setEnabled(true);
						setEditingConfig(null);
						setDescription("");
						setDomainKeywordsInput("");
						setExampleQueriesInput("");
						setIsTesting(false);
					}
				}}
			>
				<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
					<DialogHeader className="flex-shrink-0">
						<DialogTitle>
							{editingConfig
								? `Configure ${editingConfig.mcpServer?.name || editingConfig.displayName || "MCP Server"}`
								: selectedServer
									? `Add ${selectedServer.name}`
									: "Add MCP Server"}
						</DialogTitle>
					</DialogHeader>
					<div className="space-y-4 overflow-y-auto flex-1 pr-2">
						{(selectedServer?.key === "github-remote" ||
							editingConfig?.mcpServer?.key === "github-remote" ||
							baseUrl?.includes("githubcopilot.com")) && (
							<div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
								<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
								<div className="text-sm text-amber-800 dark:text-amber-200">
									<p className="font-medium">
										Recommended: Use the built-in GitHub
										integration instead
									</p>
									<p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
										Go to{" "}
										<strong>
											Workflow Integrations → GitHub
										</strong>{" "}
										for a more reliable connection with full
										private repo access. The built-in
										integration supports all GitHub tools
										(repos, issues, PRs, file contents)
										without requiring a separate MCP server.
									</p>
								</div>
							</div>
						)}
						<div>
							<Label>Display Name</Label>
							<Input
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder={
									selectedServer?.name ||
									editingConfig?.mcpServer?.name ||
									"My MCP Server"
								}
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								Give this server a custom name to distinguish it
								from others
							</p>
						</div>
						{!editingConfig && !selectedServer && (
							<div>
								<Label>Server Type</Label>
								<Select
									value={selectedServer?.id}
									onValueChange={(id) => {
										const server = servers.find(
											(s: any) => s.id === id,
										);
										setSelectedServer(server);
										setBaseUrl(server?.defaultUrl || "");
										setAuthType(
											getDefaultAuthTypeFromServer(
												server,
											),
										);
									}}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a server type" />
									</SelectTrigger>
									<SelectContent>
										{servers.map((s: any) => (
											<SelectItem key={s.id} value={s.id}>
												{s.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						{selectedServer && (
							<div>
								<Label>Server Type</Label>
								<Input
									value={selectedServer.name}
									disabled
									className="bg-muted"
								/>
							</div>
						)}
						{/* Base URL field - show for HTTP/SSE servers only */}
						{(() => {
							const isStdio =
								selectedServer?.transport === "STDIO" ||
								editingConfig?.mcpServer?.transport === "STDIO";
							const hasCommand =
								selectedServer?.command ||
								editingConfig?.mcpServer?.command;

							if (isStdio && !hasCommand) {
								// STDIO server without command - truly local only
								return (
									<div className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
										<p className="text-sm text-foreground">
											<strong>Local Server:</strong> This
											MCP server runs locally via command
											line and cannot be configured from
											the web UI.
										</p>
										<p className="mt-2 text-xs text-highlight/80">
											Use Claude Desktop or a local MCP
											client to run this server.
										</p>
									</div>
								);
							}

							if (isStdio && hasCommand) {
								// STDIO server with command - can be configured via wrapper
								// Check if this is Azure DevOps (needs organization name)
								const cmdStr =
									selectedServer?.command ||
									editingConfig?.mcpServer?.command ||
									"";
								const isAzureDevOps =
									cmdStr.includes("azure-devops");

								return (
									<div className="space-y-4">
										<div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
											<p className="text-sm text-blue-900 dark:text-blue-100">
												<strong>Server Command:</strong>{" "}
												This server will be run securely
												on our servers with your
												credentials.
											</p>
											<code className="mt-2 block bg-muted p-2 rounded text-xs font-mono">
												{cmdStr}
												{commandArgs.length > 0
													? ` ${commandArgs.join(" ")}`
													: ""}
											</code>
										</div>
										{isAzureDevOps && (
											<div>
												<Label>
													Organization Name{" "}
													<span className="text-destructive">
														*
													</span>
												</Label>
												<Input
													value={commandArgs[0] || ""}
													onChange={(e) =>
														setCommandArgs([
															e.target.value,
														])
													}
													placeholder="e.g., contoso or mycompany"
												/>
												<p className="mt-1 text-xs text-muted-foreground">
													Your Azure DevOps
													organization name (from
													dev.azure.com/YOUR_ORG)
												</p>
											</div>
										)}
									</div>
								);
							}

							// HTTP/SSE server - show Base URL field
							return (
								<div>
									<Label>
										Base URL{" "}
										<span className="text-destructive">
											*
										</span>
									</Label>
									<Input
										value={baseUrl}
										onChange={(e) =>
											setBaseUrl(e.target.value)
										}
										placeholder={
											selectedServer?.defaultUrl ||
											selectedServer?.name
												? `https://${selectedServer?.name?.toLowerCase().replace(/\s+/g, "")}.example.com/mcp`
												: "https://mcp.example.com"
										}
										disabled={
											!!editingConfig || !!selectedServer
										}
										className={
											!!editingConfig || !!selectedServer
												? "bg-muted"
												: ""
										}
									/>
									{(!!editingConfig || !!selectedServer) && (
										<p className="mt-1 text-xs text-muted-foreground">
											Base URL is set from the server
											registry and cannot be changed
											{baseUrl.includes(
												"{YOUR_API_KEY}",
											) &&
												authType === "API_KEY" && (
													<>
														. The{" "}
														<code className="px-1 py-0.5 bg-muted rounded text-xs">
															{"{YOUR_API_KEY}"}
														</code>{" "}
														placeholder will be
														automatically replaced
														with your API key.
													</>
												)}
										</p>
									)}
								</div>
							);
						})()}
						<div>
							<Label>Auth Type</Label>
							{authType === "NONE" || authOverride ? (
								<>
									<Select
										value={authType}
										onValueChange={(v) => {
											setAuthType(
												v as
													| "NONE"
													| "API_KEY"
													| "OAUTH2",
											);
											setAuthOverride(
												v !==
													getDefaultAuthTypeFromServer(
														selectedServer,
													),
											);
										}}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="NONE">
												None (Public)
											</SelectItem>
											<SelectItem value="API_KEY">
												API Key
											</SelectItem>
										</SelectContent>
									</Select>
									<p className="mt-1 text-xs text-muted-foreground">
										{authOverride
											? "Auth type overridden — the registry listed this server as public but it requires authentication."
											: "Override if the server requires authentication despite being listed as public."}
									</p>
								</>
							) : (
								<>
									<Input
										value={
											authType === "API_KEY"
												? "API Key"
												: "OAuth 2.0"
										}
										disabled
										className="bg-muted"
									/>
									<p className="mt-1 text-xs text-muted-foreground">
										Authentication type is determined by the
										server configuration
									</p>
								</>
							)}
						</div>
						{authType === "API_KEY" && (
							<div>
								<Label>Authentication Method</Label>
								<Select
									value={apiKeyMethod}
									onValueChange={(v: string) =>
										setApiKeyMethod(
											v as "BEARER" | "HEADER" | "PLAIN",
										)
									}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select method" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="BEARER">
											Bearer Token (Authorization: Bearer)
										</SelectItem>
										<SelectItem value="PLAIN">
											Plain Authorization (Authorization:
											key)
										</SelectItem>
										<SelectItem value="HEADER">
											X-API-Key Header
										</SelectItem>
									</SelectContent>
								</Select>
								<p className="mt-1 text-xs text-muted-foreground">
									{apiKeyMethod === "HEADER"
										? "API key sent as X-API-Key header"
										: apiKeyMethod === "PLAIN"
											? "API key sent as Authorization header without Bearer prefix"
											: "API key sent as Authorization: Bearer token"}
								</p>
							</div>
						)}
						{authType === "API_KEY" && (
							<div>
								<Label>
									API Key
									{editingConfig?.encryptedApiKey &&
										!apiKey && (
											<span className="ml-2 text-xs text-success dark:text-green-400 font-normal">
												(currently set)
											</span>
										)}
								</Label>
								<div className="relative">
									<Input
										type={showApiKey ? "text" : "password"}
										value={apiKey}
										onChange={(e) =>
											setApiKey(e.target.value)
										}
										placeholder={
											editingConfig?.encryptedApiKey
												? "Leave empty to keep existing key"
												: "Enter your API key..."
										}
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
								<p className="mt-1 text-xs text-muted-foreground">
									{editingConfig?.encryptedApiKey
										? "Enter a new key to update, or leave empty to keep the existing key. Stored encrypted on server."
										: "Your API key will be stored encrypted on the server."}
								</p>
							</div>
						)}
						{authType === "OAUTH2" && (
							<div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
								<p className="text-sm text-blue-900 dark:text-blue-100">
									<strong>OAuth 2.0:</strong> Click "Connect
									via OAuth" to authenticate. Credentials are
									managed automatically.
								</p>
							</div>
						)}
						<div className="flex items-center justify-between">
							<Label>Enabled</Label>
							<Switch
								checked={enabled}
								onCheckedChange={setEnabled}
							/>
						</div>
						<div className="space-y-4 pt-4 border-t">
							<div>
								<Label>
									Description{" "}
									<span className="text-xs text-muted-foreground font-normal">
										(improves server selection accuracy)
									</span>
								</Label>
								<Textarea
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									placeholder="e.g., CRM project management - assignments, notes, and task tracking"
									rows={2}
									className="resize-none"
								/>
								<p className="mt-1 text-xs text-muted-foreground">
									Prefilled from the server metadata when
									available. You can refine it before saving.
								</p>
							</div>
							<div>
								<Label>
									Domain Keywords{" "}
									<span className="text-xs text-muted-foreground font-normal">
										(comma-separated)
									</span>
								</Label>
								<Input
									value={domainKeywordsInput}
									onChange={(e) =>
										setDomainKeywordsInput(e.target.value)
									}
									placeholder="e.g., crm, assignment, project, task, notes"
								/>
							</div>
							<div>
								<Label>
									Example Queries{" "}
									<span className="text-xs text-muted-foreground font-normal">
										(comma-separated)
									</span>
								</Label>
								<Textarea
									value={exampleQueriesInput}
									onChange={(e) =>
										setExampleQueriesInput(e.target.value)
									}
									placeholder="e.g., get assignment notes, list crm tasks, show projects"
									rows={2}
									className="resize-none"
								/>
							</div>
						</div>
					</div>
					<DialogFooter className="flex-row justify-between flex-shrink-0 pt-4 border-t">
						{/* Hide Test Connection for STDIO servers - they don't have a URL to test */}
						{selectedServer?.transport !== "STDIO" &&
						editingConfig?.mcpServer?.transport !== "STDIO" ? (
							<Button
								type="button"
								variant="secondary"
								autoLoading={false}
								onClick={handleTestConnection}
								disabled={isTesting || !baseUrl}
							>
								{isTesting ? (
									<LoaderIcon className="mr-1 size-4 animate-spin" />
								) : (
									<TestTube2Icon className="mr-1 size-4" />
								)}{" "}
								Test Connection
							</Button>
						) : (
							<div /> // Spacer for flex layout
						)}
						<div className="flex gap-2">
							<Button
								variant="outline"
								onClick={() => setOpenAddDialog(false)}
							>
								Cancel
							</Button>
							{authType === "OAUTH2" ? (
								<>
									<Button
										variant="outline"
										onClick={() =>
											saveMutation.mutate({
												startOAuth: false,
											})
										}
										disabled={
											saveMutation.isPending ||
											isConnectingOAuth
										}
									>
										{saveMutation.isPending &&
										!isConnectingOAuth ? (
											<LoaderIcon className="mr-1 size-4 animate-spin" />
										) : (
											<CheckCircleIcon className="mr-1 size-4" />
										)}{" "}
										Save Only
									</Button>
									<Button
										onClick={() =>
											saveMutation.mutate({
												startOAuth: true,
											})
										}
										disabled={
											saveMutation.isPending ||
											isConnectingOAuth
										}
									>
										{saveMutation.isPending ||
										isConnectingOAuth ? (
											<LoaderIcon className="mr-1 size-4 animate-spin" />
										) : (
											<KeyIcon className="mr-1 size-4" />
										)}{" "}
										Connect via OAuth
									</Button>
								</>
							) : (
								<Button
									onClick={() => saveMutation.mutate({})}
									disabled={saveMutation.isPending}
								>
									{saveMutation.isPending ? (
										<LoaderIcon className="mr-1 size-4 animate-spin" />
									) : (
										<CheckCircleIcon className="mr-1 size-4" />
									)}{" "}
									Save
								</Button>
							)}
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Registry Selection Dialog */}
			<Dialog
				open={openRegistryDialog}
				onOpenChange={setOpenRegistryDialog}
			>
				<DialogContent className="max-w-[95vw] w-full h-[90vh] flex flex-col p-0">
					<DialogHeader className="px-6 pt-6 pb-4 border-b">
						<DialogTitle className="text-2xl">
							Add MCP Server from Registry
						</DialogTitle>
						<p className="text-sm text-muted-foreground mt-2">
							Select a server from the registry to configure
						</p>
					</DialogHeader>

					{/* Search Bar and Filters */}
					<div className="px-6 py-4 border-b space-y-3">
						<div className="relative">
							<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
							<SearchInput
								placeholder="Search MCP servers..."
								value={registrySearchQuery}
								onChange={(e) =>
									setRegistrySearchQuery(e.target.value)
								}
								className="pl-9"
							/>
						</div>

						{/* Transport Type Filter + View Toggle */}
						<div className="flex items-center justify-between gap-4">
							<div className="flex items-center gap-4 flex-wrap">
								<span className="text-sm text-muted-foreground">
									Filter by transport:
								</span>
								{(["HTTP", "SSE", "STDIO"] as const).map(
									(transport) => {
										const id = `transport-filter-${transport}`;
										return (
											<div
												key={transport}
												className="flex items-center gap-2"
											>
												<Checkbox
													id={id}
													checked={
														transportFilters[
															transport
														]
													}
													onCheckedChange={(
														checked,
													) =>
														setTransportFilters(
															(prev) => ({
																...prev,
																[transport]:
																	checked ===
																	true,
															}),
														)
													}
												/>
												<label
													htmlFor={id}
													className="text-sm flex items-center gap-1.5 cursor-pointer"
												>
													{transport}
													<Badge
														variant="secondary"
														className="px-1.5 py-0 text-[10px]"
													>
														{transportCounts[
															transport
														] || 0}
													</Badge>
												</label>
											</div>
										);
									},
								)}
							</div>
							<div className="flex gap-1 border rounded-md p-1 shrink-0">
								<Button
									variant={
										registryViewMode === "grid"
											? "default"
											: "ghost"
									}
									size="icon-sm"
									onClick={() => setRegistryViewMode("grid")}
									aria-label="Grid view"
								>
									<GridIcon className="h-4 w-4" />
								</Button>
								<Button
									variant={
										registryViewMode === "list"
											? "default"
											: "ghost"
									}
									size="icon-sm"
									onClick={() => setRegistryViewMode("list")}
									aria-label="List view"
								>
									<ListIcon className="h-4 w-4" />
								</Button>
							</div>
						</div>
					</div>

					{/* Server List / Grid */}
					<div className="flex-1 overflow-y-auto px-6 py-4">
						{servers.length === 0 ? (
							<div className="text-center py-12 text-muted-foreground">
								No servers in registry
							</div>
						) : filteredRegistryServers.length === 0 ? (
							<div className="text-center py-12 text-muted-foreground">
								No servers found matching "{registrySearchQuery}
								"
							</div>
						) : registryViewMode === "grid" ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
								{filteredRegistryServers.map((server: any) => (
									<McpServerCard
										key={server.id}
										server={server}
										showInstallButton={true}
										onInstall={(s) => {
											handleRegistryInstall(s);
										}}
									/>
								))}
							</div>
						) : (
							<div className="space-y-2">
								{filteredRegistryServers.map((server: any) => {
									const canConfigure =
										server.transport !== "STDIO" ||
										!!server.command;

									const shortDesc = server.description
										? server.description.length > 200
											? `${server.description.slice(0, 200)}...`
											: server.description
										: null;

									const authMethod =
										server.authMethods?.[0] || "NONE";
									const noAuth =
										!server.authMethods?.length ||
										server.authMethods.includes("NONE");
									const authLabel = noAuth
										? "Public"
										: authMethod === "API_KEY"
											? "API Key"
											: authMethod === "OAUTH2"
												? "OAuth"
												: authMethod;

									return (
										<div
											key={server.id}
											className="flex items-center gap-4 rounded-lg border bg-card/50 p-3 hover:border-primary/30 hover:shadow-sm transition-all group"
										>
											<McpServerIcon
												name={server.name || server.key}
												iconUrl={server.iconUrl}
												docsUrl={server.docsUrl}
												repositoryUrl={
													server.repositoryUrl
												}
												defaultUrl={server.defaultUrl}
												size={32}
												className="h-8 w-8 rounded-lg"
											/>

											{/* Info */}
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2 mb-0.5">
													<span className="font-medium text-sm truncate">
														{server.name}
													</span>
													{server.transport && (
														<Badge
															variant="secondary"
															className="text-[10px] px-1.5 py-0 shrink-0"
														>
															{server.transport}
														</Badge>
													)}
													<Badge
														variant="outline"
														className="text-[10px] px-1.5 py-0 shrink-0"
													>
														{authLabel}
													</Badge>
													{server.category && (
														<Badge
															variant="secondary"
															className="text-[10px] px-1.5 py-0 shrink-0 hidden sm:inline-flex"
														>
															{server.category}
														</Badge>
													)}
												</div>
												{shortDesc && (
													<p className="text-xs text-muted-foreground truncate">
														{shortDesc}
													</p>
												)}
											</div>

											{/* Install button */}
											<Button
												size="sm"
												variant={
													canConfigure
														? "default"
														: "outline"
												}
												className="shrink-0"
												onClick={() =>
													handleRegistryInstall(
														server,
													)
												}
											>
												{canConfigure ? (
													<>
														<PlusIcon className="mr-1 size-3.5" />
														Install
													</>
												) : (
													"Local Only"
												)}
											</Button>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>

			{/* Add Custom MCP Server Dialog */}
			<Dialog
				open={openCustom}
				onOpenChange={(open) => {
					setOpenCustom(open);
					if (!open) {
						setCName("");
						setCDescription("");
						setCDefaultUrl("");
						setCDocsUrl("");
						setCTransport("HTTP");
						setCAuthType("NONE");
						setCApiKeyMethod("BEARER");
						setCApiKey("");
						setCShowApiKey(false);
						setCEnabled(true);
					}
				}}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>Add Custom MCP Server</DialogTitle>
					</DialogHeader>
					<div className="space-y-3">
						<div>
							<Label>
								Name <span className="text-destructive">*</span>
							</Label>
							<Input
								value={cName}
								onChange={(e) => setCName(e.target.value)}
								placeholder="My MCP Server"
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								A unique key will be auto-generated from the
								name
							</p>
						</div>
						<div>
							<Label>Description</Label>
							<Textarea
								value={cDescription}
								onChange={(e) =>
									setCDescription(e.target.value)
								}
								placeholder="Short description"
								rows={3}
							/>
						</div>
						<div>
							<Label>
								Base URL{" "}
								<span className="text-destructive">*</span>
							</Label>
							<Input
								value={cDefaultUrl}
								onChange={(e) => setCDefaultUrl(e.target.value)}
								placeholder="https://api.example.com/mcp"
							/>
						</div>
						<div>
							<Label>Docs URL (optional)</Label>
							<Input
								value={cDocsUrl}
								onChange={(e) => setCDocsUrl(e.target.value)}
								placeholder="https://docs.example.com"
							/>
						</div>
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
							<div>
								<Label>Transport</Label>
								<Select
									value={cTransport}
									onValueChange={(v: any) => setCTransport(v)}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="HTTP">
											Streamable HTTP
										</SelectItem>
										<SelectItem value="SSE">SSE</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div>
								<Label>
									Auth Type{" "}
									<span className="text-destructive">*</span>
								</Label>
								<Select
									value={cAuthType}
									onValueChange={(v: any) => setCAuthType(v)}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="NONE">
											None
										</SelectItem>
										<SelectItem value="API_KEY">
											API Key
										</SelectItem>
										<SelectItem value="OAUTH2">
											OAuth 2.0
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
						{cAuthType === "API_KEY" && (
							<>
								<div>
									<Label>Authentication Method</Label>
									<Select
										value={cApiKeyMethod}
										onValueChange={(v: any) =>
											setCApiKeyMethod(v)
										}
									>
										<SelectTrigger>
											<SelectValue placeholder="Select" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="BEARER">
												Bearer Token (Authorization:
												Bearer)
											</SelectItem>
											<SelectItem value="PLAIN">
												Plain Authorization
												(Authorization: key)
											</SelectItem>
											<SelectItem value="HEADER">
												X-API-Key Header
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div>
									<Label>
										API Key{" "}
										<span className="text-destructive">
											*
										</span>
									</Label>
									<div className="relative">
										<Input
											type={
												cShowApiKey
													? "text"
													: "password"
											}
											value={cApiKey}
											onChange={(e) =>
												setCApiKey(e.target.value)
											}
											placeholder="Enter your API key..."
											className="pr-10"
										/>
										<button
											type="button"
											onClick={() =>
												setCShowApiKey(!cShowApiKey)
											}
											className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
										>
											{cShowApiKey ? (
												<EyeOffIcon className="size-4" />
											) : (
												<EyeIcon className="size-4" />
											)}
										</button>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Your API key will be stored encrypted on
										the server.
									</p>
								</div>
							</>
						)}
						{cAuthType === "OAUTH2" && (
							<div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
								<p className="text-sm text-blue-900 dark:text-blue-100">
									OAuth will start after you save this custom
									server.
								</p>
							</div>
						)}
						<div className="flex items-center justify-between rounded-md border border-border p-3">
							<Label>Enabled</Label>
							<Switch
								checked={cEnabled}
								onCheckedChange={setCEnabled}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setOpenCustom(false)}
						>
							Cancel
						</Button>
						<Button
							disabled={createServer.isPending}
							onClick={() => createServer.mutate()}
						>
							<CheckCircleIcon className="mr-1 size-4" />
							{cAuthType === "OAUTH2"
								? "Save and Connect"
								: "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<AlertDialog
				open={!!deletingConfig}
				onOpenChange={(open) => !open && setDeletingConfig(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete Configuration
						</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete this MCP server
							configuration? This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								deletingConfig &&
								deleteMutation.mutate(deletingConfig.id)
							}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* MCP Chat Dialog */}
			<McpChatDialog
				open={!!chatConfig}
				onOpenChange={(open) => !open && setChatConfig(null)}
				config={chatConfig || { id: "", displayName: "" }}
				organizationId={organizationId ?? null}
			/>
		</div>
	);
}
