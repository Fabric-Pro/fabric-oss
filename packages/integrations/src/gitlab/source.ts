import {
	type GitLabConnectionDeps,
	type GitLabTenant,
	getGitLabConnectionToken,
	mcpRowOrigin,
	patchGitLabConnectionSettings,
	resolveGitLabConnectionDeps,
} from "./connection";
import {
	type GitLabIntegrationSettings,
	type GitLabMcpProbeRecord,
	readUseOfficialMcp,
} from "./integration-settings";
import {
	createGitLabMcpClient,
	type GitLabMcpClient,
	GitLabMcpError,
	GitLabMcpMethodNotFoundError,
} from "./mcp-client";
import {
	type GitLabApiCredential,
	gitlabApiBaseForOrigin,
} from "./rest-client";

export type GitLabSource =
	| {
			kind: "official-mcp";
			callTool: GitLabMcpClient["callTool"];
			/**
			 * Record that the official MCP endpoint is gone for this
			 * connection (it answered 404), so later calls pick REST. Fenced
			 * on the connection generation the source was built from.
			 */
			onCapabilityLost?: () => Promise<void>;
			/**
			 * The same connection's token for REST, on the same instance as
			 * the endpoint — for a call that has to fall back.
			 */
			credential: GitLabApiCredential;
	  }
	| {
			kind: "rest-adapter";
			/** The token with the REST base of the instance that issued it. */
			credential: GitLabApiCredential;
	  };

export interface ResolveGitLabSourceOpts {
	userId: string;
	organizationId: string | null;
	/** Test seam: replaces the connection service's database/lock/clock. */
	deps?: Partial<GitLabConnectionDeps>;
}

/**
 * Pick the transport for a person's GitLab calls. Both transports carry the
 * SAME credential — the person's one GitLab connection
 * (`getGitLabConnectionToken`). `useOfficialMcp` only chooses whether calls
 * go through GitLab's official MCP endpoint or the REST adapter; the
 * `gitlab-official` MCPConfig contributes its server URL, never a token of
 * its own.
 *
 * Returns null when the person has no usable GitLab connection. The token is
 * only sent to the official MCP endpoint when that endpoint is on the same
 * GitLab origin the credential was issued by; otherwise the REST adapter
 * (which talks to the credential's own origin) is used.
 */
export async function resolveGitLabSource(
	opts: ResolveGitLabSourceOpts,
): Promise<GitLabSource | null> {
	const tenant: GitLabTenant = {
		userId: opts.userId,
		organizationId: opts.organizationId,
	};
	// `anyOrigin`: the REST adapter talks to the credential's own instance
	// (`credential.apiBase`), and the official MCP endpoint is only used
	// when it is on that same instance (checked below).
	const token = await getGitLabConnectionToken(
		tenant,
		{ mode: "lenient", anyOrigin: true },
		opts.deps,
	);
	if (!token.ok) {
		if (token.reason !== "not-connected") {
			console.warn("[gitlab-source] GitLab connection unusable", {
				userId: opts.userId,
				organizationId: opts.organizationId,
				connectionReason: token.reason,
			});
		}
		return null;
	}

	const rest: GitLabSource = {
		kind: "rest-adapter",
		credential: {
			token: token.accessToken,
			apiBase: gitlabApiBaseForOrigin(token.origin),
		},
	};
	const flag = readUseOfficialMcp(
		token.settings as GitLabIntegrationSettings | null | undefined,
	);
	if (flag !== true && flag !== "legacy") {
		return rest;
	}

	const serverUrl = await findOfficialMcpServerUrl(tenant, opts.deps);
	if (!serverUrl) {
		if (flag === true) {
			// Settings say capable but the row that names the endpoint is
			// missing or disabled. console.error so production telemetry
			// surfaces it (most log shippers drop warn-level by default).
			console.error(
				"[gitlab-source] settings.useOfficialMcp=true but gitlab-official MCPConfig missing — falling back to REST",
			);
		}
		return rest;
	}
	// A config naming a refused address has no origin (`mcpRowOrigin`), so
	// it never matches and the token never goes there.
	if (serverUrl.origin !== token.origin) {
		console.warn(
			"[gitlab-source] official MCP endpoint is on a different GitLab instance than the connection; using REST",
			{ userId: opts.userId, organizationId: opts.organizationId },
		);
		return rest;
	}
	const client = createGitLabMcpClient({
		serverUrl: serverUrl.url,
		token: token.accessToken,
	});
	const generation = token.generation;
	return {
		kind: "official-mcp",
		callTool: client.callTool,
		credential: rest.credential,
		// Capability reconciliation the connection refresher used to do at
		// refresh time: a 404 from the endpoint says this instance/tier no
		// longer serves official MCP. Only the routing flag changes — under
		// the lifecycle lock, only at the generation this source was built
		// from, so it never overwrites a newer connect, disconnect or reauth
		// mark — and the issuer's MCPConfig registration is kept.
		onCapabilityLost: async () => {
			const mcpProbe: GitLabMcpProbeRecord = {
				status: "not-found",
				httpStatus: 404,
				checkedAt: new Date().toISOString(),
				baseUrl: token.origin,
			};
			await patchGitLabConnectionSettings(
				tenant,
				{
					expectedGeneration: generation,
					patch: { useOfficialMcp: false, mcpProbe },
				},
				opts.deps,
			);
		},
	};
}

