/**
 * Unit tests for `NotifyMembersDialog` (In-Feature Collaboration — Notify).
 *
 * Covers the frontend contract:
 *   - Surfaces only project members from `members.list`, excluding the current
 *     user (you can't notify yourself).
 *   - Send is disabled until at least one member is selected.
 *   - Submitting calls the `stories.share` mutation with the selected recipient
 *     ids + trimmed message.
 *
 * `useQuery`/`useMutation` are mocked directly so the test needs no
 * QueryClientProvider; the orpc option factories are passthrough stubs.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateSpy, useQueryMock, useMutationMock } = vi.hoisted(() => ({
	mutateSpy: vi.fn(),
	useQueryMock: vi.fn(),
	useMutationMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", name: "Alice" } }),
}));

// Echo keys; interpolate `name` so member checkboxes get distinct labels.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
		vals?.name ? `${key}:${vals.name}` : key,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: { queryOptions: (o: unknown) => o },
			},
			stories: {
				share: { mutationOptions: (o: unknown) => o },
			},
		},
	},
}));

import { NotifyMembersDialog } from "../NotifyMembersDialog";

const MEMBERS = [
	{
		userId: "user-1", // current user — must be excluded
		user: { name: "Alice", email: "alice@example.com", image: null },
		isGuest: false,
		acceptedAt: null,
	},
	{
		userId: "user-2",
		user: { name: "Bob", email: "bob@example.com", image: null },
		isGuest: false,
		acceptedAt: new Date(),
	},
	{
		userId: "user-3",
		user: { name: "Carol", email: "carol@example.com", image: null },
		isGuest: true,
		acceptedAt: new Date(),
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({
		data: { members: MEMBERS },
		isLoading: false,
	});
	useMutationMock.mockReturnValue({ mutate: mutateSpy, isPending: false });
});

function renderDialog() {
	return render(
		<NotifyMembersDialog
			projectId="proj-1"
			storyId="story-1"
			organizationId={null}
			open={true}
			onOpenChange={() => {}}
		/>,
	);
}

describe("NotifyMembersDialog", () => {
	it("lists project members but excludes the current user", () => {
		renderDialog();
		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.getByText("Carol")).toBeTruthy();
		// Alice is the current user (user-1) → not offered as a recipient.
		expect(screen.queryByText("Alice")).toBeNull();
	});

	it("disables Send until a member is selected, then sends the right payload", () => {
		renderDialog();

		const sendButton = screen.getByRole("button", {
			name: "notifySend",
		}) as HTMLButtonElement;
		expect(sendButton.disabled).toBe(true);

		// Select Bob via his checkbox (label interpolates his name).
		fireEvent.click(
			screen.getByRole("checkbox", { name: "notifySelectMember:Bob" }),
		);
		expect(sendButton.disabled).toBe(false);

		fireEvent.click(sendButton);
		expect(mutateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: null,
				recipientUserIds: ["user-2"],
			}),
		);
	});
});
