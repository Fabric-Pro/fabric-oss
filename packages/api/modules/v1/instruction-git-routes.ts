import { parseAdoRepositoryUrl } from "@repo/connectors";
import { logger } from "@repo/logs";
import { Permissions } from "@repo/permissions";
import type { Context, Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	assertDirectRepositorySourceCurrent,
	type DirectRepositorySource,
	loadDirectRepositorySource,
} from "../projects/procedures/instructions/repository/direct-source";
import { resolveInstructionProject } from "./instruction-project-gate";

const GIT_SERVICE = "git-upload-pack";
const NEGOTIATION_MAX_BYTES = 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_TRANSFERS = 4;

let activeTransfers = 0;

type V1Context = Context<{ Variables: ExternalApiVariables }>;

type TransportFailureReason =
	| "busy"
	| "upstream_fetch_failed"
	| "upstream_status"
	| "upstream_empty_body"
	| "upstream_content_type"
	| "aborted"
	| "authority_check_failed";

interface TransportFailureContext {
	provider: DirectRepositorySource["repository"]["provider"];
	method: "GET" | "POST";
	upstreamStatus?: number;
	upstreamContentType?: string | null;
}

function parseGeneration(raw: string): number | null {
	return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
		? Number(raw)
		: null;
}

function gatewayFailure(message: string, status = 403): Response {
	return Response.json({ error: { message } }, { status });
}

function transportUnavailable(
	reason: TransportFailureReason,
	context: TransportFailureContext,
): Response {
	logger.warn("[instruction-git] transport unavailable", {
		reason,
		...context,
	});
	return gatewayFailure(
		reason === "busy"
			? "Repository Git transport is busy. Try again."
			: "Repository Git transport is unavailable.",
		503,
	);
}

