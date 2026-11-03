import { after } from "next/server";
import { cache } from "react";

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
