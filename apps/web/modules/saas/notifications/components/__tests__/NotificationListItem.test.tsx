/**
 * Verifies the NotificationListItem renders the correct leading visual:
 *  - actor present → UserAvatar with a small category-icon badge overlay.
 *    The badge uses `bg-primary` while unread, `bg-muted` once read.
 *  - actor null    → the original muted category-icon bubble (system /
 *    agent-originated rows have no human actor to show).
 *
 * Both branches must keep the row clickable; nothing about the avatar swap
 * may change the row's link / button structure.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The component resolves a notification's link against the current workspace
// via `useBasePath`. Make the base mutable so the href-resolution cases below
// can exercise both the personal (`/app`) and org (`/app/{slug}`) workspaces;
// `beforeEach` resets it to personal so the role-gate cases stay order-stable.
const { mockBasePath } = vi.hoisted(() => ({
	mockBasePath: { current: "/app" },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => mockBasePath.current,
}));

// `useSession` drives the admin-gated INCIDENT redirect. Default the
// viewer to a regular user so the existing snapshots (which assert on
// the leading visual, not the link behaviour) are untouched. Tests that
// need a different role override per-case via `mockUseSession`.
const { mockUseSession, mockToastInfo } = vi.hoisted(() => ({
	mockUseSession: vi.fn(),
	mockToastInfo: vi.fn(),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => mockUseSession(),
}));

// Sonner toast — the admin-gated click handler surfaces a toast for
// non-admin viewers; mock it so the test doesn't try to mount a real
// toaster and so the role-gate test can assert on the call shape.
vi.mock("sonner", () => ({
	toast: {
		info: (...args: unknown[]) => mockToastInfo(...args),
		success: vi.fn(),
		error: vi.fn(),
	},
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

import { fireEvent } from "@testing-library/react";
import { beforeEach } from "vitest";
import { NotificationListItem } from "../NotificationListItem";

beforeEach(() => {
	mockUseSession.mockReset();
	mockUseSession.mockReturnValue({ user: { role: "user" } });
	mockToastInfo.mockReset();
	mockBasePath.current = "/app";
});

function makeNotification(over: Partial<any> = {}) {
	return {
		id: "n1",
		userId: "u1",
		organizationId: null,
		organizationSlug: null,
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

describe("NotificationListItem — leading visual", () => {
	it("renders UserAvatar with category badge when an actor is present", () => {
		render(
			<NotificationListItem
				notification={makeNotification({
					actorUserId: "u9",
					actor: { id: "u9", name: "Ada Lovelace", image: null },
				})}
				onSelect={() => {}}
			/>,
		);

		// Avatar fallback uses the first letters of the name.
		expect(screen.getByText("AL")).toBeInTheDocument();
		// Category badge overlay is rendered.
		const badge = screen.getByTestId("notification-category-badge");
		expect(badge).toBeInTheDocument();
		// Unread → primary tint on the badge.
		expect(badge.className).toContain("bg-primary");
		// The icon-only fallback bubble must NOT render in this branch.
		expect(
			screen.queryByTestId("notification-icon-bubble"),
		).not.toBeInTheDocument();
	});

	it("uses the muted bg-muted badge tint once the row is read", () => {
		render(
			<NotificationListItem
				notification={makeNotification({
					actorUserId: "u9",
					actor: { id: "u9", name: "Ada", image: null },
					readAt: new Date().toISOString(),
				})}
				onSelect={() => {}}
			/>,
		);

		const badge = screen.getByTestId("notification-category-badge");
		expect(badge.className).toContain("bg-muted");
		expect(badge.className).not.toContain("bg-primary");
	});

	it("falls back to the category-icon bubble when actor is null", () => {
		render(
			<NotificationListItem
				notification={makeNotification({
					actorUserId: null,
					actor: null,
				})}
				onSelect={() => {}}
			/>,
		);

		expect(
			screen.getByTestId("notification-icon-bubble"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("notification-category-badge"),
		).not.toBeInTheDocument();
	});
});

describe("NotificationListItem — link href resolution", () => {
	// In the personal workspace (base `/app`) an absolute admin link is already
	// complete and is used verbatim — re-basing it would double the prefix
	// (the original bug: `/app/admin/monitoring` → `/app/app/admin/monitoring`).
	it("uses an absolute admin link verbatim in the personal workspace", () => {
		mockUseSession.mockReturnValue({ user: { role: "admin" } });
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "SYSTEM_INCIDENT",
					link: "/app/admin/monitoring?incident=inc-1",
					title: "Error budget burn",
				})}
				onSelect={() => {}}
			/>,
		);

		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"/app/admin/monitoring?incident=inc-1",
		);
	});

	// In an org workspace the slug-less admin link is re-based onto the current
	// workspace so the admin stays in their org instead of being flipped to
	// "Personal" (the active workspace is derived purely from the URL slug).
	it("re-bases an absolute admin link onto the org workspace", () => {
		mockBasePath.current = "/app/acme";
		mockUseSession.mockReturnValue({ user: { role: "admin" } });
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "SYSTEM_INCIDENT",
					link: "/app/admin/monitoring?incident=inc-1",
					title: "Error budget burn",
				})}
				onSelect={() => {}}
			/>,
		);

		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"/app/acme/admin/monitoring?incident=inc-1",
		);
	});

	// Context-relative links (no leading slash) resolve against the
	// notification's OWN org base — here `/app`, because this fixture's
	// `organizationSlug` is null (personal). See resolve-notification-link / #1528.
	it("prepends the context base path to a relative link", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "STORY_MENTION",
					link: "projects/p1/stories/s1#comment-c1",
				})}
				onSelect={() => {}}
			/>,
		);

		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"/app/projects/p1/stories/s1#comment-c1",
		);
	});

	// THE #1528 REGRESSION: the row is rendered while the user is viewing a
	// DIFFERENT workspace (current base `/app/team-beta`), but the notification
	// belongs to `team-alpha`. The href must point at the notification's own org.
	it("resolves a relative link against the notification's own org, not the current workspace", () => {
		mockBasePath.current = "/app/team-beta";
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "STORY_MENTION",
					organizationId: "org-a",
					organizationSlug: "team-alpha",
					link: "projects/p1/stories/s1#comment-c1",
				})}
				onSelect={() => {}}
			/>,
		);

		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"/app/team-alpha/projects/p1/stories/s1#comment-c1",
		);
	});
});

describe("NotificationListItem — admin-gated INCIDENT redirect", () => {
	// The monitoring dashboard at /app/admin/monitoring is admin-gated. The
	// page silently redirects non-admins to /app, so an INCIDENT row that
	// just navigates blindly looks broken to org-owner viewers. The row's
	// click handler detects the admin-only types up-front and degrades:
	//   - Admins  -> Link navigates normally.
	//   - Others  -> e.preventDefault(); toast.info(...); mark-as-read.

	it("admin clicks INTEGRATION_INCIDENT row → navigation proceeds (no toast)", () => {
		mockUseSession.mockReturnValue({ user: { role: "admin" } });
		const onSelect = vi.fn();
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "INTEGRATION_INCIDENT",
					link: "/app/admin/monitoring",
					title: "OpenAI degraded",
				})}
				onSelect={onSelect}
			/>,
		);

		const row = screen.getByRole("link");
		fireEvent.click(row);

		// onSelect still fires (mark-as-read), but no toast for admins.
		expect(onSelect).toHaveBeenCalledWith("n1");
		expect(mockToastInfo).not.toHaveBeenCalled();
		// The aria-disabled attribute is set only for non-admins.
		expect(row.getAttribute("aria-disabled")).toBeNull();
	});

	it("non-admin clicks SYSTEM_INCIDENT row → toast + mark-as-read, no navigation", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		const onSelect = vi.fn();
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "SYSTEM_INCIDENT",
					link: "/app/admin/monitoring",
					title: "Error budget burn",
				})}
				onSelect={onSelect}
			/>,
		);

		const row = screen.getByRole("link");
		// Verify the role-gate is signaled at the markup level too.
		expect(row.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(row);

		expect(onSelect).toHaveBeenCalledWith("n1");
		expect(mockToastInfo).toHaveBeenCalledTimes(1);
		expect(mockToastInfo).toHaveBeenCalledWith(
			expect.stringMatching(/admin access/i),
		);
	});

	it("regular notification types are unaffected by the role gate", () => {
		mockUseSession.mockReturnValue({ user: { role: "user" } });
		const onSelect = vi.fn();
		render(
			<NotificationListItem
				notification={makeNotification({
					type: "STORY_MENTION",
					link: "/app/projects/p1",
				})}
				onSelect={onSelect}
			/>,
		);

		const row = screen.getByRole("link");
		expect(row.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(row);

		expect(onSelect).toHaveBeenCalledWith("n1");
		expect(mockToastInfo).not.toHaveBeenCalled();
	});
});
