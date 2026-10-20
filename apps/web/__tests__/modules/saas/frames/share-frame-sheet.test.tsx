import { ShareFrameSheet } from "@saas/frames/components/ShareFrameSheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listGrants: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { frames: { listGrants: mocks.listGrants } },
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@ui/components/sheet", () => {
	const Pass = ({ children }: { children?: ReactNode }) => (
		<div>{children}</div>
	);
	return {
		Sheet: Pass,
		SheetContent: Pass,
		SheetHeader: Pass,
		SheetTitle: Pass,
		SheetDescription: Pass,
	};
});

function renderSharing(isProjectFrame = false) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ShareFrameSheet
				frameId="frame-1"
				isProjectFrame={isProjectFrame}
				open
				onOpenChange={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => vi.clearAllMocks());

describe("ShareFrameSheet", () => {
	it("makes no privacy claim or access change available while loading", () => {
		mocks.listGrants.mockReturnValue(new Promise(() => {}));
		renderSharing();

		expect(screen.getByRole("status")).toHaveTextContent(
			"Loading sharing settings",
		);
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(screen.queryByText(/completely private/)).toBeNull();
	});

	it("shows failed verification and retries instead of claiming private access", async () => {
		mocks.listGrants.mockRejectedValueOnce(
			new Error("Output validation failed"),
		);
		mocks.listGrants.mockResolvedValueOnce({
			shareScope: "PROJECT",
			grants: [],
		});
		renderSharing();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"could not be verified",
		);
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(screen.queryByText(/completely private/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(
			await screen.findByRole("radio", { name: "Project members" }),
		).toBeChecked();
		expect(
			screen.getByRole("radio", { name: "Private" }),
		).not.toBeChecked();
		expect(
			screen.getByText(
				/Accepted members of this frame's project can access it/,
			),
		).toBeInTheDocument();
		expect(mocks.listGrants).toHaveBeenCalledTimes(2);
	});

	it("hides stale private claims when a later refresh fails", async () => {
		mocks.listGrants.mockResolvedValueOnce({
			shareScope: "PRIVATE",
			grants: [],
		});
		const client = renderSharing();
		expect(
			await screen.findByText(/completely private/),
		).toBeInTheDocument();
		expect(screen.queryByText(/retain access regardless/)).toBeNull();

		mocks.listGrants.mockRejectedValueOnce(
			new Error("Network unavailable"),
		);
		await client.invalidateQueries({
			queryKey: ["frame", "grants", "frame-1"],
		});

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.queryByText(/completely private/)).toBeNull();
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});

	it("explains inherited project access even when the saved scope is PRIVATE", async () => {
		mocks.listGrants.mockResolvedValueOnce({
			shareScope: "PRIVATE",
			grants: [],
		});
		renderSharing(true);

		expect(
			await screen.findByRole("radio", { name: "Private" }),
		).toBeChecked();
		expect(screen.getByText(/accepted project members/)).toHaveTextContent(
			"project-scoped guests, retain access regardless of this sharing setting",
		);
		expect(screen.getByText("No additional sharing")).toBeInTheDocument();
		expect(screen.queryByText(/Only you can access/)).toBeNull();
		expect(screen.queryByText(/completely private/)).toBeNull();
	});

	it("describes email invitations as access in addition to project membership", async () => {
		mocks.listGrants.mockResolvedValueOnce({
			shareScope: "EMAILS_ONLY",
			grants: [],
		});
		renderSharing(true);

		expect(
			await screen.findByRole("radio", { name: "Email invites only" }),
		).toBeChecked();
		expect(
			screen.getByText(/People you invite by email can also view/),
		).toBeInTheDocument();
		expect(screen.getByText(/accepted project members/)).toHaveTextContent(
			"retain access regardless of this sharing setting",
		);
		expect(screen.queryByText(/Only the people you invite/)).toBeNull();
	});
});
