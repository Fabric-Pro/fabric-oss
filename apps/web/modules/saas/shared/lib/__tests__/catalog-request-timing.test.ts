import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("react", () => ({
	cache: <T>(factory: () => T) => {
		let value: T | undefined;
		return () => {
			if (value === undefined) {
				value = factory();
			}
			return value;
		};
	},
}));

import {
	logCatalogRequestTiming,
	measureCatalogRequestPhase,
} from "../catalog-request-timing";

describe("catalog request timing", () => {
	beforeEach(() => {
		mocks.after.mockReset();
	});

	it("logs the request-scoped phase timings only after the response", async () => {
		// Arrange
		const now = vi
			.spyOn(performance, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(110)
			.mockReturnValueOnce(145)
			.mockReturnValueOnce(200);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		// Act
		await measureCatalogRequestPhase("saas_session", async () => undefined);
		logCatalogRequestTiming();

		// Assert
		expect(mocks.after).toHaveBeenCalledOnce();
		expect(info).not.toHaveBeenCalled();

		const callback = mocks.after.mock.calls[0]?.[0];
		expect(callback).toBeTypeOf("function");
		callback?.();

		expect(info).toHaveBeenCalledWith("Catalog request timing", {
			event: "catalog.request_timing",
			responseMs: 100,
			saas_session: 35,
		});
		now.mockRestore();
		info.mockRestore();
	});
});
