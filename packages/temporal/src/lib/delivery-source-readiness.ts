/** Server-only operator/storage gate; never a source or provider-health grant. */
import { db } from "@repo/database";

export type PrivateDeliverySourceAvailability =
	| { state: "ENABLED"; reason: null }
	| { state: "UNAVAILABLE"; reason: "NOT_ENABLED" | "STORAGE_UNAVAILABLE" };

/** Synchronous discovery ceiling only. Handlers must also check storage readiness. */
export function isPrivateDeliverySourceCaptureEnabled(): boolean {
	return process.env.FABRIC_PRIVATE_SOURCE_CAPTURE_ENABLED === "true";
}

/** Catalog-only storage check, independent of ingestion; retention must continue while capture is off. */
export function isPrivateDeliverySourceStorageReady(): Promise<boolean> {
 return storageReady(false);
}
/** Capture needs the new command columns and validated constraints; cleanup needs only the base tables. */
async function storageReady(requireHistory: boolean): Promise<boolean> {
	try {
		const rows = await db.$queryRaw<Array<{ ready: boolean }>>`
			SELECT count(*) = 5 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
 AND (NOT ${requireHistory} OR (
 (SELECT count(*)=2 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass('public.delivery_signal_source_command') AND a.attname IN ('captureWindowStart','captureWindowEnd') AND NOT a.attisdropped AND a.atttypid='timestamp'::regtype)
 AND (SELECT count(*)=2 FROM pg_catalog.pg_constraint k WHERE k.conrelid=to_regclass('public.delivery_signal_source_command') AND k.conname IN ('delivery_source_capture_window_valid','delivery_source_capture_window_finite') AND k.convalidated)
 )) AS ready
			FROM pg_catalog.pg_class c
			JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
			AND c.relname IN (
				'delivery_signal_watch', 'delivery_signal_source_grant',
				'delivery_signal_observation', 'delivery_signal_source_command',
				'delivery_signal_capture_page'
			)`;
		return rows[0]?.ready === true;
	} catch {
		return false;
	}
}

/** No cache: disabling/re-enabling or a schema change must affect the next call. */
export async function getPrivateDeliverySourceAvailability(): Promise<PrivateDeliverySourceAvailability> {
	if (!isPrivateDeliverySourceCaptureEnabled()) {
		return { state: "UNAVAILABLE", reason: "NOT_ENABLED" };
	}
	return (await storageReady(true))
		? { state: "ENABLED", reason: null }
		: { state: "UNAVAILABLE", reason: "STORAGE_UNAVAILABLE" };
}

export class PrivateDeliverySourceUnavailableError extends Error {
	readonly code = "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE";
	constructor(readonly reason: "NOT_ENABLED" | "STORAGE_UNAVAILABLE") {
		super("Private source capture is not available in this deployment.");
		this.name = "PrivateDeliverySourceUnavailableError";
	}
}

/** Call after actor/object authorization; this does not replace either check. */
export async function requirePrivateDeliverySourceAvailability(): Promise<void> {
	const availability = await getPrivateDeliverySourceAvailability();
	if (availability.state !== "ENABLED") {
		throw new PrivateDeliverySourceUnavailableError(availability.reason);
	}
}
