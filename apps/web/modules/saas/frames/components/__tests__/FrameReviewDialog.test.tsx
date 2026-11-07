import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.mock("next-intl", async (actual) => await actual());
const m = vi.hoisted(() => ({
	state: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	approve: vi.fn(),
	close: vi.fn(),
	saved: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			getReview: m.state,
			listChanges: m.list,
			getChange: m.get,
			approveRevision: m.approve,
		},
	},
}));
vi.mock("../FrameChangeReview", () => ({ FrameChangeReview: () => null }));

import { FrameReviewDialog } from "../FrameReviewDialog";

const a = "2026-01-01T00:00:00.000Z";
const b = "2026-01-02T00:00:00.000Z";
const state = {
	frameId: "example-frame",
	currentUpdatedAt: a,
	currentContentHash: "a".repeat(64),
	approved: null,
	published: null,
	hasPublicLink: false,
	hasUnapprovedChanges: true,
	hasUnpublishedChanges: true,
};
function setup() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={client}>
				<FrameReviewDialog
					frameId="example-frame"
					organizationId="example-org"
					userId="example-user"
					kind="frame"
					viewedUpdatedAt={a}
					onClose={m.close}
					onSaved={m.saved}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
	return client;
}
beforeEach(() => {
	vi.resetAllMocks();
	m.state.mockResolvedValue(state);
	m.list.mockResolvedValue({ proposals: [], hasMore: false });
	m.saved.mockResolvedValue(undefined);
	m.approve.mockResolvedValue({ ...state, hasUnapprovedChanges: false });
});
it("cannot approve a revision newer than the artifact actually displayed", async () => {
	m.state.mockResolvedValue({
		...state,
		currentUpdatedAt: b,
		currentContentHash: "b".repeat(64),
	});
	setup();
	await screen.findByText(/changed after the version you viewed/);
	expect(
		screen.queryByRole("button", {
			name: "Approve current revision",
			exact: true,
		}),
	).toBeNull();
	expect(m.approve).not.toHaveBeenCalled();
	await userEvent.click(
		screen.getByRole("button", {
			name: "Reload to review current artifact",
		}),
	);
	await waitFor(() => expect(m.saved).toHaveBeenCalledOnce());
	expect(m.close).toHaveBeenCalledOnce();
});
it("pins confirmation to the displayed revision rather than replacing it after a refetch", async () => {
	const client = setup();
	await userEvent.click(
		await screen.findByRole("button", {
			name: "Approve current revision",
			exact: true,
		}),
	);
	m.state.mockResolvedValue({
		...state,
		currentUpdatedAt: b,
		currentContentHash: "b".repeat(64),
	});
	await client.invalidateQueries({ queryKey: ["frame-review"] });
	await screen.findByText(/changed after the version you viewed/);
	expect(
		screen.queryByRole("button", { name: "Confirm approval", exact: true }),
	).toBeNull();
	expect(m.approve).not.toHaveBeenCalled();
});
it("sends the exact revision and hash shown when confirming approval", async () => {
	setup();
	await userEvent.click(
		await screen.findByRole("button", {
			name: "Approve current revision",
			exact: true,
		}),
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Confirm approval", exact: true }),
	);
	expect(m.approve).toHaveBeenCalledWith({
		id: "example-frame",
		organizationId: "example-org",
		expectedUpdatedAt: a,
		expectedContentHash: "a".repeat(64),
	});
});
