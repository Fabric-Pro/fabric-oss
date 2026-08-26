export type McpProbeStatus =
	| "ok"
	| "unauthorized"
	| "not-found"
	| "network-error"
	| "timeout";

export type McpProbeResult = {
	capable: boolean;
	status: McpProbeStatus;
	httpStatus: number | null;
};

export type ProbeGitLabMcpOpts = {
	baseUrl: string;
	accessToken: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
};

export async function probeGitLabMcp(
	opts: ProbeGitLabMcpOpts,
): Promise<McpProbeResult> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 2000;
	const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v4/mcp`;
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2024-11-05", capabilities: {} },
	});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetchImpl(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.accessToken}`,
				"Content-Type": "application/json",
			},
			body,
			signal: controller.signal,
		});

		if (res.status >= 200 && res.status < 300) {
			return { capable: true, status: "ok", httpStatus: res.status };
		}
		if (res.status === 401 || res.status === 403) {
			return {
				capable: false,
				status: "unauthorized",
				httpStatus: res.status,
			};
		}
		// 404 is the documented "no MCP on this tier" signature; any other
		// non-2xx is treated the same way (we couldn't reach a working MCP).
		return { capable: false, status: "not-found", httpStatus: res.status };
	} catch (err) {
		const name = (err as { name?: string })?.name;
		if (name === "AbortError") {
			return { capable: false, status: "timeout", httpStatus: null };
		}
		// Network-level errors from fetch surface as TypeError. Anything
		// else (TypeError-from-our-code, SyntaxError, ReferenceError, …)
		// is a bug we don't want to silently swallow — log it so it's
		// observable, but still return network-error so the caller's
		// fallback path continues to work.
		if (err instanceof TypeError) {
			return {
				capable: false,
				status: "network-error",
				httpStatus: null,
			};
		}
		// TODO(observability): @repo/integrations is a leaf package with no
		// structured logger dep; use console.error so unexpected exception
		// types at least surface in container logs.
		console.error("[gitlab-probe] unexpected error during probe", err);
		return { capable: false, status: "network-error", httpStatus: null };
	} finally {
		clearTimeout(timer);
	}
}
