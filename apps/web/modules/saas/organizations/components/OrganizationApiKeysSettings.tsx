"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckIcon,
	CopyIcon,
	InfoIcon,
	KeyIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// Available scopes with descriptions
export const AVAILABLE_SCOPES = [
	{
		id: "mcp:read",
		label: "MCP Read",
		description: "Read MCP server configurations and tools",
	},
	{
		id: "mcp:write",
		label: "MCP Write",
		description: "Execute MCP tools and modify configurations",
	},
	{
		id: "ai:models:read",
		label: "AI Models Read",
		description: "Read available AI model configurations",
	},
	{
		id: "ai:models:resolve",
		label: "AI Models Resolve",
		description:
			"Resolve AI model configuration for tasks (used by agents)",
	},
	{
		id: "projects:read",
		label: "Projects Read",
		description: "Read project data",
	},
	{
		id: "projects:write",
		label: "Projects Write",
		description: "Modify project data",
	},
	{
		id: "agents:read",
		label: "Agents Read",
		description: "Read agent metadata and list available agents",
	},
	{
		id: "agents:execute",
		label: "Agents Execute",
		description: "Trigger agent executions via API",
	},
	{
		id: "agents:stream",
		label: "Agents Stream",
		description: "Access real-time agent execution streams",
	},
	{
		id: "orgs:read",
		label: "Organizations Read",
		description: "List organizations and read your identity",
	},
	{
		id: "features:read",
		label: "Features Read",
		description: "Read features, bugs and their decision history",
	},
	{
		id: "features:write",
		label: "Features Write",
		description: "Create and update features, bugs and their tasks",
	},
	{
		id: "workspaces:read",
		label: "Workspaces Read",
		description: "Read workspaces and run knowledge queries",
	},
	{
		id: "workflows:read",
		label: "Workflows Read",
		description: "Read workflows and their execution history",
	},
	{
		id: "workflows:run",
		label: "Workflows Run",
		description: "Trigger workflow executions",
	},
	{
		id: "frames:read",
		label: "Frames Read",
		description: "Read frames and slideshows",
	},
	{
		id: "frames:write",
		label: "Frames Write",
		description: "Create, update and share frames",
	},
	{
		id: "chats:read",
		label: "Chats Read",
		description: "Read AI chat threads",
	},
	{
		id: "audit_log:read",
		label: "Audit Log Read",
		description: "Read this organization's audit log",
	},
	{
		id: "audit_log:export",
		label: "Audit Log Export",
		description: "Export the full audit trail in bulk",
	},
	{
		id: "system_health:read",
		label: "System Health Read",
		description: "Read health signals for this organization",
	},
	{
		id: "status_updates:read",
		label: "Status Updates Read",
		description: "Read platform status announcements",
	},
] as const;

type ApiKeyScope = (typeof AVAILABLE_SCOPES)[number]["id"];

