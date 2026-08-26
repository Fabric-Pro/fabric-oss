/**
 * MCP Server Dialog
 *
 * Dialog for adding/editing custom MCP servers.
 */

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { CheckCircleIcon } from "lucide-react";
import type {
	ApiKeyMethod,
	AuthType,
	McpServer,
	McpServerFormState,
	Transport,
} from "../types";

export interface McpServerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	form: McpServerFormState;
	editingServer: McpServer | null;
	isLoading?: boolean;
	isDiscovering?: boolean;
	disabled?: boolean;
	onNameChange: (name: string) => void;
	onDescriptionChange: (description: string) => void;
	onDefaultUrlChange: (url: string) => void;
	onDocsUrlChange: (url: string) => void;
	onTransportChange: (transport: Transport) => void;
	onAuthTypeChange: (authType: AuthType) => void;
	onApiKeyMethodChange: (method: ApiKeyMethod) => void;
	onAutoDiscoverOAuthChange: (auto: boolean) => void;
	onDiscoveryUrlChange: (url: string) => void;
	onDcrRegistrationEndpointChange: (endpoint: string) => void;
	onDiscoverEndpoints?: () => void;
	onSave: () => void;
}

export function McpServerDialog({
	open,
	onOpenChange,
	form,
	editingServer,
	isLoading = false,
	isDiscovering = false,
	disabled = false,
	onNameChange,
	onDescriptionChange,
	onDefaultUrlChange,
	onDocsUrlChange,
	onTransportChange,
	onAuthTypeChange,
	onApiKeyMethodChange,
	onAutoDiscoverOAuthChange,
	onDiscoveryUrlChange,
	onDcrRegistrationEndpointChange,
	onDiscoverEndpoints,
	onSave,
}: McpServerDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle>
						{editingServer
							? "Edit Custom MCP Server"
							: "Add Custom MCP Server"}
					</DialogTitle>
				</DialogHeader>
				{!editingServer && (
					<p className="text-sm text-muted-foreground">
						Create the server first, then configure credentials for
						your account.
					</p>
				)}
				<div className="space-y-3 overflow-y-auto flex-1 pr-2">
					<div>
						<Label>
							Name <span className="text-destructive">*</span>
						</Label>
						<Input
							value={form.name}
							onChange={(e) => onNameChange(e.target.value)}
							placeholder="My MCP Server"
						/>
						<p className="mt-1 text-xs text-muted-foreground">
							A unique key will be auto-generated from the name
						</p>
					</div>
					<div>
						<Label>Description</Label>
						<Textarea
							value={form.description}
							onChange={(e) =>
								onDescriptionChange(e.target.value)
							}
							placeholder="Short description"
							rows={3}
						/>
					</div>
					<div>
						<Label>
							Base URL <span className="text-destructive">*</span>
						</Label>
						<Input
							value={form.defaultUrl}
							onChange={(e) => onDefaultUrlChange(e.target.value)}
							placeholder="https://api.example.com/mcp"
						/>
					</div>
					<div>
						<Label>Docs URL (optional)</Label>
						<Input
							value={form.docsUrl}
							onChange={(e) => onDocsUrlChange(e.target.value)}
							placeholder="https://docs.example.com"
						/>
					</div>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<div>
							<Label>Transport</Label>
							<Select
								value={form.transport}
								onValueChange={(v) =>
									onTransportChange(v as Transport)
								}
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
								value={form.authType}
								onValueChange={(v) =>
									onAuthTypeChange(v as AuthType)
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="NONE">None</SelectItem>
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

					{/* API Key Method Selection */}
					{form.authType === "API_KEY" && (
						<div>
							<Label>API Key Authentication Method</Label>
							<Select
								value={form.apiKeyMethod}
								onValueChange={(v) =>
									onApiKeyMethodChange(v as ApiKeyMethod)
								}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select method" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="BEARER">
										Bearer Token (Authorization: Bearer)
									</SelectItem>
									<SelectItem value="HEADER">
										X-API-Key Header
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="mt-1 text-xs text-muted-foreground">
								{form.apiKeyMethod === "HEADER"
									? "Users will send API key as X-API-Key header"
									: "Users will send API key as Authorization: Bearer token (default)"}
							</p>
						</div>
					)}

					{/* OAuth Configuration */}
					{form.authType === "OAUTH2" && (
						<div className="space-y-3">
							<div className="flex items-center justify-between rounded-md border border-border p-3">
								<div className="flex-1">
									<Label className="text-sm font-medium">
										Automatic OAuth Discovery
									</Label>
									<p className="text-xs text-muted-foreground mt-1">
										{form.autoDiscoverOAuth
											? "OAuth endpoints will be automatically discovered from the base URL"
											: "Manually configure OAuth discovery URL and DCR endpoint"}
									</p>
								</div>
								<Switch
									checked={form.autoDiscoverOAuth}
									onCheckedChange={onAutoDiscoverOAuthChange}
								/>
							</div>

							{!form.autoDiscoverOAuth && (
								<>
									<div>
										<Label>
											OAuth Discovery URL (optional)
										</Label>
										<Input
											value={form.discoveryUrl}
											onChange={(e) =>
												onDiscoveryUrlChange(
													e.target.value,
												)
											}
											placeholder="https://host/.well-known/oauth-authorization-server"
										/>
										{onDiscoverEndpoints && (
											<div className="mt-2 flex flex-wrap items-center gap-2">
												<Button
													variant="outline"
													size="sm"
													disabled={
														!form.discoveryUrl ||
														isDiscovering
													}
													onClick={
														onDiscoverEndpoints
													}
												>
													{isDiscovering
														? "Discovering..."
														: "Discover endpoints"}
												</Button>
												<p className="text-xs text-muted-foreground">
													Fetch OpenID Connect
													metadata to auto-fill the
													DCR endpoint.
												</p>
											</div>
										)}
									</div>
									<div>
										<Label>
											DCR Registration Endpoint (optional)
										</Label>
										<Input
											value={form.dcrRegistrationEndpoint}
											onChange={(e) =>
												onDcrRegistrationEndpointChange(
													e.target.value,
												)
											}
											placeholder="https://host/oauth/register"
										/>
										<p className="mt-1 text-xs text-muted-foreground">
											If this server supports RFC 7591
											Dynamic Client Registration, enter
											the registration endpoint URL.
										</p>
									</div>
								</>
							)}
						</div>
					)}
				</div>
				<DialogFooter className="flex-shrink-0 pt-4 border-t">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={
							disabled ||
							isLoading ||
							!form.name ||
							!form.defaultUrl.trim()
						}
						onClick={onSave}
					>
						<CheckCircleIcon className="mr-1 size-4" />
						{isLoading
							? "Saving..."
							: editingServer
								? "Save"
								: "Continue"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
