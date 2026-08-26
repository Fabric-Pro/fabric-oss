import { describe, expect, it } from "vitest";
import { GITLAB_REST_CAPABILITIES } from "../capabilities";

describe("GITLAB_REST_CAPABILITIES", () => {
	it("matches the documented contract", () => {
		expect(GITLAB_REST_CAPABILITIES).toEqual({
			hasPMCapabilities: true,
			canCreate: true,
			canUpdate: true,
			canGet: true,
			canList: true,
			canFetch: true,
			supportsPush: true,
			supportsPull: true,
			supportsTaskSync: false,
		});
	});

	it("is frozen so consumers cannot mutate", () => {
		expect(() => {
			(
				GITLAB_REST_CAPABILITIES as unknown as {
					supportsTaskSync: boolean;
				}
			).supportsTaskSync = true;
		}).toThrow();
	});
});
