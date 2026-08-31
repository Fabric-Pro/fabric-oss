/**
 * Covers the optimistic archive + Undo flow on the Notifications page:
 *  1. Clicking the X on a row calls `archive`.
 *  2. The toast is invoked with an `Undo` action.
 *  3. Triggering the Undo action calls `restore` with the same id.
 *  4. Selecting the Archived tab switches the query to `status: "archived"`
 *     and renders `Restore` controls instead of the X.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveMutate = vi.fn();
const restoreMutate = vi.fn();
const markReadMutate = vi.fn();
const markAllReadMutate = vi.fn();
const toastMock = vi.fn();

const notificationsState: {
	status: string;
	items: any[];
} = {
	status: "all",
	items: [],
};

vi.mock("../../hooks/use-notifications", () => ({
	useNotifications: (input: { status: string }) => {
		notificationsState.status = input.status;
		return {
			data: {
				pages: [{ items: notificationsState.items, nextCursor: null }],
				pageParams: [undefined],
			},
			isLoading: false,
			fetchNextPage: () => Promise.resolve(),
			hasNextPage: false,
			isFetchingNextPage: false,
		};
	},
}));

vi.mock("../../hooks/use-archive", () => ({
	useArchiveNotifications: () => ({
		mutate: archiveMutate,
		isPending: false,
	}),
	useRestoreNotifications: () => ({
		mutate: restoreMutate,
		isPending: false,
	}),
}));

vi.mock("../../hooks/use-mark-read", () => ({
	useMarkNotificationsRead: () => ({
		mutate: markReadMutate,
		isPending: false,
	}),
	useMarkAllNotificationsRead: () => ({
		mutate: markAllReadMutate,
		isPending: false,
	}),
}));

// The page resolves the display style once and passes it down (#2117). These
// archive-flow cases are style-agnostic, so pin the compact default — the
// layout switch itself is covered by NotificationListItem.stacked.test.tsx.
vi.mock("../../hooks/use-notification-preferences", () => ({
	useStackedCardStyle: () => ({ stacked: false, isLoading: false }),
}));

vi.mock("sonner", () => ({
	toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (p: string) => p,
	// `NotificationListItem` reads `useBasePath` to resolve its link against the
	// active workspace; default it to the personal base so these archive-flow
	// rows render without throwing.
	useBasePath: () => "/app",
	useOrganizationId: () => null,
}));

// `useSession` drives the admin-gated INCIDENT redirect on
// `NotificationListItem`. The archive-flow assertions don't exercise
// the role-gate path, but the hook is read on every render — mock it to
// a plain user so the component renders without throwing.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { role: "user" } }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const map: Record<string, string> = {
			sectionLabel: "Inbox",
			title: "Notifications",
			markAllRead: "Mark all read",
			dismiss: "Dismiss",
			restore: "Restore",
			archivedToast: "Notification archived",
			undo: "Undo",
			"tabs.all": "All",
			"tabs.unread": "Unread",
			"tabs.mentions": "Mentions",
			"tabs.archived": "Archived",
			unreadIndicator: "Unread",
			settings: "Notification settings",
			settingsHint: "Opens your account settings",
		};
		return map[key] ?? key;
	},
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		onClick,
		className,
	}: {
		children: ReactNode;
		href: string;
		onClick?: () => void;
		className?: string;
	}) => (
		<a href={href} onClick={onClick} className={className}>
			{children}
		</a>
	),
}));

import { NotificationsPage } from "../NotificationsPage";

function makeNotification(over: Partial<any> = {}) {
	return {
		id: over.id ?? "n1",
		userId: "u1",
		organizationId: null,
		type: "STORY_MENTION",
		category: "MENTION",
		title: over.title ?? "You were mentioned",
		snippet: over.snippet ?? null,
		link: over.link ?? "/app/projects/p1",
		iconKey: null,
		projectId: null,
		storyId: null,
		taskId: null,
		commentId: null,
		documentId: null,
		actorUserId: null,
		payload: {},
		readAt: over.readAt ?? null,
		archivedAt: over.archivedAt ?? null,
		dedupeKey: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	};
}

beforeEach(() => {
	archiveMutate.mockReset();
	restoreMutate.mockReset();
	markReadMutate.mockReset();
	markAllReadMutate.mockReset();
	toastMock.mockReset();
	notificationsState.status = "all";
	notificationsState.items = [makeNotification({ id: "n1" })];
});

describe("NotificationsPage — archive flow", () => {
	it("clicking the Dismiss button archives the notification and shows a toast with Undo", () => {
		render(<NotificationsPage />);

		const dismiss = screen.getByLabelText("Dismiss");
		fireEvent.click(dismiss);

		expect(archiveMutate).toHaveBeenCalledTimes(1);
		const [ids, opts] = archiveMutate.mock.calls[0];
		expect(ids).toEqual(["n1"]);

		// Simulate the server success so the toast fires with the Undo action.
		opts.onSuccess();
		expect(toastMock).toHaveBeenCalledTimes(1);
		const [message, toastOpts] = toastMock.mock.calls[0];
		expect(message).toBe("Notification archived");
		expect(toastOpts.action.label).toBe("Undo");

		// Invoking Undo restores the same id.
		toastOpts.action.onClick();
		expect(restoreMutate).toHaveBeenCalledWith(["n1"]);
	});

	it("Archived tab requests archived rows and surfaces a Restore button", async () => {
		notificationsState.items = [
			makeNotification({
				id: "n2",
				archivedAt: new Date().toISOString(),
			}),
		];

		const user = userEvent.setup();
		render(<NotificationsPage />);

		await user.click(screen.getByRole("tab", { name: "Archived" }));

		expect(notificationsState.status).toBe("archived");

		const restoreBtn = screen.getByLabelText("Restore");
		fireEvent.click(restoreBtn);
		expect(restoreMutate).toHaveBeenCalledWith(["n2"]);

		// Dismiss should NOT be rendered in archived mode.
		expect(screen.queryByLabelText("Dismiss")).toBeNull();
	});

	it("hides Mark all read on the Archived tab", async () => {
		const user = userEvent.setup();
		render(<NotificationsPage />);

		expect(screen.queryByText("Mark all read")).not.toBeNull();

		await user.click(screen.getByRole("tab", { name: "Archived" }));
		expect(screen.queryByText("Mark all read")).toBeNull();
	});

	it("shows a Notification Settings link to the personal settings route on every tab", async () => {
		const user = userEvent.setup();
		render(<NotificationsPage />);

		const settingsLink = screen.getByRole("link", {
			name: "Notification settings",
		});
		expect(settingsLink).toHaveAttribute(
			"href",
			"/app/settings/notifications",
		);

		// Unlike "Mark all read", the settings link stays visible on the
		// Archived tab (persistent entry point, FR-5).
		await user.click(screen.getByRole("tab", { name: "Archived" }));
		expect(
			screen.getByRole("link", { name: "Notification settings" }),
		).toHaveAttribute("href", "/app/settings/notifications");
	});
});
