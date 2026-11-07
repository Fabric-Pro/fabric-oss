import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.mock("next-intl", async (actual) => await actual());
const m = vi.hoisted(() => ({
	start: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	download: vi.fn(),
	save: vi.fn(),
	close: vi.fn(),
	userId: "example-user",
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: m.userId } }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			startExport: m.start,
			getExport: m.get,
			cancelExport: m.cancel,
			downloadExport: m.download,
		},
	},
}));
vi.mock("../../lib/download-file", () => ({ downloadHref: m.save }));

import { FrameExportDialog } from "../FrameExportDialog";

const job = {
	exportId: "example-export",
	status: "pending",
	expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
	expiresAt: "2026-11-02T00:00:00.000Z",
};
function setup(
	open = true,
	presentation: "DOCUMENT" | "INTERFACE" = "DOCUMENT",
	supportsNativePdf = true,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={client}>
				<FrameExportDialog
					frameId="example-frame"
					organizationId="example-org"
					updatedAt={job.expectedUpdatedAt}
					title="Example report"
					kind="frame"
					presentation={presentation}
					supportsNativePdf={supportsNativePdf}
					open={open}
					onOpenChange={m.close}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
	return { ...view, client };
}
beforeEach(() => {
	vi.clearAllMocks();
	m.start.mockResolvedValue(job);
	m.get.mockResolvedValue(job);
	m.cancel.mockResolvedValue({ ...job, status: "running" });
	m.download.mockResolvedValue({
		url: "https://example.com/download",
		expiresAt: job.expiresAt,
	});
});
it("starts only after confirmation with the reviewed revision", async () => {
	setup();
	expect(m.start).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	await screen.findByText("Export queued");
	expect(m.start).toHaveBeenCalledWith(
		expect.objectContaining({
			id: "example-frame",
			organizationId: "example-org",
			expectedUpdatedAt: job.expectedUpdatedAt,
			orientation: "portrait",
			requestId: expect.any(String),
		}),
	);
});
it("reuses the same admission identity after a lost acknowledgement", async () => {
	m.start.mockRejectedValueOnce(new Error("Connection lost"));
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Check export request" }),
	);
	await screen.findByText("Export queued");
	expect(m.start).toHaveBeenCalledTimes(2);
	expect(m.start.mock.calls[1][0].requestId).toBe(
		m.start.mock.calls[0][0].requestId,
	);
});
it("waits for cancellation confirmation instead of declaring success early", async () => {
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Cancel export" }),
	);
	await screen.findByText(
		"Cancellation requested. Waiting for confirmation…",
	);
	expect(screen.queryByText("Export cancelled")).toBeNull();
	expect(m.cancel).toHaveBeenCalledWith({
		id: "example-frame",
		organizationId: "example-org",
		exportId: job.exportId,
	});
});
it("asks for a fresh authorized link only when Download is clicked", async () => {
	m.start.mockResolvedValue({ ...job, status: "completed" });
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	const button = await screen.findByRole("button", { name: "Download PDF" });
	expect(m.download).not.toHaveBeenCalled();
	fireEvent.click(button);
	await waitFor(() =>
		expect(m.save).toHaveBeenCalledWith(
			"https://example.com/download",
			"Example report.pdf",
		),
	);
});
it("does not poll while closed", async () => {
	setup(false);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(m.get).not.toHaveBeenCalled();
	expect(m.start).not.toHaveBeenCalled();
});

it("immediately shows a confirmed cancellation instead of stale cached progress", async () => {
	m.cancel.mockResolvedValue({ ...job, status: "cancelled" });
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Cancel export" }),
	);
	await screen.findByText("Export cancelled");
	expect(screen.queryByRole("button", { name: "Cancel export" })).toBeNull();
});

it("explains static interface limitations before export without claiming a document theme", () => {
	setup(true, "INTERFACE");
	expect(
		screen.getByText(
			/Inline SVG, form fields and dynamic content are not supported/,
		),
	).toBeVisible();
	expect(screen.queryByText(/without a saved brand theme/)).toBeNull();
});

it("explains unsupported multi-block Interface export before admission", () => {
	setup(true, "INTERFACE", false);
	expect(
		screen.getByText(/Combine the interface into one HTML block/),
	).toBeVisible();
	expect(screen.getByRole("button", { name: "Create PDF" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Create PDF" }));
	expect(m.start).not.toHaveBeenCalled();
});