export function OrganizationApiKeysSettings() {
	const queryClient = useQueryClient();
	const { organizationId, isOrgContext, userRole } = useOrganizationContext();
	const { user } = useSession();

	// Creating a key is a member capability: the key carries only the access
	// its creator already has, so minting one grants nothing new. It used to be
	// admin-gated, which left members no way to connect an editor or AI tool
	// short of being promoted — a far larger grant than the key itself.
	const canCreateKey = Boolean(organizationId);

	// Revocation mirrors the server: an owner may retire any key in the
	// organization, everyone else only their own. Rendering a button the API
	// would refuse is how the delete control came to 403 for admins in the
	// first place.
	const isOrganizationOwner = userRole === "owner";
	const canRevokeKey = (createdByUserId: string) =>
		isOrganizationOwner || createdByUserId === user?.id;
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [selectedScopes, setSelectedScopes] = useState<string[]>([
		"mcp:read",
		"mcp:write",
	]);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [apiUrl, setApiUrl] = useState("http://localhost:3000");

	// Set API URL on client side to avoid hydration mismatch
	useEffect(() => {
		setApiUrl(window.location.origin);
	}, []);

	// Query to get existing API keys
	const { data: apiKeys, isLoading } = useQuery({
		queryKey: ["organizationApiKeys", organizationId],
		queryFn: async () => {
			if (!organizationId) {
				return [];
			}
			return await orpcClient.organizations.apiKeys.list({
				organizationId,
				includeInactive: false,
			});
		},
		enabled: !!organizationId,
	});

	// Mutation to create API key
	const createMutation = useMutation({
		mutationFn: async ({
			name,
			scopes,
		}: {
			name: string;
			scopes: string[];
		}) => {
			if (!organizationId) {
				throw new Error("Organization not found");
			}
			return await orpcClient.organizations.apiKeys.create({
				organizationId,
				name,
				// Derived from the list above rather than re-typed: the hand
				// written union had fallen five scopes behind what the
				// procedure accepts, and nothing could notice.
				scopes: scopes as ApiKeyScope[],
			});
		},
		onSuccess: (data) => {
			setNewKey(data.rawKey);
			queryClient.invalidateQueries({
				queryKey: ["organizationApiKeys", organizationId],
			});
			toast.success("API key created", {
				description:
					"Make sure to copy your key now. You won't see it again!",
			});
		},
		onError: (error) => {
			toast.error("Failed to create API key", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Mutation to delete API key
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			if (!organizationId) {
				throw new Error("Organization not found");
			}
			return await orpcClient.organizations.apiKeys.delete({
				organizationId,
				id,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["organizationApiKeys", organizationId],
			});
			toast.success("API key deleted");
		},
		onError: () => {
			toast.error("Failed to delete API key");
		},
	});

	const handleCreate = () => {
		if (!newKeyName.trim()) {
			toast.error("Please enter a name for the API key");
			return;
		}
		if (selectedScopes.length === 0) {
			toast.error("Please select at least one scope");
			return;
		}
		createMutation.mutate({ name: newKeyName, scopes: selectedScopes });
	};

	const handleCopy = async () => {
		if (newKey) {
			await navigator.clipboard.writeText(newKey);
			setCopied(true);
			toast.success("API key copied to clipboard");
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleDelete = (id: string, name: string) => {
		if (
			window.confirm(`Delete API key "${name}"? This cannot be undone.`)
		) {
			deleteMutation.mutate(id);
		}
	};

	const handleCloseCreate = () => {
		setIsCreateOpen(false);
		setNewKeyName("");
		setSelectedScopes(["mcp:read", "mcp:write"]);
		setNewKey(null);
		setCopied(false);
	};

	const handleCreateDialogOpenChange = (open: boolean) => {
		setIsCreateOpen(open);
		if (!open) {
			setNewKeyName("");
			setSelectedScopes(["mcp:read", "mcp:write"]);
			setNewKey(null);
			setCopied(false);
		}
	};

	const toggleScope = (scopeId: string) => {
		setSelectedScopes((prev) =>
			prev.includes(scopeId)
				? prev.filter((s) => s !== scopeId)
				: [...prev, scopeId],
		);
	};

	const formatDate = (date: Date | null) => {
		if (!date) {
			return "Never";
		}
		return new Date(date).toLocaleDateString();
	};

	if (!isOrgContext) {
		return null;
	}

	return (
		<SettingsItem
			title="Your API Keys"
			description={
				isOrganizationOwner
					? "Keys carry the access of whoever created them — they are personal, not shared. As an owner you can see and revoke every key in this organization."
					: "Connect external tools to Fabric. A key carries your own access to this organization and nothing more, and only you can see the keys you create."
			}
		>
			<div className="space-y-4">
				{/* Create Key Dialog */}
				{canCreateKey && (
					<Dialog
						open={isCreateOpen}
						onOpenChange={handleCreateDialogOpenChange}
					>
						<DialogTrigger asChild>
							<Button size="sm">
								<PlusIcon className="mr-2 size-4" />
								Create API Key
							</Button>
						</DialogTrigger>
						<DialogContent className="max-w-md">
							<DialogHeader>
								<DialogTitle>
									{newKey
										? "API Key Created"
										: "Create API Key"}
								</DialogTitle>
								<DialogDescription>
									{newKey
										? "Copy your API key now. You won't be able to see it again!"
										: "Create a new API key for external agents and integrations."}
								</DialogDescription>
							</DialogHeader>

							{newKey ? (
								<div className="space-y-4">
									<div className="rounded-lg border bg-muted p-4">
										<code className="break-all text-sm">
											{newKey}
										</code>
									</div>
									<Button
										onClick={handleCopy}
										className="w-full"
										autoLoading={false}
									>
										{copied ? (
											<>
												<CheckIcon className="mr-2 size-4" />
												Copied!
											</>
										) : (
											<>
												<CopyIcon className="mr-2 size-4" />
												Copy to Clipboard
											</>
										)}
									</Button>
								</div>
							) : (
								<div className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="keyName">
											Key Name
										</Label>
										<Input
											id="keyName"
											placeholder="e.g., Production Agent, CUGA Integration"
											value={newKeyName}
											onChange={(e) =>
												setNewKeyName(e.target.value)
											}
										/>
									</div>

									<div className="space-y-2">
										<Label>Permissions</Label>
										<p className="text-muted-foreground text-xs">
											Select which actions this API key
											can perform
										</p>
										<div className="space-y-2 rounded-lg border p-3">
											{AVAILABLE_SCOPES.map((scope) => (
												<div
													key={scope.id}
													className="flex items-start gap-2"
												>
													<Checkbox
														id={scope.id}
														checked={selectedScopes.includes(
															scope.id,
														)}
														onCheckedChange={() =>
															toggleScope(
																scope.id,
															)
														}
													/>
													<div className="grid gap-0.5 leading-none">
														<label
															htmlFor={scope.id}
															className="cursor-pointer font-medium text-sm"
														>
															{scope.label}
														</label>
														<p className="text-muted-foreground text-xs">
															{scope.description}
														</p>
													</div>
												</div>
											))}
										</div>
									</div>
								</div>
							)}

							<DialogFooter>
								{newKey ? (
									<Button onClick={handleCloseCreate}>
										Done
									</Button>
								) : (
									<>
										<Button
											variant="outline"
											onClick={handleCloseCreate}
										>
											Cancel
										</Button>
										<Button
											onClick={handleCreate}
											disabled={createMutation.isPending}
										>
											{createMutation.isPending
												? "Creating..."
												: "Create Key"}
										</Button>
									</>
								)}
							</DialogFooter>
						</DialogContent>
					</Dialog>
				)}

				{/* API Keys Table */}
				{!isLoading && apiKeys && apiKeys.length > 0 && (
					<h3 className="font-medium text-sm">
						{isOrganizationOwner
							? "All keys in this organization"
							: "Your keys"}
					</h3>
				)}
				{isLoading ? (
					<div className="text-muted-foreground text-sm">
						Loading...
					</div>
				) : apiKeys && apiKeys.length > 0 ? (
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Key</TableHead>
									<TableHead>Scopes</TableHead>
									<TableHead>Created By</TableHead>
									<TableHead>Last Used</TableHead>
									{apiKeys.some((key) =>
										canRevokeKey(key.createdBy.id),
									) && <TableHead className="w-[50px]" />}
								</TableRow>
							</TableHeader>
							<TableBody>
								{apiKeys.map((key) => (
									<TableRow key={key.id}>
										<TableCell className="font-medium">
											<div className="flex items-center gap-2">
												<KeyIcon className="size-4 text-muted-foreground" />
												{key.name}
											</div>
										</TableCell>
										<TableCell>
											<code className="rounded bg-muted px-2 py-1 text-xs">
												{key.keyPrefix}...
											</code>
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap gap-1">
												{key.scopes
													.slice(0, 2)
													.map((scope) => (
														<Badge
															key={scope}
															variant="secondary"
															className="text-xs"
														>
															{scope}
														</Badge>
													))}
												{key.scopes.length > 2 && (
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Badge
																	variant="outline"
																	className="cursor-help text-xs"
																>
																	+
																	{key.scopes
																		.length -
																		2}
																</Badge>
															</TooltipTrigger>
															<TooltipContent>
																<div className="space-y-1">
																	{key.scopes
																		.slice(
																			2,
																		)
																		.map(
																			(
																				scope,
																			) => (
																				<div
																					key={
																						scope
																					}
																				>
																					{
																						scope
																					}
																				</div>
																			),
																		)}
																</div>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												)}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{key.createdBy.name ||
												key.createdBy.email ||
												"Unknown"}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{formatDate(key.lastUsedAt)}
										</TableCell>
										{canRevokeKey(key.createdBy.id) && (
											<TableCell>
												<Button
													variant="ghost"
													size="icon"
													onClick={() =>
														handleDelete(
															key.id,
															key.name,
														)
													}
													disabled={
														deleteMutation.isPending
													}
												>
													<Trash2Icon className="size-4 text-destructive" />
												</Button>
											</TableCell>
										)}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				) : (
					<div className="rounded-lg border border-dashed p-8 text-center">
						<KeyIcon className="mx-auto size-8 text-muted-foreground" />
						<h3 className="mt-4 font-medium">No API keys yet</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							Create one to connect an editor, an AI assistant or
							a script to this organization.
						</p>
					</div>
				)}

				{/* Usage Instructions */}
				<div className="rounded-lg border bg-muted/50 p-4">
					<div className="flex items-start gap-2">
						<InfoIcon className="mt-0.5 size-4 text-muted-foreground" />
						<div>
							<h4 className="font-medium text-sm">
								Using your API key
							</h4>
							<p className="mt-1 text-muted-foreground text-xs">
								External agents can use these keys to resolve AI
								model configuration:
							</p>
							<pre className="mt-2 overflow-x-auto rounded bg-background p-3 text-xs">
								{`POST ${apiUrl}/api/ai-config/resolve-for-agent
{
  "apiKey": "<org_xxx_...>",
  "taskType": "CHAT",  // or "TOOL_CALLING", "REASONING", etc.
  "agentId": "optional-agent-id"
}`}
							</pre>
							<p className="mt-2 text-muted-foreground text-xs">
								The response includes model configuration and a
								cache TTL hint for efficiency.
							</p>
						</div>
					</div>
				</div>
			</div>
		</SettingsItem>
	);
}
