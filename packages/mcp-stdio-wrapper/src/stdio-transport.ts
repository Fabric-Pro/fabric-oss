/**
 * STDIO Transport for MCP Servers
 *
 * Manages the lifecycle of MCP STDIO processes with:
 * - Credential injection via environment variables (MCP-compliant)
 * - JSON-RPC message passing over stdin/stdout
 * - Process health monitoring
 * - Graceful shutdown
 *
 * Per MCP Authorization Documentation:
 * "For MCP servers using the STDIO transport, you can use environment-based credentials"
 *
 * @see https://modelcontextprotocol.io/docs/tutorials/security/authorization
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface StdioTransportConfig {
	/** The command to run (e.g., 'npx') */
	command: string;
	/** Arguments for the command (e.g., ['@azure-devops/mcp', 'myorg']) */
	args: string[];
	/** Environment variables to set (credentials go here) */
	env?: Record<string, string>;
	/** Working directory for the process */
	cwd?: string;
	/** Timeout for process startup in milliseconds (default: 30000) */
	startupTimeoutMs?: number;
	/** Timeout for requests in milliseconds (default: 30000) */
	requestTimeoutMs?: number;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30 * 1000; // 30 seconds
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000; // 30 seconds

export class StdioTransport {
	private process: ChildProcess | null = null;
	private readline: Interface | null = null;
	private requestId = 0;
	private pendingRequests = new Map<number | string, PendingRequest>();
	private isClosing = false;
	private readonly config: StdioTransportConfig;
	private readonly startupTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	constructor(config: StdioTransportConfig) {
		this.config = config;
		this.startupTimeoutMs =
			config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		this.requestTimeoutMs =
			config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * Start the MCP server process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Process already started");
		}

