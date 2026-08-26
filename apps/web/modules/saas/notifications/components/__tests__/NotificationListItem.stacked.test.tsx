/**
 * NotificationListItem picks the layout (#2117).
 *
 * The display preference is resolved ONCE per list container and passed down,
 * rather than read from a hook inside every row. Two reasons: both consumers
 * (the inbox page and the bell popover) already need the value for their own
 * container spacing, so the container is where it belongs; and keeping the row
 * free of data dependencies means it stays renderable with no QueryClient —
 * which is what lets the pre-existing NotificationListItem suite keep passing
 * untouched.
 *
 * `stacked` therefore defaults to false: omitting it yields today's compact row.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBasePath } = vi.hoisted(() => ({
	mockBasePath: { current: "/app" },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => mockBasePath.current,
}));

const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => mockUseSession(),
}));

vi.mock("sonner", () => ({
	toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		className,
		onClick,
		...rest
	}: {
		children: ReactNode;
		href: string;
		className?: string;
		onClick?: (e: React.MouseEvent) => void;
	} & Record<string, unknown>) => (
		<a href={href} className={className} onClick={onClick} {...rest}>
			{children}
		</a>
	),
}));

import { NotificationListItem } from "../NotificationListItem";

beforeEach(() => {
	mockUseSession.mockReset();
	mockUseSession.mockReturnValue({ user: { role: "user" } });
	mockBasePath.current = "/app";
});

function makeNotification(over: Partial<any> = {}) {
	return {
		id: "n1",
		userId: "u1",
		organizationId: null,
		organizationSlug: null,
		organizationName: null,
		projectName: null,
		type: "STORY_MENTION",
		category: "MENTION",
		title: "You were mentioned",
		snippet: null,
		link: "/app/projects/p1",
		iconKey: null,
		projectId: null,
		storyId: null,
		taskId: null,
		commentId: null,
		documentId: null,
		actorUserId: null,
		actor: null,
		payload: {},
		readAt: null,
		archivedAt: null,
		dedupeKey: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	};
}

describe("NotificationListItem — layout switch", () => {
	it("renders the compact row when `stacked` is omitted", () => {
		render(
			<NotificationListItem
				notification={makeNotification()}
				onSelect={() => {}}
			/>,
		);
		expect(
			screen.getByTestId("notification-icon-bubble"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("notification-card-chip")).toBeNull();
	});

	it("renders the compact row when `stacked` is explicitly false", () => {
		render(
			<NotificationListItem
				notification={makeNotification()}
				onSelect={() => {}}
				stacked={false}
			/>,
		);
		expect(
			screen.getByTestId("notification-icon-bubble"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("notification-card-chip")).toBeNull();
	});

	it("renders the stacked card when `stacked` is true", () => {
		render(
			<NotificationListItem
				notification={makeNotification()}
				onSelect={() => {}}
				stacked
			/>,
		);
		expect(
			screen.getByTestId("notification-card-chip"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("notification-icon-bubble")).toBeNull();
	});

	it("forwards archive and restore handlers to whichever layout renders", () => {
		const onRestore = vi.fn();
		const { rerender } = render(
			<NotificationListItem
				notification={makeNotification()}
				onSelect={() => {}}
				onRestore={onRestore}
				mode="archived"
				stacked
			/>,
		);
		expect(screen.getByText("restore")).toBeInTheDocument();

		rerender(
			<NotificationListItem
				notification={makeNotification()}
				onSelect={() => {}}
				onRestore={onRestore}
				mode="archived"
				stacked={false}
			/>,
		);
		expect(screen.getByText("restore")).toBeInTheDocument();
	});

	it("renders with no QueryClient in scope — the row holds no data dependency", () => {
		// Guard for the decision above. If a future change reads the preference
		// from inside the row, this render throws "No QueryClient set" and the
		// pre-existing NotificationListItem suite breaks with it.
		expect(() =>
			render(
				<NotificationListItem
					notification={makeNotification()}
					onSelect={() => {}}
					stacked
				/>,
			),
		).not.toThrow();
	});
});
