/**
 * Verifies the Zod schemas for the new incident notification types
 * (INTEGRATION_INCIDENT, SYSTEM_INCIDENT) accept the documented payload
 * shape and reject malformed inputs.
 *
 * Keep in lock-step with the helper in
 * packages/database/prisma/queries/incident-notifications.ts — the helper
 * inserts rows whose payload field is validated against this schema on
 * subsequent reads (see notification-service.ts validatePayload).
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const VALID = {
	incidentId: "inc-1",
	providerKey: "openai",
	severity: "sev1",
	summary: "OpenAI reports a major outage",
	link: "/app/admin/monitoring?incident=inc-1",
	startedAt: "2026-05-16T12:34:56.000Z",
} as const;

describe("incident payload schemas", () => {
	it("accepts the documented shape for INTEGRATION_INCIDENT", () => {
		const result = validatePayload(
			NotificationType.INTEGRATION_INCIDENT,
			VALID,
		);
		expect(result).toMatchObject(VALID);
	});

	it("accepts the documented shape for SYSTEM_INCIDENT (providerKey optional)", () => {
		const { providerKey, ...withoutProvider } = VALID;
		const result = validatePayload(
			NotificationType.SYSTEM_INCIDENT,
			withoutProvider,
		);
		expect(result.providerKey).toBeUndefined();
		expect(result).toMatchObject(withoutProvider);
	});

	it("rejects unknown severity values", () => {
		expect(() =>
			validatePayload(NotificationType.INTEGRATION_INCIDENT, {
				...VALID,
				severity: "warn",
			}),
		).toThrow();
	});

	it("rejects payloads missing required fields", () => {
		const { incidentId: _omit, ...partial } = VALID;
		expect(() =>
			validatePayload(
				NotificationType.SYSTEM_INCIDENT,
				partial as typeof VALID,
			),
		).toThrow();
	});

	it("rejects summary longer than 280 chars (caller must truncate first)", () => {
		expect(() =>
			validatePayload(NotificationType.SYSTEM_INCIDENT, {
				...VALID,
				summary: "x".repeat(281),
			}),
		).toThrow();
	});
});