		return new Promise((resolve, reject) => {
			// SECURITY: Never log credentials
			const safeEnvKeys = Object.keys(this.config.env ?? {}).filter(
				(key) =>
					!key.toLowerCase().includes("key") &&
					!key.toLowerCase().includes("token") &&
					!key.toLowerCase().includes("secret") &&
					!key.toLowerCase().includes("password") &&
					!key.toLowerCase().includes("pat"),
			);
			console.log(
				`[StdioTransport] Starting: ${this.config.command} ${this.config.args.join(" ")}`,
			);
			console.log(
				`[StdioTransport] Environment keys (safe to log): ${safeEnvKeys.join(", ")}`,
			);

			const startupTimeout = setTimeout(() => {
				reject(
					new Error(
						`Process startup timeout after ${this.startupTimeoutMs}ms`,
					),
				);
				this.close().catch(() => {});
			}, this.startupTimeoutMs);

			try {
				this.process = spawn(this.config.command, this.config.args, {
					cwd: this.config.cwd,
					env: {
						...process.env,
						...this.config.env,
					},
					stdio: ["pipe", "pipe", "pipe"],
				});

				// Handle process errors
				this.process.on("error", (error) => {
					clearTimeout(startupTimeout);
					console.error("[StdioTransport] Process error:", error);
					reject(
						new Error(`Failed to start process: ${error.message}`),
					);
					this.handleProcessExit();
				});

				// Handle process exit
				this.process.on("exit", (code, signal) => {
					console.log(
						`[StdioTransport] Process exited with code: ${code}, signal: ${signal}`,
					);
					this.handleProcessExit();
				});

				// Handle stderr for debugging
				this.process.stderr?.on("data", (data: Buffer) => {
					const message = data.toString().trim();
					if (message) {
						// Don't log if it might contain credentials
						if (
							!message.toLowerCase().includes("key") &&
							!message.toLowerCase().includes("token")
						) {
							console.error("[StdioTransport] stderr:", message);
						} else {
							console.error(
								"[StdioTransport] stderr: [message redacted - may contain credentials]",
							);
						}
					}
				});

				// Set up readline for JSON-RPC responses
				if (!this.process.stdout) {
					throw new Error("Process stdout is not available");
				}
				this.readline = createInterface({
					input: this.process.stdout,
					crlfDelay: Number.POSITIVE_INFINITY,
				});

				this.readline.on("line", (line) => {
					this.handleLine(line);
				});

				this.readline.on("close", () => {
					console.log("[StdioTransport] Readline closed");
				});

				// Consider the process started once we have stdin/stdout ready
				// In production, you might want to send an initialize request first
				setTimeout(() => {
					clearTimeout(startupTimeout);
					resolve();
				}, 100);
			} catch (error) {
				clearTimeout(startupTimeout);
				reject(error);
			}
		});
	}

	/**
	 * Send a JSON-RPC request to the MCP server and wait for response.
	 */
	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.process || this.isClosing) {
			throw new Error("Transport not connected");
		}

		const id = ++this.requestId;
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					new Error(
						`Request timeout after ${this.requestTimeoutMs}ms`,
					),
				);
			}, this.requestTimeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timeout });

			const message = JSON.stringify(request);
			console.log(`[StdioTransport] Sending request: ${method}`);

			this.process?.stdin?.write(`${message}\n`, (error) => {
				if (error) {
					clearTimeout(timeout);
					this.pendingRequests.delete(id);
					reject(
						new Error(`Failed to send request: ${error.message}`),
					);
				}
			});
		});
	}

	/**
	 * Send a JSON-RPC notification (no response expected).
	 */
	async notify(method: string, params?: unknown): Promise<void> {
		if (!this.process || this.isClosing) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0",
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			const message = JSON.stringify(notification);
			console.log(`[StdioTransport] Sending notification: ${method}`);

			this.process?.stdin?.write(`${message}\n`, (error) => {
				if (error) {
					reject(
						new Error(
							`Failed to send notification: ${error.message}`,
						),
					);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Check if the process is still alive.
	 */
	isAlive(): boolean {
		return (
			this.process !== null &&
			!this.isClosing &&
			this.process.exitCode === null &&
			this.process.signalCode === null
		);
	}

	/**
	 * Close the transport and terminate the process.
	 */
	async close(): Promise<void> {
		if (this.isClosing) {
			return;
		}

		this.isClosing = true;
		console.log("[StdioTransport] Closing transport");

		// Clear all pending requests
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Transport closed"));
			this.pendingRequests.delete(id);
		}

		// Close readline
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}

		// Terminate the process
		if (this.process) {
			// Try graceful shutdown first
			this.process.stdin?.end();

			// Wait a bit then force kill
			await new Promise<void>((resolve) => {
				const forceKillTimeout = setTimeout(() => {
					if (this.process && this.process.exitCode === null) {
						console.log("[StdioTransport] Force killing process");
						this.process.kill("SIGKILL");
					}
					resolve();
				}, 5000);

				if (this.process) {
					this.process.once("exit", () => {
						clearTimeout(forceKillTimeout);
						resolve();
					});

					// Try SIGTERM first
					this.process.kill("SIGTERM");
				} else {
					clearTimeout(forceKillTimeout);
					resolve();
				}
			});

			this.process = null;
		}

		console.log("[StdioTransport] Transport closed");
	}

	/**
	 * Handle a line of output from the process.
	 */
	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}

		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;

			if (
				"id" in parsed &&
				parsed.id !== undefined &&
				"method" in parsed &&
				typeof parsed.method === "string"
			) {
				this.handleServerRequest(
					parsed.id as string | number,
					parsed.method,
				);
				return;
			}

			const response = parsed as unknown as JsonRpcResponse;

			if ("id" in response && response.id !== undefined) {
				const pending = this.pendingRequests.get(response.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(response.id);

					if (response.error) {
						pending.reject(
							new Error(
								`MCP error ${response.error.code}: ${response.error.message}`,
							),
						);
					} else {
						pending.resolve(response.result);
					}
				}
			} else {
				console.log(
					"[StdioTransport] Received notification:",
					response,
				);
			}
		} catch {
			if (
				!line.toLowerCase().includes("key") &&
				!line.toLowerCase().includes("token")
			) {
				console.log("[StdioTransport] Non-JSON output:", line);
			}
		}
	}

	private handleServerRequest(id: string | number, method: string): void {
		console.log(`[StdioTransport] Server request: ${method} (id=${id})`);

		let result: unknown;
		if (method === "elicitation/create") {
			result = { action: "cancel" };
		} else {
			result = {};
		}

		const reply = JSON.stringify({
			jsonrpc: "2.0",
			id,
			result,
		});

		this.process?.stdin?.write(`${reply}\n`, (error) => {
			if (error) {
				console.error(
					`[StdioTransport] Failed to reply to server request ${method}:`,
					error.message,
				);
			}
		});
	}

	/**
	 * Handle process exit.
	 */
	private handleProcessExit(): void {
		// Reject all pending requests
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Process exited unexpectedly"));
			this.pendingRequests.delete(id);
		}

		this.process = null;
	}
}

/**
 * Create and start a STDIO transport.
 */
export async function createStdioTransport(
	config: StdioTransportConfig,
): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.start();
	return transport;
}
