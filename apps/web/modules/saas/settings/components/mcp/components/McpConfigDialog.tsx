/**
 * MCP Config Dialog
 *
 * Dialog for adding/editing MCP server configurations.
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
import {
	AlertTriangleIcon,
	CheckCircleIcon,
	EyeIcon,
	EyeOffIcon,
	LoaderIcon,
	TestTube2Icon,
} from "lucide-react";
import type {
	ApiKeyMethod,
	McpConfig,
	McpConfigFormState,
	OAuthStatus,
} from "../types";
import {
	getAuthTypeLabel,
	getCredentialHelpText,
	getCredentialLabel,
	getCredentialPlaceholder,
} from "../types";

export interface McpConfigDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	form: McpConfigFormState;
	editingConfig: McpConfig | null;
	currentOAuthStatus: OAuthStatus | null;
	isLoading?: boolean;
	isTesting?: boolean;
	isConnecting?: boolean;
	isRegisteringDcr?: boolean;
	disabled?: boolean;
	onDisplayNameChange: (name: string) => void;
	onBaseUrlChange: (url: string) => void;
	onApiKeyMethodChange: (method: ApiKeyMethod) => void;
	onApiKeyChange: (key: string) => void;
	onShowApiKeyToggle: () => void;
	onEnabledChange: (enabled: boolean) => void;
	onOauthClientIdChange: (id: string) => void;
	onOauthClientSecretChange: (secret: string) => void;
	onShowOAuthSecretToggle: () => void;
	onScopesChange: (scopes: string) => void;
	onUseDcrChange: (useDcr: boolean) => void;
	onTestConnection: () => void;
	onSave: () => void;
	onConnectOAuth: () => void;
	onRegisterDcr?: () => void;
	onUnregisterDcr?: () => void;
}

export function McpConfigDialog({
	open,
	onOpenChange,
	form,
	editingConfig,
	currentOAuthStatus,
	isLoading = false,
	isTesting = false,
	isConnecting = false,
	isRegisteringDcr = false,
	disabled = false,
	onDisplayNameChange,
	onBaseUrlChange,
	onApiKeyMethodChange,
	onApiKeyChange,
	onShowApiKeyToggle,
	onEnabledChange,
	onOauthClientIdChange,
	onOauthClientSecretChange,
	onShowOAuthSecretToggle,
	onScopesChange,
	onUseDcrChange,
	onTestConnection,
	onSave,
	onConnectOAuth,
	onRegisterDcr,
	onUnregisterDcr,
}: McpConfigDialogProps) {
	const server = form.selectedServer;
	const authTypeLabel = getAuthTypeLabel(form.authType);
	const hasDcrEndpoint = !!server?.dcrRegistrationEndpoint;
	const isGitHubServer =
		server?.key === "github-remote" ||
		form.baseUrl?.includes("githubcopilot.com");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle>
						{editingConfig
							? "Configure MCP Server"
							: "Add MCP Server"}
					</DialogTitle>
				</DialogHeader>
				<div className="space-y-3 overflow-y-auto flex-1 pr-2">
					{isGitHubServer && (
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
									(repos, issues, PRs, file contents) without
									requiring a separate MCP server.
								</p>
							</div>
						</div>
					)}
					<div>
						<Label>Server Type</Label>
						<Input
							value={server?.name || server?.key || ""}
							disabled
							className="bg-muted"
						/>
					</div>
					<div>
						<Label>MCP Server Name (Optional)</Label>
						<Input
							value={form.displayName}
							onChange={(e) =>
								onDisplayNameChange(e.target.value)
							}
							placeholder={`My ${server?.name || "Server"} Account`}
						/>
						<p className="mt-1 text-xs text-muted-foreground">
							Give this server a custom name to distinguish it
							from others
						</p>
					</div>
					<div>
						<Label>
							Base URL <span className="text-destructive">*</span>
						</Label>
						<Input
							value={form.baseUrl}
							onChange={(e) => onBaseUrlChange(e.target.value)}
							placeholder={server?.defaultUrl || "https://..."}
							required
							disabled={!!editingConfig || !!server}
							className={
								!!editingConfig || !!server ? "bg-muted" : ""
							}
						/>
						{!!editingConfig || !!server ? (
							<p className="mt-1 text-xs text-muted-foreground">
								Base URL is set from the server registry and
								cannot be changed
							</p>
						) : !form.baseUrl ? (
							<p className="mt-1 text-xs text-destructive">
								Base URL is required
							</p>
						) : null}
					</div>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<div>
							<Label>Auth Type</Label>
							<Input
								value={authTypeLabel}
								disabled
								className="bg-muted"
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								Authentication type is determined by the server
								configuration
							</p>
						</div>
						<div className="flex items-end justify-end">
							<div className="flex items-center gap-2">
								<Label>Enabled</Label>
								<Switch
									checked={form.enabled}
									onCheckedChange={onEnabledChange}
								/>
							</div>
						</div>
					</div>

					{/* API Key Section */}
					{form.authType === "API_KEY" && (
						<div className="space-y-3">
							{/* Only show auth method selector for non-STDIO servers */}
							{server?.transport !== "STDIO" && (
								<div>
									<Label>Authentication Method</Label>
									<Select
										value={form.apiKeyMethod}
										onValueChange={(v) =>
											onApiKeyMethodChange(
												v as ApiKeyMethod,
											)
										}
									>
										<SelectTrigger>
											<SelectValue placeholder="Select method" />
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
									<p className="mt-1 text-xs text-muted-foreground">
										{form.apiKeyMethod === "HEADER"
											? "API key sent as X-API-Key header"
											: form.apiKeyMethod === "PLAIN"
												? "API key sent as Authorization header without Bearer prefix"
												: "API key sent as Authorization: Bearer token"}
									</p>
								</div>
							)}
							<div>
								<Label>
									{server
										? getCredentialLabel(server)
										: "API Key"}
								</Label>
								<div className="relative">
									<Input
										type={
											form.showApiKey
												? "text"
												: "password"
										}
										value={form.apiKey}
										onChange={(e) =>
											onApiKeyChange(e.target.value)
										}
										placeholder={
											server
												? getCredentialPlaceholder(
														server,
													)
												: "sk-..."
										}
										className="pr-10"
										autoComplete="off"
										data-lpignore="true"
										data-1p-ignore
										data-form-type="other"
									/>
									<button
										type="button"
										onClick={onShowApiKeyToggle}
										className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									>
										{form.showApiKey ? (
											<EyeOffIcon className="size-4" />
										) : (
											<EyeIcon className="size-4" />
										)}
									</button>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									{server
										? getCredentialHelpText(server)
										: "Stored encrypted on server."}
								</p>
							</div>
						</div>
					)}

					{/* OAuth Section */}
					{form.authType === "OAUTH2" && (
						<div className="space-y-3">
							{/* DCR Toggle */}
							{hasDcrEndpoint && (
								<div className="flex flex-col gap-2 rounded-md border p-3">
									<div className="flex items-start justify-between gap-3">
										<div>
											<Label className="text-sm font-medium">
												Dynamic Client Registration
											</Label>
											<p className="mt-1 text-xs text-muted-foreground">
												When enabled, client credentials
												are registered automatically
												with this MCP server.
											</p>
											{form.dcrRegisteredAt && (
												<p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
													Registered at{" "}
													{new Date(
														form.dcrRegisteredAt,
													).toLocaleString()}
												</p>
											)}
										</div>
										<div className="flex flex-col items-end gap-2">
											<div className="flex items-center gap-2">
												<Switch
													checked={form.useDcr}
													onCheckedChange={
														onUseDcrChange
													}
												/>
												<span className="text-xs text-muted-foreground">
													{form.useDcr
														? "Enabled"
														: "Disabled"}
												</span>
											</div>
											{form.useDcr &&
												form.dcrRegisteredAt &&
												editingConfig &&
												onUnregisterDcr && (
													<Button
														type="button"
														variant="outline"
														size="sm"
														disabled={
															isRegisteringDcr
														}
														onClick={
															onUnregisterDcr
														}
													>
														Clear registration
													</Button>
												)}
										</div>
									</div>
								</div>
							)}

							{/* OAuth Status Display */}
							{editingConfig && currentOAuthStatus && (
								<div className="rounded-md border border-border p-3">
									<div className="flex items-center justify-between">
										<div>
											<Label className="text-sm font-medium">
												OAuth Connection Status
											</Label>
											<div className="mt-1 space-y-1">
												{currentOAuthStatus.authenticated &&
												!currentOAuthStatus.tokenExpired ? (
													<>
														<p className="text-xs text-success">
															✓ Connected
														</p>
														{currentOAuthStatus.tokenExpiresAt && (
															<p className="text-xs text-muted-foreground">
																Token expires:{" "}
																{new Date(
																	currentOAuthStatus.tokenExpiresAt,
																).toLocaleString()}
															</p>
														)}
													</>
												) : currentOAuthStatus.tokenExpired &&
													currentOAuthStatus.hasRefreshToken ? (
													<p className="text-xs text-highlight">
														⚠ Token expired (refresh
														available)
													</p>
												) : (
													<p className="text-xs text-destructive">
														✗ Not connected
													</p>
												)}
											</div>
										</div>
									</div>
								</div>
							)}

							{/* OAuth Info Banner */}
							<div className="rounded-md border border-border bg-muted/40 p-3">
								<p className="text-sm text-foreground">
									<strong>Automatic OAuth Setup:</strong>{" "}
									Click "Connect with OAuth" below to
									automatically discover endpoints and
									authenticate. Manual credentials are
									optional.
								</p>
							</div>

							{/* Manual Credentials (Collapsible) */}
							<details className="group">
								<summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
									Advanced: Manual OAuth Credentials
									(optional)
								</summary>
								<div className="mt-3 space-y-3">
									<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
										<div>
											<Label>OAuth Client ID</Label>
											<Input
												value={form.oauthClientId}
												onChange={(e) =>
													onOauthClientIdChange(
														e.target.value,
													)
												}
												placeholder="client_id"
												autoComplete="off"
												data-lpignore="true"
												data-1p-ignore
												data-form-type="other"
											/>
										</div>
										<div>
											<Label>OAuth Client Secret</Label>
											<div className="relative">
												<Input
													type={
														form.showOAuthSecret
															? "text"
															: "password"
													}
													value={
														form.oauthClientSecret
													}
													onChange={(e) =>
														onOauthClientSecretChange(
															e.target.value,
														)
													}
													placeholder="client_secret"
													className="pr-10"
													autoComplete="off"
													data-lpignore="true"
													data-1p-ignore
													data-form-type="other"
												/>
												<button
													type="button"
													onClick={
														onShowOAuthSecretToggle
													}
													className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
												>
													{form.showOAuthSecret ? (
														<EyeOffIcon className="size-4" />
													) : (
														<EyeIcon className="size-4" />
													)}
												</button>
											</div>
											<p className="mt-1 text-xs text-muted-foreground">
												Stored encrypted on server.
											</p>
										</div>
									</div>
									<p className="text-xs text-muted-foreground">
										Only provide manual credentials if
										automatic discovery fails or if you have
										pre-registered OAuth credentials.
									</p>
								</div>
							</details>

							{/* Scopes */}
							<div>
								<Label>Scopes (space-separated)</Label>
								<Input
									value={form.scopes}
									onChange={(e) =>
										onScopesChange(e.target.value)
									}
									placeholder="read write offline_access"
								/>
								{form.useDcr && hasDcrEndpoint && (
									<p className="mt-1 text-xs text-muted-foreground">
										Scopes will be sent during Dynamic
										Client Registration.
									</p>
								)}
							</div>

							{/* OAuth Actions */}
							<div className="flex justify-between gap-2">
								{form.useDcr &&
									hasDcrEndpoint &&
									onRegisterDcr && (
										<Button
											type="button"
											variant="outline"
											disabled={
												isRegisteringDcr ||
												!server ||
												!form.baseUrl
											}
											onClick={onRegisterDcr}
										>
											{isRegisteringDcr ? (
												<LoaderIcon className="mr-1 size-4 animate-spin" />
											) : (
												<CheckCircleIcon className="mr-1 size-4" />
											)}{" "}
											{form.dcrRegisteredAt
												? "Re-register client"
												: "Register client"}
										</Button>
									)}

								<Button
									type="button"
									variant="secondary"
									disabled={!server || isConnecting}
									onClick={onConnectOAuth}
								>
									{isConnecting ? (
										<LoaderIcon className="mr-1 size-4 animate-spin" />
									) : (
										<CheckCircleIcon className="mr-1 size-4" />
									)}{" "}
									{editingConfig &&
									currentOAuthStatus?.authenticated &&
									!currentOAuthStatus?.tokenExpired
										? "Re-authenticate"
										: "Connect with OAuth"}
								</Button>
							</div>
						</div>
					)}
				</div>
				<DialogFooter className="flex-row justify-between flex-shrink-0 pt-4 border-t">
					<Button
						type="button"
						variant="secondary"
						onClick={onTestConnection}
						disabled={isTesting || !form.baseUrl}
					>
						{isTesting ? (
							<LoaderIcon className="mr-1 size-4 animate-spin" />
						) : (
							<TestTube2Icon className="mr-1 size-4" />
						)}{" "}
						Test Connection
					</Button>
					<div className="flex gap-2">
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={onSave}
							disabled={
								isLoading ||
								!server ||
								!form.baseUrl ||
								disabled
							}
						>
							{isLoading ? (
								<LoaderIcon className="mr-1 size-4 animate-spin" />
							) : (
								<CheckCircleIcon className="mr-1 size-4" />
							)}{" "}
							Save
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