async function findOfficialMcpServerUrl(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
): Promise<{ url: string; origin: string | null } | null> {
	const deps = await resolveGitLabConnectionDeps(overrides);
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	const row = (await deps.db.mCPConfig.findFirst({
		where: {
			...tenantFilter,
			enabled: true,
			mcpServer: { key: "gitlab-official" },
		},
		select: {
			id: true,
			baseUrl: true,
			mcpServer: { select: { defaultUrl: true } },
		},
	} as never)) as {
		baseUrl: string | null;
		mcpServer: { defaultUrl: string | null } | null;
	} | null;
	if (!row) {
		return null;
	}
	const url = row.baseUrl ?? row.mcpServer?.defaultUrl ?? null;
	if (!url) {
		return null;
	}
	return { url, origin: mcpRowOrigin(row) };
}

/**
 * HTTP 404 answered by the official MCP endpoint itself — not by a URL a
 * redirect led to: the endpoint is gone (the instance or tier stopped serving
 * official MCP), so the call never ran there. A 404 reached through a
 * redirect proves nothing (the endpoint may have run the call, then pointed
 * elsewhere), and neither does a redirect the client refused to follow.
 */
export function isGitLabMcpEndpointGone(err: unknown): boolean {
	return (
		err instanceof GitLabMcpError &&
		err.httpStatus === 404 &&
		err.answeredByEndpoint
	);
}

/**
 * Record a capability loss the endpoint just reported, so later calls go
 * straight to REST. A failure to record it never fails the caller's call.
 */
export async function recordGitLabMcpCapabilityLoss(
	source: Extract<GitLabSource, { kind: "official-mcp" }>,
	method: string,
): Promise<void> {
	console.warn(
		`[gitlab] official MCP endpoint answered 404 on ${method}; using REST and recording the capability loss`,
	);
	try {
		await source.onCapabilityLost?.();
	} catch (recordError) {
		console.error(
			"[gitlab] could not record the official MCP capability loss",
			{
				error:
					recordError instanceof Error
						? recordError.message
						: String(recordError),
			},
		);
	}
}

/**
 * Call the official GitLab MCP server, falling back to the REST adapter on
 * failure.
 *
 * `idempotent` (default `true`) controls the write-safety of the fallback.
 * For reads, an ambiguous network/parse error after the request was sent is
 * harmless to retry over REST. For WRITES (`idempotent: false`), it is NOT:
 * a network error raised client-side may mean the mutation already landed
 * server-side (the request reached GitLab, the response was lost). Blindly
 * retrying that write over REST would DUPLICATE the mutation (e.g. create a
 * second GitLab issue). So writes only fall back when the server *proves* the
 * call never ran — i.e. a `GitLabMcpMethodNotFoundError` — and otherwise
 * rethrow the ambiguous error for the caller to handle.
 */
export async function callMcpWithRestFallback<T>(args: {
	source: GitLabSource;
	method: string;
	args: Record<string, unknown>;
	restFallback: () => Promise<T>;
	idempotent?: boolean;
}): Promise<T> {
	if (args.source.kind === "rest-adapter") {
		return args.restFallback();
	}
	const idempotent = args.idempotent ?? true;
	try {
		return (await args.source.callTool(args.method, args.args)) as T;
	} catch (err) {
		// The endpoint itself is gone, so the call never ran — REST is safe
		// even for a write.
		if (isGitLabMcpEndpointGone(err)) {
			await recordGitLabMcpCapabilityLoss(args.source, args.method);
			return args.restFallback();
		}
		// Method-not-found proves the call never executed server-side, so a
		// REST retry can never duplicate — always fall back, even for writes.
		if (err instanceof GitLabMcpMethodNotFoundError) {
			console.warn(
				`[gitlab] official MCP missing method ${args.method}, falling back to REST`,
			);
			return args.restFallback();
		}
		// Network/parse errors bubble up as plain Error from fetch. These are
		// ambiguous: the mutation may have landed before the failure. Only
		// fall back when the operation is idempotent; writes rethrow instead
		// to avoid duplicating a mutation that may already have succeeded.
		if (!(err instanceof GitLabMcpError)) {
			if (idempotent) {
				console.warn(
					`[gitlab] official MCP network error on ${args.method}, falling back to REST: ${err instanceof Error ? err.message : String(err)}`,
				);
				return args.restFallback();
			}
			console.warn(
				`[gitlab] official MCP network error on non-idempotent ${args.method}; NOT falling back to REST (avoiding duplicate write): ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		}
		throw err;
	}
}
