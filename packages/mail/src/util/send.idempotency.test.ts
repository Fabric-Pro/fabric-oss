import { describe, expect, it, vi } from "vitest";

const sendSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../provider", () => ({
	send: (...args: unknown[]) => sendSpy(...args),
}));
vi.mock("./templates", () => ({
	getTemplate: vi
		.fn()
		.mockResolvedValue({ subject: "S", text: "T", html: "<p>H</p>" }),
}));

import { sendEmail } from "./send";

describe("sendEmail idempotencyKey (template path)", () => {
	it("forwards idempotencyKey to the provider", async () => {
		sendSpy.mockClear();
		await sendEmail({
			to: "a@b.com",
			templateId: "releaseNotesNewsletter",
			// @ts-expect-error context shape intentionally unchecked; getTemplate is mocked
			context: {},
			idempotencyKey: "newsletter-send123-deadbeef",
		});
		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(sendSpy.mock.calls[0][0]).toMatchObject({
			idempotencyKey: "newsletter-send123-deadbeef",
		});
	});
});
