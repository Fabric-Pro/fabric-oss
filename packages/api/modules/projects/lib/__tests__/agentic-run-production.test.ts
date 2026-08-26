/**
 * A PRODUCTION target WARNS and the run proceeds. It used to refuse.
 *
 * Product-visible in both directions, so it is pinned rather than left to a
 * comment. The previous gate demanded a `confirmProduction` flag that no caller
 * ever sent, which made every production run impossible AND left the
 * warn/refuse branch unexercisable — the spec's UNTESTED item #5.
 */

import { describe, expect, it } from "vitest";
import { describeProductionRunWarning } from "../agentic-run-production";

describe("describeProductionRunWarning", () => {
	it("warns for a PRODUCTION environment", () => {
		const warning = describeProductionRunWarning({
			name: "Live",
			type: "PRODUCTION",
		});

		expect(warning).toContain("PRODUCTION environment");
		// Past tense: by the time this is read the browser has been dispatched.
		// "will act" would imply a chance to stop it, and there is none.
		expect(warning).toContain("acted on your live system");
	});

	it("says nothing for a staging or QA environment", () => {
		expect(
			describeProductionRunWarning({ name: "Staging", type: "STAGING" }),
		).toBeNull();
		expect(
			describeProductionRunWarning({ name: "QA", type: "QA" }),
		).toBeNull();
	});

	it("names the environment, so two production targets are distinguishable", () => {
		// A team with EU and US live targets has to know from the warning alone
		// which one a run just touched.
		expect(
			describeProductionRunWarning({
				name: "EU prod",
				type: "PRODUCTION",
			}),
		).toContain("EU prod");
		expect(
			describeProductionRunWarning({
				name: "US prod",
				type: "PRODUCTION",
			}),
		).toContain("US prod");
	});
});
