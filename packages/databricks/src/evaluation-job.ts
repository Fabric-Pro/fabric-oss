import { createHash } from "node:crypto";
import { DatabricksApiClient, DatabricksApiError } from "./api-client";
import { createOAuthM2MProvider, type DatabricksTokenProvider } from "./auth";
import { validateDatabricksWorkspaceOrigin } from "./workspace-origin";

export const EVALUATION_TASK_KEY = "evaluate_context_snapshot";
export const EVALUATION_MAX_PAYLOAD_BYTES = 128 * 1024;
export const EVALUATION_MAX_RESPONSE_BYTES = 256 * 1024;

export type EvaluationJobErrorCode =
	| "INVALID_BINDING"
	| "CONNECTION_UNAVAILABLE"
	| "REMOTE_UNAVAILABLE"
	| "REMOTE_PROTOCOL"
	| "SNAPSHOT_CONFLICT"
	| "JOB_NOT_QUALIFIED";

/** Provider text is never carried into workflow history, audit or UI errors. */
export class DatabricksEvaluationError extends Error {
	constructor(
		readonly code: EvaluationJobErrorCode,
		readonly status?: number,
	) {
		super(
			`Databricks evaluation ${code.toLowerCase().replaceAll("_", " ")}.`,
		);
		this.name = "DatabricksEvaluationError";
	}
}

export interface EvaluationJobBinding {
	workspaceOrigin: string;
	jobId: string;
	experimentId: string;
	volumePath: string;
	notebookPath: string;
	notebookSha256: string;
}

export interface EvaluationRunIdentity {
	fabricRunId: string;
	payloadHash: string;
	snapshotPath: string;
	experimentId: string;
}

export interface EvaluationRemoteRun {
	runId: string;
	jobId: string;
	taskRunId: string | null;
	lifecycle: string;
	result: string | null;
	terminal: boolean;
	parametersMatch: boolean;
}

export function computeDatabricksEvaluationPrincipalFingerprint(
	workspaceOrigin: string,
	clientId: string,
): string {
	const host = validateDatabricksWorkspaceOrigin(workspaceOrigin);
	return createHash("sha256")
		.update(JSON.stringify([host, clientId.trim().toLowerCase()]))
		.digest("hex");
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
	}
	return value as Record<string, unknown>;
}

function remoteId(value: unknown): string {
	if (
		(typeof value === "string" &&
			/^[1-9][0-9]{0,15}$/.test(value) &&
			Number.isSafeInteger(Number(value))) ||
		(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
	) {
		return String(value);
	}
	throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
}

function validId(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validateEvaluationJobBinding(
	binding: EvaluationJobBinding,
): EvaluationJobBinding {
	try {
		const workspaceOrigin = validateDatabricksWorkspaceOrigin(
			binding.workspaceOrigin,
		);
		if (
			workspaceOrigin !== binding.workspaceOrigin ||
			remoteId(binding.jobId) !== binding.jobId ||
			remoteId(binding.experimentId) !== binding.experimentId ||
			!/^[a-f0-9]{64}$/.test(binding.notebookSha256) ||
			!/^(\/Volumes)(\/[A-Za-z0-9_-]+){3,8}$/.test(binding.volumePath) ||
			!binding.notebookPath.startsWith("/") ||
			binding.notebookPath.length > 1024 ||
			/[\p{Cc}\p{Cf}\\]/u.test(binding.notebookPath) ||
			binding.notebookPath
				.split("/")
				.slice(1)
				.some((part) => !part || part === "." || part === "..")
		) {
			throw new Error();
		}
		return binding;
	} catch {
		throw new DatabricksEvaluationError("INVALID_BINDING");
	}
}

export function evaluationSnapshotPath(
	binding: EvaluationJobBinding,
	runId: string,
): string {
	validateEvaluationJobBinding(binding);
	if (!validId(runId)) {
		throw new DatabricksEvaluationError("INVALID_BINDING");
	}
	return `${binding.volumePath}/${runId}.json`;
}

/** Same payload and bound resources always reuse one native admission key. */
export function evaluationAdmissionKey(
	binding: EvaluationJobBinding,
	identity: EvaluationRunIdentity,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				binding.workspaceOrigin,
				binding.jobId,
				binding.experimentId,
				identity.fabricRunId,
				identity.payloadHash,
			]),
		)
		.digest("hex");
}

