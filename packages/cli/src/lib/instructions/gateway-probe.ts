/**
 * Telling whether an MCP server entry whose address is on this deployment's
 * origin, but spelled in a way the gateway is not published at, is one of
 * Fabric's gateways and for which project.
 *
 * One unauthenticated `GET`: a Fabric gateway answers 401 with a
 * `WWW-Authenticate: Bearer resource_metadata="..."` challenge, and the metadata
 * it points to names the `resource` it protects. Nothing else is asked of
 * anyone: the request carries no cookie or credential, follows no redirect, is
 * cut off after a few seconds, and goes only to an address on the deployment's
 * own origin, which the metadata address must be on as well. An answer that
 * cannot be read is `unknown`, which the caller never counts as Fabric's.
 */
import {
	classifyGatewayResource,
	normalizeServerUrl,
} from "../oauth/project-resource.js";

type ProbeResult =
	| "this-project"
	| "other-project"
	| "org-wide"
	/** Answered, and is not a Fabric gateway. */
	| "foreign"
	/** Did not answer, or answered in a way that says nothing. */
	| "unknown";

/** Asks where one address on the deployment's origin points. */
export type GatewayProbe = (url: string) => Promise<ProbeResult>;

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

const PROBE_TIMEOUT_MS = 3_000;
const MAX_METADATA_CHARS = 64 * 1024;
const CHALLENGE_METADATA = /resource_metadata="([^"]+)"/;

function sameOrigin(left: string, right: string): boolean {
	const a = normalizeServerUrl(left);
	const b = normalizeServerUrl(right);
	return a !== null && b !== null && new URL(a).origin === new URL(b).origin;
}

async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Nothing was going to be read from it.
	}
}

function request(fetcher: ProbeFetch, url: string): Promise<Response> {
	return fetcher(url, {
		method: "GET",
		redirect: "manual",
		credentials: "omit",
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
}

export function gatewayProbeFor(input: {
	origin: string;
	projectId: string;
	fetch?: ProbeFetch;
}): GatewayProbe {
	const fetcher: ProbeFetch =
		input.fetch ?? ((url, init) => fetch(url, init));
	return async (url) => {
		if (!sameOrigin(url, input.origin)) {
			return "unknown";
		}
		try {
			const challenged = await request(fetcher, url);
			await discard(challenged);
			if (challenged.status >= 500) {
				return "unknown";
			}
			const metadataUrl =
				challenged.status === 401
					? CHALLENGE_METADATA.exec(
							challenged.headers.get("www-authenticate") ?? "",
						)?.[1]
					: undefined;
			if (metadataUrl === undefined) {
				return "foreign";
			}
			if (!sameOrigin(metadataUrl, input.origin)) {
				return "unknown";
			}
			const metadata = await request(fetcher, metadataUrl);
			if (metadata.status !== 200) {
				await discard(metadata);
				return "unknown";
			}
			const text = await metadata.text();
			if (text.length > MAX_METADATA_CHARS) {
				return "unknown";
			}
			const parsed: unknown = JSON.parse(text);
			const resource: unknown =
				typeof parsed === "object" && parsed !== null
					? Reflect.get(parsed, "resource")
					: undefined;
			if (typeof resource !== "string") {
				return "unknown";
			}
			const relation = classifyGatewayResource(
				input.origin,
				input.projectId,
				resource,
			);
			return relation === "unfamiliar" ? "unknown" : relation;
		} catch {
			return "unknown";
		}
	};
}
