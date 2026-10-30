vi.mock(
	"next-intl",
	async (original) => await original<typeof import("next-intl")>(),
);

import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	input: vi.fn(),
	listResult: vi.fn(),
	setPage: vi.fn(),
	state: {
		currentPage: 2,
		query: "example",
		status: "deactivated",
		sort: "createdAt",
		direction: "desc",
	} as Record<string, string | number>,
}));
vi.mock("nuqs", async (original) => {
	const { useState } = await import("react");
	return {
		...(await original<typeof import("nuqs")>()),
		useQueryState: (key: string) => {
			const [value, setValue] = useState(() => mocks.state[key]);
			return [
				value,
				(next: string | number, options?: unknown) => {
					if (key === "currentPage") {
						mocks.setPage(next, options);
					}
					mocks.state[key] = next;
					setValue(next);
				},
			];
		},
	};
});
vi.mock("usehooks-ts", () => ({
	useDebounceValue: (value: string) => [value],
}));
vi.mock("@saas/admin/lib/links", () => ({
	useAdminPath: () => (path: string) => `/app/example-org/admin${path}`,
}));
vi.mock("@saas/organizations/components/OrganizationLogo", () => ({
	OrganizationLogo: ({ name }: { name: string }) => (
		<span data-testid={`logo-${name}`} />
	),
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			organizations: {
				list: {
					queryOptions: ({
						input,
						...options
					}: {
						input: unknown;
						placeholderData?: unknown;
					}) => {
						mocks.input(input);
						return {
							...options,
							queryKey: ["list", input],
							queryFn: async () =>
								mocks.listResult() ?? {
									organizations: [
										{
											id: "example-org",
											name: "Example organization",
											logo: null,
											membersCount: 4,
											projectsCount: 3,
											createdAt: new Date("2026-01-01"),
											deletedAt: new Date("2026-10-01"),
											scheduledPermanentDeleteAt:
												new Date("2026-11-01"),
										},
									],
									total: 1,
								},
						};
					},
					key: () => ["list"],
				},
			},
			hostedAdoption: {
				counts: {
					queryOptions: () => ({
						queryKey: ["counts"],
						queryFn: async () => ({
							organizations: 1,
							projects: 3,
							users: 4,
						}),
					}),
				},
			},
		},
	},
}));

import { OrganizationList } from "../OrganizationList";

afterEach(cleanup);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.listResult.mockReset();
	Object.assign(mocks.state, {
		currentPage: 2,
		query: "example",
		status: "deactivated",
		sort: "createdAt",
		direction: "desc",
	});
});
function show() {
	return render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={new QueryClient()}>
				<OrganizationList />
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
}
it("renders counts and deactivated rows and forwards URL pagination, search, status and sorting", async () => {
	show();
	expect(mocks.input).toHaveBeenCalledWith({
		limit: 10,
		offset: 10,
		query: "example",
		status: "deactivated",
		sort: "createdAt",
		direction: "desc",
	});
	expect(await screen.findByText("Example organization")).toBeInTheDocument();
	expect(screen.getAllByText("Deactivated").length).toBeGreaterThan(0);
	expect(screen.getByText(/Purges/)).toBeInTheDocument();
});
it.each([
	["desc", "arrow-down"],
	["asc", "arrow-up"],
])(
	"shows the active %s indicator and neutral inactive indicators",
	(direction, icon) => {
		mocks.state.direction = direction;
		show();
		const active = screen.getByRole("button", { name: "Created" });
		expect(active).toHaveClass("font-semibold");
		expect(active.querySelector(`.lucide-${icon}`)).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(
			screen.getByRole("columnheader", { name: "Created" }),
		).toHaveAttribute(
			"aria-sort",
			direction === "asc" ? "ascending" : "descending",
		);
		for (const name of ["Organization", "Members", "Projects"]) {
			const button = screen.getByRole("button", { name });
			expect(
				button.querySelector(".lucide-chevrons-up-down"),
			).toHaveAttribute("aria-hidden", "true");
			expect(button.querySelector("svg")).toHaveClass(
				"text-muted-foreground",
			);
		}
		for (const name of ["Members", "Projects"]) {
			expect(screen.getByRole("columnheader", { name })).toHaveClass(
				"text-right",
			);
		}
	},
);
it.each([
	["Organization", "name", "asc"],
	["Members", "members", "desc"],
	["Projects", "projects", "desc"],
	["Created", "createdAt", "desc"],
])(
	"first click on %s chooses its initial direction and resets page 2",
	(label, sort, direction) => {
		mocks.state.sort = sort === "name" ? "projects" : "name";
		mocks.state.currentPage = 2;
		show();
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(mocks.state).toMatchObject({ currentPage: 1, sort, direction });
	},
);
it.each([
	["asc", "desc"],
	["desc", "asc"],
])(
	"flips active direction from %s to %s and resets page 2",
	(direction, nextDirection) => {
		mocks.state.direction = direction;
		mocks.state.currentPage = 2;
		show();
		fireEvent.click(screen.getByRole("button", { name: "Created" }));
		expect(mocks.state).toMatchObject({
			currentPage: 1,
			sort: "createdAt",
			direction: nextDirection,
		});
	},
);
it("changing search resets page 2", () => {
	mocks.state.currentPage = 2;
	show();
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "another" },
	});
	expect(mocks.state).toMatchObject({ currentPage: 1, query: "another" });
});
it("changing status resets page 2", async () => {
	mocks.state.currentPage = 2;
	show();
	fireEvent.keyDown(screen.getByRole("combobox", { name: "Status" }), {
		key: "ArrowDown",
	});
	fireEvent.click(await screen.findByRole("option", { name: "Active" }));
	expect(mocks.state).toMatchObject({ currentPage: 1, status: "active" });
});

