import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../../../../../../../../packages/i18n/translations/en.json";

vi.mock("next-intl", async (importActual) => await importActual());

import { FramesPanel } from "../FramesPanel";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	org: "example-org" as string | undefined,
	slug: "example-team" as string | undefined,
	userId: "example-user" as string | undefined,
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { frames: { list: mocks.list } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: () => mocks.org,
	useOrganizationSlug: () => mocks.slug,
}));
function setup(conversationId: string | null = "example-conversation") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		</NextIntlClientProvider>
	);
	return {
		...render(<FramesPanel conversationId={conversationId} />, { wrapper }),
		client,
	};
}
const frame = (n: number) => ({
	id: `example-frame-${n}`,
	title: `Frame ${n}`,
	createdAt: "2026-11-01",
	conversationId: "example-conversation",
});
beforeEach(() => {
	mocks.list.mockReset().mockResolvedValue([]);
	mocks.userId = "example-user";
	mocks.org = "example-org";
	mocks.slug = "example-team";
});
describe("Frames discovery", () => {
	it("starts with this conversation and switches to all owned frames", async () => {
		setup();
		await screen.findByText("No frames in this conversation yet");
		expect(mocks.list).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			conversationId: "example-conversation",
			limit: 21,
			offset: 0,
		});
		await userEvent.click(
			screen.getByRole("button", { name: "All my frames" }),
		);
		await screen.findByText("No frames yet");
		expect(mocks.list).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			conversationId: undefined,
			limit: 21,
			offset: 0,
		});
	});
	it("paginates without displaying the lookahead row and resets on conversation change", async () => {
		mocks.list
			.mockResolvedValueOnce(
				Array.from({ length: 21 }, (_, n) => frame(n)),
			)
			.mockResolvedValue([frame(21)]);
		const view = setup();
		await screen.findByText("Frame 0");
		expect(screen.queryByText("Frame 20")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await screen.findByText("Frame 21");
		expect(mocks.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ offset: 20 }),
		);
		view.rerender(<FramesPanel conversationId="example-other" />);
		await waitFor(() =>
			expect(mocks.list).toHaveBeenLastCalledWith(
				expect.objectContaining({
					conversationId: "example-other",
					offset: 0,
				}),
			),
		);
		expect(screen.getByText("Page 1")).toBeInTheDocument();
	});
	it("shows an error and retries without claiming the library is empty", async () => {
		mocks.list
			.mockRejectedValueOnce(new Error("private failure"))
			.mockResolvedValue([]);
		setup();
		await screen.findByRole("alert");
		expect(screen.queryByText("No frames yet")).toBeNull();
		expect(screen.queryByText("private failure")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);
		await screen.findByText("No frames in this conversation yet");
	});
	it("does not fetch without a resolved organization or create personal links", () => {
		mocks.org = undefined;
		setup();
		expect(mocks.list).not.toHaveBeenCalled();
		expect(screen.queryByRole("link")).toBeNull();
	});
	it("opens an organization link and never labels a null association as this conversation", async () => {
		mocks.list.mockResolvedValue([{ ...frame(1), conversationId: null }]);
		setup(null);
		expect(
			await screen.findByRole("link", { name: /Frame 1/ }),
		).toHaveAttribute("href", "/app/example-team/frames/example-frame-1");
		expect(
			screen.getByRole("button", { name: "This conversation" }),
		).toBeDisabled();
		expect(screen.queryByText(/· This conversation/)).toBeNull();
	});
	it("does not reuse another organization's cached frames", async () => {
		mocks.list.mockResolvedValueOnce([frame(1)]).mockResolvedValue([]);
		const view = setup();
		await screen.findByText("Frame 1");
		mocks.org = "example-other-org";
		mocks.slug = "example-other-team";
		view.rerender(<FramesPanel conversationId="example-conversation" />);
		await screen.findByText("No frames in this conversation yet");
		expect(screen.queryByText("Frame 1")).toBeNull();
	});
});

it("does not reuse another user's private titles in the same organization", async () => {
	mocks.list.mockResolvedValue([frame(1)]);
	const view = setup();
	await screen.findByText("Frame 1");
	await userEvent.click(
		screen.getByRole("button", { name: "All my frames" }),
	);
	await screen.findByText("Frame 1");
	mocks.list.mockResolvedValue([]);
	mocks.userId = "example-other-user";
	view.rerender(<FramesPanel conversationId="example-conversation" />);
	await screen.findByText("No frames in this conversation yet");
	expect(screen.queryByText("Frame 1")).toBeNull();
	expect(
		view.client
			.getQueryCache()
			.getAll()
			.some((q) => q.queryKey.includes("example-other-user")),
	).toBe(true);
});
it("does not fetch while authenticated identity is unresolved", () => {
	mocks.userId = undefined;
	setup();
	expect(mocks.list).not.toHaveBeenCalled();
});
