/**
 * HTTP Request Step
 * Makes HTTP requests to external APIs
 *
 * Includes SSRF protection to prevent access to internal networks
 */

import {
	getUnsafeUrlReason,
	safeFetchOutbound,
} from "@repo/utils/url-security";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

/**
 * Ports commonly used by internal services. The shared SSRF validator
 * (`getUnsafeUrlReason`) covers internal/private HOSTS (loopback, private
 * ranges, cloud metadata, IPv6); this adds a port blocklist on top as
 * defense-in-depth.
 */
const INTERNAL_PORTS = new Set([
	22, 23, 25, 3306, 5432, 6379, 27017, 9200, 9300, 2379, 2380,
]);

function blockedInternalPortReason(urlString: string): string | null {
	try {
		const url = new URL(urlString);
		const port = url.port
			? Number.parseInt(url.port, 10)
			: url.protocol === "https:"
				? 443
				: 80;
		if (INTERNAL_PORTS.has(port)) {
			return `Port ${port} is commonly used for internal services and is not allowed`;
		}
		return null;
	} catch {
		return "Invalid URL format";
	}
}

/**
 * Request timeout in milliseconds
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Maximum response size in bytes (10MB)
 */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

export async function executeHttpRequestStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		url,
		method = "GET",
		headers = {},
		body,
	} = params.nodeConfig as {
		url?: string;
		method?: string;
		headers?: Record<string, string>;
		body?: unknown;
	};

	if (!url) {
		return { success: false, error: "URL is required" };
	}

	const interpolatedUrl = interpolateTemplate(url, params.inputs);

	// SSRF Protection: reject internal/private hosts via the shared validator
	// plus an internal-service port blocklist. The request itself uses
	// `safeFetchOutbound` (redirect: "error") below, so a permitted host that
	// 3xx-redirects to an internal target is ALSO blocked — closing the
	// redirect-bypass the previous one-time, hostname-only check missed.
	const unsafeReason = getUnsafeUrlReason(interpolatedUrl);
	if (unsafeReason) {
		return { success: false, error: `Request blocked: ${unsafeReason}` };
	}
	const portReason = blockedInternalPortReason(interpolatedUrl);
	if (portReason) {
		return { success: false, error: `Request blocked: ${portReason}` };
	}

	try {
		// Add timeout to prevent hanging requests
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			REQUEST_TIMEOUT_MS,
		);

		const response = await safeFetchOutbound(interpolatedUrl, {
			method,
			headers: { "Content-Type": "application/json", ...headers },
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		// Check content length to prevent memory exhaustion
		const contentLength = response.headers.get("content-length");
		if (
			contentLength &&
			Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE
		) {
			return {
				success: false,
				error: `Response too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`,
			};
		}

		// Read response with size limit
		const text = await response.text();
		if (text.length > MAX_RESPONSE_SIZE) {
			return {
				success: false,
				error: `Response too large: ${text.length} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`,
			};
		}

		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}

		return {
			success: response.ok,
			output: { status: response.status, data },
			error: response.ok ? undefined : `HTTP ${response.status}`,
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				success: false,
				error: `Request timeout: exceeded ${REQUEST_TIMEOUT_MS / 1000} seconds`,
			};
		}
		// `safeFetchOutbound` throws on a disallowed redirect (redirect: "error")
		// or a late-detected unsafe URL — surface as a failed request.
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "HTTP request failed",
		};
	}
}
