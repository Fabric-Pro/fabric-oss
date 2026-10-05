/**
 * The rename control beside a document's title.
 *
 * It is hidden until the title is hovered. Hover never happens on a touch
 * device, so there it stayed invisible while still taking the tap — and a
 * keyboard user focused it without seeing it. On a document card it also sits
 * in a region that passes clicks through to the card, so it has to take its
 * own pointer events, and so does the input it opens.
 *
 * jsdom evaluates no media queries, so the classes that carry the behaviour
 * are pinned, as `ProjectFavoriteToggle.test.tsx` does.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				update: {
					mutationOptions: (opts: unknown) => ({ ...(opts ?? {}) }),
				},
				list: { queryKey: () => ["projects.documents.list"] },
				get: { queryKey: () => ["projects.documents.get"] },
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { DocumentTitleInlineEdit } from "../DocumentTitleInlineEdit";

function renderTitle() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<DocumentTitleInlineEdit
				projectId="proj_1"
				documentId="doc_1"
				organizationId="org_1"
				title="Project Proposal"
				canEdit
			/>
		</QueryClientProvider>,
	);
}

const classes = (element: Element) => element.className.split(/\s+/);
const rename = () => screen.getByRole("button", { name: "Rename document" });

describe("DocumentTitleInlineEdit — the rename control without a mouse", () => {
	it("keeps the mouse behaviour: hidden until the title is hovered", () => {
		renderTitle();

		expect(classes(rename())).toEqual(
			expect.arrayContaining(["opacity-0", "group-hover:opacity-60"]),
		);
	});

	it("is visible on a touch device, which never hovers", () => {
		renderTitle();

		// A bare `opacity-0` would leave an invisible control that still
		// takes the tap and turns the title into an input.
		expect(classes(rename())).toContain("pointer-coarse:opacity-60");
	});

	it("is visible when it holds keyboard focus", () => {
		renderTitle();

		expect(classes(rename())).toContain("focus-visible:opacity-100");
	});

	it("gets a larger target than its icon on a touch device", () => {
		renderTitle();

		expect(classes(rename())).toEqual(
			expect.arrayContaining([
				"relative",
				"pointer-coarse:after:absolute",
				"pointer-coarse:after:-inset-3.5",
			]),
		);
	});

	it("takes its own pointer events, and so does the input it opens", async () => {
		const user = userEvent.setup();
		renderTitle();

		expect(classes(rename())).toContain("pointer-events-auto");

		await user.click(rename());

		const input = screen.getByDisplayValue("Project Proposal");
		expect(input.closest(".pointer-events-auto")).not.toBeNull();
	});
});
