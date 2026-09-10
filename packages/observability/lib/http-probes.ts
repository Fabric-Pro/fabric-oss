/** Keep infrastructure probes out of customer-request traces and SLO counts. */
export function isHttpProbe(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	try {
		const path = new URL(url, "http://localhost").pathname;
		return /^\/(?:api\/)?(?:healthz?|readyz?|livez?|metrics)(?:\/|$)/.test(
			path,
		);
	} catch {
		return false;
	}
}
