/**
 * The proxy stamps each app page request with when it reached the proxy, how
 * long the proxy's process had been running and how many requests that process
 * had handled. The app layout logs these beside its own timing, so a slow first
 * hit splits into proxy start, the hop to the page function, loading the
 * route's modules and rendering. The stamp is ours to set: the proxy replaces
 * any copy a client sent.
 */
export const PROXY_TIMING_HEADER = "x-fabric-proxy-timing";

type ProxyTiming = {
	receivedAt: number;
	uptimeMs: number;
	requestIndex: number;
};

let handledRequests = 0;

export function proxyTimingHeaderValue(): string {
	handledRequests += 1;
	const fields = [Date.now(), Math.round(performance.now()), handledRequests];
	return fields.join(";");
}

export function parseProxyTiming(
	value: string | null,
): ProxyTiming | undefined {
	const parts = value?.split(";").map(Number);
	if (parts?.length !== 3 || !parts.every(Number.isSafeInteger)) {
		return undefined;
	}
	const [receivedAt, uptimeMs, requestIndex] = parts;
	return { receivedAt, uptimeMs, requestIndex };
}
