/**
 * Tests for the non-member contact register in organization settings
 * (Fizzy #2340).
 *
 * The behaviours pinned here are the ones that make a contact SAFE to keep
 * beside the members list:
 *
 *   1. The tab exists only for someone who may manage members. The register
 *      holds third-party names and contact details across every project, so a
 *      plain member must not even see the surface.
 *   2. A contact row cannot be mistaken for a member row. A contact never signs
 *      in and grants nobody access; if the two rows read alike, the settings
 *      page is quietly telling the reader that this person has an account.
 *   3. A same-name create is REFUSED once and only goes through after an
 *      explicit confirmation. The create response is a discriminated union
 *      precisely so `.contact` cannot be read on the refused branch, and this
 *      pins that the client branches on `status` instead.
 *   4. Deleting REPORTS the detached to-do count. Deletion redacts the person
 *      and detaches their work rather than deleting it, so the count is the
 *      operator's only signal of how much is now unassigned.
 *
 * `@tanstack/react-query` is real rather than mocked: the create/update/delete
 * paths all run mutation -> awaited invalidation -> refetch, and a mocked
 * `useMutation` would hide a query key that matches nothing (the failure mode
 * `organizationContactsQueryKey` exists to prevent — `invalidateQueries` with a
 * wrong-shaped filter refreshes zero queries and reports no error).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "organizations.settings.members.contacts";

const {
	listMock,
	createMock,
	updateMock,
	deleteMock,
	organizationMock,
	sessionUserMock,
	toastSuccessMock,
	toastErrorMock,
} = vi.hoisted(() => ({
	listMock: vi.fn(),
	createMock: vi.fn(),
	updateMock: vi.fn(),
	deleteMock: vi.fn(),
	organizationMock: vi.fn(),
	sessionUserMock: vi.fn(),
	toastSuccessMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

// The mocked key shapes mirror oRPC's real ones exactly — `key()` returns the
// path-only prefix and `queryOptions()` hangs `{ input, type }` below it — so
// the invalidation in the component has to partially match for real here.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		todos: {
			contacts: {
				list: {
					key: () => [["todos", "contacts", "list"], {}],
					queryOptions: (options: { input: unknown }) => ({
						queryKey: [
							["todos", "contacts", "list"],
							{ input: options.input, type: "query" },
						],
						queryFn: () => listMock(options.input),
					}),
				},
				create: { call: (input: unknown) => createMock(input) },
				update: { call: (input: unknown) => updateMock(input) },
				delete: { call: (input: unknown) => deleteMock(input) },
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: (propOrganizationId?: string | null) =>
		propOrganizationId ?? "org-1",
}));

vi.mock("@saas/organizations/hooks/member-roles", () => ({
	useOrganizationMemberRoles: () => ({
		owner: "Owner",
		admin: "Admin",
		member: "Member",
	}),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: sessionUserMock() }),
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useFullOrganizationQuery: () => ({ data: organizationMock() }),
	useOrgInvitationsQuery: () => ({ data: [] }),
	fullOrganizationQueryKey: (id: string) => ["organization", id],
	orgInvitationsQueryKey: (id: string) => ["organization", id, "invitations"],
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		organization: {
			updateMemberRole: vi.fn(),
			removeMember: vi.fn(),
			inviteMember: vi.fn(),
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			invitations: { resend: vi.fn(), cancel: vi.fn() },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccessMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
		promise: vi.fn(),
	},
}));

// The global next-intl mock echoes the key and DROPS the interpolation values,
// which would make "reports the detached count" unassertable. Echo the values
// too, so the count the component passes is visible in the rendered copy.
vi.mock("next-intl", () => {
	const useTranslations = () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key} ${JSON.stringify(values)}` : key;
		t.raw = (key: string) => key;
		return t;
	};
	return {
		useTranslations,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString(),
			number: (value: number) => String(value),
			relativeTime: (date: Date) => date.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

// Radix's dropdown needs real pointer capture to open, which jsdom does not
// implement; the repo's existing pattern is to flatten it to pass-throughs so
// the menu's ACTIONS stay clickable. The AlertDialogs are left real — their
// open/confirm flow is part of what these tests are about.
vi.mock("@ui/components/dropdown-menu", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		DropdownMenu: Pass,
		DropdownMenuTrigger: () => null,
		DropdownMenuContent: Pass,
		DropdownMenuItem: ({
			children,
			onClick,
		}: {
			children?: ReactNode;
			onClick?: () => void;
		}) => (
			<button type="button" onClick={onClick}>
				{children}
			</button>
		),
	};
});

import { OrganizationContactsList } from "@saas/organizations/components/OrganizationContactsList";
import { OrganizationMembersBlock } from "@saas/organizations/components/OrganizationMembersBlock";
import { OrganizationMembersList } from "@saas/organizations/components/OrganizationMembersList";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const MEMBER_USER = { id: "user-1", name: "Ada Member", role: "user" };

function organizationWithRole(role: string) {
	return {
		id: "org-1",
		slug: "example-org",
		name: "Example Org",
		members: [
			{
				id: "member-1",
				userId: "user-1",
				role,
				user: {
					id: "user-1",
					name: "Ada Member",
					email: "ada@example.com",
					image: null,
				},
			},
		],
		invitations: [],
	};
}

function contact(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "contact-1",
		organizationId: "org-1",
		name: "Casey Client",
		email: null,
		company: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		todoCount: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionUserMock.mockReturnValue(MEMBER_USER);
	organizationMock.mockReturnValue(organizationWithRole("admin"));
	listMock.mockResolvedValue({
		contacts: [],
		total: 0,
		hasMore: false,
		nextOffset: null,
	});
});

describe("Contacts tab visibility", () => {
	it("renders the tab for a viewer who may manage members", async () => {
		render(<OrganizationMembersBlock organizationId="org-1" />, {
			wrapper,
		});

		expect(
			await screen.findByRole("tab", { name: `${T}.tab` }),
		).toBeInTheDocument();
	});

	it("hides the tab from a viewer who may not manage members", async () => {
		organizationMock.mockReturnValue(organizationWithRole("member"));

		render(<OrganizationMembersBlock organizationId="org-1" />, {
			wrapper,
		});

		expect(
			await screen.findByRole("tab", {
				name: "organizations.settings.members.activeMembers",
			}),
		).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: `${T}.tab` })).toBeNull();
	});

	it("keeps the existing members and invitations tabs working", async () => {
		const user = userEvent.setup();

		render(<OrganizationMembersBlock organizationId="org-1" />, {
			wrapper,
		});

		expect(
			await screen.findByRole("tab", {
				name: "organizations.settings.members.activeMembers",
			}),
		).toBeInTheDocument();
		// The members tab is the default, so its row is on screen already.
		expect(screen.getByText("Ada Member")).toBeInTheDocument();

		await user.click(
			screen.getByRole("tab", {
				name: "organizations.settings.members.pendingInvitations",
			}),
		);
		expect(
			await screen.findByText(
				"organizations.settings.members.invitations.empty",
			),
		).toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: `${T}.tab` }));
		expect(await screen.findByText(`${T}.empty.title`)).toBeInTheDocument();
	});
});

describe("Contact rows", () => {
	it("marks a contact row as accountless so it cannot read as a member", async () => {
		listMock.mockResolvedValue({
			contacts: [contact({ email: "casey@example.com" })],
			total: 1,
			hasMore: false,
			nextOffset: null,
		});

		render(
			<>
				<OrganizationMembersList organizationId="org-1" />
				<OrganizationContactsList organizationId="org-1" />
			</>,
			{ wrapper },
		);

		const contactRow = await screen.findByTestId("contact-row");
		expect(
			within(contactRow).getByText(`${T}.noAccountBadge`),
		).toBeInTheDocument();
		expect(
			within(contactRow).getByTestId("contact-no-account-mark"),
		).toBeInTheDocument();
		// The optional detail is the row's second line, not something hidden
		// behind an edit dialog — it is what keeps two same-name people apart.
		expect(
			within(contactRow).getByText("casey@example.com"),
		).toBeInTheDocument();

		const memberRow = screen.getByText("Ada Member").closest("tr");
		expect(memberRow).not.toBeNull();
		expect(
			within(memberRow as HTMLElement).queryByText(`${T}.noAccountBadge`),
		).toBeNull();
		expect(
			within(memberRow as HTMLElement).queryByTestId(
				"contact-no-account-mark",
			),
		).toBeNull();
	});

	it("renders the empty state when the register holds no contacts", async () => {
		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		expect(await screen.findByText(`${T}.empty.title`)).toBeInTheDocument();
		expect(screen.queryByTestId("contact-row")).toBeNull();
	});
});

describe("Creating a contact", () => {
	it("creates from a name alone", async () => {
		const user = userEvent.setup();
		createMock.mockResolvedValue({
			status: "created",
			contact: contact(),
			duplicates: [],
		});

		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		await user.type(
			await screen.findByLabelText(`${T}.form.name`),
			"Casey Client",
		);
		await user.click(
			screen.getByRole("button", { name: `${T}.form.submit` }),
		);

		await waitFor(() => {
			expect(createMock).toHaveBeenCalledWith({
				organizationId: "org-1",
				name: "Casey Client",
				email: undefined,
				company: undefined,
				confirmDuplicate: undefined,
			});
		});
		// The awaited invalidation has to match the query the list reads, or
		// the new contact never appears without a page reload.
		await waitFor(() => {
			expect(listMock).toHaveBeenCalledTimes(2);
		});
		expect(toastSuccessMock).toHaveBeenCalled();
	});

	it("asks for confirmation on a duplicate name, then creates after it", async () => {
		const user = userEvent.setup();
		createMock
			.mockResolvedValueOnce({
				status: "duplicate",
				contact: null,
				duplicates: [
					contact({
						id: "contact-existing",
						company: "Northwind",
					}),
				],
			})
			.mockResolvedValueOnce({
				status: "created",
				contact: contact({ id: "contact-2" }),
				duplicates: [],
			});

		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		await user.type(
			await screen.findByLabelText(`${T}.form.name`),
			"Casey Client",
		);
		await user.click(
			screen.getByRole("button", { name: `${T}.form.submit` }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText(`${T}.duplicate.title`),
		).toBeInTheDocument();
		// The existing match is shown, with the detail that tells the two
		// people apart.
		expect(within(dialog).getByText("Northwind")).toBeInTheDocument();
		expect(createMock).toHaveBeenCalledTimes(1);

		await user.click(
			within(dialog).getByRole("button", {
				name: `${T}.duplicate.confirm`,
			}),
		);

		await waitFor(() => {
			expect(createMock).toHaveBeenNthCalledWith(2, {
				organizationId: "org-1",
				name: "Casey Client",
				email: undefined,
				company: undefined,
				confirmDuplicate: true,
			});
		});
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
		});
	});
});

describe("Editing a contact", () => {
	it("persists a renamed contact", async () => {
		const user = userEvent.setup();
		listMock
			.mockResolvedValueOnce({
				contacts: [contact()],
				total: 1,
				hasMore: false,
				nextOffset: null,
			})
			.mockResolvedValue({
				contacts: [contact({ name: "Casey Clientson" })],
				total: 1,
				hasMore: false,
				nextOffset: null,
			});
		updateMock.mockResolvedValue({
			contact: contact({ name: "Casey Clientson" }),
		});

		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		await user.click(
			await screen.findByRole("button", { name: `${T}.edit` }),
		);

		const nameInput = await screen.findByLabelText(`${T}.form.name`, {
			selector: "#edit-contact-name-contact-1",
		});
		await user.clear(nameInput);
		await user.type(nameInput, "Casey Clientson");
		await user.click(
			screen.getByRole("button", { name: `${T}.form.save` }),
		);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith({
				organizationId: "org-1",
				contactId: "contact-1",
				name: "Casey Clientson",
				email: "",
				company: "",
			});
		});
		expect(await screen.findByText("Casey Clientson")).toBeInTheDocument();
	});
});

describe("Deleting a contact", () => {
	it("reports how many to-dos were detached", async () => {
		const user = userEvent.setup();
		listMock
			.mockResolvedValueOnce({
				contacts: [contact()],
				total: 1,
				hasMore: false,
				nextOffset: null,
			})
			.mockResolvedValue({
				contacts: [],
				total: 0,
				hasMore: false,
				nextOffset: null,
			});
		deleteMock.mockResolvedValue({
			success: true,
			contactId: "contact-1",
			redactedAt: "2026-09-18T00:00:00.000Z",
			detachedTodoCount: 3,
			clearedSuggestionCount: 1,
		});

		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		await user.click(
			await screen.findByRole("button", { name: `${T}.delete` }),
		);

		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", {
				name: `${T}.deleteConfirm.confirm`,
			}),
		);

		await waitFor(() => {
			expect(deleteMock).toHaveBeenCalledWith({
				organizationId: "org-1",
				contactId: "contact-1",
			});
		});
		await waitFor(() => {
			expect(toastSuccessMock).toHaveBeenCalledWith(
				`${T}.notifications.deleted.description {"count":3}`,
			);
		});
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull();
		});
	});
});

describe("A failed save", () => {
	it("keeps the editor open with the typing still in it", async () => {
		// The clear-on-settle convention is about optimistic values, which have
		// to be released on both paths. A half-typed correction is the person's
		// own work: discarding it because the save failed makes them retype it
		// just to find out whether the retry works.
		const user = userEvent.setup();
		listMock.mockResolvedValue({
			contacts: [contact()],
			total: 1,
			hasMore: false,
			nextOffset: null,
		});
		updateMock.mockRejectedValue(new Error("nope"));

		render(<OrganizationContactsList organizationId="org-1" />, {
			wrapper,
		});

		await user.click(
			await screen.findByRole("button", { name: `${T}.edit` }),
		);

		const nameInput = await screen.findByLabelText(`${T}.form.name`, {
			selector: "#edit-contact-name-contact-1",
		});
		await user.clear(nameInput);
		await user.type(nameInput, "Casey Clientson");
		await user.click(
			screen.getByRole("button", { name: `${T}.form.save` }),
		);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalled();
		});
		expect(
			await screen.findByLabelText(`${T}.form.name`, {
				selector: "#edit-contact-name-contact-1",
			}),
		).toHaveValue("Casey Clientson");
	});
});
