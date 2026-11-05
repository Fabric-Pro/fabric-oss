import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	props: vi.fn(),
	userId: "example-user",
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: m.userId } }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { frames: { get: m.get } },
}));
vi.mock("@saas/frames/components/FrameRevisionDialog", () => ({
	FrameRevisionDialog: (props: unknown) => {
		m.props(props);
		return <div>Shared revision controls</div>;
	},
}));

import { PageHistorySheet } from "../PageHistorySheet";

const frame = {
	id: "example-frame",
	userId: "example-user",
	title: "Example",
	updatedAt: "2026-11-01T00:00:00Z",
	document: { blocks: [] },
};
function setup(open = true) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<PageHistorySheet
				frameId="example-frame"
				organizationId="example-org"
				open={open}
				onOpenChange={vi.fn()}
				onRestored={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	m.userId = "example-user";
	m.get.mockResolvedValue(frame);
});
it("does not load an unopened history surface", () => {
	setup(false);
	expect(m.get).not.toHaveBeenCalled();
});
it("uses the shared controls for the current owner and tenant", async () => {
	setup();
	await screen.findByText("Shared revision controls");
	expect(m.get).toHaveBeenCalledWith({
		id: "example-frame",
		organizationId: "example-org",
	});
	expect(m.props).toHaveBeenCalledWith(
		expect.objectContaining({
			frame,
			organizationId: "example-org",
			userId: "example-user",
			initialTab: "history",
		}),
	);
});
it("does not expose owner editing controls to a shared viewer", async () => {
	m.get.mockResolvedValue({ ...frame, userId: "example-owner" });
	setup();
	await screen.findByRole("alert");
	expect(m.props).not.toHaveBeenCalled();
});
it("shows a read failure without claiming there is no history", async () => {
	m.get.mockRejectedValue(new Error("unavailable"));
	setup();
	await screen.findByRole("alert");
	expect(m.props).not.toHaveBeenCalled();
});