function fileUrl(path: string): string {
	return `/api/2.0/fs/files${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function boundedBytes(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		return new Uint8Array();
	}
	const parts: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) {
				break;
			}
			bytes += item.value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
			}
			parts.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(parts);
}

const TERMINAL = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]);

export class DatabricksEvaluationClient {
	readonly binding: EvaluationJobBinding;
	private readonly client: DatabricksApiClient;

	constructor(input: {
		binding: EvaluationJobBinding;
		credentials?: Record<string, string>;
		tokenProvider?: DatabricksTokenProvider;
		fetchImpl?: typeof fetch;
	}) {
		this.binding = validateEvaluationJobBinding(input.binding);
		const transport = input.fetchImpl ?? globalThis.fetch;
		const boundedFetch: typeof fetch = async (input, init) => {
			const response = await transport(input, init);
			if ([204, 205, 304].includes(response.status)) {
				return response;
			}
			return new Response(
				new Uint8Array(
					await boundedBytes(response, EVALUATION_MAX_RESPONSE_BYTES),
				),
				{
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				},
			);
		};
		let provider = input.tokenProvider;
		if (!provider) {
			const credentials = input.credentials;
			if (
				!credentials?.DATABRICKS_CLIENT_ID ||
				!credentials.DATABRICKS_CLIENT_SECRET ||
				credentials.DATABRICKS_HOST !== this.binding.workspaceOrigin
			) {
				throw new DatabricksEvaluationError("CONNECTION_UNAVAILABLE");
			}
			provider = createOAuthM2MProvider(
				this.binding.workspaceOrigin,
				credentials.DATABRICKS_CLIENT_ID,
				credentials.DATABRICKS_CLIENT_SECRET,
				boundedFetch,
			);
		}
		this.client = new DatabricksApiClient({
			host: this.binding.workspaceOrigin,
			tokenProvider: provider,
			fetchImpl: boundedFetch,
			maxRetries: 2,
		});
	}

	private async json(
		method: string,
		path: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		try {
			const response = await this.client.requestRaw(method, path, {
				headers:
					body === undefined
						? undefined
						: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
			const bytes = await boundedBytes(
				response,
				EVALUATION_MAX_RESPONSE_BYTES,
			);
			if (bytes.length === 0) {
				return {};
			}
			return object(JSON.parse(Buffer.from(bytes).toString("utf8")));
		} catch (error) {
			if (error instanceof DatabricksEvaluationError) {
				throw error;
			}
			throw new DatabricksEvaluationError(
				"REMOTE_UNAVAILABLE",
				error instanceof DatabricksApiError ? error.status : undefined,
			);
		}
	}

	async qualifyJob(signal: AbortSignal): Promise<void> {
		const inspected = await this.inspectJobForApproval(signal);
		if (
			inspected.notebookPath !== this.binding.notebookPath ||
			inspected.notebookSha256 !== this.binding.notebookSha256
		) {
			throw new DatabricksEvaluationError("JOB_NOT_QUALIFIED");
		}
	}

	async inspectJobForApproval(
		signal: AbortSignal,
	): Promise<{ notebookPath: string; notebookSha256: string }> {
		const job = await this.json(
			"GET",
			`/api/2.2/jobs/get?job_id=${this.binding.jobId}`,
			undefined,
			signal,
		);
		const settings = object(job.settings);
		const tasks = settings.tasks;
		if (
			!Array.isArray(tasks) ||
			tasks.length !== 1 ||
			settings.schedule ||
			settings.continuous ||
			settings.trigger ||
			settings.git_source
		) {
			throw new DatabricksEvaluationError("JOB_NOT_QUALIFIED");
		}
		const task = object(tasks[0]);
		const notebook = object(task.notebook_task);
		if (
			task.task_key !== EVALUATION_TASK_KEY ||
			(notebook.source !== undefined &&
				notebook.source !== "WORKSPACE") ||
			typeof notebook.notebook_path !== "string" ||
			(task.max_retries !== undefined && task.max_retries !== 0) ||
			task.retry_on_timeout === true ||
			typeof task.timeout_seconds !== "number" ||
			task.timeout_seconds <= 0 ||
			task.timeout_seconds > 900 ||
			typeof settings.timeout_seconds !== "number" ||
			settings.timeout_seconds <= 0 ||
			settings.timeout_seconds > 1200 ||
			settings.max_concurrent_runs !== 1
		) {
			throw new DatabricksEvaluationError("JOB_NOT_QUALIFIED");
		}
		const notebookPath = String(notebook.notebook_path);
		validateEvaluationJobBinding({ ...this.binding, notebookPath });
		const exported = await this.json(
			"GET",
			`/api/2.0/workspace/export?path=${encodeURIComponent(notebookPath)}&format=SOURCE`,
			undefined,
			signal,
		);
		if (
			typeof exported.content !== "string" ||
			!/^[A-Za-z0-9+/]+={0,2}$/.test(exported.content)
		) {
			throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
		}
		const source = Buffer.from(exported.content, "base64");
		if (!source.length || source.length > 180 * 1024) {
			throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
		}
		return {
			notebookPath,
			notebookSha256: createHash("sha256").update(source).digest("hex"),
		};
	}

	private validateIdentity(identity: EvaluationRunIdentity): void {
		if (
			identity.experimentId !== this.binding.experimentId ||
			!/^[a-f0-9]{64}$/.test(identity.payloadHash) ||
			identity.snapshotPath !==
				evaluationSnapshotPath(this.binding, identity.fabricRunId)
		) {
			throw new DatabricksEvaluationError("INVALID_BINDING");
		}
	}

	async uploadSnapshot(
		identity: EvaluationRunIdentity,
		payload: string,
		signal: AbortSignal,
	): Promise<void> {
		this.validateIdentity(identity);
		const path = evaluationSnapshotPath(this.binding, identity.fabricRunId);
		const bytes = Buffer.from(payload, "utf8");
		if (
			identity.snapshotPath !== path ||
			bytes.length > EVALUATION_MAX_PAYLOAD_BYTES ||
			createHash("sha256").update(bytes).digest("hex") !==
				identity.payloadHash
		) {
			throw new DatabricksEvaluationError("INVALID_BINDING");
		}
		try {
			const response = await this.client.requestRaw(
				"PUT",
				`${fileUrl(path)}?overwrite=false`,
				{
					body: bytes,
					headers: { "Content-Type": "application/octet-stream" },
					signal,
				},
			);
			await response.body?.cancel();
		} catch (error) {
			// A lost upload response or an existing path is reconciled by exact bytes;
			// never overwrite another version and never infer absence from a timeout.
			try {
				const response = await this.client.requestRaw(
					"GET",
					fileUrl(path),
					{ signal },
				);
				const stored = await boundedBytes(
					response,
					EVALUATION_MAX_PAYLOAD_BYTES,
				);
				if (
					createHash("sha256").update(stored).digest("hex") ===
					identity.payloadHash
				) {
					return;
				}
				throw new DatabricksEvaluationError("SNAPSHOT_CONFLICT");
			} catch (readError) {
				if (readError instanceof DatabricksEvaluationError) {
					throw readError;
				}
				throw new DatabricksEvaluationError(
					"REMOTE_UNAVAILABLE",
					error instanceof DatabricksApiError
						? error.status
						: undefined,
				);
			}
		}
	}

	async admit(
		identity: EvaluationRunIdentity,
		signal: AbortSignal,
	): Promise<string> {
		this.validateIdentity(identity);
		const response = await this.json(
			"POST",
			"/api/2.2/jobs/run-now",
			{
				job_id: Number(this.binding.jobId),
				idempotency_token: evaluationAdmissionKey(
					this.binding,
					identity,
				),
				job_parameters: {
					fabric_run_id: identity.fabricRunId,
					payload_hash: identity.payloadHash,
					snapshot_path: identity.snapshotPath,
					experiment_id: identity.experimentId,
				},
			},
			signal,
		);
		return remoteId(response.run_id);
	}

	async getRun(
		runId: string,
		identity: EvaluationRunIdentity,
		signal: AbortSignal,
	): Promise<EvaluationRemoteRun> {
		this.validateIdentity(identity);
		const response = await this.json(
			"GET",
			`/api/2.2/jobs/runs/get?run_id=${remoteId(runId)}`,
			undefined,
			signal,
		);
		const state = object(response.state);
		const params = Array.isArray(response.job_parameters)
			? response.job_parameters.map(object)
			: [];
		const parameterValues = new Map(
			params.map((param) => [param.name, param.value]),
		);
		const match =
			parameterValues.get("fabric_run_id") === identity.fabricRunId &&
			parameterValues.get("payload_hash") === identity.payloadHash &&
			parameterValues.get("snapshot_path") === identity.snapshotPath &&
			parameterValues.get("experiment_id") === identity.experimentId;
		const tasks = Array.isArray(response.tasks)
			? response.tasks.map(object)
			: [];
		const task = tasks.find(
			(entry) => entry.task_key === EVALUATION_TASK_KEY,
		);
		const lifecycle =
			typeof state.life_cycle_state === "string"
				? state.life_cycle_state
				: "UNKNOWN";
		return {
			runId: remoteId(response.run_id),
			jobId: remoteId(response.job_id),
			taskRunId:
				task?.run_id === undefined ? null : remoteId(task.run_id),
			lifecycle,
			result:
				typeof state.result_state === "string"
					? state.result_state
					: null,
			terminal: TERMINAL.has(lifecycle),
			parametersMatch:
				match && remoteId(response.job_id) === this.binding.jobId,
		};
	}

	/** Read-only admission lookup: safe after cancellation or permission revocation. */
	async findAdmittedRun(
		identity: EvaluationRunIdentity,
		createdAt: Date,
		signal: AbortSignal,
		pagination?: {
			pageToken?: string | null;
			checkpoint: (nextPageToken: string | null) => Promise<void>;
		},
	): Promise<string | null> {
		this.validateIdentity(identity);
		const start = Math.max(0, createdAt.getTime() - 60_000);
		let page: string | undefined = pagination?.pageToken ?? undefined;
		if (page && (page.length > 2048 || /[\p{Cc}]/u.test(page)))
			throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
		for (let i = 0; i < 4; i++) {
			const response = await this.json(
				"GET",
				`/api/2.2/jobs/runs/list?job_id=${this.binding.jobId}&start_time_from=${start}&limit=25${page ? `&page_token=${encodeURIComponent(page)}` : ""}`,
				undefined,
				signal,
			);
			const runs = Array.isArray(response.runs)
				? response.runs.map(object)
				: [];
			for (const run of runs) {
				const params = Array.isArray(run.job_parameters)
					? run.job_parameters.map(object)
					: [];
				if (
					params.some(
						(param) =>
							param.name === "fabric_run_id" &&
							param.value === identity.fabricRunId,
					)
				) {
					const found = await this.getRun(
						remoteId(run.run_id),
						identity,
						signal,
					);
					if (!found.parametersMatch) {
						throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
					}
					await pagination?.checkpoint(null);
					return found.runId;
				}
			}
			if (
				typeof response.next_page_token !== "string" ||
				!response.next_page_token
			) {
				await pagination?.checkpoint(null);
				break;
			}
			page = response.next_page_token;
			if (page.length > 2048 || /[\p{Cc}]/u.test(page))
				throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
			await pagination?.checkpoint(page);
		}
		return null;
	}

	async cancel(runId: string, signal: AbortSignal): Promise<void> {
		await this.json(
			"POST",
			"/api/2.2/jobs/runs/cancel",
			{ run_id: Number(remoteId(runId)) },
			signal,
		);
	}

	async output(taskRunId: string, signal: AbortSignal): Promise<unknown> {
		const response = await this.json(
			"GET",
			`/api/2.2/jobs/runs/get-output?run_id=${remoteId(taskRunId)}`,
			undefined,
			signal,
		);
		const notebook = object(response.notebook_output);
		if (
			notebook.truncated === true ||
			typeof notebook.result !== "string" ||
			Buffer.byteLength(notebook.result, "utf8") > 100 * 1024
		) {
			throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
		}
		try {
			return JSON.parse(notebook.result);
		} catch {
			throw new DatabricksEvaluationError("REMOTE_PROTOCOL");
		}
	}

	async deleteSnapshot(
		identity: EvaluationRunIdentity,
		signal: AbortSignal,
	): Promise<void> {
		this.validateIdentity(identity);
		const path = evaluationSnapshotPath(this.binding, identity.fabricRunId);
		if (path !== identity.snapshotPath) {
			throw new DatabricksEvaluationError("INVALID_BINDING");
		}
		try {
			const response = await this.client.requestRaw(
				"DELETE",
				fileUrl(path),
				{ signal },
			);
			await response.body?.cancel();
		} catch (error) {
			if (error instanceof DatabricksApiError && error.status === 404) {
				return;
			}
			throw new DatabricksEvaluationError(
				"REMOTE_UNAVAILABLE",
				error instanceof DatabricksApiError ? error.status : undefined,
			);
		}
	}
}

/** Read-only discovery used by administrators before approving a binding. */
export async function inspectDatabricksEvaluationJob(
	input: {
		workspaceOrigin: string;
		jobId: string;
		credentials?: Record<string, string>;
		tokenProvider?: DatabricksTokenProvider;
		fetchImpl?: typeof fetch;
	},
	signal: AbortSignal,
): Promise<{ notebookPath: string; notebookSha256: string }> {
	return new DatabricksEvaluationClient({
		...input,
		binding: {
			workspaceOrigin: input.workspaceOrigin,
			jobId: input.jobId,
			experimentId: "1",
			volumePath: "/Volumes/discovery/discovery/discovery",
			notebookPath: "/discovery",
			notebookSha256: "0".repeat(64),
		},
	}).inspectJobForApproval(signal);
}
