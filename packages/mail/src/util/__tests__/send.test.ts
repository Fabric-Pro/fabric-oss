import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the provider
vi.mock("../../provider", () => ({
	send: vi.fn().mockResolvedValue(undefined),
}));

// Mock template resolution
vi.mock("./templates", () => ({
	getTemplate: vi.fn().mockResolvedValue({
		subject: "Test Subject",
		text: "Test text",
		html: "<p>Test</p>",
	}),
}));

// Mock logger
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
	},
}));

// Mock config
vi.mock("@repo/config", () => ({
	config: {
		i18n: {
			defaultLocale: "en",
			locales: { en: "en" },
		},
	},
}));

import { logger } from "@repo/logs";
import { send } from "../../provider";
import { sendEmail } from "../send";

describe("sendEmail - correlation ID injection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("injects correlation ID from AsyncLocalStorage", async () => {
		const testCorrelationId = "req_test_abc123";

		await runWithCorrelationId(testCorrelationId, async () => {
			await sendEmail({
				to: "user@example.com",
				subject: "Test",
				text: "Hello",
			});
		});

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Correlation-ID": testCorrelationId,
				}),
			}),
		);
	});

	it("falls back to generated ID when no AsyncLocalStorage context", async () => {
		await sendEmail({
			to: "user@example.com",
			subject: "Test",
			text: "Hello",
		});

		const callArgs = vi.mocked(send).mock.calls[0][0];
		expect(callArgs.headers?.["X-Correlation-ID"]).toMatch(
			/^req_[a-z0-9]+_[a-z0-9]+$/,
		);
	});

	it("does not overwrite explicit caller-provided correlation ID", async () => {
		const explicitId = "req_explicit_override";

		await runWithCorrelationId("req_should_be_ignored", async () => {
			await sendEmail({
				to: "user@example.com",
				subject: "Test",
				text: "Hello",
				headers: { "X-Correlation-ID": explicitId },
			});
		});

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Correlation-ID": explicitId,
				}),
			}),
		);
	});

	it("preserves other caller-provided headers", async () => {
		await sendEmail({
			to: "user@example.com",
			subject: "Test",
			text: "Hello",
			headers: {
				"X-Custom-Header": "custom-value",
			},
		});

		const callArgs = vi.mocked(send).mock.calls[0][0];
		expect(callArgs.headers?.["X-Custom-Header"]).toBe("custom-value");
		expect(callArgs.headers?.["X-Correlation-ID"]).toBeDefined();
	});

	it("logs correlation ID on successful send", async () => {
		await sendEmail({
			to: "user@example.com",
			subject: "Test Subject",
			text: "Hello",
		});

		expect(logger.info).toHaveBeenCalledWith(
			"Email sent successfully",
			expect.objectContaining({
				correlationId: expect.stringMatching(/^req_/),
				to: "user@example.com",
				subject: "Test Subject",
			}),
		);
	});

	it("logs correlation ID on send failure", async () => {
		vi.mocked(send).mockRejectedValueOnce(new Error("SMTP timeout"));

		const result = await sendEmail({
			to: "user@example.com",
			subject: "Test Subject",
			text: "Hello",
		});

		expect(result).toBe(false);
		expect(logger.error).toHaveBeenCalledWith(
			"Email send failed",
			expect.objectContaining({
				correlationId: expect.stringMatching(/^req_/),
				to: "user@example.com",
				subject: "Test Subject",
				error: "SMTP timeout",
				stack: expect.any(String),
			}),
		);
	});
});
