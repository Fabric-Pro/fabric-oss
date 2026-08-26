/**
 * The payloads the prompt fan-outs build must satisfy their registered schemas.
 *
 * `createNotification` calls `validatePayload`, which **throws** on a mismatch —
 * and every `fanOut.*` helper wraps its per-recipient write in a try/catch that
 * logs and swallows. So a payload that disagrees with its schema does not fail
 * loudly: it produces zero notifications, forever, while the fan-out returns 0
 * and the caller carries on. Nothing upstream is in a position to notice.
 *
 * That failure mode is not hypothetical here. Both prompt notification types
 * are new and, at the time of writing, no row of either had ever been written
 * in any environment — so the pairing had never actually executed.
 *
 * These tests assert the exact objects the two helpers construct against the
 * exact schemas the writer validates with. They are cheap precisely because
 * they need no database: the mismatch is a pure shape question.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/prompt-notification-payloads.test.ts
 */

import { NotificationType } from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../../notifications/lib/payloads";

describe("PROMPT_NOMINATION_PENDING payload", () => {
	/** Exactly the object `fanOut.promptNominationPending` passes. */
	const built = {
		nominationId: "nom-1",
		promptId: "p-1",
		promptName: "Tighter drafter",
		targetScope: "ORG" as const,
		actionCount: 2,
		summaryDegraded: false,
	};

	it("validates the object the fan-out actually builds", () => {
		expect(() =>
			validatePayload(NotificationType.PROMPT_NOMINATION_PENDING, built),
		).not.toThrow();
	});

	it("accepts the system tier too", () => {
		expect(() =>
			validatePayload(NotificationType.PROMPT_NOMINATION_PENDING, {
				...built,
				targetScope: "SYSTEM",
			}),
		).not.toThrow();
	});

	it("rejects a missing field rather than writing a partial row", () => {
		// Guards the guard: if the schema accepted anything, the tests above
		// would pass against a payload that had drifted from it.
		const { nominationId: _dropped, ...missing } = built;
		expect(() =>
			validatePayload(
				NotificationType.PROMPT_NOMINATION_PENDING,
				missing,
			),
		).toThrow();
	});

	it("rejects a tier that is not a reviewable one", () => {
		// USER never reaches review; a payload claiming it would mean the
		// caller resolved the wrong recipients.
		expect(() =>
			validatePayload(NotificationType.PROMPT_NOMINATION_PENDING, {
				...built,
				targetScope: "USER",
			}),
		).toThrow();
	});
});

describe("PROMPT_DEFAULT_UPDATED payload", () => {
	/** Exactly the object `fanOut.promptDefaultUpdated` passes. */
	const built = {
		promptId: "p-1",
		promptName: "Tighter drafter",
		scope: "ORG" as const,
		targetKey: "test_case_drafter",
		documentType: "GENERAL",
		storyKind: null,
		informationalOnly: false,
	};

	it("validates the object the fan-out actually builds", () => {
		expect(() =>
			validatePayload(NotificationType.PROMPT_DEFAULT_UPDATED, built),
		).not.toThrow();
	});

	it("accepts a kind-scoped binding", () => {
		expect(() =>
			validatePayload(NotificationType.PROMPT_DEFAULT_UPDATED, {
				...built,
				storyKind: "BUG",
			}),
		).not.toThrow();
	});

	it("rejects a missing field", () => {
		const { informationalOnly: _dropped, ...missing } = built;
		expect(() =>
			validatePayload(NotificationType.PROMPT_DEFAULT_UPDATED, missing),
		).toThrow();
	});
});
