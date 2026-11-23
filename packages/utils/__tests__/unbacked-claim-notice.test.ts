/**
 * The Direct chat's unbacked-claim notice is said to the user about a reply.
 * A surface that takes the reply as content ("Apply to document") gets the
 * reply without it, and every other reply unchanged.
 */

import { describe, expect, it } from "vitest";
import {
	UNBACKED_CLAIM_NOTICE,
	withoutUnbackedClaimNotice,
} from "../lib/unbacked-claim-notice";

const REPLY = "## Overview\n\nThe feature exports reports as PDF.";

describe("withoutUnbackedClaimNotice", () => {
	it("removes the notice the Direct chat adds under a reply", () => {
		expect(
			withoutUnbackedClaimNotice(`${REPLY}\n\n${UNBACKED_CLAIM_NOTICE}`),
		).toBe(REPLY);
	});

	it("removes it when whitespace follows the notice", () => {
		expect(
			withoutUnbackedClaimNotice(
				`${REPLY}\n\n${UNBACKED_CLAIM_NOTICE}\n`,
			),
		).toBe(REPLY);
	});

	it("leaves a reply without the notice unchanged", () => {
		expect(withoutUnbackedClaimNotice(`${REPLY}\n`)).toBe(`${REPLY}\n`);
	});

	it("leaves the notice's text in place when it is not the reply's ending", () => {
		const quoted = `${UNBACKED_CLAIM_NOTICE}\n\n${REPLY}`;

		expect(withoutUnbackedClaimNotice(quoted)).toBe(quoted);
	});

	it("leaves nothing when the reply is only the notice", () => {
		expect(withoutUnbackedClaimNotice(UNBACKED_CLAIM_NOTICE)).toBe("");
	});
});
