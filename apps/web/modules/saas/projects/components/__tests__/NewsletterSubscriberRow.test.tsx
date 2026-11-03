/**
 * Org-synced subscribers carry their own icon and can be excluded and brought
 * back (Fizzy #1986, FR10-FR12). They have no Remove button, because removing
 * writes a permanent opt-out in that person's name.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewsletterSubscriberRow } from "../NewsletterSubscriberRow";

const onRemove = vi.fn();
const onSetExcluded = vi.fn();

const base = {
	id: "sub_1",
	email: "a@example.com",
	name: null,
	status: "ACTIVE",
	source: "MANUAL",
	excludedAt: null,
};

function setup(sub: Partial<typeof base> & { excludedAt?: Date | null }) {
	render(
		<NewsletterSubscriberRow
			sub={{ ...base, ...sub }}
			onRemove={onRemove}
			onSetExcluded={onSetExcluded}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("NewsletterSubscriberRow", () => {
	it("shows a manual subscriber with Remove and no organization mark", () => {
		setup({});

		fireEvent.click(
			screen.getByRole("button", { name: "Remove a@example.com" }),
		);
		expect(onRemove).toHaveBeenCalledWith("sub_1");
		expect(
			screen.queryByLabelText("Added from your organization"),
		).toBeNull();
	});

	it("marks an org-synced subscriber and offers Exclude, not Remove", () => {
		setup({ source: "ORG_SYNC" });

		expect(
			screen.getByLabelText("Added from your organization"),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Remove a@example.com" }),
		).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Exclude a@example.com" }),
		);
		expect(onSetExcluded).toHaveBeenCalledWith("sub_1", true);
	});

	it("keeps an excluded subscriber visible and lets it come back", () => {
		setup({ source: "ORG_SYNC", excludedAt: new Date() });

		expect(screen.getByText("Excluded")).toBeTruthy();
		expect(screen.queryByText("Active")).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Include a@example.com" }),
		);
		expect(onSetExcluded).toHaveBeenCalledWith("sub_1", false);
	});

	it("never offers to bring back someone who unsubscribed", () => {
		setup({ source: "ORG_SYNC", status: "UNSUBSCRIBED" });

		expect(screen.getByText("Unsubscribed")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Include|Exclude/ }),
		).toBeNull();
	});
});
