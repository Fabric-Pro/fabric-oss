import { expect, it } from "vitest";
import {
	CATEGORY_TO_TOGGLE,
	DEFAULT_NOTIFICATION_PREFERENCES,
	isCategoryEnabled,
} from "../prisma/queries/notification-preferences";

it("PUBLISHING is suppressible, not always-on (D6)", () => {
	// An unsuppressible category is defensible for a rare, non-optional event — SYSTEM, BILLING,
	// the indexing pair. It is indefensible for a recurring feed. Omitting this entry is what
	// would make the bell unsuppressible, and nothing else would fail.
	expect(CATEGORY_TO_TOGGLE.PUBLISHING).toBe("publishingSuggestions");
});

it("defaults to on, matching the opt-out model of every neighbouring flag", () => {
	expect(DEFAULT_NOTIFICATION_PREFERENCES.publishingSuggestions).toBe(true);
});

it("an explicit false suppresses the category, and nothing else does", () => {
	expect(
		isCategoryEnabled(
			{
				...DEFAULT_NOTIFICATION_PREFERENCES,
				publishingSuggestions: false,
			},
			"PUBLISHING",
		),
	).toBe(false);
	expect(
		isCategoryEnabled(DEFAULT_NOTIFICATION_PREFERENCES, "PUBLISHING"),
	).toBe(true);
});

it("publishingEmails is NOT a category toggle — it gates email, never the bell", () => {
	// The negative half of the contract, and the one a positive-only suite misses. If this key
	// were registered here, turning off publishing EMAILS would also silence the in-app bell.
	// The compiler would not catch that mistake either — publishingEmails is a legal member of
	// NotificationPreferenceFlags, so CATEGORY_TO_TOGGLE's value type accepts it — which makes
	// this assertion the only thing standing between a typo and one user-facing switch silencing
	// two different channels.
	expect(Object.values(CATEGORY_TO_TOGGLE)).not.toContain("publishingEmails");
	expect(CATEGORY_TO_TOGGLE.PUBLISHING).toBe("publishingSuggestions");
});

it("publishingEmails defaults to enabled (opt-out model)", () => {
	expect(DEFAULT_NOTIFICATION_PREFERENCES.publishingEmails).toBe(true);
});

// The two DB-backed cases for getRecipientsWithEmailFlagEnabled live in
// publishing-notifications.test.ts — they need db, RUN_DB and the Task 1 seed helpers, none of
// which this file has or should gain. The "without querying" case moved there too: pinning that
// claim needs a spy on db.notificationPreference.findMany, and this file must import nothing but
// Vitest and the pure helpers above.