function encodedPath(value: string): string {
	return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * The stored integration is the sole origin authority. This only constructs
 * HTTPS Git endpoints for providers the direct reader already permits.
 */
function upstreamGitUrl(source: DirectRepositorySource): URL | null {
	const { provider, owner, repo, repositoryUrl } = source.repository;
	switch (provider) {
		case "GITHUB":
			return new URL(
				`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
			);
		case "GITLAB":
			return new URL(
				`https://gitlab.com/${encodedPath(owner)}/${encodeURIComponent(repo)}.git`,
			);
		case "AZURE_DEVOPS": {
			try {
				if (parseAdoRepositoryUrl(repositoryUrl) === null) {
					return null;
				}
				const parsed = new URL(repositoryUrl);
				if (parsed.protocol !== "https:") {
					return null;
				}
				parsed.username = "";
				parsed.password = "";
				parsed.search = "";
				parsed.hash = "";
				parsed.pathname = parsed.pathname.replace(/\/+$/, "");
				return parsed;
			} catch {
				return null;
			}
		}
		default:
			return provider satisfies never;
	}
}

function upstreamHeaders(source: DirectRepositorySource): Headers {
	const headers = new Headers({
		Accept: "application/x-git-upload-pack-advertisement, application/x-git-upload-pack-result",
	});
	switch (source.repository.provider) {
		case "GITHUB":
			headers.set(
				"Authorization",
				`Basic ${Buffer.from(`x-access-token:${source.repository.token}`).toString("base64")}`,
			);
			break;
		case "GITLAB":
			headers.set(
				"Authorization",
				`Basic ${Buffer.from(`oauth2:${source.repository.token}`).toString("base64")}`,
			);
			break;
		case "AZURE_DEVOPS":
			headers.set(
				"Authorization",
				source.repository.azureDevOpsAuth === "bearer"
					? `Bearer ${source.repository.token}`
					: `Basic ${Buffer.from(`:${source.repository.token}`).toString("base64")}`,
			);
			break;
		default:
			source.repository.provider satisfies never;
	}
	return headers;
}

function boundedRequestBody(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	let bytes = 0;
	return body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > NEGOTIATION_MAX_BYTES) {
					controller.error(new Error("Git negotiation is too large"));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

async function authorize(c: V1Context, projectId: string) {
	return resolveInstructionProject(projectId, c.get("externalApiContext"), {
		org: c.req.query("org"),
		personal: c.req.query("personal") === "1",
		requiredPermission: Permissions.REPOSITORY_READ,
	});
}

async function sourceFor(
	c: V1Context,
	projectId: string,
	generation: number,
): Promise<{ source: DirectRepositorySource; userId: string } | Response> {
	const permitted = await authorize(c, projectId);
	if ("error" in permitted) {
		return c.json({ error: permitted.error }, permitted.status);
	}
	let source: DirectRepositorySource;
	try {
		source = await loadDirectRepositorySource({
			projectId,
			userId: permitted.userId,
			signal: c.req.raw.signal,
		});
	} catch {
		return gatewayFailure("Repository Git transport is unavailable.", 409);
	}
	if (source.generation !== generation) {
		return gatewayFailure(
			"Repository configuration changed. Reconnect and try again.",
			409,
		);
	}
	return { source, userId: permitted.userId };
}

async function sourceStillCurrent(
	c: V1Context,
	projectId: string,
	userId: string,
	source: DirectRepositorySource,
): Promise<Response | null> {
	const permitted = await authorize(c, projectId);
	if ("error" in permitted || permitted.userId !== userId) {
		return gatewayFailure(
			"Repository Git transport is no longer authorized.",
			403,
		);
	}
	try {
		await assertDirectRepositorySourceCurrent({
			projectId,
			userId,
			source,
		});
		return null;
	} catch {
		return gatewayFailure(
			"Repository configuration changed. Reconnect and try again.",
			409,
		);
	}
}

async function proxyUploadPack(
	c: V1Context,
	method: "GET" | "POST",
): Promise<Response> {
	const projectId = c.req.param("projectId");
	const generation = parseGeneration(c.req.param("generation") ?? "");
	if (projectId === undefined || generation === null) {
		return gatewayFailure("Invalid repository generation.", 400);
	}
	const query = new URL(c.req.url).searchParams;
	const gitProtocol = c.req.header("git-protocol");
	const contentEncoding = c.req.header("content-encoding")?.toLowerCase();
	if (
		(method === "GET" &&
			(query.size !== 1 || query.get("service") !== GIT_SERVICE)) ||
		(method === "POST" &&
			(query.size !== 0 ||
				c.req.header("content-type") !==
					"application/x-git-upload-pack-request" ||
				(contentEncoding !== undefined && contentEncoding !== "gzip")))
	) {
		return gatewayFailure("Only git-upload-pack is available.", 400);
	}
	const resolved = await sourceFor(c, projectId, generation);
	if (resolved instanceof Response) {
		return resolved;
	}
	const upstream = upstreamGitUrl(resolved.source);
	if (upstream === null) {
		return gatewayFailure("Repository Git transport is unavailable.", 409);
	}
	const path =
		method === "GET" ? `info/refs?service=${GIT_SERVICE}` : GIT_SERVICE;
	const target = new URL(path, `${upstream.toString().replace(/\/$/, "")}/`);
	const failureContext: TransportFailureContext = {
		provider: resolved.source.repository.provider,
		method,
	};
	if (activeTransfers >= MAX_CONCURRENT_TRANSFERS) {
		return transportUnavailable("busy", failureContext);
	}
	activeTransfers += 1;
	let released = false;
	const release = (): void => {
		if (!released) {
			released = true;
			activeTransfers -= 1;
		}
	};
	const abort = AbortSignal.any([
		c.req.raw.signal,
		AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
	]);
	let upstreamResponse: Response;
	try {
		const headers = upstreamHeaders(resolved.source);
		if (method === "POST")
			headers.set(
				"Content-Type",
				"application/x-git-upload-pack-request",
			);
		if (method === "POST" && contentEncoding === "gzip")
			headers.set("Content-Encoding", contentEncoding);
		if (gitProtocol === "version=2")
			headers.set("Git-Protocol", gitProtocol);
		upstreamResponse = await fetch(target, {
			method,
			headers,
			...(method === "POST" && c.req.raw.body
				? {
						body: boundedRequestBody(c.req.raw.body),
						duplex: "half" as const,
					}
				: {}),
			redirect: "error",
			signal: abort,
		});
	} catch {
		release();
		return transportUnavailable(
			abort.aborted ? "aborted" : "upstream_fetch_failed",
			failureContext,
		);
	}
	if (!upstreamResponse.ok || upstreamResponse.body === null) {
		await upstreamResponse.body?.cancel().catch(() => undefined);
		release();
		return transportUnavailable(
			upstreamResponse.ok ? "upstream_empty_body" : "upstream_status",
			{ ...failureContext, upstreamStatus: upstreamResponse.status },
		);
	}
	const expectedContentType =
		method === "GET"
			? "application/x-git-upload-pack-advertisement"
			: "application/x-git-upload-pack-result";
	if (
		!upstreamResponse.headers
			.get("content-type")
			?.toLowerCase()
			.startsWith(expectedContentType)
	) {
		await upstreamResponse.body.cancel().catch(() => undefined);
		release();
		return transportUnavailable("upstream_content_type", {
			...failureContext,
			upstreamStatus: upstreamResponse.status,
			upstreamContentType: upstreamResponse.headers.get("content-type"),
		});
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const cancelTransfer = (): void => {
		if (reader) {
			void reader.cancel().catch(() => undefined);
		} else {
			void upstreamResponse.body?.cancel().catch(() => undefined);
		}
		release();
	};
	abort.addEventListener("abort", cancelTransfer, { once: true });
	if (abort.aborted) {
		cancelTransfer();
		abort.removeEventListener("abort", cancelTransfer);
		return transportUnavailable("aborted", failureContext);
	}
	try {
		const current = await sourceStillCurrent(
			c,
			projectId,
			resolved.userId,
			resolved.source,
		);
		if (current) {
			await upstreamResponse.body.cancel().catch(() => undefined);
			abort.removeEventListener("abort", cancelTransfer);
			release();
			return current;
		}
	} catch {
		await upstreamResponse.body.cancel().catch(() => undefined);
		abort.removeEventListener("abort", cancelTransfer);
		release();
		return transportUnavailable("authority_check_failed", failureContext);
	}
	const streamReader = upstreamResponse.body.getReader();
	reader = streamReader;
	const complete = (): void => {
		abort.removeEventListener("abort", cancelTransfer);
		release();
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await streamReader.read();
				if (next.done) {
					complete();
					controller.close();
					return;
				}
				controller.enqueue(next.value);
			} catch {
				complete();
				controller.error(
					new Error("Repository Git transport ended unexpectedly."),
				);
			}
		},
		async cancel() {
			complete();
			await streamReader.cancel().catch(() => undefined);
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type":
				upstreamResponse.headers.get("content-type") ??
				(method === "GET"
					? "application/x-git-upload-pack-advertisement"
					: "application/x-git-upload-pack-result"),
			"Cache-Control": "no-store",
		},
	});
}

export function registerInstructionGitRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
): void {
	const base = "/projects/:projectId/instructions/repository/git/:generation";
	app.get(`${base}/info/refs`, requireScope("repositories:read"), (c) =>
		proxyUploadPack(c, "GET"),
	);
	app.post(
		`${base}/git-upload-pack`,
		requireScope("repositories:read"),
		(c) => proxyUploadPack(c, "POST"),
	);
	app.all(`${base}/*`, requireScope("repositories:read"), () =>
		gatewayFailure("Only git-upload-pack is available.", 400),
	);
}
