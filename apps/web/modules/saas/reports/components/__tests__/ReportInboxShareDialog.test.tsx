import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	download: vi.fn(),
	share: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@saas/organizations/lib/api", () => ({
	useFullOrganizationQuery: () => ({
		data: {
			members: [
				{
					user: {
						id: "example-member",
						name: "Example reviewer",
						email: "reviewer@example.com",
					},
				},
			],
		},
		isPending: false,
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		reports: { artifacts: { download: m.download, distribute: m.share } },
	},
}));
vi.mock("sonner", () => ({ toast: { success: m.toast } }));

import { ReportInboxShareDialog } from "../ReportInboxShareDialog";

afterEach(cleanup);
beforeEach(() => {
	vi.clearAllMocks();
	m.download.mockResolvedValue({ artifactHash: "a".repeat(64) });
});
describe("explicit report inbox sharing", () => {
	it("requires recipient review and output verification, then retains request identity on uncertain retry", async () => {
		m.share
			.mockRejectedValueOnce(new Error("lost response"))
			.mockResolvedValue({ recipientCount: 1 });
		const close = vi.fn();
		render(
			<ReportInboxShareDialog
				artifactId="example-artifact"
				artifactName="Weekly.pdf"
				organizationId="example-org"
				onClose={close}
			/>,
		);
		expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Example reviewer" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Share with 1" }),
			).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Share with 1" }));
		await screen.findByRole("alert");
		expect(close).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Share with 1" }));
		await waitFor(() => expect(close).toHaveBeenCalledOnce());
		const first = m.share.mock.calls[0][0];
		expect(first).toMatchObject({
			artifactId: "example-artifact",
			organizationId: "example-org",
			expectedArtifactHash: "a".repeat(64),
			recipientUserIds: ["example-member"],
		});
		expect(m.share.mock.calls[1][0].requestId).toBe(first.requestId);
	});
	it("refuses sharing when the exact artifact cannot be verified", async () => {
		m.download.mockRejectedValue(new Error("access revoked"));
		render(
			<ReportInboxShareDialog
				artifactId="example-artifact"
				artifactName="Weekly.pdf"
				organizationId="example-org"
				onClose={vi.fn()}
			/>,
		);
		await screen.findByRole("alert");
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Example reviewer" }),
		);
		expect(
			screen.getByRole("button", { name: "Share with 1" }),
		).toBeDisabled();
		expect(m.share).not.toHaveBeenCalled();
	});
});
