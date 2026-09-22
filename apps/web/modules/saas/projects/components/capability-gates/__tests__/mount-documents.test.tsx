/**
 * The create-document dialog's gate wiring (Fizzy #1930).
 *
 * The claim worth pinning is the one that is easy to get wrong: the gate is
 * about *generating* a document from sources, so it must block generation and
 * nothing else. A manual document needs none of those sources, and taking the
 * Create button away from someone writing one by hand would block the very work
 * that satisfies the gate in the first place.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityGateSelection } from "../useCapabilityGates";

const { getAiConfigStatus, availablePrompts } = vi.hoisted(() => ({
	getAiConfigStatus: vi.fn(),
	availablePrompts: vi.fn(),
}));

const gateRef = { current: null as CapabilityGateSelection | null };

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null, basePath: "/app" }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: (i: unknown) => getAiConfigStatus(i) },
		},
		prompts: { bindings: { set: vi.fn() } },
		projects: {
			contexts: { createUploadUrl: vi.fn(), processFile: vi.fn() },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				create: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
				list: { queryKey: () => ["projects.documents.list"] },
			},
		},
		prompts: {
			agents: {
				available: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.agents.available", input],
						queryFn: () => availablePrompts(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		loading: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
	},
}));

/**
 * Gates the restore control reads. Keyed the way the provider keys them, so a
 * suppressed entry here is what a dismissed warning looks like to the dialog.
 */
const gatesRef: { current: Map<string, unknown> } = { current: new Map() };
const restoreSpy = vi.fn();

/**
 * Stubbed so this file can assert WHERE the control is mounted without driving
 * the Radix type selector, which jsdom cannot click. Its own behaviour — what
 * it lists and what restoring does — is covered in
 * `capability-restore-control.test.tsx`.
 */
vi.mock("../CapabilityRestoreControl", () => ({
	CapabilityRestoreControl: ({
		capabilityKeys,
	}: {
		capabilityKeys?: readonly string[];
	}) => (
		<div
			data-testid="restore-control"
			data-scope={(capabilityKeys ?? []).join(",")}
		/>
	),
}));

vi.mock("../useCapabilityGates", async () => {
	// The real destination mapping, so the remedy assertion below reaches the
	// same link the product renders (Fizzy #1930: the banner owns it now).
	const { gateLinkFor } = await import("../gate-destinations");
	return {
		useCapabilityGate: () =>
			gateRef.current ?? {
				gate: null,
				view: null,
				blocked: false,
			},
		useCapabilityGates: () => ({
			projectId: "project-1",
			suppress: vi.fn(),
			restore: restoreSpy,
			gates: gatesRef.current,
			isSessionDismissed: () => false,
			linkFor: (target: Parameters<typeof gateLinkFor>[0]) =>
				gateLinkFor(target, {
					projectId: "project-1",
					basePath: "/app",
				}),
			codebaseRetryFor: () => undefined,
			codebaseRetrying: false,
		}),
		SNOOZE_DURATIONS: ["session", "1d", "7d", "30d", "forever"] as const,
	};
});

import { CreateDocumentDialog } from "../../CreateDocumentDialog";

