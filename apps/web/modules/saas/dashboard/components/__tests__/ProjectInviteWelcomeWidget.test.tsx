import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: pushMock }),
}));

// The widget no longer reads the feature flag (gated at the dashboard level); it
// only uses config for the avatar image-proxy bucket name.
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { avatars: "avatars" } } },
}));

vi.mock("@saas/organizations/hooks", () => ({
	useOrganizationId: () => null,
	useOrganizationSlug: () => null,
}));

const getWelcomeWidget = vi.fn();
const accept = vi.fn();
const dismissWelcomeWidget = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			members: {
				invitations: {
					getWelcomeWidget: (...a: unknown[]) =>
						getWelcomeWidget(...a),
					accept: (...a: unknown[]) => accept(...a),
					dismissWelcomeWidget: (...a: unknown[]) =>
						dismissWelcomeWidget(...a),
				},
			},
		},
	},
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: { error: (...a: unknown[]) => toastError(...a) },
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
	useQuery: (...a: unknown[]) => useQueryMock(...a),
	useMutation: (opts: {
		mutationFn: () => Promise<unknown>;
		onMutate?: () => void;
		onSuccess?: (r: unknown) => void;
		onError?: (e: unknown) => void;
	}) => ({
		isPending: false,
		mutate: async () => {
			opts.onMutate?.();
			try {
				const r = await opts.mutationFn();
				opts.onSuccess?.(r);
			} catch (e) {
				opts.onError?.(e);
			}
		},
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import {
	ProjectInviteWelcomeWidget,
	type WelcomeWidgetEntry,
} from "../ProjectInviteWelcomeWidget";

function widgetData(
	over: Partial<Extract<WelcomeWidgetEntry, { kind: "invite" }>> = {},
	totalCount = 1,
) {
	return {
		mostRecent: {
			kind: "invite" as const,
			invitationId: over.invitationId ?? "inv-1",
			projectId: over.projectId ?? "proj-1",
			projectName: over.projectName ?? "Fabric Main",
			projectDescription:
				over.projectDescription === undefined
					? "A platform"
					: over.projectDescription,
			heroImageUrl: over.heroImageUrl ?? null,
			heroEmojis: over.heroEmojis ?? [],
			icon: over.icon ?? null,
			color: over.color ?? null,
			organizationId: over.organizationId ?? null,
			organizationSlug: over.organizationSlug ?? null,
			inviter:
				over.inviter === undefined
					? { name: "Avery", image: null, banned: false }
					: over.inviter,
			role: over.role ?? "VIEWER",
			expiresAt: over.expiresAt ?? "2026-06-09T00:00:00Z",
		},
		totalCount,
	};
}

function memberData(
	over: Partial<Extract<WelcomeWidgetEntry, { kind: "member" }>> = {},
	totalCount = 1,
) {
	return {
		mostRecent: {
			kind: "member" as const,
			projectId: over.projectId ?? "proj-1",
			projectName: over.projectName ?? "Fabric Main",
			projectDescription:
				over.projectDescription === undefined
					? "A platform"
					: over.projectDescription,
			heroImageUrl: over.heroImageUrl ?? null,
			heroEmojis: over.heroEmojis ?? [],
			icon: over.icon ?? null,
			color: over.color ?? null,
			organizationId: over.organizationId ?? null,
			organizationSlug: over.organizationSlug ?? null,
			inviter:
				over.inviter === undefined
					? { name: "Avery", image: null, banned: false }
					: over.inviter,
			role: over.role ?? "VIEWER",
			acceptedAt: over.acceptedAt ?? "2026-06-16T00:00:00Z",
		},
		totalCount,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({ data: widgetData(), isLoading: false });
});

describe("ProjectInviteWelcomeWidget", () => {
	it("renders the inviter headline, summary and Open project CTA for a single invite", () => {
		render(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", {
				name: "Avery has invited you to join Fabric Main.",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("A platform")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /open project/i }),
		).toBeInTheDocument();
		expect(screen.queryByText(/View all/i)).not.toBeInTheDocument();
	});

	it("shows the View all link with the total count when >= 2 invites", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({}, 3),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		const link = screen.getByRole("link", {
			name: /3 New Project Invites\. View all/i,
		});
		expect(link).toHaveAttribute("href", "/app/invitations");
	});

	it("hides the summary when the project has no description", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({ projectDescription: null }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		expect(screen.queryByText("A platform")).not.toBeInTheDocument();
	});

	it("falls back to neutral copy when the inviter is missing (deleted)", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({ inviter: null }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", {
				name: "You have been invited to Fabric Main.",
			}),
		).toBeInTheDocument();
	});

	it("falls back to neutral copy when the inviter is banned (deactivated)", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({
				inviter: { name: "Avery", image: null, banned: true },
			}),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", {
				name: "You have been invited to Fabric Main.",
			}),
		).toBeInTheDocument();
	});

	it("renders the hero image with project-name alt and falls back on error", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({
				heroImageUrl: "https://x/img.png",
				heroEmojis: [],
				icon: null,
			}),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		const img = screen.getByAltText("Fabric Main") as HTMLImageElement;
		expect(img).toBeInTheDocument();
		fireEvent.error(img);
		expect(screen.queryByAltText("Fabric Main")).not.toBeInTheDocument();
		// initials fallback of "Fabric Main"
		expect(screen.getByText("FM")).toBeInTheDocument();
	});

	it("uses the project emoji as the fallback visual when there is no image", () => {
		useQueryMock.mockReturnValue({
			data: widgetData({ heroImageUrl: null, heroEmojis: ["🚀"] }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		expect(screen.getByText("🚀")).toBeInTheDocument();
	});

	it("dismiss calls the API with projectId and hides the widget", async () => {
		dismissWelcomeWidget.mockResolvedValue({ success: true });
		render(<ProjectInviteWelcomeWidget />);
		fireEvent.click(
			screen.getByRole("button", { name: /dismiss invitation/i }),
		);
		expect(dismissWelcomeWidget).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
		});
		// optimistic hide
		expect(
			screen.queryByRole("heading", { name: /invited you to join/i }),
		).not.toBeInTheDocument();
	});

	it("CTA accepts the invite then navigates to the project", async () => {
		accept.mockResolvedValue({ member: {} });
		render(<ProjectInviteWelcomeWidget />);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /open project/i }),
			);
		});
		expect(accept).toHaveBeenCalledWith({ invitationId: "inv-1" });
		expect(pushMock).toHaveBeenCalledWith("/app/projects/proj-1");
	});

	it("renders nothing when there is no pending invite", () => {
		useQueryMock.mockReturnValue({
			data: { mostRecent: null, totalCount: 0 },
			isLoading: false,
		});
		const { container } = render(<ProjectInviteWelcomeWidget />);
		expect(container).toBeEmptyDOMElement();
	});

	it("re-invite resurfaces after dismiss without remounting (per-instance dismissal)", async () => {
		dismissWelcomeWidget.mockResolvedValue({ success: true });
		useQueryMock.mockReturnValue({
			data: widgetData({
				invitationId: "inv-1",
				expiresAt: "2026-06-09T00:00:00Z",
			}),
			isLoading: false,
		});
		const { rerender } = render(<ProjectInviteWelcomeWidget />);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /dismiss invitation/i }),
			);
		});
		expect(
			screen.queryByRole("heading", { name: /invited you to join/i }),
		).not.toBeInTheDocument();

		// Same invitation re-issued with a LATER expiry => different instance key.
		useQueryMock.mockReturnValue({
			data: widgetData({
				invitationId: "inv-1",
				expiresAt: "2026-06-20T00:00:00Z",
			}),
			isLoading: false,
		});
		rerender(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", { name: /invited you to join/i }),
		).toBeInTheDocument();
	});

	it("explicit org props drive actions, the View-all link and navigation", async () => {
		accept.mockResolvedValue({ member: {} });
		dismissWelcomeWidget.mockResolvedValue({ success: true });
		// Hooks still return null — props must win.
		useQueryMock.mockReturnValue({
			data: widgetData({ organizationSlug: "acme" }, 2),
			isLoading: false,
		});
		render(
			<ProjectInviteWelcomeWidget
				organizationId="org-1"
				organizationSlug="acme"
			/>,
		);

		expect(
			screen.getByRole("link", {
				name: /2 New Project Invites\. View all/i,
			}),
		).toHaveAttribute("href", "/app/acme/invitations");

		// Open project (assert before dismiss optimistically hides the widget).
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /open project/i }),
			);
		});
		expect(accept).toHaveBeenCalledWith({ invitationId: "inv-1" });
		expect(pushMock).toHaveBeenCalledWith("/app/acme/projects/proj-1");

		// Dismiss carries the explicit org id, not the (null) hook value.
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /dismiss invitation/i }),
			);
		});
		expect(dismissWelcomeWidget).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
	});

	it("member-kind: shows the 'added you' headline and Open project navigates without accepting", async () => {
		useQueryMock.mockReturnValue({ data: memberData(), isLoading: false });
		render(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", {
				name: "Avery added you to Fabric Main.",
			}),
		).toBeInTheDocument();
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /open project/i }),
			);
		});
		expect(accept).not.toHaveBeenCalled();
		expect(pushMock).toHaveBeenCalledWith("/app/projects/proj-1");
	});

	it("member-kind: neutral 'You were added' copy when the inviter is missing", () => {
		useQueryMock.mockReturnValue({
			data: memberData({ inviter: null }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		expect(
			screen.getByRole("heading", {
				name: "You were added to Fabric Main.",
			}),
		).toBeInTheDocument();
	});

	it("cross-org guest entry routes via the entry's org slug even on the personal dashboard", async () => {
		useQueryMock.mockReturnValue({
			data: memberData({ projectId: "p-9", organizationSlug: "acme" }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /open project/i }),
			);
		});
		expect(pushMock).toHaveBeenCalledWith("/app/acme/projects/p-9");
	});

	it("member-kind: dismiss posts the projectId and hides the widget", async () => {
		dismissWelcomeWidget.mockResolvedValue({ success: true });
		useQueryMock.mockReturnValue({
			data: memberData({ projectId: "pm-1" }),
			isLoading: false,
		});
		render(<ProjectInviteWelcomeWidget />);
		fireEvent.click(
			screen.getByRole("button", { name: /dismiss invitation/i }),
		);
		expect(dismissWelcomeWidget).toHaveBeenCalledWith({
			projectId: "pm-1",
			organizationId: null,
		});
		expect(
			screen.queryByRole("heading", { name: /added you to/i }),
		).not.toBeInTheDocument();
	});
});
