import { createHash } from "node:crypto";
import { createFabricClient } from "@fabric-harness/client";
import type {
	HarnessAdapterOptions,
	HarnessAdmission,
	HarnessAdmissionIntent,
	HarnessIdentity,
	HarnessOperation,
	HarnessRunInput,
	HarnessRunProjection,
	HarnessRunStatus,
	HarnessStartInput,
	QualifiedHarnessTarget,
} from "./types";

export class HarnessAdapterError extends Error {
	constructor(
		public readonly code:
			| "INVALID_INPUT"
			| "UNQUALIFIED_TARGET"
			| "FORBIDDEN"
			| "ADMISSION_CONFLICT"
			| "ADMISSION_UNCERTAIN"
			| "NOT_STARTED"
			| "NOT_FOUND"
			| "CANCELLED"
			| "DEADLINE_EXCEEDED"
			| "REMOTE_FAILURE",
		message: string,
		public readonly recovery?: { operationId: string; runId?: string },
	) {
		super(message);
		this.name = "HarnessAdapterError";
	}
}
const invalid = () =>
	new HarnessAdapterError(
		"INVALID_INPUT",
		"The finite agent request does not match the supported bounded contract.",
	);
const failed = () =>
	new HarnessAdapterError(
		"REMOTE_FAILURE",
		"The qualified agent operation could not be completed. No automatic retry was started.",
	);
