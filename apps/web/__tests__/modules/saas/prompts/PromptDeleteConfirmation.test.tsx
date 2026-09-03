/**
 * What a prompt deletion says before and after it happens (Fizzy #2328,
 * R5/R7/R10/R14/R15, KTD6/KTD7).
 *
 * Deleting a SYSTEM prompt reaches rows in tenants the operator cannot see, so
 * the confirmation has to say how far it goes. These tests hold that copy to
 * three rules:
 *
 *  - it names the figures, and names no organization and no person (R6);
 *  - an impact that could not be read says exactly that, never "no bindings" —
 *    see `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md`;
 *  - the completion reports what the deletion RETURNED, not the snapshot the
 *    dialog showed, because a binding can be written while the operator reads
 *    it (R15, AE16).
 *
 * NEGATIVE-ASSERTION PROOF. The figure assertions below are only worth
 * something if they fail when the impact is not fetched. Stub
 * `deletionImpact` to resolve `undefined` and
 * "names every figure ..." must go red — the message becomes the
 * "could not be determined" sentence. That check was performed by hand before
 * this file landed; keep it possible by never asserting the figures with a
 * matcher that an absent impact would also satisfy.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptDeleteConfirmation.test.tsx
 */

import { PromptCard } from "@saas/prompts/components/PromptCard";
import { PromptManagementPage } from "@saas/prompts/components/PromptManagementPage";
import { PromptsListView } from "@saas/prompts/components/PromptsListView";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	deletionImpact,
	deletePrompt,
	confirmMock,
	toastSuccess,
	toastError,
	state,
} = vi.hoisted(() => ({
	deletionImpact: vi.fn(),
	deletePrompt: vi.fn(),
	confirmMock: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	state: { prompts: [] as unknown[] },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			delete: (input: unknown) => deletePrompt(input),
			deletionImpact: (input: unknown) => deletionImpact(input),
			bind: { clear: vi.fn(), set: vi.fn() },
			get: { byId: vi.fn().mockResolvedValue(null) },
			fork: { fork: vi.fn() },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			list: {
				queryOptions: () => ({
					queryKey: ["prompts", "list"],
					queryFn: async () => ({
						prompts: state.prompts,
						total: state.prompts.length,
					}),
				}),
			},
			categories: {
				queryOptions: () => ({
					queryKey: ["prompts", "categories"],
					queryFn: async () => ({ categories: [] }),
				}),
			},
			get: {
				byId: {
					queryOptions: () => ({
						queryKey: ["prompts", "byId"],
						queryFn: async () => null,
						enabled: false,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "admin" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/example-org",
		organizationId: "org-1",
		userRole: "admin",
	}),
}));

vi.mock("@saas/prompts/components/PromptBindingManager", () => ({
	PromptBindingManager: () => null,
}));
vi.mock("@saas/prompts/components/PromptsHero", () => ({
	PromptsHero: () => null,
}));

const systemPrompt = {
	id: "p-sys",
	name: "Draft Generator",
	description: null,
	scope: "SYSTEM" as const,
	organizationId: null,
	userId: null,
	format: "PLAIN_TEXT" as const,
	category: null,
	tags: [] as string[],
	isPublic: true,
	usageCount: 0,
	lastUsedAt: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-01"),
	versions: [{ id: "pv-1", version: 1, content: "body" }],
	_count: { versions: 1 },
	forkedFrom: null,
};

const orgPrompt = {
	...systemPrompt,
	id: "p-org",
	name: "Team Draft Generator",
	scope: "ORG" as const,
	organizationId: "org-1",
};

/** Two organizations and one personal override — the AE4 fixture. */
const busyImpact = {
	promptRowCount: 2,
	bindingCount: 5,
	organizationCount: 2,
	personalOverrideUserCount: 1,
	documentTypeLabels: ["Draft", "PRD"],
};

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const surfaces = [
	{
		name: "the prompt card",
		anchor: "Duplicate",
		render: (prompt: typeof systemPrompt | typeof orgPrompt) => {
			wrap(<PromptCard prompt={prompt} />);
		},
	},
	{
		name: "the prompt list row",
		anchor: "Duplicate",
		render: (prompt: typeof systemPrompt | typeof orgPrompt) => {
			wrap(<PromptsListView prompts={[prompt]} onUpdate={() => {}} />);
		},
	},
	{
		name: "the prompt management table",
		anchor: "Fork",
		render: (prompt: typeof systemPrompt | typeof orgPrompt) => {
			state.prompts = [prompt];
			wrap(<PromptManagementPage organizationSlug="example-org" />);
		},
	},
];

/**
 * The overflow trigger, found the way the busy assertions need it: by attribute
 * rather than by role, because Radix marks everything outside an OPEN menu
 * `aria-hidden`, which hides the trigger from role queries mid-flight.
 */
function overflowTrigger(): HTMLButtonElement {
	const trigger = document.querySelector<HTMLButtonElement>(
		'[aria-haspopup="menu"]',
	);
	if (!trigger) {
		throw new Error("overflow trigger not found");
	}
	return trigger;
}

async function chooseDelete(anchor: string) {
	const user = userEvent.setup();
	// One surface loads its rows from a query, so wait for the trigger to
	// exist before reaching for it by attribute.
	await screen.findByRole("button", { name: /^Actions for / });
	await user.click(overflowTrigger());
	expect(await screen.findByText(anchor)).toBeInTheDocument();
	await user.click(screen.getByText("Delete"));
	return user;
}

/** The options the surface handed the shared confirmation dialog. */
function confirmOptions() {
	expect(confirmMock).toHaveBeenCalledTimes(1);
	return confirmMock.mock.calls[0][0] as {
		title: string;
		message: string;
		confirmLabel?: string;
		destructive?: boolean;
		onConfirm: () => void;
	};
}

beforeEach(() => {
	deletionImpact.mockReset();
	deletePrompt.mockReset();
	confirmMock.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
	state.prompts = [];
	deletePrompt.mockResolvedValue({
		success: true,
		promptKey: "draft_generator",
		scope: "SYSTEM",
		promptRowCount: 2,
		bindingCount: 5,
		organizationCount: 2,
		personalOverrideUserCount: 1,
		documentTypeLabels: ["Draft", "PRD"],
		retirementRecorded: true,
	});
});

describe("the confirmation for a SYSTEM prompt", () => {
	it("names every figure the deletion will remove, and names nobody (AE4)", async () => {
		deletionImpact.mockResolvedValue(busyImpact);
		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		const { message } = confirmOptions();

		expect(deletionImpact).toHaveBeenCalledWith({ id: "p-sys" });
		// Each of the figures R5 requires, individually.
		expect(message).toContain("2 prompt rows");
		expect(message).toContain("5 bindings");
		expect(message).toContain("2 organizations");
		expect(message).toContain("1 person holding a personal override");
		expect(message).toContain("Draft and PRD");
		// R6: totals only. No organization and no person is identifiable.
		expect(message).not.toMatch(/org-\w|user-\w/);
	});

	it("says plainly that nothing is bound when nothing is (AE5)", async () => {
		deletionImpact.mockResolvedValue({
			promptRowCount: 1,
			bindingCount: 0,
			organizationCount: 0,
			personalOverrideUserCount: 0,
			documentTypeLabels: [],
		});
		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		const { message } = confirmOptions();

		expect(message).toContain("1 prompt row carries its key");
		expect(message).toContain("There are no bindings");
		// Not an empty impact list, and not a row of zeroes.
		expect(message).not.toContain("0 organizations");
	});

	it("says all the rows carrying the key go together (R14)", async () => {
		deletionImpact.mockResolvedValue(busyImpact);
		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		expect(confirmOptions().message).toContain(
			"2 prompt rows carry its key and all of them will be removed",
		);
	});

	it("reports an unreadable impact as unknown, never as zero, and still offers to continue", async () => {
		deletionImpact.mockRejectedValue(new Error("network down"));
		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		const options = confirmOptions();

		expect(options.message).toContain("could not be determined");
		expect(options.message).not.toMatch(/no bindings|0 bindings/);
		// A hard block is the dead end this ticket removes: confirming still
		// deletes (R7).
		options.onConfirm();
		await waitFor(() =>
			expect(deletePrompt).toHaveBeenCalledWith({ id: "p-sys" }),
		);
	});
});

describe("the confirmation for an ORG prompt", () => {
	it("never asks for a platform-wide impact and keeps the plain wording", async () => {
		surfaces[0].render(orgPrompt);
		await chooseDelete(surfaces[0].anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		expect(deletionImpact).not.toHaveBeenCalled();
		expect(confirmOptions().message).toBe(
			'Are you sure you want to delete "Team Draft Generator"? This action cannot be undone.',
		);
	});
});

describe("the wait has a visible home on every surface", () => {
	it.each(surfaces)(
		"$name marks its overflow trigger busy until the dialog opens",
		async (surface) => {
			let releaseImpact: ((value: unknown) => void) | undefined;
			deletionImpact.mockImplementation(
				() =>
					new Promise((resolve) => {
						releaseImpact = resolve;
					}),
			);

			surface.render(systemPrompt);
			await chooseDelete(surface.anchor);

			const trigger = overflowTrigger();
			await waitFor(() => expect(trigger).toBeDisabled());
			expect(trigger).toHaveAttribute("aria-busy", "true");
			// The dialog must not open on a sentence that is not ready yet.
			expect(confirmMock).not.toHaveBeenCalled();
			// And the wait is announced, not merely drawn.
			expect(screen.getByRole("status")).toHaveTextContent(
				/checking what deleting this system prompt would remove/i,
			);

			releaseImpact?.(busyImpact);

			await waitFor(() => expect(confirmMock).toHaveBeenCalled());
			expect(overflowTrigger()).not.toBeDisabled();
			expect(overflowTrigger()).toHaveAttribute("aria-busy", "false");
		},
	);
});

describe("after the deletion", () => {
	it("reports the figures the deletion returned, not the ones shown (AE16)", async () => {
		// The dialog showed five bindings; a sixth and a second personal
		// override were written while the operator read it.
		deletionImpact.mockResolvedValue(busyImpact);
		deletePrompt.mockResolvedValue({
			success: true,
			promptKey: "draft_generator",
			scope: "SYSTEM",
			promptRowCount: 2,
			bindingCount: 7,
			organizationCount: 3,
			personalOverrideUserCount: 2,
			documentTypeLabels: ["Draft", "PRD"],
			retirementRecorded: true,
		});

		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);
		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		confirmOptions().onConfirm();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		const description = toastSuccess.mock.calls[0][1]?.description ?? "";

		expect(description).toContain("7 bindings");
		expect(description).toContain("3 organizations");
		expect(description).toContain("2 people holding personal overrides");
		// The stale snapshot must not be what gets reported.
		expect(description).not.toContain("5 bindings");
	});

	it("surfaces the server's own reason when the deletion is rejected (R10)", async () => {
		deletionImpact.mockResolvedValue(busyImpact);
		deletePrompt.mockRejectedValue(
			new Error("This prompt has already been deleted"),
		);

		surfaces[0].render(systemPrompt);
		await chooseDelete(surfaces[0].anchor);
		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		confirmOptions().onConfirm();

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastError.mock.calls[0][1]?.description).toBe(
			"This prompt has already been deleted",
		);
	});

	it("says nothing cross-tenant about an ORG deletion", async () => {
		deletePrompt.mockResolvedValue({
			success: true,
			promptKey: "team_draft_generator",
			scope: "ORG",
			promptRowCount: 1,
			bindingCount: 1,
			organizationCount: 1,
			personalOverrideUserCount: 0,
			documentTypeLabels: ["Draft"],
			retirementRecorded: false,
		});

		surfaces[0].render(orgPrompt);
		await chooseDelete(surfaces[0].anchor);
		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		confirmOptions().onConfirm();

		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		expect(toastSuccess.mock.calls[0][1]?.description).toBeUndefined();
	});
});

describe("every surface confirms through the shared dialog (KTD7)", () => {
	it.each(surfaces)("$name", async (surface) => {
		deletionImpact.mockResolvedValue(busyImpact);
		surface.render(systemPrompt);
		await chooseDelete(surface.anchor);

		await waitFor(() => expect(confirmMock).toHaveBeenCalled());
		const options = confirmOptions();

		expect(options.title).toBe("Delete Prompt");
		expect(options.destructive).toBe(true);
		expect(options.message).toContain("5 bindings");
		cleanup();
	});
});
