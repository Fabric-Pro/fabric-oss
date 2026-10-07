import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, string>) => {
			let node: unknown = en;
			for (const segment of `${namespace}.${key}`.split(".")) {
				node =
					typeof node === "object" && node !== null
						? Reflect.get(node, segment)
						: undefined;
			}
			return String(node).replace(
				/\{(\w+)\}/g,
				(_match, name: string) => values?.[name] ?? name,
			);
		},
}));

const status = vi.hoisted(() => ({
	data: null as null | Record<string, unknown>,
	currentOrganization: null as null | { enabled: boolean },
}));

vi.mock("../chatgpt-plan-status", () => ({
	useChatgptPlanStatus: () => ({
		query: { data: status.data },
		currentOrganization: status.currentOrganization,
	}),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/app/example-org" }));

import { ChatgptPlanSharedFallbackNotice } from "../ChatgptPlanSharedFallbackNotice";

const copy = en.settings.chatgptPlan.sharedFallback;

beforeEach(() => {
	status.currentOrganization = { enabled: true };
	status.data = {
		ownPlanSpent: {
			resetAt: new Date("2026-10-07T15:00:00Z"),
			servedBySharedPlan: true,
		},
	};
});

// Fizzy #2770: a member whose own plan is spent keeps working on the
// organization's shared plan, and is told so.
describe("ChatGPT plan shared fallback notice", () => {
	it("warns that the shared plan carries the work until the reset", () => {
		render(<ChatgptPlanSharedFallbackNotice />);
		expect(screen.getByText(copy.title)).toBeInTheDocument();
		expect(
			screen.getByTestId("chatgpt-plan-shared-fallback-notice"),
		).toHaveTextContent(/until about .+, when your plan resets/);
	});

	it("is absent when nothing serves the work instead", () => {
		status.data = {
			ownPlanSpent: { resetAt: null, servedBySharedPlan: false },
		};
		render(<ChatgptPlanSharedFallbackNotice />);
		expect(screen.queryByText(copy.title)).toBeNull();
	});

	it("is absent while the own plan has usage left, or is off here", () => {
		status.data = { ownPlanSpent: null };
		const { rerender } = render(<ChatgptPlanSharedFallbackNotice />);
		expect(screen.queryByText(copy.title)).toBeNull();
		status.data = {
			ownPlanSpent: { resetAt: null, servedBySharedPlan: true },
		};
		status.currentOrganization = { enabled: false };
		rerender(<ChatgptPlanSharedFallbackNotice />);
		expect(screen.queryByText(copy.title)).toBeNull();
	});
});
