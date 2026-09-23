import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real translator, so the FR15 copy is asserted as shipped.
vi.mock("next-intl", async (importActual) => importActual());

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" } }),
}));

import { AiRecommendedGuidance } from "../AiRecommendedGuidance";

const FR15 =
	"This was created as part of an AI-recommendation batch. To remove a full batch, use the context menu in the Roadmap. To protect an item from removal, use the context menu on this page and choose ‘Protect Work Item.’";

function withIntl(ui: ReactNode) {
	return (
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			{ui}
		</NextIntlClientProvider>
	);
}

describe("AiRecommendedGuidance", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the FR15 copy verbatim as a note", async () => {
		render(withIntl(<AiRecommendedGuidance projectId="project-1" />));
		const note = await screen.findByRole("note");
		expect(note).toHaveTextContent(FR15);
	});

	it("drops the protect hint on an item that is already protected", async () => {
		render(
			withIntl(
				<AiRecommendedGuidance projectId="project-1" isProtected />,
			),
		);
		const note = await screen.findByRole("note");
		expect(note).toHaveTextContent(
			"This was created as part of an AI-recommendation batch and is protected, so removing its batch will skip it. To remove a full batch, use the context menu in the Roadmap.",
		);
		expect(note).not.toHaveTextContent(/To protect an item/);
	});

	it("stays dismissed for the same person and project, not for another project", async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			withIntl(<AiRecommendedGuidance projectId="project-1" />),
		);
		await user.click(
			await screen.findByRole("button", {
				name: "Dismiss AI recommendation guidance",
			}),
		);
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		expect(
			window.localStorage.getItem(
				"fabric:ai-recommended-guidance-dismissed:user-1:project-1",
			),
		).toBe("1");
		unmount();

		const again = render(
			withIntl(<AiRecommendedGuidance projectId="project-1" />),
		);
		await Promise.resolve();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		again.unmount();

		render(withIntl(<AiRecommendedGuidance projectId="project-2" />));
		expect(await screen.findByRole("note")).toBeInTheDocument();
	});

	it("still shows and dismisses when storage throws", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const user = userEvent.setup();
		render(withIntl(<AiRecommendedGuidance projectId="project-1" />));

		await user.click(
			await screen.findByRole("button", {
				name: "Dismiss AI recommendation guidance",
			}),
		);
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});
