/**
 * The payload map must stay TOTAL over `NotificationType` (Fizzy #2199).
 *
 * `validatePayload` looks a schema up by type and calls `.parse` on it, so a
 * type with no registered schema is a `TypeError` at the first row anyone
 * writes — the map's totality is enforced by `tsc`, but only a test proves the
 * two new types resolve to a schema that actually accepts what the writer emits.
 *
 * Keep in lock-step with `emitDocumentGenerationNotification` in
 * `@repo/database` (`prisma/queries/projects/document-generation-notifications.ts`).
 * That writer bypasses this validator entirely — its caller is a Temporal
 * activity, and `@repo/api` depends on `@repo/temporal` — which is exactly why
 * the shapes have to be pinned against each other here.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const COMPLETED = {
	documentId: "doc-1",
	projectId: "proj-1",
	status: "COMPLETED",
} as const;

const FAILED = { ...COMPLETED, status: "FAILED" } as const;

describe("document generation payload schemas", () => {
	it("resolves a schema for both new types", () => {
		expect(
			validatePayload(
				NotificationType.DOCUMENT_GENERATION_COMPLETED,
				COMPLETED,
			),
		).toMatchObject(COMPLETED);
		expect(
			validatePayload(
				NotificationType.DOCUMENT_GENERATION_FAILED,
				FAILED,
			),
		).toMatchObject(FAILED);
	});

	it("requires the project pointer the read-time access filter reads", () => {
		const { projectId: _omit, ...partial } = COMPLETED;
		expect(() =>
			validatePayload(
				NotificationType.DOCUMENT_GENERATION_COMPLETED,
				partial,
			),
		).toThrow();
	});

	it("rejects a status outside the two terminal outcomes", () => {
		expect(() =>
			validatePayload(NotificationType.DOCUMENT_GENERATION_FAILED, {
				...COMPLETED,
				status: "QUEUED",
			}),
		).toThrow();
	});

	it("strips anything the writer did not put there", () => {
		// The list API hands payloads back to the client verbatim. An error
		// string smuggled in by a future caller must not survive validation.
		const parsed = validatePayload(
			NotificationType.DOCUMENT_GENERATION_FAILED,
			{ ...FAILED, error: "ActivityFailure: timed out (run_id=abc123)" },
		);
		expect(parsed).not.toHaveProperty("error");
	});
});
