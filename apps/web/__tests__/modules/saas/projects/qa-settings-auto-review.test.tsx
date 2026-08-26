/**
 * The auto-review switch, and the one property that matters about it.
 *
 * Turning it on makes Fabric write into a team's pull requests. Every other
 * switch on this page defaults on so an unconfigured project behaves as it
 * always did; this one must default OFF, and the form must send exactly what the
 * person set rather than a coerced default.
 */

import { QA_SETTINGS_DEFAULTS } from "@repo/database/prisma/queries/projects/qa-settings";
import { describe, expect, it } from "vitest";

describe("automatic pull-request review", () => {
	it("is off unless a project asks for it", () => {
		// The default lives in the query layer and is what an unconfigured project
		// reads. A `true` here would start commenting on every connected
		// repository the moment this shipped.
		expect(QA_SETTINGS_DEFAULTS.prReviewAutoReviewEnabled).toBe(false);
	});

	it("leaves the two lens switches on, as they were", () => {
		expect(QA_SETTINGS_DEFAULTS.prReviewQaLensEnabled).toBe(true);
		expect(QA_SETTINGS_DEFAULTS.prReviewArchitectureLensEnabled).toBe(true);
	});
});
