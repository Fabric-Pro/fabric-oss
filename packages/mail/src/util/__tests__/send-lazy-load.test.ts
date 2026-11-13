import { describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ templates: 0, provider: 0 }));

vi.mock("../templates", () => {
	loads.templates += 1;
	return { getTemplate: vi.fn() };
});

vi.mock("../../provider", () => {
	loads.provider += 1;
	return { send: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock("@repo/config", () => ({
	config: {
		i18n: { defaultLocale: "en", locales: { en: "en" } },
		support: { email: "help@example.com" },
	},
}));

import { sendEmail } from "../send";

describe("sendEmail module loading", () => {
	it("loads the templates and the provider on the first send, not on import", async () => {
		// Arrange
		expect(loads).toEqual({ templates: 0, provider: 0 });

		// Act
		const sent = await sendEmail({
			to: "dev@example.com",
			subject: "Subject",
			text: "Body",
		});
		await sendEmail({
			to: "dev@example.com",
			subject: "Again",
			text: "Body",
		});

		// Assert
		expect(sent).toBe(true);
		expect(loads).toEqual({ templates: 1, provider: 1 });
	});
});
