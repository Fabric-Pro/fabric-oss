import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
	}),
}));

import { FailedBriefState } from "../FailedBriefState";

const copy = en.app.aiProviderMissing;

// A brief that failed because the organization has no AI provider says so,
// and links to where one is configured, instead of "Activity task failed".
describe("FailedBriefState", () => {
	it("explains a missing AI provider and links to the organization's AI providers", () => {
		render(<FailedBriefState errorMessage="AI_PROVIDER_NOT_CONFIGURED" />);
		expect(screen.getByTestId("brief-provider-missing")).toHaveTextContent(
			copy.title,
		);
		expect(
			screen.getByRole("link", { name: copy.configure }),
		).toHaveAttribute("href", "/app/example-org/settings/ai-providers");
		expect(screen.queryByText("AI_PROVIDER_NOT_CONFIGURED")).toBeNull();
	});

	it("shows any other error as before", () => {
		render(<FailedBriefState errorMessage="Sources unavailable" />);
		expect(screen.getByText("Sources unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: copy.configure })).toBeNull();
	});
});
