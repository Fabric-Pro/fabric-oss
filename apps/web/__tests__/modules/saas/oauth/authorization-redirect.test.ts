import { followAuthorizationRedirect } from "@saas/oauth/lib/authorization-redirect";
import { describe, expect, it, vi } from "vitest";

const CALLBACK = "http://127.0.0.1:64702/callback?code=example&state=example";

describe("followAuthorizationRedirect", () => {
	it("leaves a redirect answer to the auth client's plugin, so the callback is requested once", () => {
		const location = { assign: vi.fn() };

		followAuthorizationRedirect(
			{ redirect: true, url: CALLBACK },
			location,
		);

		expect(location.assign).not.toHaveBeenCalled();
	});

	it("navigates itself when the answer is not marked as a redirect", () => {
		const location = { assign: vi.fn() };

		followAuthorizationRedirect({ url: CALLBACK }, location);

		expect(location.assign).toHaveBeenCalledTimes(1);
		expect(location.assign).toHaveBeenCalledWith(CALLBACK);
	});
});
