/**
 * The read side of a status-announcement notification must be able to see and
 * render the row the sweeper writes.
 *
 * The sweeper lives in `@repo/database` and therefore cannot run this validator —
 * the same architectural gap the incident and report payloads carry. That gap is
 * what made the original implementation wrong: it reused `SYSTEM_INCIDENT`, whose
 * registered schema requires `incidentId`, a sev1/sev2/sev3 `severity` and a
 * `summary`, none of which an announcement has. Nothing would have failed at write
 * time; the rows would simply have been unrenderable — and invisible besides, since
 * the bell excludes incident types.
 *
 * This closes the gap from the read side. `PAYLOAD_LITERAL` is the exact object the
 * sweeper's own test asserts it writes (`toEqual`, in
 * `packages/database/__tests__/status-announcement-notifications.test.ts`), so the
 * two tests form a chain: the sweeper writes this shape, and this shape validates.
 * Drifting either end fails one of them.
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../incident-notification-types";
import { validatePayload } from "../payloads";

/** Mirrors the sweeper's write. Kept in sync by the assertion cited above. */
const PAYLOAD_LITERAL = {
	statusUpdateId: "su_1",
	impact: "MAJOR",
	lifecycle: "INVESTIGATING",
	startedAt: "2026-08-07T11:00:00.000Z",
};

describe("the payload the sweeper writes is valid", () => {
	it("passes the registered STATUS_ANNOUNCEMENT schema", () => {
		expect(() =>
			validatePayload(
				NotificationType.STATUS_ANNOUNCEMENT,
				PAYLOAD_LITERAL,
			),
		).not.toThrow();
	});

	it("keeps the validator total over the new enum value", () => {
		// A new NotificationType with no registered schema is the failure this
		// catches: the row writes, then the renderer has nothing to parse it with.
		expect(NotificationType.STATUS_ANNOUNCEMENT).toBe(
			"STATUS_ANNOUNCEMENT",
		);
		expect(() =>
			validatePayload(
				NotificationType.STATUS_ANNOUNCEMENT,
				PAYLOAD_LITERAL,
			),
		).not.toThrow();
	});

	it.each(["statusUpdateId", "impact", "lifecycle", "startedAt"])(
		"rejects the payload when %s is missing",
		(field) => {
			const partial = { ...PAYLOAD_LITERAL } as Record<string, unknown>;
			delete partial[field];

			expect(() =>
				validatePayload(NotificationType.STATUS_ANNOUNCEMENT, partial),
			).toThrow();
		},
	);

	it("rejects an impact the status page does not notify about", () => {
		// MINOR/NONE announcements are not notifiable; the schema says so too, so a
		// widened query cannot quietly produce rows the UI claims are high-impact.
		expect(() =>
			validatePayload(NotificationType.STATUS_ANNOUNCEMENT, {
				...PAYLOAD_LITERAL,
				impact: "MINOR",
			}),
		).toThrow();
	});
});

describe("reusing an incident type would have been wrong, not just untidy", () => {
	it("the incident schema rejects this payload outright", () => {
		// Proof that the shapes are genuinely different — a coerced announcement
		// would have needed a fabricated severity and an incidentId pointing at a
		// StatusUpdate row no incident lookup can resolve.
		expect(() =>
			validatePayload(NotificationType.SYSTEM_INCIDENT, PAYLOAD_LITERAL),
		).toThrow();
	});

	it("STATUS_ANNOUNCEMENT is not bell-hidden", () => {
		// The bell and the unread count exclude INCIDENT_NOTIFICATION_TYPES unless
		// the dedupe key starts with the weekly-digest prefix. The sweeper's key
		// starts with `status-announcement:` (keyed by announcement, organization and
		// recipient), so membership here would make every
		// row it writes invisible to the customers it addresses.
		expect(INCIDENT_NOTIFICATION_TYPES).not.toContain(
			"STATUS_ANNOUNCEMENT",
		);
		expect(
			"status-announcement:su_1:org_1:u1".startsWith(
				WEEKLY_DIGEST_DEDUPE_PREFIX,
			),
		).toBe(false);
	});
});

describe("the renderer must not treat this type as admin-only", () => {
	it("STATUS_ANNOUNCEMENT is absent from ADMIN_ONLY_NOTIFICATION_TYPES", async () => {
		// The sibling rule to the bell filter, and equally load-bearing. The row
		// renderer lists INTEGRATION_INCIDENT and SYSTEM_INCIDENT there, and a
		// non-platform-admin clicking one gets an "admin-only" toast instead of
		// navigation. Adding this type would make every announcement inert for
		// exactly the customers it is addressed to — and silently, because the row
		// would still appear in the bell.
		//
		// Read from source because the set is a module-local const in an app-side
		// hook this package cannot import. The bell-filter half of this pair is
		// locked by an import above; this half had nothing holding it.
		const { readFile } = await import("node:fs/promises");
		const { resolve } = await import("node:path");
		const hook = await readFile(
			resolve(
				__dirname,
				"../../../../../../apps/web/modules/saas/notifications/hooks/use-notification-row.ts",
			),
			"utf8",
		);

		const start = hook.indexOf("ADMIN_ONLY_NOTIFICATION_TYPES");
		expect(start).toBeGreaterThan(-1);
		const block = hook.slice(start, hook.indexOf("]", start));

		// Sanity-check the extraction before trusting the negative assertion.
		expect(block).toContain("SYSTEM_INCIDENT");
		expect(block).not.toContain("STATUS_ANNOUNCEMENT");
	});
});
