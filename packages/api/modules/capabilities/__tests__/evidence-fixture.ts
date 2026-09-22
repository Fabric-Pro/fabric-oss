/**
 * A plain, fully-satisfied `CapabilityEvidence`, plus a deep-merge helper.
 *
 * Every rule is pure and reads nothing but this object, so a test never needs a
 * database. The default is the happy project — everything connected, indexed
 * and grounded — and each test states only the thing it is taking away. That
 * way a test reads as its own scenario rather than as a wall of setup, and a
 * new field added to the evidence type does not silently change what an
 * existing test was asserting.
 */

import type { CapabilityEvidence, JobSnapshot } from "../types";

export const IDLE_JOB: JobSnapshot = {
	running: false,
	lastProgressAt: null,
	lastRunFailed: false,
};

export function runningJob(lastProgressAt: Date): JobSnapshot {
	return { running: true, lastProgressAt, lastRunFailed: false };
}

export function healthyEvidence(): CapabilityEvidence {
	return {
		projectId: "project_example",
		viewer: { canEditProjectSettings: true, canUpdateProject: true },
		codebase: {
			connected: true,
			indexingEnabled: true,
			indexingAvailable: true,
			usable: true,
			healthy: true,
			integrationStatus: "ACTIVE",
			indexing: { ...IDLE_JOB },
			lastIndexCompletedAt: new Date("2026-09-01T00:00:00.000Z"),
			retryTargetId: "integration_example",
			graphReady: false,
		},
		context: {
			total: 4,
			technical: 2,
			product: 2,
			processing: { ...IDLE_JOB },
			hasFailedSource: false,
			technicalInFlight: 0,
			productInFlight: 0,
		},
		documents: {
			usableTypes: new Set(["PRD", "ARCHITECTURE", "TECHNICAL_SPEC"]),
			inFlightTypes: new Set(),
			generating: { ...IDLE_JOB },
		},
		descriptionLength: 240,
		// The default configuration: the two AI reviewers are on, neither
		// repository scanner is, so the scan needs no codebase.
		scan: { ...IDLE_JOB, requiresCodebase: false },
	};
}

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Merge an override over the healthy default, one level of nesting deep. */
export function evidenceWith(
	overrides: DeepPartial<CapabilityEvidence>,
): CapabilityEvidence {
	const base = healthyEvidence();
	for (const [key, value] of Object.entries(overrides)) {
		const current = (base as Record<string, unknown>)[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!(value instanceof Set) &&
			!(value instanceof Date) &&
			current !== null &&
			typeof current === "object" &&
			!(current instanceof Set)
		) {
			(base as Record<string, unknown>)[key] = { ...current, ...value };
		} else {
			(base as Record<string, unknown>)[key] = value;
		}
	}
	return base;
}