const token = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const digest = (value: unknown) =>
	typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const statuses = new Set<HarnessRunStatus>([
	"queued",
	"running",
	"completed",
	"failed",
	"aborted",
]);
function status(value: unknown): HarnessRunStatus {
	if (typeof value !== "string" || !statuses.has(value as HarnessRunStatus)) {
		throw failed();
	}
	return value as HarnessRunStatus;
}
function identity(value: HarnessIdentity) {
	if (
		!value ||
		!token(value.organizationId) ||
		!token(value.actorId) ||
		!(value.projectId === null || token(value.projectId))
	) {
		throw invalid();
	}
	return {
		organizationId: value.organizationId,
		actorId: value.actorId,
		projectId: value.projectId,
	};
}
function canonical(value: unknown, depth = 0): string {
	if (depth > 12) {
		throw invalid();
	}
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length > 1000) {
			throw invalid();
		}
		return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
	}
	if (
		value &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		const keys = Object.keys(value).sort();
		if (
			keys.length > 1000 ||
			keys.some((key) =>
				["__proto__", "prototype", "constructor"].includes(key),
			)
		) {
			throw invalid();
		}
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
	}
	throw invalid();
}
const hash = (value: unknown) =>
	`sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
function relativePath(value: unknown) {
	return (
		typeof value === "string" &&
		value.length <= 300 &&
		/^[A-Za-z0-9_./-]+$/.test(value) &&
		value.split("/").every((part) => part && part !== "." && part !== "..")
	);
}
/** Stable release pin for registry lookup; this is NOT artifact attestation. */
export function fingerprintHarnessRelease(
	release: HarnessStartInput["release"],
): string {
	if (
		!release ||
		release.kind !== "harness_finite" ||
		release.protocol?.interface !== "finite_job" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/.test(
			release.protocol.generation,
		) ||
		!digest(release.artifact?.digest) ||
		release.artifact.buildManifestVersion !== 2 ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
			release.artifact.repository?.revision ?? "",
		) ||
		!token(release.entrypoint?.identity) ||
		!relativePath(release.entrypoint.module) ||
		!/^[A-Za-z_$][A-Za-z0-9_$]{0,199}$/.test(release.entrypoint.export) ||
		!digest(release.schemas?.input?.digest) ||
		!digest(release.schemas?.output?.digest) ||
		!relativePath(release.schemas.input.path) ||
		!relativePath(release.schemas.output.path)
	) {
		throw invalid();
	}
	const url = new URL(release.artifact.repository.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw invalid();
	}
	const { sdk, node, client } = release.artifact.packages;
	const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
	if (
		sdk?.name !== "@fabric-harness/sdk" ||
		sdk.entrypoint !== "strict" ||
		!version.test(sdk.version) ||
		node?.name !== "@fabric-harness/node" ||
		!version.test(node.version) ||
		(client &&
			(client.name !== "@fabric-harness/client" ||
				!version.test(client.version)))
	) {
		throw invalid();
	}
	return hash(release);
}
function bounded(value: number | undefined, fallback: number, max: number) {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < 1 || result > max) {
		throw invalid();
	}
	return result;
}
function abortError(signal: AbortSignal) {
	return new HarnessAdapterError(
		signal.reason === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED",
		signal.reason === "deadline"
			? "The finite agent operation exceeded its deadline."
			: "The finite agent operation was cancelled.",
	);
}
function sanitize(value: unknown, secrets: string[], depth = 0): unknown {
	if (depth > 12) {
		throw failed();
	}
	if (typeof value === "string") {
		let result = value.replace(/Bearer\s+[^\s"'<>]+/gi, "[redacted]");
		for (const secret of secrets) {
			if (secret.length >= 8) {
				result = result.split(secret).join("[redacted]");
			}
		}
		return result;
	}
	if (Array.isArray(value)) {
		if (value.length > 1000) {
			throw failed();
		}
		return value.map((item) => sanitize(item, secrets, depth + 1));
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length > 1000) {
			throw failed();
		}
		return Object.fromEntries(
			entries
				.filter(
					([key]) =>
						!["__proto__", "prototype", "constructor"].includes(
							key,
						),
				)
				.map(([key, item]) => [
					key,
					/authorization|cookie|password|secret|credential|api[-_]?key|(^|_)token($|_)/i.test(
						key,
					)
						? "[redacted]"
						: sanitize(item, secrets, depth + 1),
				]),
		);
	}
	return value;
}

function unqualifiedTarget() {
	return new HarnessAdapterError(
		"UNQUALIFIED_TARGET",
		"The trusted target configuration is malformed or unsupported.",
	);
}
function plain(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
function fields(value: Record<string, unknown>, names: string[]) {
	return (
		Object.keys(value).length === names.length &&
		names.every((name) => Object.hasOwn(value, name))
	);
}
/** Validate storage/config input at runtime; TS interfaces are not authorization checks. */
function parseQualifiedTarget(value: unknown): QualifiedHarnessTarget {
	let target: unknown;
	try {
		target = JSON.parse(canonical(value));
	} catch {
		throw unqualifiedTarget();
	}
	if (
		!plain(target) ||
		!fields(target, [
			"bindingId",
			"baseUrl",
			"organizationId",
			"actorIds",
			"projectIds",
			"qualification",
		]) ||
		!token(target.bindingId) ||
		!token(target.organizationId) ||
		typeof target.baseUrl !== "string" ||
		target.baseUrl.length > 2000 ||
		/[\p{Cc}]/u.test(target.baseUrl) ||
		!Array.isArray(target.actorIds) ||
		!target.actorIds.length ||
		target.actorIds.length > 1000 ||
		!target.actorIds.every(token) ||
		new Set(target.actorIds).size !== target.actorIds.length ||
		!Array.isArray(target.projectIds) ||
		!target.projectIds.length ||
		target.projectIds.length > 1000 ||
		!target.projectIds.every((item) => item === null || token(item)) ||
		new Set(target.projectIds).size !== target.projectIds.length
	) {
		throw unqualifiedTarget();
	}
	const q = target.qualification;
	const booleans = [
		"readOnlyRecovery",
		"finiteJobs",
		"status",
		"events",
		"cancel",
	];
	if (
		!plain(q) ||
		!fields(q, [
			"authority",
			"attestationReference",
			"releaseFingerprint",
			"expiresAt",
			"clientVersion",
			"identityPolicy",
			"effectPolicy",
			...booleans,
		]) ||
		q.authority !== "operator" ||
		typeof q.attestationReference !== "string" ||
		!q.attestationReference.trim() ||
		q.attestationReference.length > 1000 ||
		/[\p{Cc}]/u.test(q.attestationReference) ||
		!digest(q.releaseFingerprint) ||
		typeof q.expiresAt !== "number" ||
		!Number.isSafeInteger(q.expiresAt) ||
		q.expiresAt <= 0 ||
		q.clientVersion !== "6.3.0" ||
		q.identityPolicy !== "fabric-broker-organization-actor-project-v1" ||
		(q.effectPolicy !== "read_only" && q.effectPolicy !== "effectful") ||
		!booleans.every((name) => typeof q[name] === "boolean")
	) {
		throw unqualifiedTarget();
	}
	try {
		new URL(target.baseUrl);
	} catch {
		throw unqualifiedTarget();
	}
	return target as unknown as QualifiedHarnessTarget;
}

export function createHarnessFiniteAdapter(options: HarnessAdapterOptions) {
	const timeoutMs = bounded(options.limits?.timeoutMs, 15_000, 30_000);
	const maxPayload = bounded(
		options.limits?.maxPayloadBytes,
		128 * 1024,
		256 * 1024,
	);
	const maxResponse = bounded(
		options.limits?.maxResponseBytes,
		1024 * 1024,
		2 * 1024 * 1024,
	);
	const maxEvents = bounded(options.limits?.maxEvents, 100, 100);
	async function operation<T>(
		external: AbortSignal | undefined,
		execute: (signal: AbortSignal) => Promise<T>,
		uncertainOnAbort?: () => HarnessAdapterError | undefined,
	): Promise<T> {
		const controller = new AbortController();
		const onAbort = () => controller.abort("cancelled");
		if (external?.aborted) {
			onAbort();
		} else {
			external?.addEventListener("abort", onAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort("deadline"), timeoutMs);
		let abortListener: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			abortListener = () =>
				reject(uncertainOnAbort?.() ?? abortError(controller.signal));
			controller.signal.addEventListener("abort", abortListener, {
				once: true,
			});
			if (controller.signal.aborted) {
				abortListener();
			}
		});
		try {
			return await Promise.race([execute(controller.signal), aborted]);
		} catch (error) {
			if (error instanceof HarnessAdapterError) {
				throw error;
			}
			throw failed();
		} finally {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
			if (abortListener) {
				controller.signal.removeEventListener("abort", abortListener);
			}
		}
	}
	function check(signal: AbortSignal) {
		if (signal.aborted) {
			throw abortError(signal);
		}
	}
	async function targetFor(
		who: HarnessIdentity,
		bindingId: string,
		releaseFingerprint: string,
		op: HarnessOperation,
		signal: AbortSignal,
	) {
		check(signal);
		const resolved = await options.resolveQualifiedTarget({
			identity: who,
			bindingId,
			releaseFingerprint,
			signal,
		});
		check(signal);
		const target = resolved ? parseQualifiedTarget(resolved) : null;
		if (
			!target ||
			target.bindingId !== bindingId ||
			target.organizationId !== who.organizationId ||
			!target.actorIds.includes(who.actorId) ||
			!target.projectIds.includes(who.projectId)
		) {
			throw new HarnessAdapterError(
				"FORBIDDEN",
				"The target is not available for this organization, actor and project.",
			);
		}
		const q = target.qualification;
		if (
			!q ||
			q.authority !== "operator" ||
			!q.attestationReference ||
			q.releaseFingerprint !== releaseFingerprint ||
			!Number.isFinite(q.expiresAt) ||
			q.expiresAt <= Date.now() ||
			q.clientVersion !== "6.3.0" ||
			q.identityPolicy !==
				"fabric-broker-organization-actor-project-v1" ||
			q.effectPolicy !== "read_only" ||
			!q.readOnlyRecovery ||
			!q.finiteJobs ||
			!q.status ||
			!q.events ||
			!q.cancel
		) {
			throw new HarnessAdapterError(
				"UNQUALIFIED_TARGET",
				"The finite read-only target, release, broker identity policy or recovery capabilities have not been qualified.",
			);
		}
		const url = new URL(target.baseUrl);
		const local =
			options.allowLoopbackHttpForTests === true &&
			url.protocol === "http:" &&
			["127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			(!local && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new HarnessAdapterError(
				"UNQUALIFIED_TARGET",
				"The qualified target URL is invalid.",
			);
		}
		if (
			(await options.authorizeOperation({
				identity: who,
				target,
				operation: op,
				signal,
			})) !== true
		) {
			throw new HarnessAdapterError(
				"FORBIDDEN",
				"Current permission does not allow this agent operation.",
			);
		}
		check(signal);
		return target;
	}
	async function clientFor(
		who: HarnessIdentity,
		target: QualifiedHarnessTarget,
		op: HarnessOperation,
		signal: AbortSignal,
		runId?: string,
		onMutationDispatched?: () => void,
	) {
		let credentials: Awaited<
			ReturnType<HarnessAdapterOptions["brokerCredentials"]>
		>;
		try {
			credentials = await options.brokerCredentials({
				identity: who,
				targetBindingId: target.bindingId,
				operation: op,
				runId,
				signal,
			});
		} catch {
			check(signal);
			throw new HarnessAdapterError(
				"UNQUALIFIED_TARGET",
				"Scoped broker identity credentials could not be prepared. No agent request was sent.",
			);
		}
		check(signal);
		if (
			typeof credentials?.authorization !== "string" ||
			!/^Bearer [A-Za-z0-9._~+/=-]{8,8192}$/.test(
				credentials.authorization,
			) ||
			typeof credentials.identityAssertion !== "string" ||
			!credentials.identityAssertion ||
			credentials.identityAssertion.length > 16_384 ||
			/[\p{Cc}\s]/u.test(credentials.identityAssertion)
		) {
			throw new HarnessAdapterError(
				"UNQUALIFIED_TARGET",
				"Scoped broker identity credentials are unavailable.",
			);
		}
		const base = new URL(
			target.baseUrl.endsWith("/")
				? target.baseUrl
				: `${target.baseUrl}/`,
		);
		const secrets = [
			credentials.authorization,
			credentials.authorization.slice(7),
			credentials.identityAssertion,
		];
		let mutationSent = false;
		const safeFetch: typeof fetch = async (input, init) => {
			check(signal);
			const url = new URL(
				input instanceof Request ? input.url : String(input),
			);
			if (
				url.origin !== base.origin ||
				!url.pathname.startsWith(base.pathname)
			) {
				throw failed();
			}
			if (
				!["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase())
			) {
				// Public client 6.3.0 retries 401/403. Never let that replay a mutation.
				if (mutationSent) {
					throw failed();
				}
				mutationSent = true;
				onMutationDispatched?.();
			}
			const response = await fetch(input, {
				...init,
				redirect: "error",
				signal,
			});
			const length = Number(response.headers.get("content-length"));
			if (length > maxResponse) {
				await response.body?.cancel();
				throw failed();
			}
			const reader = response.body?.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			if (reader) {
				try {
					while (true) {
						const item = await reader.read();
						if (item.done) {
							break;
						}
						size += item.value.byteLength;
						if (size > maxResponse) {
							await reader.cancel();
							throw failed();
						}
						chunks.push(item.value);
					}
				} finally {
					reader.releaseLock();
				}
			}
			const body = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.length;
			}
			return new Response(size ? body : null, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		};
		return {
			client: createFabricClient({
				baseUrl: target.baseUrl,
				headers: {
					authorization: credentials.authorization,
					"x-fabric-identity-assertion":
						credentials.identityAssertion,
				},
				fetch: safeFetch,
				requestTimeoutMs: 0,
			}),
			secrets,
		};
	}
	async function load(
		input: HarnessRunInput,
		op: HarnessOperation,
		signal: AbortSignal,
	) {
		const who = identity(input.identity);
		if (!token(input.operationId)) {
			throw invalid();
		}
		check(signal);
		const stored = await options.admissions.read({
			organizationId: who.organizationId,
			operationId: input.operationId,
		});
		check(signal);
		const admission = stored
			? (JSON.parse(canonical(stored)) as HarnessAdmission)
			: null;
		if (
			!admission ||
			admission.state !== "accepted" ||
			!admission.receipt
		) {
			throw new HarnessAdapterError(
				admission?.state === "not_started"
					? "NOT_STARTED"
					: admission
						? "ADMISSION_UNCERTAIN"
						: "NOT_FOUND",
				admission?.state === "not_started"
					? "The prior attempt did not dispatch a request."
					: admission
						? "The prior admission must be reconciled before further agent operations."
						: "The agent operation was not found.",
				{ operationId: input.operationId },
			);
		}
		if (
			canonical(admission.intent.identity) !== canonical(who) ||
			admission.intent.organizationId !== who.organizationId ||
			admission.intent.operationId !== input.operationId
		) {
			throw new HarnessAdapterError(
				"FORBIDDEN",
				"The operation does not belong to this identity.",
			);
		}
		if (
			!token(admission.receipt.runId) ||
			fingerprintHarnessRelease(admission.intent.release) !==
				admission.intent.releaseFingerprint
		) {
			throw failed();
		}
		const target = await targetFor(
			who,
			admission.intent.targetBindingId,
			admission.intent.releaseFingerprint,
			op,
			signal,
		);
		return {
			admission,
			receipt: admission.receipt,
			target,
			who,
			...(await clientFor(
				who,
				target,
				op,
				signal,
				admission.receipt.runId,
			)),
		};
	}
	return {
		start(input: HarnessStartInput) {
			let mutationDispatched = false;
			const operationId = input.operationId;
			const targetBindingId = input.targetBindingId;
			return operation(
				input.signal,
				async (signal) => {
					const who = identity(input.identity);
					if (!token(operationId) || !token(targetBindingId)) {
						throw invalid();
					}
					const payload = canonical(input.payload);
					if (Buffer.byteLength(payload, "utf8") > maxPayload) {
						throw invalid();
					}
					const release = JSON.parse(
						canonical(input.release),
					) as HarnessStartInput["release"];
					const releaseFingerprint =
						fingerprintHarnessRelease(release);
					const target = await targetFor(
						who,
						targetBindingId,
						releaseFingerprint,
						"start",
						signal,
					);
					if (
						(await options.validateInput({
							release,
							payload: JSON.parse(payload),
							signal,
						})) !== true
					) {
						throw invalid();
					}
					check(signal);
					const { client } = await clientFor(
						who,
						target,
						"start",
						signal,
						undefined,
						() => {
							mutationDispatched = true;
						},
					);
					check(signal);
					const intent: HarnessAdmissionIntent = {
						organizationId: who.organizationId,
						operationId,
						identity: who,
						targetBindingId,
						release,
						releaseFingerprint,
						payloadHash: hash(JSON.parse(payload)),
						idempotencyKey: `fabric:${hash({ identity: who, operationId, targetBindingId }).slice(7)}`,
					};
					const claimed = await options.admissions.claim(intent);
					if (
						canonical(claimed.admission.intent) !==
						canonical(intent)
					) {
						throw new HarnessAdapterError(
							"ADMISSION_CONFLICT",
							"The operation identity is already bound to different input or release requirements.",
						);
					}
					if (!claimed.created) {
						if (
							claimed.admission.state === "accepted" &&
							claimed.admission.receipt &&
							token(claimed.admission.receipt.runId)
						) {
							return {
								...claimed.admission.receipt,
								attached: true,
							};
						}
						if (claimed.admission.state === "not_started") {
							throw new HarnessAdapterError(
								"NOT_STARTED",
								"The prior attempt did not dispatch a request. Correct local setup and create a new operation.",
								{ operationId },
							);
						}
						throw new HarnessAdapterError(
							"ADMISSION_UNCERTAIN",
							"A prior start may have been accepted. Reconcile its receipt; starting the whole job again is disabled.",
							{ operationId: input.operationId },
						);
					}
					if (claimed.admission.state !== "starting") {
						throw failed();
					}
					let runId: string | undefined;
					try {
						check(signal);
						const result = await client.jobs.invoke(
							release.entrypoint.identity,
							JSON.parse(payload),
							{
								wait: false,
								idempotencyKey: intent.idempotencyKey,
							},
						);
						if (!token(result.runId)) {
							throw failed();
						}
						runId = result.runId;
						const receipt = {
							runId,
							status: status(result.status),
						};
						await options.admissions.recordAccepted(
							intent,
							receipt,
						);
						return { ...receipt, attached: false };
					} catch (error) {
						if (!mutationDispatched) {
							try {
								await options.admissions.markNotStarted(intent);
							} catch {
								/* No remote request was dispatched, even if local cleanup failed. */
							}
							if (error instanceof HarnessAdapterError) {
								throw error;
							}
							throw new HarnessAdapterError(
								"NOT_STARTED",
								"The request was not sent. Correct the local agent configuration before a new operation.",
								{ operationId },
							);
						}
						try {
							await options.admissions.markUncertain(intent);
						} catch {
							/* The durable starting claim still fences another POST. */
						}
						throw new HarnessAdapterError(
							"ADMISSION_UNCERTAIN",
							"The start outcome is unknown. Reconcile the stored operation before retrying; the adapter will not restart it.",
							{
								operationId: input.operationId,
								...(runId ? { runId } : {}),
							},
						);
					}
				},
				() =>
					mutationDispatched
						? new HarnessAdapterError(
								"ADMISSION_UNCERTAIN",
								"The start deadline or cancellation left an unknown outcome. Reconcile the stored operation before retrying.",
								{ operationId },
							)
						: undefined,
			);
		},
		status(input: HarnessRunInput) {
			return operation(input.signal, async (signal) => {
				const { admission, receipt, client, secrets, who } = await load(
					input,
					"status",
					signal,
				);
				const result = await client.runs.get(receipt.runId);
				if (
					result.runId !== receipt.runId ||
					result.job !==
						admission.intent.release.entrypoint.identity ||
					(result.tenantId !== undefined &&
						result.tenantId !== who.organizationId)
				) {
					throw failed();
				}
				const projected: HarnessRunProjection = {
					runId: result.runId,
					job: result.job,
					status: status(result.status),
				};
				if (
					result.status === "completed" &&
					(await options.validateOutput({
						release: admission.intent.release,
						output: result.output,
						signal,
					})) !== true
				) {
					throw failed();
				}
				if (result.output !== undefined) {
					projected.output = sanitize(result.output, secrets);
				}
				if (result.error) {
					projected.error = {
						type: "job_failed",
						message: "The qualified agent job reported a failure.",
					};
				}
				return projected;
			});
		},
		events(input: HarnessRunInput & { offset?: string; limit?: number }) {
			return operation(input.signal, async (signal) => {
				const limit = bounded(input.limit, maxEvents, maxEvents);
				if (
					input.offset !== undefined &&
					(input.offset.length > 200 ||
						/[\p{Cc}]/u.test(input.offset))
				) {
					throw invalid();
				}
				const { receipt, client, secrets } = await load(
					input,
					"events",
					signal,
				);
				const result = await client.runs.events(receipt.runId, {
					offset: input.offset,
					limit,
				});
				if (
					!Array.isArray(result.events) ||
					result.events.length > limit ||
					typeof result.nextOffset !== "string" ||
					result.nextOffset.length > 200 ||
					typeof result.upToDate !== "boolean"
				) {
					throw failed();
				}
				return {
					events: result.events.map((event) =>
						sanitize(event, secrets),
					),
					nextOffset: result.nextOffset,
					upToDate: result.upToDate,
				};
			});
		},
		cancel(input: HarnessRunInput) {
			return operation(input.signal, async (signal) => {
				const { receipt, client } = await load(input, "cancel", signal);
				const result = await client.runs.abort(receipt.runId);
				if (
					result.runId !== receipt.runId ||
					typeof result.aborted !== "boolean"
				) {
					throw failed();
				}
				return {
					runId: result.runId,
					requested: true,
					aborted: result.aborted,
					status: status(result.status),
				};
			});
		},
	};
}
