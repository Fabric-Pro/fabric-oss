import { describe, expect, it } from "vitest";
import { resolveHistoryView } from "../sync-log-access";

describe("resolveHistoryView", () => {
	it("defaults to the change log when nothing was requested", () => {
		expect(resolveHistoryView(null)).toBe("changes");
	});

	it("honours an explicit request", () => {
		expect(resolveHistoryView("sync")).toBe("sync");
		expect(resolveHistoryView("changes")).toBe("changes");
	});

	// There is deliberately no permission branch: both logs are PROJECT_READ,
	// so a deep link never has to degrade to a tab the viewer cannot open.
	it("does not withhold the sync log from anyone", () => {
		expect(resolveHistoryView("sync")).toBe("sync");
	});
});
