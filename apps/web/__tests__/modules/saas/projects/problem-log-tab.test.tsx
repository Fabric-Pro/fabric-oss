/**
 * Problem Log tab (Fizzy #2277): list, detail sheet, the status action, and
 * the review of entries drafted from meetings.
 *
 * React Query hooks are stubbed so the test drives the component with fixed
 * list / detail data and captures the mutation it sends.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	listItems: [] as unknown[],
	detail: undefined as unknown,
	mutate: vi.fn(),
	listInput: undefined as undefined | ((cursor?: string) => unknown),
	drafts: [] as unknown[],
	draftsInput: undefined as unknown,
	reportInput: undefined as unknown,
	reportRows: [] as unknown[],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		problemLog: {
			key: () => ["problemLog"],
			list: {
				infiniteOptions: (opts: {
					input: (cursor?: string) => unknown;
				}) => {
					state.listInput = opts.input;
					return { queryKey: ["list"] };
				},
				queryOptions: (opts: { input: unknown }) => {
					state.draftsInput = opts.input;
					return { queryKey: ["drafts"] };
				},
			},
			get: { queryOptions: () => ({ queryKey: ["get"] }) },
			setStatus: { mutationOptions: (opts: unknown) => opts },
			review: { mutationOptions: (opts: unknown) => opts },
			report: {
				queryOptions: (opts: { input: unknown }) => {
					state.reportInput = opts.input;
					return { queryKey: ["report"] };
				},
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: () => ({
		data: { pages: [{ items: state.listItems, nextCursor: null }] },
		isPending: false,
		isError: false,
		hasNextPage: false,
	}),
	useQuery: (opts: { enabled?: boolean; queryKey: string[] }) =>
		opts.queryKey[0] === "drafts"
			? { data: { items: state.drafts, nextCursor: null } }
			: opts.queryKey[0] === "report"
				? {
						isPending: false,
						data: {
							rows: state.reportRows,
							truncated: false,
							generatedAt: "2026-11-02T09:00:00.000Z",
						},
					}
				: { data: opts.enabled ? state.detail : undefined },
	useMutation: () => ({ mutate: state.mutate, isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProblemLogTab } from "@saas/projects/components/problem-log/ProblemLogTab";

const ENTRY = {
	id: "entry-1",
	title: 'Could not sync "Checkout flow" to jira',
	category: "INTEGRATION_FAILURE",
	severity: "ERROR",
	status: "OPEN",
	occurrenceCount: 4,
	firstSeenAt: "2026-10-01T10:00:00.000Z",
	lastSeenAt: "2026-10-02T10:00:00.000Z",
	resolvedAt: null,
	source: "pm-sync:jira",
	description: "The PM tool rejected the update.",
};

beforeEach(() => {
	state.listItems = [ENTRY];
	state.detail = {
		entry: ENTRY,
		history: [
			{
				id: "h1",
				at: "2026-10-01T12:00:00.000Z",
				actorType: "user",
				actorName: "Dev",
				previousStatus: "RESOLVED",
				newStatus: "OPEN",
				note: "Still failing",
			},
		],
	};
	state.mutate.mockReset();
	state.drafts = [];
	state.reportRows = [];
	state.reportInput = undefined;
});

const DRAFT = {
	id: "draft-1",
	title: "Vendor API keys not issued",
	description: null,
	category: "PROJECT_BLOCKER",
	severity: "ERROR",
	sourceQuote: "we still have no keys from the vendor",
	metadata: { meetingSubject: "Weekly sync" },
};

describe("ProblemLogTab drafts from meetings", () => {
	it("lists pending drafts with their quote and meeting for a manager", () => {
		state.drafts = [DRAFT];
		render(<ProblemLogTab projectId="proj-1" canManage />);
		expect(state.draftsInput).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-1",
			reviewState: "PENDING",
		});
		expect(screen.getByText(DRAFT.title)).toBeTruthy();
		expect(screen.getByText(/we still have no keys/)).toBeTruthy();
		expect(screen.getByText(/Project blocker · Weekly sync/)).toBeTruthy();
	});

	it("is not shown without the manage permission", () => {
		state.drafts = [DRAFT];
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		expect(screen.queryByText(DRAFT.title)).toBeNull();
	});

	it("confirms and dismisses a draft", async () => {
		state.drafts = [DRAFT];
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage />);
		await user.click(
			screen.getByRole("button", { name: `Confirm: ${DRAFT.title}` }),
		);
		expect(state.mutate).toHaveBeenLastCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			entryId: "draft-1",
			decision: "CONFIRM",
			edits: undefined,
		});
		await user.click(
			screen.getByRole("button", { name: `Dismiss: ${DRAFT.title}` }),
		);
		expect(state.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				entryId: "draft-1",
				decision: "DISMISS",
			}),
		);
	});

	it("confirms a draft with the reviewer's edits", async () => {
		state.drafts = [DRAFT];
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage />);
		await user.click(
			screen.getByRole("button", { name: `Edit: ${DRAFT.title}` }),
		);
		const title = screen.getByLabelText("Title");
		await user.clear(title);
		await user.type(title, "Vendor keys block go-live");
		await user.type(
			screen.getByLabelText("Description"),
			"Raised by the vendor lead.",
		);
		await user.click(screen.getByRole("button", { name: "Confirm" }));
		expect(state.mutate).toHaveBeenLastCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			entryId: "draft-1",
			decision: "CONFIRM",
			edits: {
				title: "Vendor keys block go-live",
				description: "Raised by the vendor lead.",
				category: "PROJECT_BLOCKER",
				severity: "ERROR",
			},
		});
	});
});

describe("ProblemLogTab", () => {
	it("lists entries with severity, category, count and status, defaulting to open ones", () => {
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		const row = screen.getByText(ENTRY.title).closest("tr") as HTMLElement;
		expect(within(row).getByText("Error")).toBeTruthy();
		expect(within(row).getByText("Integration failure")).toBeTruthy();
		expect(within(row).getByText("4")).toBeTruthy();
		expect(within(row).getByText("Open")).toBeTruthy();
		expect(state.listInput?.(undefined)).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-1",
			status: "OPEN",
		});
	});

	it("shows the empty state when nothing is recorded", () => {
		state.listItems = [];
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		expect(screen.getByText("No problems recorded")).toBeTruthy();
	});

	it("opens an entry with its history; a manager resolves it with a note", async () => {
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage />);
		await user.click(screen.getByText(ENTRY.title));

		expect(
			screen.getByText("The PM tool rejected the update."),
		).toBeTruthy();
		expect(screen.getByText("Still failing")).toBeTruthy();

		await user.type(
			screen.getByLabelText("Status change note"),
			"Token renewed",
		);
		await user.click(screen.getByRole("button", { name: "Mark resolved" }));
		expect(state.mutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			entryId: "entry-1",
			status: "RESOLVED",
			note: "Token renewed",
		});
	});

	it("offers no status action without the manage permission", async () => {
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		await user.click(screen.getByText(ENTRY.title));
		expect(
			screen.queryByRole("button", { name: "Mark resolved" }),
		).toBeNull();
	});
});

describe("ProblemLogTab incident report", () => {
	const REPORT_ROW = {
		...ENTRY,
		projectName: "Example project",
		affectedUser: "Dev",
	};

	it("previews the filtered entries and narrows them by date range", async () => {
		state.reportRows = [REPORT_ROW];
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		await user.click(
			screen.getByRole("button", { name: "Incident report" }),
		);

		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(ENTRY.title)).toBeTruthy();
		expect(within(dialog).getByText("Dev")).toBeTruthy();
		expect(state.reportInput).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-1",
			status: "OPEN",
		});

		await user.type(within(dialog).getByLabelText("From"), "2026-10-01");
		await user.type(within(dialog).getByLabelText("To"), "2026-10-31");
		const input = state.reportInput as { from: Date; to: Date };
		expect(input.from).toBeInstanceOf(Date);
		expect(input.to.getTime()).toBeGreaterThan(input.from.getTime());
		expect(
			within(dialog).getByRole("button", { name: "Download CSV" }),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "Download PDF" }),
		).toBeTruthy();
	});

	it("flags an inverted date range", async () => {
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		await user.click(
			screen.getByRole("button", { name: "Incident report" }),
		);
		const dialog = screen.getByRole("dialog");
		await user.type(within(dialog).getByLabelText("From"), "2026-10-31");
		await user.type(within(dialog).getByLabelText("To"), "2026-10-01");
		expect(within(dialog).getByRole("alert").textContent).toMatch(
			/start date must not be after/,
		);
	});

	it("reports a single entry from its sheet", async () => {
		state.reportRows = [REPORT_ROW];
		const user = userEvent.setup();
		render(<ProblemLogTab projectId="proj-1" canManage={false} />);
		await user.click(screen.getByText(ENTRY.title));
		const sheetButtons = screen.getAllByRole("button", {
			name: "Incident report",
		});
		await user.click(sheetButtons[sheetButtons.length - 1]);
		expect(state.reportInput).toMatchObject({ entryId: "entry-1" });
		expect(screen.getByText("Single entry")).toBeTruthy();
	});
});
