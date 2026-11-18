import type { ConnectionTestResult } from "@repo/integrations";
import {
	getBlockedOutboundReason,
	getUnsafeUrlReason,
	safeFetchOutbound,
} from "@repo/utils/url-security";

const DESTINATION_NOT_ALLOWED = "Request blocked: destination is not allowed.";

class ConnectionDestinationError extends Error {
	constructor() {
		super(DESTINATION_NOT_ALLOWED);
	}
}

export function isProviderTenantLabel(label: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
}

export async function fetchConnectionProvider(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = String(input);
	if (URL.parse(url)?.protocol !== "https:" || getUnsafeUrlReason(url)) {
		throw new ConnectionDestinationError();
	}

	let response: Response;
	try {
		response = await safeFetchOutbound(url, {
			...init,
			redirect: "manual",
		});
	} catch (error) {
		if (getBlockedOutboundReason(error)) {
			throw new ConnectionDestinationError();
		}
		throw error;
	}

	if ([301, 302, 303, 307, 308].includes(response.status)) {
		await response.body?.cancel().catch(() => undefined);
		throw new ConnectionDestinationError();
	}
	return response;
}

// The clients can wrap transport errors in their own connection failures.
export async function testWithGuardedFetch(
	test: (fetchImpl: typeof fetch) => Promise<ConnectionTestResult>,
): Promise<ConnectionTestResult> {
	let refused = false;
	const guardedFetch: typeof fetch = async (input, init) => {
		try {
			return await fetchConnectionProvider(String(input), init);
		} catch (error) {
			if (error instanceof ConnectionDestinationError) {
				refused = true;
			}
			throw error;
		}
	};
	const result = await test(guardedFetch);
	return refused
		? { success: false, error: DESTINATION_NOT_ALLOWED }
		: result;
}
