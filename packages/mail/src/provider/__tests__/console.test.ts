import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: {
		log: vi.fn(),
	},
}));

import { logger } from "@repo/logs";
import { send } from "../console";

describe("Console provider - headers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("logs headers when provided", async () => {
		await send({
			to: "user@example.com",
			subject: "Test",
			text: "Hello",
			headers: {
				"X-Correlation-ID": "req_test_123",
				"X-Custom": "value",
			},
		});

		const loggedOutput = vi.mocked(logger.log).mock.calls[0][0];
		expect(loggedOutput).toContain("X-Correlation-ID");
		expect(loggedOutput).toContain("req_test_123");
	});

	it("does not log headers section when no headers provided", async () => {
		await send({
			to: "user@example.com",
			subject: "Test",
			text: "Hello",
		});

		const loggedOutput = vi.mocked(logger.log).mock.calls[0][0];
		expect(loggedOutput).not.toContain("Headers:");
	});
});
