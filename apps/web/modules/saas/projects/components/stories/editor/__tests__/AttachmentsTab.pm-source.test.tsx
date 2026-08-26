/**
 * A row synced in from a PM tool (Jira, ADO, Fizzy) is read-only until a
 * teammate explicitly promotes it: no lock toggle, no remove, just a source
 * badge and a Promote button. Once promoted it behaves exactly like a
 * Fabric-origin upload, but keeps the "Originally from X" provenance label.
 * A Fabric-origin row (source === "FABRIC") is implicitly promoted and must
 * render exactly as it did before this feature. Fizzy #1746.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../../lib/stories/types";
import { AttachmentsTab } from "../AttachmentsTab";

const { listAttachments, promoteAttachment } = vi.hoisted(() => ({
	listAttachments: vi.fn(),
	promoteAttachment: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				listAttachments,
				promoteAttachment,
				removeAttachment: vi.fn().mockResolvedValue({ removed: true }),
				setAttachmentDesignation: vi.fn().mockResolvedValue({
					attachment: { id: "a1", designation: "UNLOCKED" },
				}),
			},
		},
	},
}));

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const story = { id: "s1", description: "" } as unknown as UserStory;
const baseProps = {
	story,
	projectId: "p1",
	organizationId: null as string | null,
};

function renderTab(attachments: unknown[]) {
	listAttachments.mockReset().mockResolvedValue({ attachments });
	promoteAttachment.mockReset().mockResolvedValue({
		attachment: { id: "a1", promotedAt: new Date(9) },
	});
	return render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
}

/** Like `renderTab`, but also returns the QueryClient so a test can spy on
 * `invalidateQueries`. */
function renderTabWithClient(attachments: unknown[]) {
	listAttachments.mockReset().mockResolvedValue({ attachments });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const result = render(
		<QueryClientProvider client={client}>
			<AttachmentsTab {...baseProps} canEdit={true} />
		</QueryClientProvider>,
	);
	return { ...result, client };
}

const inboundRow = {
	id: "a1",
	filename: "logs.txt",
	mimeType: "text/plain",
	sizeBytes: 120,
	designation: "LOCKED" as const,
	source: "PM_SYNCED" as const,
	sourceTool: "jira",
	promotedAt: null,
	externalAuthor: "QA Engineer",
	externalCreatedAt: new Date(1),
	createdAt: new Date(0),
	downloadUrl: "https://signed",
};

