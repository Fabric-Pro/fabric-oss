import { describe, expect, it } from "vitest";

import { resolveMeetingDisplayName } from "../meeting-display-name";

/**
 * The rule these tests pin is a reversal: the series subject used to win,
 * defended in code as "the more stable label". Each case below is therefore
 * written so that restoring the old precedence turns it red, rather than only
 * asserting the new behaviour in isolation.
 */
describe("resolveMeetingDisplayName", () => {
	it("prefers the occurrence's own subject over the series name", () => {
		expect(
			resolveMeetingDisplayName({
				occurrence: "Fabric DSU",
				series: "Fabric Dev Sync",
			}),
		).toBe("Fabric DSU");
	});

	it("keeps naming a past occurrence after its series is renamed (#2340)", () => {
		// The reported defect, as a test. The series was renamed to "Fabric Dev
		// Sync" long after these occurrences happened; the stored series subject
		// followed the rename, the occurrence subjects did not, and the list
		// showed the series name on every row.
		const rows = [
			{ occurrence: "Fabric DSU", series: "Fabric Dev Sync" },
			{ occurrence: "Fabric DSU", series: "Fabric Dev Sync" },
		];

		expect(
			rows.map((r) =>
				resolveMeetingDisplayName({
					occurrence: r.occurrence,
					series: r.series,
				}),
			),
		).toEqual(["Fabric DSU", "Fabric DSU"]);
	});

	it("falls back to the series name when the occurrence has none", () => {
		expect(
			resolveMeetingDisplayName({
				occurrence: null,
				series: "Fabric Dev Sync",
			}),
		).toBe("Fabric Dev Sync");
	});

	it("treats the stored placeholder as no name at all", () => {
		// The case a null-keyed resolver gets wrong, and the reason this function
		// judges absence by content. `MeetingInstance.subject` is non-optional and
		// every Graph path defaults it to this literal upstream, so a calendar
		// event with no subject is stored as the placeholder rather than as null —
		// and the placeholder must not beat a real series name.
		expect(
			resolveMeetingDisplayName({
				occurrence: "Untitled Meeting",
				series: "Fabric Dev Sync",
			}),
		).toBe("Fabric Dev Sync");
	});

	it("treats a blank or whitespace-only occurrence subject as no name", () => {
		expect(
			resolveMeetingDisplayName({
				occurrence: "",
				series: "Fabric Dev Sync",
			}),
		).toBe("Fabric Dev Sync");
		expect(
			resolveMeetingDisplayName({
				occurrence: "   ",
				series: "Fabric Dev Sync",
			}),
		).toBe("Fabric Dev Sync");
	});

	it("ignores an unusable series name too, rather than only the occurrence", () => {
		expect(
			resolveMeetingDisplayName({
				occurrence: null,
				series: "Untitled Meeting",
			}),
		).toBe("Untitled Meeting");
		expect(
			resolveMeetingDisplayName({
				occurrence: "Fabric DSU",
				series: "Untitled Meeting",
			}),
		).toBe("Fabric DSU");
	});

	it("still surfaces a placeholder when it is the only stored name", () => {
		// Not a fallthrough to null: the old expression rendered "Untitled
		// Meeting" here, and a surface that showed a label yesterday should not
		// show an empty space today. Absence is reserved for genuine absence.
		expect(
			resolveMeetingDisplayName({
				occurrence: "Untitled Meeting",
				series: null,
			}),
		).toBe("Untitled Meeting");
		expect(
			resolveMeetingDisplayName({
				occurrence: null,
				series: "Untitled Meeting",
			}),
		).toBe("Untitled Meeting");
	});

	it("returns null when neither column names anything", () => {
		expect(
			resolveMeetingDisplayName({ occurrence: null, series: null }),
		).toBeNull();
		expect(
			resolveMeetingDisplayName({
				occurrence: undefined,
				series: undefined,
			}),
		).toBeNull();
		expect(
			resolveMeetingDisplayName({ occurrence: "  ", series: "" }),
		).toBeNull();
	});
});
