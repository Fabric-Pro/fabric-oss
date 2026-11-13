import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseProxyTiming } from "@shared/lib/proxy-timing";
import { after } from "next/server";
import { cache } from "react";

// The phase timings are wall-clock: an awaited query cannot resume while the
// process runs other code, so a slow phase may be waiting on the CPU, not the
// database. The longest stall of the event loop during a request says which.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function cpuMsOf(usage: NodeJS.CpuUsage): number {
	return Math.round((usage.user + usage.system) / 1000);
}

// When this module instance was evaluated, and how many app requests it has
// rendered. A count that starts again at 1 in a process that has been up for
// a while means the route loaded its own copy of the modules.
const moduleEvaluatedAtMs = Math.round(performance.now());
let appRequestsRendered = 0;

// Fast repeat requests are not logged; their cost is already known.
const SLOW_APP_REQUEST_MS = 1500;

type CatalogRequestPhase =
	| "root_locale"
	| "saas_messages"
	| "saas_locale"
	| "saas_session"
	| "saas_prefetch"
	| "app_session"
	| "app_organizations"
	| "app_billing"
	| "app_feature_flags"
	| "app_default_function_tags"
	| "organization_deleted_check"
	| "organization_lookup"
	| "organization_session"
	| "organization_guest_check"
	| "organization_mfa_check"
	| "organization_feature_flags"
	| "organization_prefetch"
	| "chat_organization"
	| "chat_preferences"
	| "chat_registry"
	| "chat_ai_config"
	| "catalog_session"
	| "catalog_params";

type CatalogRequestTiming = {
	startedAt: number;
	phases: Partial<Record<CatalogRequestPhase, number>>;
	phaseOffsets: Partial<
		Record<CatalogRequestPhase, { startMs: number; endMs: number }>
	>;
};

const getCatalogRequestTiming = cache(
	(): CatalogRequestTiming => ({
		startedAt: performance.now(),
		phases: {},
		phaseOffsets: {},
	}),
);

export async function measureCatalogRequestPhase<T>(
	phase: CatalogRequestPhase,
	operation: () => Promise<T>,
): Promise<T> {
	const timing = getCatalogRequestTiming();
	const startedAt = performance.now();
	try {
		return await operation();
	} finally {
		const endedAt = performance.now();
		timing.phases[phase] = Math.round(endedAt - startedAt);
		timing.phaseOffsets[phase] = {
			startMs: Math.round(startedAt - timing.startedAt),
			endMs: Math.round(endedAt - timing.startedAt),
		};
	}
}

export function logChatRequestTiming(route: "main" | "registered-agent"): void {
	const timing = getCatalogRequestTiming();

	after(() => {
		console.info("Chat request timing", {
			event: "chat.request_timing",
			route,
			elapsedAtAfterMs: Math.round(performance.now() - timing.startedAt),
			phases: timing.phases,
			phaseOffsets: timing.phaseOffsets,
		});
	});
}

/**
 * Logs where an app page request spent its time, for the first request this
 * module instance renders and for any slow one. `proxyToRenderMs` runs from
 * the proxy receiving the request to the root layout starting to render, so
 * it holds the hop to the page function, its cold start and the loading of
 * the route's modules. It compares clocks of two functions, so read it to
 * tens of milliseconds, not exactly. `cpuMs` is the process's CPU time from
 * this call to the end of the response, and `loopStallMaxMs` its longest
 * event-loop stall in that time; other requests running alongside add to
 * both. `processCpuMs` is the CPU time since the process started.
 */
export function logAppRequestTiming(proxyTimingHeader: string | null): void {
	const timing = getCatalogRequestTiming();
	const cpuAtStart = process.cpuUsage();
	eventLoopDelay.reset();
	appRequestsRendered += 1;
	const moduleRequestIndex = appRequestsRendered;
	const proxy = parseProxyTiming(proxyTimingHeader);
	const renderStartedAt = performance.timeOrigin + timing.startedAt;
	const proxyToRenderMs = proxy
		? Math.round(renderStartedAt - proxy.receivedAt)
		: undefined;

	after(() => {
		const responseMs = Math.round(performance.now() - timing.startedAt);
		const totalMs = responseMs + (proxyToRenderMs ?? 0);
		if (moduleRequestIndex > 1 && totalMs < SLOW_APP_REQUEST_MS) {
			return;
		}
		console.info("App request timing", {
			event: "app.request_timing",
			moduleRequestIndex,
			moduleEvaluatedAtMs,
			processUptimeMs: Math.round(timing.startedAt),
			proxyToRenderMs,
			proxyUptimeMs: proxy?.uptimeMs,
			proxyRequestIndex: proxy?.requestIndex,
			responseMs,
			cpuMs: cpuMsOf(process.cpuUsage(cpuAtStart)),
			loopStallMaxMs: Math.round(eventLoopDelay.max / 1e6),
			processCpuMs: cpuMsOf(process.cpuUsage()),
			phases: timing.phases,
		});
	});
}

export function logCatalogRequestTiming(): void {
	const timing = getCatalogRequestTiming();

	after(() => {
		console.info("Catalog request timing", {
			event: "catalog.request_timing",
			responseMs: Math.round(performance.now() - timing.startedAt),
			...timing.phases,
		});
	});
}