describe("AttachmentsTab PM provenance (Fizzy #1746)", () => {
	it("labels an inbound row with its source tool", async () => {
		renderTab([inboundRow]);
		expect(await screen.findByText("From Jira")).toBeInTheDocument();
	});

	it("gives an un-promoted inbound row no lock or remove controls", async () => {
		renderTab([inboundRow]);
		await screen.findByText("From Jira");
		expect(
			screen.queryByRole("button", { name: /unlock|lock/i }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
	});

	it("offers Promote on an un-promoted inbound row and calls the procedure", async () => {
		renderTab([inboundRow]);
		await userEvent.click(
			await screen.findByRole("button", { name: /promote/i }),
		);
		expect(promoteAttachment).toHaveBeenCalledWith(
			expect.objectContaining({ attachmentId: "a1" }),
		);
	});

	it("restores controls and keeps the origin label after promotion", async () => {
		renderTab([{ ...inboundRow, promotedAt: new Date(9) }]);
		// The distinction lives in VISIBLE text, not a `title` attribute — a
		// `title` duplicating "Originally from Jira" over a "From Jira" label
		// would make a screen reader announce the same provenance twice.
		expect(
			await screen.findByText("Originally from Jira"),
		).toBeInTheDocument();
		expect(screen.queryByText("From Jira")).toBeNull();
		expect(screen.queryByRole("button", { name: /promote/i })).toBeNull();
		expect(
			screen.getByRole("button", { name: /unlock|lock/i }),
		).toBeInTheDocument();
	});

	it("leaves a Fabric-origin row untouched", async () => {
		renderTab([
			{ ...inboundRow, source: "FABRIC" as const, sourceTool: null },
		]);
		await screen.findByText("logs.txt");
		expect(screen.queryByText(/^From /)).toBeNull();
		expect(screen.queryByRole("button", { name: /promote/i })).toBeNull();
	});

	it("rapid double-click on Promote fires the procedure exactly once", async () => {
		// `mutate()` returns void, so Button's autoLoading (which only engages
		// for a promise-returning onClick) never guards this click — the
		// explicit `disabled={promoteMutation.isPending}` on the Promote
		// button is what has to swallow the second click. Fizzy #1746.
		let resolvePromote: (v: unknown) => void = () => {};
		renderTab([inboundRow]);
		promoteAttachment.mockReset().mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolvePromote = resolve;
				}),
		);

		const user = userEvent.setup();
		const button = await screen.findByRole("button", { name: /promote/i });
		await user.click(button);

		// Second click while the first promote is still pending should NOT
		// trigger a second call. We don't await it deliberately — we want to
		// test the synchronous disabled-state guard, not a debounced one.
		await user.click(button);

		// Resolve the in-flight mutation so the test can clean up.
		resolvePromote({ attachment: { id: "a1", promotedAt: new Date(9) } });

		await waitFor(() => {
			expect(promoteAttachment).toHaveBeenCalledTimes(1);
		});
	});

	it("does not re-enable row A's Promote button while it is in flight just because row B was promoted (Finding 1)", async () => {
		// There is ONE shared `promoteMutation` instance. A guard keyed on
		// `promoteMutation.variables === a.id` looks per-row but isn't — v5's
		// MutationObserver re-points `variables` to the newest call, so
		// promoting B while A is still pending would flip A's guard to false
		// and let a second click on A re-fire it.
		const rowA = { ...inboundRow, id: "a1", filename: "a.txt" };
		const rowB = { ...inboundRow, id: "a2", filename: "b.txt" };
		renderTab([rowA, rowB]);

		let resolveA: (v: unknown) => void = () => {};
		promoteAttachment
			.mockReset()
			.mockImplementation((vars: { attachmentId: string }) =>
				vars.attachmentId === "a1"
					? new Promise((resolve) => {
							resolveA = resolve;
						})
					: Promise.resolve({
							attachment: {
								id: vars.attachmentId,
								promotedAt: new Date(9),
							},
						}),
			);

		const user = userEvent.setup();
		const [buttonA, buttonB] = await screen.findAllByRole("button", {
			name: /promote/i,
		});

		// Promote A — its request is held open by the test.
		await user.click(buttonA);
		expect(promoteAttachment).toHaveBeenCalledTimes(1);

		// Promote B while A is still pending.
		await user.click(buttonB);
		expect(promoteAttachment).toHaveBeenCalledTimes(2);

		// Click A again: its button must still be disabled, so this must NOT
		// fire a third call.
		await user.click(buttonA);
		expect(promoteAttachment).toHaveBeenCalledTimes(2);

		resolveA({ attachment: { id: "a1", promotedAt: new Date(9) } });
		await waitFor(() => {
			expect(promoteAttachment).toHaveBeenCalledTimes(2);
		});
	});

	it("invalidates the attachments query even when promote rejects (Finding 2)", async () => {
		promoteAttachment.mockReset().mockRejectedValue(new Error("boom"));
		const { client } = renderTabWithClient([inboundRow]);
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: /promote/i }),
		);

		// The invalidate used to sit after the awaited call INSIDE
		// `mutationFn`, so a rejection threw past it and the invalidate never
		// ran — the row kept showing a stale, re-clickable Promote button.
		await waitFor(() => {
			expect(invalidateSpy).toHaveBeenCalled();
		});
	});

	it("renders no provenance badge on a FABRIC row even if sourceTool is stamped (Finding 4)", async () => {
		// PR 2's outbound push stamps `sourceTool` on a Fabric upload it just
		// pushed. The badge must key on `source === "PM_SYNCED"` (the same
		// column `isUnpromotedInbound` reads), not on `sourceTool` alone —
		// otherwise a file the user uploaded IN Fabric gets labeled "From
		// Jira".
		renderTab([
			{
				...inboundRow,
				source: "FABRIC" as const,
				sourceTool: "jira",
				promotedAt: new Date(9),
			},
		]);
		await screen.findByText("logs.txt");
		expect(screen.queryByText(/from jira/i)).toBeNull();
	});

	it("falls back to the raw sourceTool string for an unmapped value like a prototype key (Finding 6)", async () => {
		// `sourceTool` is a free-form `String?` column. A plain
		// `SOURCE_TOOL_LABELS[sourceTool]` index read walks the prototype
		// chain, so "constructor" would resolve to the inherited `Object`
		// constructor function instead of `undefined` — and `??` never falls
		// back to the raw string.
		renderTab([{ ...inboundRow, sourceTool: "constructor" }]);
		expect(await screen.findByText("From constructor")).toBeInTheDocument();
	});
});
