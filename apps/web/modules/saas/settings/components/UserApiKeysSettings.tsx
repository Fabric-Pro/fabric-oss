"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
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
	CheckIcon,
	CopyIcon,
	KeyIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function UserApiKeysSettings() {
	const queryClient = useQueryClient();
	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [newKey, setNewKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [apiUrl, setApiUrl] = useState("http://localhost:3000");

	// Set API URL on client side to avoid hydration mismatch
	useEffect(() => {
		setApiUrl(window.location.origin);
	}, []);

	// Query to get existing API keys
	const { data: apiKeys, isLoading } = useQuery({
		queryKey: ["userApiKeys"],
		queryFn: async () => {
			return await orpcClient.users.apiKeys.list({});
		},
	});

	// Mutation to create API key
	const createMutation = useMutation({
		mutationFn: async (name: string) => {
			return await orpcClient.users.apiKeys.create({
				name,
				scopes: [
					"mcp:read",
					"mcp:write",
					"browser:read",
					"browser:write",
					"agents:read",
					"agents:execute",
					"agents:stream",
				],
			});
		},
		onSuccess: (data) => {
			setNewKey(data.rawKey);
			queryClient.invalidateQueries({ queryKey: ["userApiKeys"] });
			toast.success("API key created", {
				description:
					"Make sure to copy your key now. You won't see it again!",
			});
		},
		onError: () => {
			toast.error("Failed to create API key");
		},
	});

	// Mutation to delete API key
	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			return await orpcClient.users.apiKeys.delete({ id });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["userApiKeys"] });
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
		createMutation.mutate(newKeyName);
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
		setNewKey(null);
		setCopied(false);
	};

	const handleCreateDialogOpenChange = (open: boolean) => {
		setIsCreateOpen(open);
		if (!open) {
			setNewKeyName("");
			setNewKey(null);
			setCopied(false);
		}
	};

	const formatDate = (date: Date | null) => {
		if (!date) {
			return "Never";
		}
		return new Date(date).toLocaleDateString();
	};

	return (
		<SettingsItem
			title="API Keys"
			description="Manage API keys for external integrations like MCP Server and Claude Desktop"
		>
			<div className="space-y-4">
				{/* Create Key Dialog */}
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
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{newKey ? "API Key Created" : "Create API Key"}
							</DialogTitle>
							<DialogDescription>
								{newKey
									? "Copy your API key now. You won't be able to see it again!"
									: "Create a new API key for external integrations."}
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
									<Label htmlFor="keyName">Key Name</Label>
									<Input
										id="keyName"
										placeholder="e.g., Claude Desktop, MCP Server"
										value={newKeyName}
										onChange={(e) =>
											setNewKeyName(e.target.value)
										}
									/>
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

				{/* API Keys Table */}
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
									<TableHead>Last Used</TableHead>
									<TableHead>Created</TableHead>
									<TableHead className="w-[50px]" />
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
										<TableCell className="text-muted-foreground text-sm">
											{formatDate(key.lastUsedAt)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{formatDate(key.createdAt)}
										</TableCell>
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
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				) : (
					<div className="rounded-lg border border-dashed p-8 text-center">
						<KeyIcon className="mx-auto size-8 text-muted-foreground" />
						<h3 className="mt-4 font-medium">No API Keys</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							Create an API key to use with Claude Desktop or
							other MCP clients.
						</p>
					</div>
				)}

				{/* Usage Instructions */}
				<div className="rounded-lg border bg-muted/50 p-4">
					<h4 className="font-medium text-sm">
						Claude Desktop Configuration
					</h4>
					<p className="mt-1 text-muted-foreground text-xs">
						Add this to your Claude Desktop config file:
					</p>
					<pre className="mt-2 overflow-x-auto rounded bg-background p-3 text-xs">
						{`{
  "mcpServers": {
    "fabric": {
      "command": "npx",
      "args": ["@fabricorg/mcp-server"],
      "env": {
        "FABRIC_API_KEY": "<your-api-key>",
        "FABRIC_USER_ID": "<your-user-id>",
        "FABRIC_API_URL": "${apiUrl}"
      }
    }
  }
}`}
					</pre>
				</div>
			</div>
		</SettingsItem>
	);
}
