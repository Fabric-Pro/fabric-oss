import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { reports: { artifacts: { list: m.list } } },
}));

import { ReportArtifactBrowserDialog } from "../ReportArtifactBrowserDialog";

const artifact = {
	id: "example-pdf",
	name: "Reviewed.pdf",
	artifactType: "PDF",
	size: 100,
	linkedFrameId: "example-frame",
};
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
describe("native report output browser", () => {
	it("pages outputs using the returned cursor and keeps explicit preview/share actions separate", async () => {
		m.list
			.mockResolvedValueOnce({
				artifacts: [artifact],
				hasMore: true,
				nextCursor: "example-next",
			})
			.mockResolvedValue({
				artifacts: [
					{ ...artifact, id: "example-older", name: "Older.pdf" },
				],
				hasMore: false,
				nextCursor: null,
			});
		const view = vi.fn();
		const share = vi.fn();
		render(
			<ReportArtifactBrowserDialog
				executionId="example-run"
				organizationId="example-org"
				frameBasePath="/app/example-org/frames"
				onClose={vi.fn()}
				onView={view}
				onShare={share}
				onHistory={vi.fn()}
				onEmail={vi.fn()}
			/>,
		);
		await screen.findByText("Reviewed.pdf");
		expect(share).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Preview" }));
		expect(view).toHaveBeenCalledWith("example-pdf", "Reviewed.pdf");
		fireEvent.click(screen.getByRole("button", { name: "Next outputs" }));
		await screen.findByText("Older.pdf");
		expect(m.list).toHaveBeenLastCalledWith({
			executionId: "example-run",
			organizationId: "example-org",
			cursor: "example-next",
			limit: 20,
		});
		expect(
			screen.getByRole("button", { name: "Next outputs" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Previous outputs" }),
		).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "Share to inbox" }));
		expect(share).toHaveBeenCalledWith("example-older", "Older.pdf");
	});
	it("shows a current-access failure without retaining stale artifact links", async () => {
		m.list.mockRejectedValue(new Error("access revoked"));
		render(
			<ReportArtifactBrowserDialog
				executionId="example-run"
				organizationId="example-org"
				frameBasePath="/frames"
				onClose={vi.fn()}
				onView={vi.fn()}
				onShare={vi.fn()}
				onHistory={vi.fn()}
				onEmail={vi.fn()}
			/>,
		);
		await screen.findByRole("alert");
		expect(
			screen.queryByRole("link", { name: "Download" }),
		).not.toBeInTheDocument();
	});
});

it("shows preview progress and prevents duplicate preview actions while fetching", async () => {
	m.list.mockResolvedValue({
		artifacts: [artifact],
		hasMore: false,
		nextCursor: null,
	});
	const preview = vi.fn();
	render(
		<ReportArtifactBrowserDialog
			executionId="example-run"
			organizationId="example-org"
			frameBasePath="/frames"
			loadingArtifactId="example-pdf"
			onClose={vi.fn()}
			onView={preview}
			onShare={vi.fn()}
			onHistory={vi.fn()}
			onEmail={vi.fn()}
		/>,
	);
	await screen.findByText("Reviewed.pdf");
	const button = screen.getByRole("button", { name: "Opening preview…" });
	expect(button).toBeDisabled();
	expect(button).toHaveAttribute("aria-busy", "true");
	fireEvent.click(button);
	expect(preview).not.toHaveBeenCalled();
});
