import { QA_SCEPTIC_ROLES } from "@repo/database";
import { QA_TEST_TYPES } from "@repo/utils/qa-test-types";
import { describe, expect, it } from "vitest";
import {
	knownScepticRoles,
	REQUIRED_TEST_TYPE_LABELS,
	SCEPTIC_ROLES,
	STRATEGY_DEPTH_INFO,
	STRATEGY_DEPTHS,
} from "../qa-settings-constants";

describe("required test types", () => {
	it("labels every kind the shared list offers", () => {
		// A kind with no label renders as a blank chip nobody can identify, and
		// the list lives in another package — so adding one there must fail here
		// rather than ship an unnamed control.
		expect(Object.keys(REQUIRED_TEST_TYPE_LABELS).sort()).toEqual(
			[...QA_TEST_TYPES].sort(),
		);
	});

	it("labels nothing the shared list does not have", () => {
		for (const key of Object.keys(REQUIRED_TEST_TYPE_LABELS)) {
			expect(QA_TEST_TYPES).toContain(key);
		}
	});
});

describe("depth tier naming", () => {
	it("names each tier in exactly one place", () => {
		// The Current policy summary used to title-case the raw enum instead of
		// reading these labels, so the selector said "Enterprise" while the
		// summary two inches above it said "Hard". One label per tier, and every
		// surface reads it.
		for (const depth of STRATEGY_DEPTHS) {
			const info = STRATEGY_DEPTH_INFO[depth];
			expect(info.label).toBeTruthy();
			expect(Object.keys(info).sort()).toEqual(["bullets", "label"]);
		}
	});

	it("reads Light / Standard / Enterprise, whatever the stored enum says", () => {
		// The tiers are stored EASY | AVERAGE | HARD and always were. These are
		// the words the product uses for them; a reader should never have to know
		// the column's vocabulary to pick a tier.
		expect(STRATEGY_DEPTH_INFO.EASY.label).toBe("Light");
		expect(STRATEGY_DEPTH_INFO.AVERAGE.label).toBe("Standard");
		expect(STRATEGY_DEPTH_INFO.HARD.label).toBe("Enterprise");
	});
});

describe("QA settings constants", () => {
	it("keeps the UI's sceptic-role keys in step with the stored key set", () => {
		// The API validates saves against @repo/database's QA_SCEPTIC_ROLES. If the
		// form offered a role that list doesn't have, ticking it would make every
		// subsequent save fail validation — with no clue why.
		expect(SCEPTIC_ROLES.map((r) => r.key).sort()).toEqual(
			[...QA_SCEPTIC_ROLES].sort(),
		);
	});

	it("drops role keys this build doesn't know about", () => {
		// A row written by a newer build (or carrying a since-removed role) must
		// not be echoed back to the API, which would reject the whole save.
		expect(
			knownScepticRoles(["security", "from-the-future", "ux"]),
		).toEqual(["security", "ux"]);
	});

	it("keeps known keys untouched", () => {
		const all = SCEPTIC_ROLES.map((r) => r.key);
		expect(knownScepticRoles([...all])).toEqual(all);
	});

	it("documents every strategy depth it offers", () => {
		// The depth cards state the policy each option implies; a depth without
		// copy would render an empty, meaningless choice.
		for (const depth of STRATEGY_DEPTHS) {
			const info = STRATEGY_DEPTH_INFO[depth];
			expect(info.label.length).toBeGreaterThan(0);
			expect(info.bullets.length).toBeGreaterThan(0);
		}
	});
});
