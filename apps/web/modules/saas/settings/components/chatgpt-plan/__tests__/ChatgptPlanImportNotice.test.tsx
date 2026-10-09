import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => {
		let node: unknown = en;
		for (const segment of `${namespace}.${key}`.split(".")) {
			node =
				typeof node === "object" && node !== null
					? Reflect.get(node, segment)
					: undefined;
		}
		return String(node);
	},
}));

const status = vi.hoisted(() => ({
	data: null as null | Record<string, unknown>,
}));

vi.mock("../chatgpt-plan-status", () => ({
	useChatgptPlanStatus: () => ({
		query: { data: status.data },
		currentOrganization: null,
	}),
}));

import { ChatgptPlanImportNotice } from "../ChatgptPlanImportNotice";

beforeEach(() => {
	status.data = null;
});

// Fizzy #2770 F3: linking a channel or a meeting series where shared plans run
// background jobs says that the first import can take much of a window.
describe("ChatGPT plan import heads-up", () => {
	it("warns while the organization's shared plans serve its background jobs", () => {
		status.data = { sharedPlansServeBackground: true };
		render(<ChatgptPlanImportNotice />);
		expect(
			screen.getByTestId("chatgpt-plan-import-notice"),
		).toHaveTextContent(en.settings.chatgptPlanPool.importHeadsUp);
	});

	it("is absent when they do not, or the plan status is not loaded", () => {
		status.data = { sharedPlansServeBackground: false };
		const { rerender } = render(<ChatgptPlanImportNotice />);
		expect(screen.queryByTestId("chatgpt-plan-import-notice")).toBeNull();
		status.data = null;
		rerender(<ChatgptPlanImportNotice />);
		expect(screen.queryByTestId("chatgpt-plan-import-notice")).toBeNull();
	});
});