/** A soft block — the selected type has no source to generate from. */
const BLOCKED: CapabilityGateSelection = {
	gate: null,
	view: {
		capabilityKey: "documents.generate-tech-spec",
		state: "SOFT_BLOCK",
		reasonKey: "documents.no-technical-source",
		tone: "warning",
		title: "reason.documents.no-technical-source.title",
		body: "reason.documents.no-technical-source.body",
		params: {
			dependency: "a PRD, architecture document or indexed codebase",
		},
		ctaLabel: "remedy.addContext",
		ctaKind: "navigate",
		ctaTarget: "context",
		blocksAction: true,
		dismissible: false,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
	},
	blocked: true,
};

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<CreateDocumentDialog
				projectId="project-1"
				open
				onOpenChange={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

const submitButton = () => screen.getByRole("button", { name: "submit" });

beforeEach(() => {
	gateRef.current = null;
	gatesRef.current = new Map();
	restoreSpy.mockReset();
	getAiConfigStatus.mockReset();
	availablePrompts.mockReset();
	availablePrompts.mockResolvedValue({ prompts: [] });
});

describe("create-document dialog — capability gate wiring", () => {
	it("blocks generation when the selected type has no source", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		gateRef.current = BLOCKED;
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).toBeDisabled(),
		);
		expect(
			screen.getByText("reason.documents.no-technical-source.body"),
		).toBeInTheDocument();
	});

	it("still lets a document be created by hand while generation is blocked", async () => {
		// AI unavailable, so this is the manual path. The gate is about sources
		// a generation would read; writing the document yourself reads none of
		// them, and blocking it would block the work that clears the gate.
		getAiConfigStatus.mockResolvedValue({ isConfigured: false });
		gateRef.current = BLOCKED;
		renderDialog();

		await waitFor(() => expect(submitButton()).not.toBeDisabled());
	});

	it("shows no gate banner on the manual path", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: false });
		gateRef.current = BLOCKED;
		renderDialog();

		await waitFor(() => expect(submitButton()).not.toBeDisabled());
		// The banner explains why generation is unavailable, which is not a
		// statement that belongs on a dialog that is not generating anything.
		expect(
			screen.queryByText("reason.documents.no-technical-source.body"),
		).not.toBeInTheDocument();
	});

	/**
	 * The banner on this surface can dismiss a warning permanently ("do not show
	 * again for this project"), so the route back has to live beside it — AC-8.
	 * It became reachable the moment the thin-context bound stopped colliding
	 * with the project-creation floor, so the mount is pinned here.
	 */
	it("mounts the restore control beside the gate banner on the AI path", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		renderDialog();
		expect(
			await screen.findByTestId("restore-control"),
		).toBeInTheDocument();
	});

	it("shows no restore control on the manual path", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: false });
		renderDialog();
		await screen.findByRole("button", { name: "submit" });
		expect(screen.queryByTestId("restore-control")).not.toBeInTheDocument();
	});

	/**
	 * The remedy link has to reach a page that exists. `/projects/<id>/contexts`
	 * and `/projects/<id>/documents` look plausible but resolve only as
	 * `[contextId]` / `[documentId]` routes — neither has an index page, so both
	 * 404. Context and Documents are tabs, reached with `?tab=<id>` like every
	 * other cross-page CTA. Both links shipped dead; this keeps them honest.
	 */
	it("points its remedy at a tab deep link, not a bare subpath", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		gateRef.current = BLOCKED;
		renderDialog();

		const cta = await screen.findByRole("link", {
			name: /remedy\.addContext/,
		});
		const href = cta.getAttribute("href") ?? "";
		expect(href).toContain("?tab=context");
		expect(href).not.toMatch(/\/contexts$/);
	});

	it("lets text pasted into the source box answer a 'no source' soft block", async () => {
		// Fizzy #1930 (A9): the pasted text IS the source the block asks for,
		// and the server waives the soft block for such a request. Disabling
		// Create over it told the person to add what they were looking at.
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		gateRef.current = BLOCKED;
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).toBeDisabled(),
		);
		await user.click(screen.getByLabelText("sourceContentLabel"));
		await user.paste("GET /v1/orders returns the order list");

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).not.toBeDisabled(),
		);
		expect(
			screen.queryByText("reason.documents.no-technical-source.body"),
		).not.toBeInTheDocument();
	});

	it("lets pasted text lift the repository-only block when code search is off", async () => {
		// Fizzy #1930 D1: on the default project shape a document generator's
		// repository fallback is a SOFT block, so the pasted API docs lift it.
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		gateRef.current = {
			...BLOCKED,
			view: BLOCKED.view && {
				...BLOCKED.view,
				capabilityKey: "documents.generate-api-spec",
				reasonKey: "codebase.code-search-off",
				title: "reason.codebase.code-search-off.title",
				body: "reason.codebase.code-search-off.body",
				ctaLabel: "remedy.enableCodeSearch",
				ctaTarget: "code-search",
			},
		};
		renderDialog();

		expect(
			await screen.findByText("reason.codebase.code-search-off.body"),
		).toBeInTheDocument();
		await user.click(screen.getByLabelText("sourceContentLabel"));
		await user.paste("GET /v1/orders returns the order list");

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).not.toBeDisabled(),
		);
	});

	it("does not let pasted text answer a hard block", async () => {
		const user = userEvent.setup();
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		gateRef.current = {
			...BLOCKED,
			view: BLOCKED.view && {
				...BLOCKED.view,
				state: "HARD_BLOCK",
				reasonKey: "codebase.credentials-expired",
				tone: "destructive",
			},
		};
		renderDialog();

		await user.click(await screen.findByLabelText("sourceContentLabel"));
		await user.paste("Some notes");

		// Give the debounced source check time to settle, then confirm.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(
			screen.getByRole("button", { name: "submitWithAi" }),
		).toBeDisabled();
	});

	it("leaves the dialog untouched when nothing is gated", async () => {
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "submitWithAi" }),
			).not.toBeDisabled(),
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
