import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.unmock("next-intl");
const m = vi.hoisted(() => ({
	list: vi.fn(),
	start: vi.fn(),
	status: vi.fn(),
	result: vi.fn(),
	review: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { triage: m } },
}));

import { ProjectSignalReview } from "../ProjectSignalReview";

const projectId = "example-project";
const scope = ["example-org", "example-user", projectId] as const;
const run = {
	id: "example-run",
	status: "COMPLETED",
	selectedCount: 1,
	createdAt: "2026-11-01T12:00:00Z",
	expiresAt: "2026-11-08T12:00:00Z",
	failureCode: null,
};
const pin = {
	observationId: "example-observation",
	watchId: "example-watch",
	grantId: "example-grant",
	grantRevision: 1,
	evidenceDigest: "a".repeat(64),
};
const proposal = {
	id: "b".repeat(64),
	title: "Example private proposal",
	summary: "A source-supported delivery risk.",
	kind: "RISK",
	urgency: "SOON",
	uncertainties: ["The owner is not confirmed."],
	citations: [pin],
};
const detail = {
	version: 1,
	run,
	result: {
		version: 1,
		audience: "PRIVATE_OWNER",
		coverage: "SELECTED_EVIDENCE_ONLY",
		reviewedEvidence: [pin],
		proposals: [proposal],
	},
	reviews: {},
};
const choices = Array.from({ length: 6 }, (_, i) => ({
	id: `example-observation-${i}`,
	capturedAt: run.createdAt,
}));
let client: QueryClient;
beforeEach(() => {
	vi.resetAllMocks();
	m.list.mockResolvedValue({
		version: 1,
		availability: "AVAILABLE",
		runs: [run],
		nextBefore: null,
	});
	m.status.mockResolvedValue(run);
	m.result.mockResolvedValue(detail);
	m.review.mockResolvedValue(detail);
	m.cancel.mockResolvedValue({ ...run, status: "CANCELLED" });
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
});
afterEach(() => {
	cleanup();
	client.clear();
});
function show() {
	render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider client={client}>
				<ProjectSignalReview
					projectId={projectId}
					scope={scope}
					choices={choices}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
}
async function openResult() {
	const user = userEvent.setup();
	show();
	await user.click(screen.getByRole("button", { name: "Review signals" }));
	await user.click(screen.getByRole("button", { name: "Run history" }));
	const row = await screen.findByRole("button", {
		name: /1 selected signal.*Completed/,
	});
	await user.click(row);
	await screen.findByText(proposal.title);
	return user;
}
describe("private signal review drawer", () => {
	it("keeps run history hidden and starts no work just by rendering", () => {
		show();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByText("Run history")).toBeNull();
		expect(m.list).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("exposes an accessible goal and limits selection to five signals", async () => {
		const user = userEvent.setup();
		show();
		await user.click(
			screen.getByRole("button", { name: "Review signals" }),
		);
		const checkboxes = await screen.findAllByRole("checkbox");
		for (const checkbox of checkboxes.slice(0, 5)) {
			await user.click(checkbox);
		}
		expect(checkboxes[5]).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Start private review" }),
		).toBeDisabled();
		await user.type(
			screen.getByLabelText("What should this review look for?"),
			"Find supported risks",
		);
		expect(
			screen.getByRole("button", { name: "Start private review" }),
		).toBeEnabled();
	});
	it("retries the original immutable request after uncertainty rather than creating another job", async () => {
		const user = userEvent.setup();
		show();
		m.start.mockRejectedValue(Error("Example lost acknowledgement"));
		await user.click(
			screen.getByRole("button", { name: "Review signals" }),
		);
		await user.click((await screen.findAllByRole("checkbox"))[0]);
		await user.type(
			screen.getByLabelText("What should this review look for?"),
			"Find supported risks",
		);
		await user.click(
			screen.getByRole("button", { name: "Start private review" }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Retry saved request" }),
		);
		await waitFor(() => expect(m.start).toHaveBeenCalledTimes(2));
		expect(m.start.mock.calls[0][0]).toEqual(m.start.mock.calls[1][0]);
		expect(m.start.mock.calls[0][0]).toMatchObject({
			projectId,
			goal: "Find supported risks",
			evidenceIds: [choices[0].id],
		});
		expect(
			screen.getByLabelText("What should this review look for?"),
		).toBeDisabled();
	});
	it("renders cited private proposals and makes a private decision with explicit identity", async () => {
		const user = await openResult();
		expect(screen.getByText(proposal.summary)).toBeInTheDocument();
		expect(screen.getByText(proposal.uncertainties[0])).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Keep privately" }),
		);
		await waitFor(() =>
			expect(m.review).toHaveBeenCalledWith({
				projectId,
				runId: run.id,
				proposalId: proposal.id,
				decision: "KEEP",
			}),
		);
		expect(m.start).not.toHaveBeenCalled();
	});
	it("withholds previously shown content while current result access is refused", async () => {
		const user = await openResult();
		m.result.mockRejectedValue(Error("Example access revoked"));
		await user.click(
			screen.getByRole("button", { name: "Check access and refresh" }),
		);
		await waitFor(() =>
			expect(screen.queryByText(proposal.title)).toBeNull(),
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});
	it("also hides stale results when status access is revoked independently", async () => {
		const user = await openResult();
		m.status.mockRejectedValue(Error("Example current access revoked"));
		await user.click(
			screen.getByRole("button", { name: "Check access and refresh" }),
		);
		await waitFor(() =>
			expect(screen.queryByText(proposal.title)).toBeNull(),
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});
	it("uses opaque continuation rather than rendering an unbounded history", async () => {
		const user = userEvent.setup();
		m.list.mockResolvedValue({
			version: 1,
			availability: "AVAILABLE",
			runs: [run],
			nextBefore: "example-bound-cursor",
		});
		show();
		await user.click(
			screen.getByRole("button", { name: "Review signals" }),
		);
		await user.click(screen.getByRole("button", { name: "Run history" }));
		await user.click(
			await screen.findByRole("button", { name: "Older reviews" }),
		);
		await waitFor(() =>
			expect(m.list).toHaveBeenCalledWith({
				projectId,
				before: "example-bound-cursor",
			}),
		);
	});
	it("renders untrusted model content as text, with no executable markup", async () => {
		m.result.mockResolvedValue({
			...detail,
			result: {
				...detail.result,
				proposals: [
					{
						...proposal,
						summary: '<img src=x onerror="window.exampleAttack=1">',
					},
				],
			},
		});
		await openResult();
		expect(
			screen.getByText('<img src=x onerror="window.exampleAttack=1">'),
		).toBeInTheDocument();
		expect(document.querySelector('img[src="x"]')).toBeNull();
	});
	it("clears cached result bodies when the drawer closes", async () => {
		const user = await openResult();
		expect(
			client.getQueryData([...scope, "triage", "result", run.id]),
		).toBeDefined();
		await user.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Close",
			}),
		);
		await waitFor(() =>
			expect(
				client.getQueryData([...scope, "triage", "result", run.id]),
			).toBeUndefined(),
		);
	});
});
