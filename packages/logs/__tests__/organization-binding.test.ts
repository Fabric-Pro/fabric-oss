/**
 * Unit tests for the AsyncLocalStorage-aware logger reporter that auto-
 * binds `organizationId` into every server-side log entry (security review
 * of Fizzy #1234 — telemetry enrichment).
 *
 * Verifies:
 *  - Entries emitted inside `runWithOrganizationLogContext` carry
 *    organizationId.
 *  - Entries outside any organization context have none.
 *  - The reporter never overwrites an explicit caller-supplied
 *    organizationId.
 *  - Entries with no meta object get one appended.
 */

import { runWithOrganizationLogContext } from "@repo/utils/organization-log-context";
import type { ConsolaReporter } from "consola";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logger } from "../lib/logger";

interface CapturedEntry {
	args: unknown[];
	type: string;
}

const originalLevel = logger.level;
beforeAll(() => {
	logger.level = 5; // verbose
});
afterAll(() => {
	logger.level = originalLevel;
});

function withTestReporter(fn: (captured: CapturedEntry[]) => void) {
	const captured: CapturedEntry[] = [];
	const sink: ConsolaReporter = {
		log: (entry) => {
			captured.push({
				args: [...entry.args],
				type: entry.type,
			});
		},
	};
	logger.addReporter(sink);
	try {
		fn(captured);
	} finally {
		logger.removeReporter(sink);
	}
}

const metaOf = (entry: CapturedEntry | undefined) =>
	entry?.args.find(
		(a) => typeof a === "object" && a !== null && !Array.isArray(a),
	) as Record<string, unknown> | undefined;

describe("organization-binding logger reporter", () => {
	it("stamps organizationId onto entries emitted inside the context", () => {
		withTestReporter((captured) => {
			runWithOrganizationLogContext("org-123", () => {
				logger.error("boom", { projectId: "p1" });
			});
			expect(metaOf(captured[0])).toMatchObject({
				organizationId: "org-123",
				projectId: "p1",
			});
		});
	});

	it("appends a meta object when the call had none", () => {
		withTestReporter((captured) => {
			runWithOrganizationLogContext("org-123", () => {
				logger.error("boom");
			});
			expect(metaOf(captured[0])).toMatchObject({
				organizationId: "org-123",
			});
		});
	});

	it("leaves entries outside the context untouched", () => {
		withTestReporter((captured) => {
			logger.error("no context", { projectId: "p1" });
			expect(metaOf(captured[0])?.organizationId).toBeUndefined();
		});
	});

	it("never overwrites an explicit caller-supplied organizationId", () => {
		withTestReporter((captured) => {
			runWithOrganizationLogContext("org-123", () => {
				logger.error("boom", { organizationId: "org-explicit" });
			});
			expect(metaOf(captured[0])?.organizationId).toBe("org-explicit");
		});
	});
});
