import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { debugLog, env } from "./env";
import {
	PortUnavailableError,
	RuntimeNotFoundError,
	SessionValidationError,
	TimeoutError,
	toProviderError,
	WorkspaceError,
} from "./errors";
import type {
	CodingExecutionProvider,
	CreateSessionParams,
	HealthCheckResult,
	SessionStatus,
} from "./provider";
import { validateCreateSessionParams } from "./schemas";
import { sanitizeBranchName, validateWorkingDirectory } from "./security";

interface EncodedLocalSession {
	taskId: string;
	runtimePort: number;
	workspacePath: string;
}

interface KanbanTaskRecord {
	id: string;
	column: string;
	baseRef?: string;
	session?: {
		state?: string;
		reviewReason?: string | null;
	};
}

interface KanbanTaskListResult {
	ok: boolean;
	workspacePath: string;
	tasks: KanbanTaskRecord[];
	count: number;
}

function encodeLocalSession(session: EncodedLocalSession): string {
	return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

export function decodeLocalKanbanSession(
	sessionId: string,
): EncodedLocalSession {
	try {
		const raw = Buffer.from(sessionId, "base64url").toString("utf8");
		const parsed = JSON.parse(raw) as EncodedLocalSession;
		if (!parsed.taskId || !parsed.runtimePort || !parsed.workspacePath) {
			throw new Error("Missing required local session fields");
		}
		return parsed;
	} catch (error) {
		throw new SessionValidationError(
			"KANBAN_LOCAL",
			`Invalid local Kanban session identifier: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * Checks if a port is available for binding
 */
async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve(true));
		});
	});
}

/**
 * Finds an available port using random sampling for efficiency
 */
async function findAvailablePort(maxAttempts = 50): Promise<number> {
	const { start, end } = env.KANBAN_RUNTIME_PORT_RANGE;
	const tried = new Set<number>();

	debugLog("Finding available port", {
		range: `${start}-${end}`,
		maxAttempts,
	});

	for (let i = 0; i < maxAttempts; i++) {
		// Random port in range to avoid collision hotspots
		const port = start + Math.floor(Math.random() * (end - start));
		if (tried.has(port)) {
			continue;
		}
		tried.add(port);

		const available = await isPortAvailable(port);
		if (available) {
			debugLog("Found available port", { port, attempts: i + 1 });
			return port;
		}
	}

	throw new PortUnavailableError("KANBAN_LOCAL", start, maxAttempts);
}

export function getLocalKanbanSessionUrl(sessionId: string): string {
	const session = decodeLocalKanbanSession(sessionId);
	return `http://127.0.0.1:${session.runtimePort}`;
}

async function waitForRuntime(
	port: number,
	timeoutMs = env.KANBAN_RUNTIME_START_TIMEOUT_MS,
): Promise<void> {
	const startedAt = Date.now();
	const checkInterval = 500;

	debugLog("Waiting for runtime to start", { port, timeoutMs });

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/api/trpc/projects.list`,
				{
					method: "GET",
					signal: AbortSignal.timeout(1500),
				},
			);
			if (
				response.ok ||
				response.status === 400 ||
				response.status === 404
			) {
				debugLog("Runtime started", {
					port,
					elapsedMs: Date.now() - startedAt,
				});
				return;
			}
		} catch {
			// Runtime is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, checkInterval));
	}

	throw new TimeoutError("KANBAN_LOCAL", "Runtime startup", timeoutMs);
}

const KANBAN_COMMAND_CANDIDATES: Array<{
	command: "fabric-kanban" | "npx";
	baseArgs: string[];
}> = [
	{ command: "fabric-kanban", baseArgs: [] },
	{ command: "npx", baseArgs: ["--yes", "@fabriccode/kanban@latest"] },
];

type KanbanCommandCandidate = (typeof KANBAN_COMMAND_CANDIDATES)[number];

/**
 * The command argument to spawn/spawnSync must stay a string LITERAL at
 * every call site: Turbopack special-cases `child_process` during output
 * file tracing, and a non-static command makes it trace the ENTIRE
 * monorepo into every app route that imports this module (the
 * "Encountered unexpected file in NFT list" build warning).
 * `turbopackIgnore` hints are not honored on child_process calls, so
 * branching on the candidate kind is the only way to keep it static.
 */
function spawnSyncKanban(
	candidate: KanbanCommandCandidate,
	args: string[],
	options: Parameters<typeof spawnSync>[2],
) {
	return candidate.command === "npx"
		? spawnSync("npx", args, options)
		: spawnSync("fabric-kanban", args, options);
}

function spawnKanban(
	candidate: KanbanCommandCandidate,
	args: string[],
	options: Parameters<typeof spawn>[2],
) {
	return candidate.command === "npx"
		? spawn("npx", args, options)
		: spawn("fabric-kanban", args, options);
}

function resolveKanbanCommandCandidate(): KanbanCommandCandidate {
	for (const candidate of KANBAN_COMMAND_CANDIDATES) {
		const result = spawnSyncKanban(
			candidate,
			[...candidate.baseArgs, "--help"],
			{
				stdio: "ignore",
				env: process.env,
			},
		);
		if (!result.error) {
			debugLog("Found kanban command", { command: candidate.command });
			return candidate;
		}
	}

	throw new RuntimeNotFoundError(
		"KANBAN_LOCAL",
		"fabric-kanban (install with: npm install -g @fabriccode/kanban@latest)",
	);
}

async function runKanbanCommand(
	args: string[],
	options: { cwd: string; runtimePort: number; parseJson?: boolean },
): Promise<Record<string, unknown> | string> {
	const cmdEnv = {
		...process.env,
		KANBAN_RUNTIME_HOST: "127.0.0.1",
		KANBAN_RUNTIME_PORT: String(options.runtimePort),
	};

	const candidate = resolveKanbanCommandCandidate();

	debugLog("Running kanban command", {
		command: candidate.command,
		args: args.join(" "),
		cwd: options.cwd,
	});

	return await new Promise<Record<string, unknown> | string>(
		(resolve, reject) => {
			const child = spawnKanban(
				candidate,
				[...candidate.baseArgs, ...args],
				{
					cwd: options.cwd,
					env: cmdEnv,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			let stdout = "";
			let stderr = "";
			// Optional chaining only for the compiler: the stdio tuple above
			// guarantees piped stdout/stderr, but the spawnKanban wrapper
			// erases the tuple-specific overload's non-null types.
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", (error) => {
				reject(
					toProviderError(error, "KANBAN_LOCAL", "WORKSPACE_ERROR"),
				);
			});
			child.on("close", (code) => {
				if (code !== 0) {
					reject(
						new WorkspaceError(
							"KANBAN_LOCAL",
							`Kanban command failed (${code}): ${stderr.trim() || stdout.trim()}`,
							undefined,
							{ code, stderr, stdout },
						),
					);
					return;
				}

				if (!options.parseJson) {
					resolve(stdout);
					return;
				}

				try {
					resolve(JSON.parse(stdout) as Record<string, unknown>);
				} catch (error) {
					reject(
						new SessionValidationError(
							"KANBAN_LOCAL",
							`Failed to parse Kanban JSON output: ${error instanceof Error ? error.message : String(error)}`,
							error,
						),
					);
				}
			});
		},
	);
}

async function runKanbanJsonCommand(
	args: string[],
	options: { cwd: string; runtimePort: number },
): Promise<Record<string, unknown>> {
	return (await runKanbanCommand(args, {
		...options,
		parseJson: true,
	})) as Record<string, unknown>;
}

export class KanbanLocalAdapter implements CodingExecutionProvider {
	async createSession(params: CreateSessionParams): Promise<{
		sessionId: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Record<string, unknown>;
	}> {
		// Validate inputs
		const validated = validateCreateSessionParams(params);

		// Validate and sanitize working directory to prevent path traversal
		const workspacePath = validateWorkingDirectory(
			validated.workingDirectory || "",
			"KANBAN_LOCAL",
		);

		// Sanitize branch name to prevent command injection
		const sanitizedBranch = validated.branch
			? sanitizeBranchName(validated.branch, "KANBAN_LOCAL")
			: undefined;

		const runtimePort = await findAvailablePort();
		const cmdEnv = {
			...process.env,
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			KANBAN_RUNTIME_PORT: String(runtimePort),
		};

		const candidate = resolveKanbanCommandCandidate();

		debugLog("Spawning kanban runtime", {
			workspacePath,
			runtimePort,
			command: candidate.command,
		});

		const child = spawnKanban(
			candidate,
			[...candidate.baseArgs, "--port", String(runtimePort), "--no-open"],
			{
				cwd: workspacePath,
				env: cmdEnv,
				detached: true,
				stdio: "ignore",
			},
		);
		child.unref();

		await waitForRuntime(runtimePort);

		const createResult = await runKanbanJsonCommand(
			[
				"task",
				"create",
				"--prompt",
				validated.title?.trim() || "Fabric implementation session",
				"--project-path",
				workspacePath,
				...(sanitizedBranch ? ["--base-ref", sanitizedBranch] : []),
			],
			{ cwd: workspacePath, runtimePort },
		);

		const task = createResult.task as { id?: string } | undefined;
		if (!task?.id) {
			throw new WorkspaceError(
				"KANBAN_LOCAL",
				"Local Kanban task creation did not return a task id.",
			);
		}

		const sessionId = encodeLocalSession({
			taskId: task.id,
			runtimePort,
			workspacePath,
		});

		debugLog("Session created", {
			sessionId,
			taskId: task.id,
			runtimePort,
		});

		return {
			sessionId,
			externalUrl: `http://127.0.0.1:${runtimePort}`,
			externalStatus: "local_runtime_created",
			providerMetadata: {
				launchMode: "kanban_local",
				workspacePath,
				runtimePort,
				taskId: task.id,
			},
		};
	}

	async sendPrompt(
		sessionId: string,
		content: string,
		_authorId: string,
	): Promise<void> {
		const localSession = decodeLocalKanbanSession(sessionId);

		debugLog("Sending prompt", {
			sessionId,
			taskId: localSession.taskId,
			contentLength: content.length,
		});

		await runKanbanJsonCommand(
			[
				"task",
				"update",
				"--task-id",
				localSession.taskId,
				"--prompt",
				content,
				"--project-path",
				localSession.workspacePath,
			],
			{
				cwd: localSession.workspacePath,
				runtimePort: localSession.runtimePort,
			},
		);

		await runKanbanJsonCommand(
			[
				"task",
				"start",
				"--task-id",
				localSession.taskId,
				"--project-path",
				localSession.workspacePath,
			],
			{
				cwd: localSession.workspacePath,
				runtimePort: localSession.runtimePort,
			},
		);
	}

	async getSessionStatus(sessionId: string): Promise<SessionStatus> {
		const localSession = decodeLocalKanbanSession(sessionId);

		debugLog("Getting session status", {
			sessionId,
			taskId: localSession.taskId,
		});

		const listResult = (await runKanbanJsonCommand(
			["task", "list", "--project-path", localSession.workspacePath],
			{
				cwd: localSession.workspacePath,
				runtimePort: localSession.runtimePort,
			},
		)) as unknown as KanbanTaskListResult;

		const task = listResult.tasks.find(
			(candidate) => candidate.id === localSession.taskId,
		);
		if (!task) {
			return {
				id: sessionId,
				status: "archived",
				branchName: null,
				artifacts: [],
			};
		}

		const sessionState = task.session?.state;
		let status: SessionStatus["status"] = "created";
		if (sessionState === "running") {
			status = "active";
		} else if (sessionState === "awaiting_review") {
			status = "completed";
		} else if (sessionState === "failed") {
			status = "failed";
		} else if (sessionState === "interrupted") {
			status = "stopped";
		} else if (task.column === "review") {
			status = "completed";
		} else if (task.column === "trash") {
			status = "archived";
		} else if (task.column === "in_progress") {
			status = "active";
		}

		return {
			id: sessionId,
			status,
			branchName: task.baseRef ?? null,
			artifacts: [
				{
					id: `local-runtime-${localSession.runtimePort}`,
					type: "local_runtime",
					url: `http://127.0.0.1:${localSession.runtimePort}`,
					metadata: {
						taskId: localSession.taskId,
						workspacePath: localSession.workspacePath,
						sessionState: sessionState ?? null,
						column: task.column,
					},
					createdAt: Date.now(),
				},
			],
		};
	}

	async cancelSession(sessionId: string): Promise<void> {
		const localSession = decodeLocalKanbanSession(sessionId);

		debugLog("Cancelling session", {
			sessionId,
			taskId: localSession.taskId,
		});

		await runKanbanJsonCommand(
			[
				"task",
				"trash",
				"--task-id",
				localSession.taskId,
				"--project-path",
				localSession.workspacePath,
			],
			{
				cwd: localSession.workspacePath,
				runtimePort: localSession.runtimePort,
			},
		);
	}

	async healthCheck(): Promise<HealthCheckResult> {
		const startedAt = Date.now();

		try {
			// Check if kanban CLI is available
			resolveKanbanCommandCandidate();

			// Check if we can find an available port
			const testPort = await findAvailablePort(5);

			return {
				healthy: true,
				latencyMs: Date.now() - startedAt,
				details: {
					commandAvailable: true,
					samplePortAvailable: testPort,
				},
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - startedAt,
				details: {
					error:
						error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
}

export { KanbanLocalAdapter as LocalKanbanProvider };
