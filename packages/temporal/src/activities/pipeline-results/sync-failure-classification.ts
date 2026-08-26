/**
 * Classify a caught pipeline-sync error into a `SyncFailureKind` — the
 * server-side half of card #2383's classifier.
 *
 * The kind→meaning table itself (what each `SyncFailureKind` MEANS, whether
 * it's the customer's fault, whether reconnecting fixes it) lives in
 * `@repo/utils/pipeline-sync-failure-kinds`, not here: it's shared vocabulary
 * between this Temporal activity and a `"use client"` bundle
 * (`SyncFailureBanner.tsx`, the Settings ▸ Development sync-health section),
 * and `apps/web` does not depend on `@repo/temporal` for runtime values (see
 * `BacklogChat.tsx`'s module doc for the same rule). This file re-exports
 * that table for callers within `@repo/temporal` so their imports don't need
 * to change, and adds the one piece that has to stay server-side:
 * `classifySyncFailure`, which needs `ProviderHttpError`.
 *
 * Pure — no `db`, no network, no clock — so every branch is unit-testable
 * without a provider or a database.
 */

import {
	classificationForKind,
	type SyncFailureClassification,
	type SyncFailureKind,
} from "@repo/utils/pipeline-sync-failure-kinds";
import { ProviderHttpError } from "./fetchers/provider-http-error";

export type { SyncFailureClassification, SyncFailureKind };
export {
	classificationForKind,
	classificationForRawKind,
} from "@repo/utils/pipeline-sync-failure-kinds";

/**
 * Classify a caught error from the fetch/ingest/RCA path.
 *
 * A `ProviderHttpError` maps by its own `kind` (see `provider-http-error.ts`),
 * with one refinement: that file's `"OTHER"` bucket covers both 404 (a
 * specific, user-actionable state) and every other unclassified status (which
 * is ours to investigate), so it is split back apart here by `status` rather
 * than pushed onto the HTTP classifier — that file's `kind` already answers
 * "what should the message say", and 404-vs-everything-else is a distinction
 * only this sync-failure classification needs. Anything that is not a
 * `ProviderHttpError` — a plain `Error`, a Prisma error, a network failure —
 * is `UNKNOWN`: it did not come from a provider response we understand, so it
 * cannot be presumed to be the customer's problem.
 */
export function classifySyncFailure(err: unknown): SyncFailureClassification {
	if (err instanceof ProviderHttpError) {
		switch (err.kind) {
			case "UNAUTHENTICATED":
				return classificationForKind("CREDENTIAL_REJECTED");
			case "FORBIDDEN":
				return classificationForKind("PERMISSION_MISSING");
			case "SSO_REQUIRED":
				return classificationForKind("SSO_REQUIRED");
			case "RATE_LIMITED":
				return classificationForKind("RATE_LIMITED");
			case "OTHER":
				return classificationForKind(
					err.status === 404 ? "NOT_FOUND" : "UNKNOWN",
				);
			default: {
				// Exhaustiveness tie to `ProviderFailureKind`: a new value added
				// there fails to compile here until it is handled above.
				const unhandled: never = err.kind;
				void unhandled;
				return classificationForKind("UNKNOWN");
			}
		}
	}
	return classificationForKind("UNKNOWN");
}
