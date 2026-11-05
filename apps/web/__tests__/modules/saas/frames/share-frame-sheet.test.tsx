import { ShareFrameSheet } from "@saas/frames/components/ShareFrameSheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../../../../../packages/i18n/translations/en.json";

const mocks = vi.hoisted(() => ({
	listGrants: vi.fn(),
	revokeShare: vi.fn(),
	share: vi.fn(),
	revokeInvite: vi.fn(),
	invite: vi.fn(),
	toast: vi.fn(),
	userId: "example-user",
}));
vi.mock("next-intl", async (actual) => await actual());
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: mocks.userId } }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			listGrants: mocks.listGrants,
			revokeShare: mocks.revokeShare,
			share: mocks.share,
			revokeInvite: mocks.revokeInvite,
			invite: mocks.invite,
		},
	},
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: mocks.toast }),
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
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={client}>
				<ShareFrameSheet
					frameId="frame-1"
					organizationId="example-org"
					isProjectFrame={isProjectFrame}
					open
					onOpenChange={vi.fn()}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
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

it("copies the server-issued public token rather than the internal frame ID", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	mocks.listGrants.mockResolvedValue({
		shareScope: "PUBLIC",
		shareToken: "public-token",
		canShareFramesPublicly: true,
		grants: [],
	});
	renderSharing();
	const link = await screen.findByRole("textbox", {
		name: "Public share link",
	});
	expect(link).toHaveValue(
		`${window.location.origin}/share/frame/public-token`,
	);
	fireEvent.click(screen.getByRole("button", { name: "Copy share link" }));
	expect(writeText).toHaveBeenCalledWith(
		`${window.location.origin}/share/frame/public-token`,
	);
});

it("confirms revoke-all and uses the reviewed sharing revision", async () => {
	mocks.listGrants.mockResolvedValue({
		shareScope: "PUBLIC",
		hasPublicLink: true,
		canShareFramesPublicly: true,
		canRevoke: true,
		shareToken: "example-token",
		updatedAt: "2026-11-01T00:00:00Z",
		grants: [],
	});
	mocks.revokeShare.mockResolvedValue({ success: true });
	mocks.share.mockResolvedValue({ success: true });
	renderSharing();
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Make private (revoke all)",
		}),
	);
	expect(mocks.revokeShare).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Revoke all sharing" }));
	await waitFor(() =>
		expect(mocks.share).toHaveBeenCalledWith({
			id: "frame-1",
			organizationId: "example-org",
			shareScope: "PRIVATE",
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
		}),
	);
});
it("removes only the public link through the distinct action", async () => {
	mocks.listGrants.mockResolvedValue({
		shareScope: "PUBLIC",
		hasPublicLink: true,
		canShareFramesPublicly: true,
		canRevoke: true,
		shareToken: "example-token",
		updatedAt: "2026-11-01T00:00:00Z",
		grants: [],
	});
	mocks.revokeShare.mockResolvedValue({ success: true });
	mocks.share.mockResolvedValue({ success: true });
	renderSharing();
	fireEvent.click(
		await screen.findByRole("button", { name: "Remove public link" }),
	);
	expect(mocks.revokeShare).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
	await waitFor(() =>
		expect(mocks.revokeShare).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "public-link" }),
		),
	);
});

it("keeps delete-only actions disabled for a member while retaining authorized make-private", async () => {
	mocks.listGrants.mockResolvedValue({
		shareScope: "PUBLIC",
		hasPublicLink: true,
		canShareFramesPublicly: true,
		canRevoke: false,
		shareToken: "example-token",
		updatedAt: "2026-11-01T00:00:00Z",
		grants: [
			{
				id: "example-grant",
				email: "reader@example.com",
				invitedAt: "2026-11-01T00:00:00Z",
				accessCount: 0,
			},
		],
	});
	mocks.share.mockResolvedValue({ success: true });
	renderSharing();
	const publicLink = await screen.findByRole("button", {
		name: "Remove public link",
	});
	const invitation = screen.getByRole("button", {
		name: "Remove invitation for reader@example.com",
	});
	expect(publicLink).toBeDisabled();
	expect(invitation).toBeDisabled();
	fireEvent.click(publicLink);
	fireEvent.click(invitation);
	expect(mocks.revokeShare).not.toHaveBeenCalled();
	expect(mocks.revokeInvite).not.toHaveBeenCalled();
	expect(
		screen.getByText(
			"Your current role cannot remove an individual public link or invitation.",
		),
	).toBeInTheDocument();
	fireEvent.click(
		screen.getByRole("button", { name: "Make private (revoke all)" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Revoke all sharing" }));
	await waitFor(() =>
		expect(mocks.share).toHaveBeenCalledWith(
			expect.objectContaining({ shareScope: "PRIVATE" }),
		),
	);
	expect(mocks.revokeShare).not.toHaveBeenCalled();
});

it("shows a disabled retained public link when current organization policy denies public access", async () => {
	mocks.listGrants.mockResolvedValue({
		shareScope: "PUBLIC",
		hasPublicLink: true,
		canShareFramesPublicly: false,
		canRevoke: true,
		shareToken: "example-retained-token",
		updatedAt: "2026-11-01T00:00:00Z",
		grants: [],
	});
	renderSharing();
	expect(
		await screen.findByRole("radio", { name: "Public link (disabled)" }),
	).toBeDisabled();
	expect(
		screen.getByText(
			"This saved public link is disabled by your organization. You can remove it.",
		),
	).toBeInTheDocument();
	expect(
		screen.queryByRole("textbox", { name: "Public share link" }),
	).toBeNull();
	expect(
		screen.queryByRole("button", { name: "Copy share link" }),
	).toBeNull();
	expect(
		screen.queryByText(
			"Anyone with the link can view this frame without signing in.",
		),
	).toBeNull();
	expect(document.body.textContent).not.toContain("example-retained-token");
	expect(
		screen.getByRole("button", { name: "Remove public link" }),
	).toBeEnabled();
});
it("describes granting email-address access without claiming to send email", async () => {
	mocks.listGrants.mockResolvedValue({
		shareScope: "EMAILS_ONLY",
		hasPublicLink: false,
		canShareFramesPublicly: true,
		canRevoke: true,
		updatedAt: "2026-11-01T00:00:00Z",
		grants: [],
	});
	mocks.invite.mockResolvedValue({ success: true });
	renderSharing();
	const input = await screen.findByRole("textbox", {
		name: "Add access by email",
	});
	expect(
		screen.getByText(
			"These addresses receive access. Fabric does not send them an email.",
		),
	).toBeInTheDocument();
	fireEvent.change(input, { target: { value: "reader@example.com" } });
	fireEvent.click(screen.getByRole("button", { name: "Add access" }));
	await waitFor(() =>
		expect(mocks.invite).toHaveBeenCalledWith(
			expect.objectContaining({ emails: ["reader@example.com"] }),
		),
	);
	await waitFor(() =>
		expect(mocks.toast).toHaveBeenCalledWith({ title: "Access added" }),
	);
	expect(screen.queryByText("Invitations sent")).toBeNull();
	expect(
		screen.queryByRole("button", { name: "Send invitations" }),
	).toBeNull();
});
