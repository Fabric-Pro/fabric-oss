/**
 * "Plugin access" on the Coding Instructions tab (spec 2026-11-04 §4.4): a
 * status per member, "Grant access" and "Grant to all" for a settings editor,
 * "Revoke" for a grant Fabric made, "Connect GitHub" guidance for a member
 * without a login, and a write-access warning on a personal repository.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	grant: vi.fn(),
	revoke: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationSlug: "example-org",
		isGuest: false,
	}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				memberAccess: {
					list: {
						queryOptions: (options: { input: unknown }) => ({
							queryKey: ["memberAccess", options.input],
							queryFn: () => m.list(options.input),
						}),
					},
					grant: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) => m.grant(input),
						}),
					},
					revoke: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) => m.revoke(input),
						}),
					},
				},
			},
		},
	},
}));

import { PluginAccessPanel } from "../PluginAccessPanel";

const LIST = {
	available: true,
	repository: "example-org/example-instructions",
	ownerType: "organization",
	repositoryProblem: null,
	canGrant: true,
	members: [
		{
			userId: "user_admin",
			name: "Admin",
			image: null,
			isCaller: false,
			githubLogin: "example-admin",
			access: "NO_ACCESS",
			grant: {
				status: "ACTIVE",
				mode: "TEAM",
				githubLogin: "example-admin",
				repository: "example-org/example-instructions",
				lastError: null,
				updatedAt: new Date("2026-11-04T10:00:00Z"),
			},
		},
		{
			userId: "user_dev",
			name: "Dev",
			image: null,
			isCaller: false,
			githubLogin: "example-dev",
			access: "NO_ACCESS",
			grant: null,
		},
		{
			userId: "user_me",
			name: "Me",
			image: null,
			isCaller: true,
			githubLogin: null,
			access: "NOT_CONNECTED",
			grant: null,
		},
	],
};

function mount(props: { readOnlyMode?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PluginAccessPanel projectId="project_1" {...props} />
		</QueryClientProvider>,
	);
}

function row(name: string) {
	const item = screen
		.getAllByRole("listitem")
		.find((li) => li.querySelector("p")?.textContent?.startsWith(name));
	if (!item) {
		throw new Error(`no row for ${name}`);
	}
	return within(item);
}

beforeEach(() => {
	m.list.mockReset();
	m.grant.mockReset();
	m.revoke.mockReset();
	m.list.mockResolvedValue(LIST);
	m.grant.mockResolvedValue({
		results: [{ userId: "user_dev", outcome: "INVITED", message: null }],
	});
	m.revoke.mockResolvedValue({ status: "REVOKED" });
});

describe("PluginAccessPanel", () => {
	it("renders nothing when the project has no GitHub instructions repository", async () => {
		m.list.mockResolvedValue({ available: false });
		const { container } = mount();
		await vi.waitFor(() => expect(m.list).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a status per member and guides a member without a login to connect GitHub", async () => {
		mount();
		expect(
			await screen.findByRole("region", { name: "Plugin access" }),
		).toBeInTheDocument();
		expect(row("Admin").getByText("Has access")).toBeInTheDocument();
		expect(
			row("Dev").getByText("No access from Fabric"),
		).toBeInTheDocument();
		expect(row("Me").getByText("Not connected")).toBeInTheDocument();
		expect(
			row("Me").getByRole("link", {
				name: "Connect GitHub to install the plugin",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/connections?tab=credentials",
		);
		expect(
			row("Me").queryByRole("button", { name: /Grant access/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Personal repository/ }),
		).not.toBeInTheDocument();
	});

	it("shows the repository owner and a member GitHub already gives access, with no grant button", async () => {
		m.list.mockResolvedValue({
			...LIST,
			ownerType: "personal",
			members: [
				{
					...LIST.members[1],
					userId: "user_owner",
					name: "Owner",
					githubLogin: "example-owner",
					access: "OWNER",
				},
				{ ...LIST.members[1], access: "HAS_ACCESS" },
			],
		});
		mount();
		expect(
			await screen.findByText("Owner — has access"),
		).toBeInTheDocument();
		expect(row("Dev").getByText("Has access")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Grant access/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Grant to all" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/Connect GitHub/)).not.toBeInTheDocument();
	});

	it("does not ask a member with a saved token GitHub has not named yet to connect GitHub", async () => {
		m.list.mockResolvedValue({
			...LIST,
			members: [{ ...LIST.members[2], access: "ACCOUNT_UNKNOWN" }],
		});
		mount();
		expect(
			await screen.findByText("GitHub account unknown"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/has not said which account your saved token/),
		).toBeInTheDocument();
		expect(screen.queryByText(/Connect GitHub/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Grant access/ }),
		).not.toBeInTheDocument();
	});

	it("grants one member", async () => {
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", { name: "Grant access to Dev" }),
		);
		await vi.waitFor(() =>
			expect(m.grant).toHaveBeenCalledWith({
				projectId: "project_1",
				userIds: ["user_dev"],
				confirmPersonalWriteAccess: false,
			}),
		);
	});

	it("grants all members", async () => {
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", { name: "Grant to all" }),
		);
		await vi.waitFor(() =>
			expect(m.grant).toHaveBeenCalledWith({
				projectId: "project_1",
				all: true,
				confirmPersonalWriteAccess: false,
			}),
		);
	});

	it("revokes a grant from the member's menu", async () => {
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", {
				name: "Access actions for Admin",
			}),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "Revoke" }),
		);
		await vi.waitFor(() =>
			expect(m.revoke).toHaveBeenCalledWith({
				projectId: "project_1",
				userId: "user_admin",
			}),
		);
	});

	it("offers no actions to a member who cannot grant", async () => {
		m.list.mockResolvedValue({ ...LIST, canGrant: false });
		mount();
		await screen.findByRole("region", { name: "Plugin access" });
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("warns about write access on a personal repository and asks before the first grant", async () => {
		const user = userEvent.setup();
		m.list.mockResolvedValue({
			...LIST,
			ownerType: "personal",
			members: LIST.members.slice(1),
		});
		mount();
		// A warning icon next to the repository; the details open on click.
		await user.click(
			await screen.findByRole("button", {
				name: /Personal repository: collaborators get write access/,
			}),
		);
		expect(
			await screen.findByText(
				/This repository belongs to a personal account/,
			),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await user.click(
			screen.getByRole("button", { name: "Grant access to Dev" }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText("Members will get write access"),
		).toBeInTheDocument();
		expect(m.grant).not.toHaveBeenCalled();
		await user.click(
			within(dialog).getByRole("button", { name: "Grant write access" }),
		);
		await vi.waitFor(() =>
			expect(m.grant).toHaveBeenCalledWith({
				projectId: "project_1",
				userIds: ["user_dev"],
				confirmPersonalWriteAccess: true,
			}),
		);
	});
});
