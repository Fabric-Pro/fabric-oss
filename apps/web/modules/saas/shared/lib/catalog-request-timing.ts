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
	| "catalog_session"
	| "catalog_params";

type CatalogRequestTiming = {
	startedAt: number;
	phases: Partial<Record<CatalogRequestPhase, number>>;
};

const getCatalogRequestTiming = cache(
	(): CatalogRequestTiming => ({
		startedAt: performance.now(),
		phases: {},
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
		timing.phases[phase] = Math.round(performance.now() - startedAt);
	}
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