function organization(id: string, name: string) {
	return {
		id,
		name,
		logo: null,
		membersCount: 4,
		projectsCount: 3,
		createdAt: new Date("2026-01-01"),
		deletedAt: null,
		scheduledPermanentDeleteAt: null,
	};
}
it("keeps the previous rows and total visible while the next search is pending", async () => {
	const first = {
		organizations: [organization("example-org", "Example organization")],
		total: 21,
	};
	let resolveNext!: (result: typeof first) => void;
	const pending = new Promise<typeof first>((resolve) => {
		resolveNext = resolve;
	});
	mocks.listResult.mockResolvedValueOnce(first).mockReturnValue(pending);
	show();
	expect(
		screen.getByText(messages.admin.organizations.loading),
	).toBeInTheDocument();
	const row = (await screen.findByText("Example organization")).closest("tr");
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "another" },
	});
	await waitFor(() => expect(mocks.listResult).toHaveBeenCalledTimes(2));
	expect(screen.getByText("Example organization").closest("tr")).toBe(row);
	expect(
		screen.queryByText(messages.admin.organizations.loading),
	).not.toBeInTheDocument();
	expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
	expect(screen.getByRole("table").querySelector("tbody")).toHaveClass(
		"opacity-60",
	);
	expect(screen.getByText(/of 21/)).toBeInTheDocument();
	await act(async () => {
		resolveNext({
			organizations: [
				organization("example-next", "Another organization"),
			],
			total: 12,
		});
	});
	expect(await screen.findByText("Another organization")).toBeInTheDocument();
	expect(screen.getByText(/of 12/)).toBeInTheDocument();
	expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "false");
});
it("preserves the same organization row when its position changes in the next results", async () => {
	mocks.state.currentPage = 1;
	const kept = organization("example-kept", "Kept organization");
	const other = organization("example-other", "Other organization");
	mocks.listResult
		.mockResolvedValueOnce({ organizations: [other, kept], total: 2 })
		.mockResolvedValue({ organizations: [kept, other], total: 2 });
	show();
	const row = (await screen.findByText("Kept organization")).closest("tr");
	const logo = screen.getByTestId("logo-Kept organization");
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "organization" },
	});
	await waitFor(() => expect(mocks.listResult).toHaveBeenCalledTimes(2));
	await waitFor(() =>
		expect(
			screen.getByRole("table").querySelector("tbody tr"),
		).toHaveTextContent("Kept organization"),
	);
	expect(screen.getByText("Kept organization").closest("tr")).toBe(row);
	expect(screen.getByTestId("logo-Kept organization")).toBe(logo);
});

it("clicking Page 3 requests offset 20 and updates the URL page state", async () => {
	mocks.listResult.mockResolvedValue({
		organizations: [organization("example-org", "Example organization")],
		total: 240,
	});
	show();
	fireEvent.click(await screen.findByRole("button", { name: "Page 3" }));
	await waitFor(() =>
		expect(mocks.input).toHaveBeenLastCalledWith(
			expect.objectContaining({ limit: 10, offset: 20 }),
		),
	);
	expect(mocks.state.currentPage).toBe(3);
});

it("going to page 12 requests offset 110", async () => {
	const user = userEvent.setup();
	mocks.listResult.mockResolvedValue({
		organizations: [organization("example-org", "Example organization")],
		total: 240,
	});
	show();
	const input = await screen.findByRole("spinbutton", {
		name: "Go to page, Pagination",
	});
	await user.type(input, "12{Enter}");
	await waitFor(() =>
		expect(mocks.input).toHaveBeenLastCalledWith(
			expect.objectContaining({ limit: 10, offset: 110 }),
		),
	);
	expect(mocks.state.currentPage).toBe(12);
});

it("corrects a stale URL page to the last page once its total is known", async () => {
	mocks.state.currentPage = 50;
	mocks.listResult
		.mockResolvedValueOnce({ organizations: [], total: 21 })
		.mockResolvedValue({
			organizations: [organization("example-last", "Last organization")],
			total: 21,
		});
	show();
	expect(await screen.findByText("Last organization")).toBeInTheDocument();
	await waitFor(() =>
		expect(mocks.input).toHaveBeenLastCalledWith(
			expect.objectContaining({ offset: 20 }),
		),
	);
	expect(mocks.state.currentPage).toBe(3);
	expect(mocks.setPage).toHaveBeenCalledWith(3, { history: "replace" });
	expect(screen.getByRole("button", { name: "Page 3" })).toHaveAttribute(
		"aria-current",
		"page",
	);
});
it("does not keep correcting a stale page when the total is empty", async () => {
	mocks.state.currentPage = 50;
	mocks.listResult.mockResolvedValue({ organizations: [], total: 0 });
	show();
	expect(await screen.findByText("No results.")).toBeInTheDocument();
	expect(mocks.setPage).not.toHaveBeenCalled();
	expect(mocks.listResult).toHaveBeenCalledTimes(1);
});
