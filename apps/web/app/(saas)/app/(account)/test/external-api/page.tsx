"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInfo {
	id: string;
	sId: string;
	name: string;
	description?: string;
	executionMode: string;
	template?: { slug: string; displayName: string; category?: string };
	deploymentId?: string | null;
}

interface UploadedFile {
	fileId: string;
	name: string;
	size: number;
	mimeType: string;
}

interface ExecutionResult {
	executionId: string;
	status: string;
	input?: Record<string, unknown>;
	output?: unknown;
	error?: string | null;
	durationMs?: number;
	tokenUsage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalCost?: number;
	};
	steps?: Array<{
		stepNumber: number;
		stepType: string;
		name: string;
		status: string;
		duration?: number;
	}>;
	artifacts?: Array<{
		id: string;
		name: string;
		mimeType: string;
		url: string;
	}>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
]);

function statusColor(status: string) {
	switch (status) {
		case "COMPLETED":
			return "success" as const;
		case "RUNNING":
		case "PENDING":
			return "secondary" as const;
		case "FAILED":
		case "TIMED_OUT":
		case "CANCELLED":
			return "error" as const;
		default:
			return "outline" as const;
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ExternalApiTestPage() {
	// -- Setup state --
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("http://localhost:3001");
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentsLoading, setAgentsLoading] = useState(false);
	const [agentsError, setAgentsError] = useState<string | null>(null);

	// -- Upload state --
	const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// -- Execute state --
	const [selectedAgent, setSelectedAgent] = useState<string>("");
	const [userMessage, setUserMessage] = useState("");
	const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(
		new Set(),
	);
	const [streaming, setStreaming] = useState(false);
	const [executing, setExecuting] = useState(false);
	const [executeError, setExecuteError] = useState<string | null>(null);

	// -- Tab state --
	const [activeTab, setActiveTab] = useState("setup");

	// -- Results state --
	const [executionResult, setExecutionResult] =
		useState<ExecutionResult | null>(null);
	const [sseEvents, setSseEvents] = useState<
		Array<{ event: string; data: string; timestamp: string }>
	>([]);
	const [showRawJson, setShowRawJson] = useState(false);
	const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// -- Helpers --
	const headers = useCallback(
		() => ({
			Authorization: `Bearer ${apiKey}`,
		}),
		[apiKey],
	);

	const apiBase = `${baseUrl.replace(/\/$/, "")}/api/v1/external`;

	// ---------------------------------------------------------------------------
	// Setup: List Agents
	// ---------------------------------------------------------------------------

	async function handleListAgents() {
		setAgentsLoading(true);
		setAgentsError(null);
		try {
			const res = await fetch(`${apiBase}/agents`, {
				headers: headers(),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(
					(err as { error?: string }).error || `HTTP ${res.status}`,
				);
			}
			const data: AgentInfo[] = await res.json();
			setAgents(data);
		} catch (e) {
			setAgentsError(
				e instanceof Error ? e.message : "Failed to list agents",
			);
		} finally {
			setAgentsLoading(false);
		}
	}

	// ---------------------------------------------------------------------------
	// Upload
	// ---------------------------------------------------------------------------

	async function handleUpload() {
		const file = fileInputRef.current?.files?.[0];
		if (!file) {
			return;
		}

		setUploading(true);
		setUploadError(null);

		const formData = new FormData();
		formData.append("file", file);

		try {
			const res = await fetch(`${apiBase}/agents/files`, {
				method: "POST",
				headers: headers(),
				body: formData,
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(
					(err as { error?: string }).error || `HTTP ${res.status}`,
				);
			}
			const data: UploadedFile = await res.json();
			setUploadedFiles((prev) => [...prev, data]);
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
		} catch (e) {
			setUploadError(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setUploading(false);
		}
	}

	// ---------------------------------------------------------------------------
	// Execute
	// ---------------------------------------------------------------------------

	function stopPolling() {
		if (pollingRef.current) {
			clearInterval(pollingRef.current);
			pollingRef.current = null;
		}
	}

	async function pollExecution(executionId: string) {
		try {
			const res = await fetch(`${apiBase}/executions/${executionId}`, {
				headers: headers(),
			});
			if (!res.ok) {
				return;
			}
			const data: ExecutionResult = await res.json();
			setExecutionResult(data);
			if (TERMINAL_STATUSES.has(data.status)) {
				stopPolling();
				setExecuting(false);
			}
		} catch {
			// keep polling
		}
	}

	async function handleExecute() {
		if (!selectedAgent) {
			return;
		}

		setActiveTab("results");
		setExecuting(true);
		setExecuteError(null);
		setExecutionResult(null);
		setSseEvents([]);
		stopPolling();

		const images = Array.from(selectedFileIds)
			.map((fid) => {
				const f = uploadedFiles.find((uf) => uf.fileId === fid);
				return f
					? { fileId: f.fileId, mimeType: f.mimeType, name: f.name }
					: null;
			})
			.filter(Boolean);

		const body: Record<string, unknown> = {
			input: { query: userMessage },
			stream: streaming,
		};
		if (images.length > 0) {
			body.images = images;
		}

		try {
			const res = await fetch(
				`${apiBase}/agents/${selectedAgent}/execute`,
				{
					method: "POST",
					headers: {
						...headers(),
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(
					(err as { error?: string }).error || `HTTP ${res.status}`,
				);
			}

			if (streaming) {
				// Capture executionId from response header for post-stream polling
				const streamExecutionId =
					res.headers.get("X-Execution-Id") || null;

				// Read SSE stream
				const reader = res.body?.getReader();
				const decoder = new TextDecoder();
				if (!reader) {
					throw new Error("No readable stream");
				}

				let buffer = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					// Keep incomplete last line in buffer
					buffer = lines.pop() || "";

					let currentEvent = "";
					for (const line of lines) {
						if (line.startsWith("event: ")) {
							currentEvent = line.slice(7).trim();
						} else if (line.startsWith("data: ")) {
							const dataStr = line.slice(6);
							setSseEvents((prev) => [
								...prev,
								{
									event: currentEvent || "message",
									data: dataStr,
									timestamp: new Date().toISOString(),
								},
							]);

							// Try to extract final result from terminal events
							if (
								currentEvent === "execution.completed" ||
								currentEvent === "execution.failed"
							) {
								try {
									const parsed = JSON.parse(dataStr);
									setExecutionResult((prev) => ({
										...prev,
										executionId:
											prev?.executionId || "streamed",
										status:
											currentEvent ===
											"execution.completed"
												? "COMPLETED"
												: "FAILED",
										output: parsed.output,
										error: parsed.error,
										durationMs: parsed.durationMs,
									}));
								} catch {
									// ignore parse errors
								}
							}
							currentEvent = "";
						}
					}
				}
				// After streaming ends, fetch full execution result (for status + artifacts)
				if (streamExecutionId) {
					try {
						const pollRes = await fetch(
							`${apiBase}/executions/${streamExecutionId}`,
							{ headers: headers() },
						);
						if (pollRes.ok) {
							const data =
								(await pollRes.json()) as ExecutionResult;
							setExecutionResult(data);
						}
					} catch {
						// ignore — SSE events already populated the result
					}
				}
				setExecuting(false);
			} else {
				// Polling mode
				const data = await res.json();
				setExecutionResult(data as ExecutionResult);
				if (!TERMINAL_STATUSES.has((data as ExecutionResult).status)) {
					pollingRef.current = setInterval(
						() =>
							pollExecution(
								(data as ExecutionResult).executionId,
							),
						2000,
					);
				} else {
					setExecuting(false);
				}
			}
		} catch (e) {
			setExecuteError(
				e instanceof Error ? e.message : "Execution failed",
			);
			setExecuting(false);
		}
	}

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------

	return (
		<div className="mx-auto max-w-4xl px-4 py-8">
			<h1 className="mb-1 font-bold text-2xl">
				External API Test Client
			</h1>
			<p className="mb-6 text-muted-foreground text-sm">
				Dev-only page for testing the external agent API with image
				support.
			</p>

			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="space-y-4"
			>
				<TabsList>
					<TabsTrigger value="setup">Setup</TabsTrigger>
					<TabsTrigger value="upload">Upload Image</TabsTrigger>
					<TabsTrigger value="execute">Execute</TabsTrigger>
					<TabsTrigger value="results">Results</TabsTrigger>
				</TabsList>

				{/* ============================================================ */}
				{/* SETUP TAB                                                     */}
				{/* ============================================================ */}
				<TabsContent value="setup" className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle>API Configuration</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="api-key">API Key</Label>
								<Input
									id="api-key"
									type="password"
									placeholder="fab_... or org_..."
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="base-url">Base URL</Label>
								<Input
									id="base-url"
									placeholder="http://localhost:3001"
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
								/>
							</div>
							<Button
								onClick={handleListAgents}
								disabled={!apiKey || agentsLoading}
							>
								{agentsLoading ? "Loading..." : "List Agents"}
							</Button>

							{agentsError && (
								<Alert variant="error">
									<AlertDescription>
										{agentsError}
									</AlertDescription>
								</Alert>
							)}
						</CardContent>
					</Card>

					{agents.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>
									Available Agents ({agents.length})
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="grid gap-3">
									{agents.map((agent) => (
										<div
											key={agent.id}
											className="flex items-center justify-between rounded-lg border p-3"
										>
											<div>
												<p className="font-medium">
													{agent.name}
												</p>
												{agent.description && (
													<p className="text-muted-foreground text-sm">
														{agent.description}
													</p>
												)}
												<div className="mt-1 flex gap-2">
													<Badge variant="outline">
														{agent.executionMode}
													</Badge>
													{agent.template && (
														<Badge variant="secondary">
															{
																agent.template
																	.displayName
															}
														</Badge>
													)}
												</div>
											</div>
											<code className="text-muted-foreground text-xs">
												{agent.id.slice(0, 8)}...
											</code>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					)}
				</TabsContent>

				{/* ============================================================ */}
				{/* UPLOAD TAB                                                    */}
				{/* ============================================================ */}
				<TabsContent value="upload" className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle>Upload Image</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="file-upload">
									Select Image (PNG, JPEG, WebP, GIF &mdash;
									max 10MB)
								</Label>
								<Input
									id="file-upload"
									type="file"
									accept="image/png,image/jpeg,image/webp,image/gif"
									ref={fileInputRef}
								/>
							</div>
							<Button
								onClick={handleUpload}
								disabled={uploading || !apiKey}
							>
								{uploading ? "Uploading..." : "Upload"}
							</Button>

							{uploadError && (
								<Alert variant="error">
									<AlertDescription>
										{uploadError}
									</AlertDescription>
								</Alert>
							)}
						</CardContent>
					</Card>

					{uploadedFiles.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>
									Uploaded Files ({uploadedFiles.length})
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="space-y-2">
									{uploadedFiles.map((f) => (
										<div
											key={f.fileId}
											className="flex items-center justify-between rounded-lg border p-3"
										>
											<div>
												<p className="font-medium text-sm">
													{f.name}
												</p>
												<p className="text-muted-foreground text-xs">
													{f.mimeType} &middot;{" "}
													{(f.size / 1024).toFixed(1)}{" "}
													KB
												</p>
											</div>
											<code className="max-w-[200px] truncate text-muted-foreground text-xs">
												{f.fileId.slice(0, 20)}...
											</code>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					)}
				</TabsContent>

				{/* ============================================================ */}
				{/* EXECUTE TAB                                                   */}
				{/* ============================================================ */}
				<TabsContent value="execute" className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle>Execute Agent</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label>Agent</Label>
								<Select
									value={selectedAgent}
									onValueChange={setSelectedAgent}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select an agent..." />
									</SelectTrigger>
									<SelectContent>
										{agents.map((a) => (
											<SelectItem key={a.id} value={a.id}>
												{a.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{agents.length === 0 && (
									<p className="text-muted-foreground text-xs">
										Go to Setup tab and list agents first.
									</p>
								)}
							</div>

							<div className="space-y-2">
								<Label htmlFor="user-message">
									Message / Query
								</Label>
								<Textarea
									id="user-message"
									placeholder="Enter your query for the agent..."
									value={userMessage}
									onChange={(e) =>
										setUserMessage(e.target.value)
									}
									rows={3}
								/>
							</div>

							{uploadedFiles.length > 0 && (
								<div className="space-y-2">
									<Label>Attach Images</Label>
									<div className="space-y-1">
										{uploadedFiles.map((f) => (
											<label
												key={f.fileId}
												className="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm hover:bg-muted/50"
											>
												<input
													type="checkbox"
													checked={selectedFileIds.has(
														f.fileId,
													)}
													onChange={(e) => {
														setSelectedFileIds(
															(prev) => {
																const next =
																	new Set(
																		prev,
																	);
																if (
																	e.target
																		.checked
																) {
																	next.add(
																		f.fileId,
																	);
																} else {
																	next.delete(
																		f.fileId,
																	);
																}
																return next;
															},
														);
													}}
												/>
												{f.name}{" "}
												<span className="text-muted-foreground text-xs">
													({f.mimeType})
												</span>
											</label>
										))}
									</div>
								</div>
							)}

							<div className="flex items-center gap-2">
								<label className="flex cursor-pointer items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={streaming}
										onChange={(e) =>
											setStreaming(e.target.checked)
										}
									/>
									Stream response (SSE)
								</label>
							</div>

							<Button
								onClick={handleExecute}
								disabled={
									executing || !selectedAgent || !apiKey
								}
							>
								{executing ? "Executing..." : "Execute"}
							</Button>

							{executeError && (
								<Alert variant="error">
									<AlertDescription>
										{executeError}
									</AlertDescription>
								</Alert>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				{/* ============================================================ */}
				{/* RESULTS TAB                                                   */}
				{/* ============================================================ */}
				<TabsContent value="results" className="space-y-4">
					{/* Execution Status */}
					{executionResult && (
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center justify-between">
									<span>Execution Result</span>
									<Badge
										variant={statusColor(
											executionResult.status,
										)}
									>
										{executionResult.status}
									</Badge>
								</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid grid-cols-2 gap-4 text-sm">
									<div>
										<span className="text-muted-foreground">
											Execution ID
										</span>
										<p className="font-mono text-xs">
											{executionResult.executionId}
										</p>
									</div>
									{executionResult.durationMs != null && (
										<div>
											<span className="text-muted-foreground">
												Duration
											</span>
											<p>
												{(
													executionResult.durationMs /
													1000
												).toFixed(2)}
												s
											</p>
										</div>
									)}
									{executionResult.tokenUsage && (
										<>
											<div>
												<span className="text-muted-foreground">
													Input Tokens
												</span>
												<p>
													{executionResult.tokenUsage
														.inputTokens ?? "–"}
												</p>
											</div>
											<div>
												<span className="text-muted-foreground">
													Output Tokens
												</span>
												<p>
													{executionResult.tokenUsage
														.outputTokens ?? "–"}
												</p>
											</div>
										</>
									)}
								</div>

								{executionResult.error && (
									<Alert variant="error">
										<AlertDescription>
											{executionResult.error}
										</AlertDescription>
									</Alert>
								)}

								{executionResult.output != null && (
									<div className="space-y-2">
										<Label>Output</Label>
										<ScrollArea className="h-64 rounded-md border p-3">
											<pre className="whitespace-pre-wrap font-mono text-sm">
												{typeof executionResult.output ===
												"string"
													? executionResult.output
													: JSON.stringify(
															executionResult.output,
															null,
															2,
														)}
											</pre>
										</ScrollArea>
									</div>
								)}

								{executionResult.artifacts &&
									executionResult.artifacts.length > 0 && (
										<div className="space-y-2">
											<Label>
												Generated Images (
												{
													executionResult.artifacts
														.length
												}
												)
											</Label>
											<div className="grid grid-cols-2 gap-4">
												{executionResult.artifacts.map(
													(art) => (
														<div
															key={art.id}
															className="space-y-2 rounded-md border p-3"
														>
															<Image
																src={art.url}
																alt={art.name}
																width={800}
																height={600}
																unoptimized
																className="h-auto w-full rounded-md"
															/>
															<div className="flex items-center justify-between text-xs text-muted-foreground">
																<span>
																	{art.name}
																</span>
																<a
																	href={
																		art.url
																	}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="text-blue-500 underline"
																>
																	Download
																</a>
															</div>
														</div>
													),
												)}
											</div>
										</div>
									)}

								{executionResult.steps &&
									executionResult.steps.length > 0 && (
										<div className="space-y-2">
											<Label>Steps</Label>
											<div className="space-y-1">
												{executionResult.steps.map(
													(step) => (
														<div
															key={
																step.stepNumber
															}
															className="flex items-center justify-between rounded border px-3 py-2 text-sm"
														>
															<span>
																{
																	step.stepNumber
																}
																. {step.name}
															</span>
															<div className="flex items-center gap-2">
																{step.duration !=
																	null && (
																	<span className="text-muted-foreground text-xs">
																		{
																			step.duration
																		}
																		ms
																	</span>
																)}
																<Badge
																	variant={statusColor(
																		step.status,
																	)}
																	className="text-xs"
																>
																	{
																		step.status
																	}
																</Badge>
															</div>
														</div>
													),
												)}
											</div>
										</div>
									)}
							</CardContent>
						</Card>
					)}

					{/* SSE Events Log */}
					{sseEvents.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle>
									SSE Events ({sseEvents.length})
								</CardTitle>
							</CardHeader>
							<CardContent>
								<ScrollArea className="h-80">
									<div className="space-y-1 font-mono text-xs">
										{sseEvents.map((evt, i) => (
											<div
												key={`${evt.timestamp}-${i}`}
												className="rounded border-l-2 border-blue-500 bg-muted/30 p-2"
											>
												<div className="flex items-center gap-2">
													<Badge
														variant="outline"
														className="text-xs"
													>
														{evt.event}
													</Badge>
													<span className="text-muted-foreground">
														{new Date(
															evt.timestamp,
														).toLocaleTimeString()}
													</span>
												</div>
												<pre className="mt-1 whitespace-pre-wrap text-muted-foreground">
													{evt.data}
												</pre>
											</div>
										))}
									</div>
								</ScrollArea>
							</CardContent>
						</Card>
					)}

					{/* Raw JSON */}
					<Card>
						<CardHeader>
							<CardTitle className="flex items-center justify-between">
								<span>Raw JSON</span>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowRawJson(!showRawJson)}
								>
									{showRawJson ? "Hide" : "Show"}
								</Button>
							</CardTitle>
						</CardHeader>
						{showRawJson && (
							<CardContent>
								<ScrollArea className="h-64 rounded-md border p-3">
									<pre className="whitespace-pre-wrap font-mono text-xs">
										{JSON.stringify(
											executionResult,
											null,
											2,
										) || "No execution data yet."}
									</pre>
								</ScrollArea>
							</CardContent>
						)}
					</Card>

					{!executionResult && sseEvents.length === 0 && (
						<p className="py-8 text-center text-muted-foreground text-sm">
							No results yet. Execute an agent from the Execute
							tab.
						</p>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
