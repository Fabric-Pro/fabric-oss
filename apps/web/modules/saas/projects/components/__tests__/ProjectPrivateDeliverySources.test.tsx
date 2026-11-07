import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {axe} from "vitest-axe";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.unmock("next-intl");
const m = vi.hoisted(() => ({
	list: vi.fn(),
	inspect: vi.fn(),
	configure: vi.fn(),
	state: vi.fn(),
	capture: vi.fn(),
	status: vi.fn(),
	cancel: vi.fn(),
	observations: vi.fn(),
	evidence: vi.fn(),
	actor: { id: "example-user" },
	organization: {
		organizationId: "example-org",
		basePath: "/app/example-team",
		userRole: "owner" as string | null,
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			deliverySources: {
				list: m.list,
				inspect: m.inspect,
				configure: m.configure,
				state: m.state,
				capture: m.capture,
				status: m.status,
				cancel: m.cancel,
				observations: m.observations,
				evidence: m.evidence,
			},
		},
	},
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: m.actor }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => m.organization,
}));

import { ProjectPrivateDeliverySources } from "../ProjectPrivateDeliverySources";

const copy = messages.deliveryPrivateSources;
const watch = {
	id: "example-watch",
	provider: "SLACK",
	label: "#delivery-example",
	state: "ACTIVE",
	version: 4,
	visibility: "ONLY_ME",
	retentionDays: 7,
	verifiedAt: "2026-11-06T12:00:00Z",
	createdAt: "2026-11-06T12:00:00Z",
	lastRequestId: null,
	lastCaptureInput: null,
	hasMore: false,
};
const connection = {
	id: "example-connection",
	name: "Example Slack connection",
	supportsPrivateCapture: true,
};
const idle = {
	version: 1,
	state: "NOT_STARTED",
	requestId: null,
	coverage: null,
	captured: null,
	hasMore: false,
	message: null,
};
const observation = {
	id: "example-observation",
	capturedAt: "2026-11-06T12:30:00Z",
	expiresAt: "2026-11-13T12:30:00Z",
	change: "UPSERT",
	hasConflict: false,
	coverage: "ROOT_MESSAGES_ONLY",
};
const response = (
	watches: unknown[] = [watch],
	connections: unknown[] = [connection],
) => ({
	version: 1,
	watches,
	connections,
	availability: { state: "ENABLED", reason: null },
});

function view(projectId = "example-project") {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	const tree = (id: string) => (
		<QueryClientProvider client={queryClient}>
			<NextIntlClientProvider locale="en" messages={messages}>
				<ProjectPrivateDeliverySources projectId={id} />
			</NextIntlClientProvider>
		</QueryClientProvider>
	);
	const rendered = render(tree(projectId));
	return {
		...rendered,
		queryClient,
		rerenderProject: (id = projectId) => rendered.rerender(tree(id)),
	};
}
async function openPanel() {
	await waitFor(() => expect(m.list).toHaveBeenCalled());
	await userEvent.click(screen.getByText(copy.title));
}
async function openWatch() {
	await openPanel();
	await userEvent.click(await screen.findByText(watch.label));
	await waitFor(() => expect(m.status).toHaveBeenCalled());
}
async function inspectChannel(
	value = "https://example.slack.com/archives/CEXAMPLE01",
) {
	await openPanel();
	await userEvent.click(screen.getByText(copy.add));
	await userEvent.click(
		screen.getByRole("combobox", { name: copy.connection }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: connection.name }),
	);
	fireEvent.change(screen.getByLabelText(copy.channel), {
		target: { value },
	});
	await userEvent.click(screen.getByRole("button", { name: copy.inspect }));
	await screen.findByText("Access checked: #delivery-example");
}
beforeEach(() => {
	vi.resetAllMocks();
	m.actor.id = "example-user";
	m.organization.organizationId = "example-org";
	m.organization.userRole = "owner";
	m.list.mockResolvedValue(response());
	m.inspect.mockResolvedValue({
		version: 1,
		provider: "SLACK",
		label: watch.label,
		visibility: "ONLY_ME",
		checkedAt: watch.verifiedAt,
		coverage: "ROOT_MESSAGES_ONLY",
	});
	m.configure.mockResolvedValue(watch);
	m.state.mockResolvedValue({ ...watch, state: "PAUSED", version: 5 });
	m.capture.mockResolvedValue({
		...idle,
		state: "RUNNING",
		requestId: "11111111-1111-4111-8111-111111111111",
	});
	m.status.mockResolvedValue(idle);
	m.cancel.mockResolvedValue({ ...idle, state: "CANCELLED" });
	m.observations.mockResolvedValue({
		version: 1,
		items: [],
		nextCursor: null,
	});
	m.evidence.mockResolvedValue({
		version: 1,
		observationId: observation.id,
		text: "<script>example literal message</script>",
		capturedAt: observation.capturedAt,
		checkedAt: observation.capturedAt,
		coverage: "ROOT_MESSAGES_ONLY",
		visibility: "ONLY_ME",
	});
});

afterEach(() => {
	vi.useRealTimers();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

describe("private Delivery source capture", () => {
	it("starts collapsed, makes no capture request, and offers real connection setup when none qualify", async () => {
		m.list.mockResolvedValue(
			response([], [{ ...connection, supportsPrivateCapture: false }]),
		);
		view();
		const summary = screen.getByText(copy.title);
		expect(summary.closest("details")).not.toHaveAttribute("open");
		await openPanel();
		expect(await screen.findByText(copy.noConnections)).toBeVisible();
		expect(
			screen.getByRole("link", { name: copy.connections }),
		).toHaveAttribute("href", "/app/example-team/connections");
		expect(screen.queryByText(copy.add)).not.toBeInTheDocument();
		expect(m.capture).not.toHaveBeenCalled();
	});
	it("checks the named channel before consent and reuses an uncertain configuration request", async () => {
		m.configure
			.mockRejectedValueOnce(new Error("private token details"))
			.mockResolvedValueOnce(watch);
		view();
		await inspectChannel();
		expect(m.inspect).toHaveBeenCalledWith({
			projectId: "example-project",
			integrationId: connection.id,
			channelId: "CEXAMPLE01",
		});
		expect(
			screen.getByRole("button", { name: copy.connect }),
		).toBeDisabled();
		expect(screen.getByText(copy.consentScope)).toBeVisible();
		await userEvent.click(
			screen.getByRole("checkbox", { name: copy.consent }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.connect }),
		);
		await screen.findByRole("alert");
		expect(
			screen.queryByText("private token details"),
		).not.toBeInTheDocument();
		const first = m.configure.mock.calls[0][0];
		expect(first).toMatchObject({
			retentionDays: 7,
			channelId: "CEXAMPLE01",
		});
		expect(first.requestId).toMatch(/^[a-f0-9-]{36}$/);
		await userEvent.click(
			screen.getByRole("button", { name: copy.retryAction }),
		);
		await waitFor(() => expect(m.configure).toHaveBeenCalledTimes(2));
		expect(m.configure.mock.calls[1][0]).toEqual(first);
		expect(m.capture).not.toHaveBeenCalled();
	});
	it("rejects lookalike Slack URLs and invalidates proof when the channel changes", async () => {
		view();
		await inspectChannel();
		fireEvent.change(screen.getByLabelText(copy.channel), {
			target: {
				value: "https://example.slack.com.evil.example/archives/CEXAMPLE01",
			},
		});
		expect(
			screen.getByRole("button", { name: copy.inspect }),
		).toBeDisabled();
		expect(
			screen.queryByRole("checkbox", { name: copy.consent }),
		).not.toBeInTheDocument();
		expect(m.configure).not.toHaveBeenCalled();
	});
	it("hides only this optional panel after a permission refusal without showing raw errors", async () => {
		m.list.mockRejectedValue({
			code: "FORBIDDEN",
			message: "private source names",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		view();
		await waitFor(() =>
			expect(screen.queryByText(copy.title)).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByText("private source names"),
		).not.toBeInTheDocument();
		expect(m.inspect).not.toHaveBeenCalled();
	});
	it("preserves the exact capture request across a lost acknowledgment", async () => {
		m.capture
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValueOnce({ ...idle, state: "RUNNING" });
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.capture }),
		);
		await screen.findByRole("alert");
		expect(m.capture).toHaveBeenCalledTimes(1);
		const first = m.capture.mock.calls[0][0];
		expect(first).toMatchObject({
			projectId: "example-project",
			watchId: watch.id,
			expectedVersion: 4,
			mode: "RECENT",
		});
		await userEvent.click(
			screen.getByRole("button", { name: copy.retryAction }),
		);
		await waitFor(() => expect(m.capture).toHaveBeenCalledTimes(2));
		expect(m.capture.mock.calls[1][0]).toEqual(first);
	});
	it("replays durable capture input after reload without reconstructing mode or version", async () => {
		const input = {
			requestId: "22222222-2222-4222-8222-222222222222",
			mode: "CONTINUE",
			expectedVersion: 2,
		};
		m.list.mockResolvedValue(
			response([
				{
					...watch,
					version: 9,
					lastRequestId: input.requestId,
					lastCaptureInput: input,
				},
			]),
		);
		m.status.mockResolvedValue({
			...idle,
			state: "OUTCOME_UNKNOWN",
			requestId: input.requestId,
		});
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.retryLast }),
		);
		expect(m.capture).toHaveBeenCalledWith({
			projectId: "example-project",
			watchId: watch.id,
			...input,
		});
	});
	it("uses versioned pause and makes disconnect an explicit destructive confirmation", async () => {
		view();
		await openWatch();
		await userEvent.click(screen.getByRole("button", { name: copy.pause }));
		await waitFor(() => expect(m.state).toHaveBeenCalled());
		expect(m.state.mock.calls[0][0]).toMatchObject({
			watchId: watch.id,
			expectedVersion: 4,
			action: "PAUSE",
		});
		await userEvent.click(
			screen.getByRole("button", { name: copy.disconnect }),
		);
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(copy.disconnectBody);
		expect(m.state).toHaveBeenCalledTimes(1);
		await userEvent.click(
			within(dialog).getByRole("button", { name: copy.disconnect }),
		);
		await waitFor(() => expect(m.state).toHaveBeenCalledTimes(2));
		expect(m.state.mock.calls[1][0]).toMatchObject({
			action: "DISCONNECT",
			expectedVersion: 4,
		});
	});
	it("lists metadata only and fetches literal text through the fresh evidence command", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		view();
		await openWatch();
		expect(m.evidence).not.toHaveBeenCalled();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(
			await within(dialog).findByText(
				"<script>example literal message</script>",
			),
		).toBeInTheDocument();
		expect(dialog.querySelector("script")).toBeNull();
		expect(dialog).toHaveTextContent(copy.evidenceScope);
		expect(m.evidence).toHaveBeenCalledWith(
			{
				projectId: "example-project",
				watchId: watch.id,
				observationId: observation.id,
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});
	it("pages observation metadata with the server cursor and a fixed page limit", async () => {
		m.observations
			.mockResolvedValueOnce({
				version: 1,
				items: [observation],
				nextCursor: "example-next",
			})
			.mockResolvedValueOnce({
				version: 1,
				items: [{ ...observation, id: "example-older" }],
				nextCursor: null,
			});
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.more }),
		);
		await waitFor(() => expect(m.observations).toHaveBeenCalledTimes(2));
		expect(m.observations.mock.calls[1][0]).toMatchObject({
			cursor: "example-next",
			limit: 20,
		});
	});
	it("clears the drawer and old private query cache on actor, organization and project switch", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const rendered = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		m.actor.id = "example-other-user";
		m.organization.organizationId = "example-other-org";
		m.list.mockResolvedValue(response([], []));
		rendered.rerenderProject("example-other-project");
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByText("<script>example literal message</script>"),
		).not.toBeInTheDocument();
		expect(
			rendered.queryClient
				.getQueryCache()
				.getAll()
				.some((query) => query.queryKey.includes("example-user")),
		).toBe(false);
	});
	it("captures the next bounded batch and cancels a running request with its own retry key", async () => {
		m.list.mockResolvedValue(response([{ ...watch, hasMore: true }]));
		m.status
			.mockResolvedValueOnce(idle)
			.mockResolvedValue({ ...idle, state: "RUNNING" });
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.continue }),
		);
		expect(m.capture.mock.calls[0][0]).toMatchObject({
			mode: "CONTINUE",
			expectedVersion: watch.version,
		});
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: copy.cancelCapture }),
			).toBeEnabled(),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.cancelCapture }),
		);
		await waitFor(() => expect(m.cancel).toHaveBeenCalledTimes(1));
		expect(m.cancel.mock.calls[0][0]).toMatchObject({
			projectId: "example-project",
			watchId: watch.id,
		});
		expect(m.cancel.mock.calls[0][0].requestId).toMatch(/^[a-f0-9-]{36}$/);
	});
	it("resumes a paused source explicitly and does not offer capture while paused", async () => {
		m.list.mockResolvedValue(response([{ ...watch, state: "PAUSED" }]));
		view();
		await openWatch();
		expect(
			screen.queryByRole("button", { name: copy.capture }),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.resume }),
		);
		expect(m.state.mock.calls[0][0]).toMatchObject({
			action: "RESUME",
			expectedVersion: watch.version,
		});
	});
	it("offers 30-day retention only as an explicit choice before connecting", async () => {
		view();
		await inspectChannel();
		await userEvent.click(
			screen.getByRole("combobox", { name: copy.retention }),
		);
		await userEvent.click(screen.getByRole("option", { name: "30 days" }));
		await userEvent.click(
			screen.getByRole("checkbox", { name: copy.consent }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.connect }),
		);
		await waitFor(() => expect(m.configure).toHaveBeenCalled());
		expect(m.configure.mock.calls[0][0].retentionDays).toBe(30);
	});

	it("removes private content when fresh source authorization is refused", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		m.evidence.mockRejectedValue({
			code: "FORBIDDEN",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await waitFor(() =>
			expect(screen.queryByText(copy.title)).not.toBeInTheDocument(),
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
	it.each(["NOT_ENABLED", "STORAGE_UNAVAILABLE"] as const)(
		"shows quiet unavailable state %s without capture actions or a false empty source list",
		async (reason) => {
			m.list.mockResolvedValue({
				...response(),
				availability: { state: "UNAVAILABLE", reason },
			});
			view();
			await openPanel();
			expect(
				await screen.findByText(
					reason === "NOT_ENABLED"
						? copy.notEnabled
						: copy.storageUnavailable,
				),
			).toBeVisible();
			expect(
				screen.queryByText(copy.noConnections),
			).not.toBeInTheDocument();
			expect(screen.queryByText(watch.label)).not.toBeInTheDocument();
			expect(screen.queryByText(copy.add)).not.toBeInTheDocument();
			expect(
				screen.getByRole("link", { name: copy.connections }),
			).toBeVisible();
			expect(m.status).not.toHaveBeenCalled();
			expect(m.inspect).not.toHaveBeenCalled();
		},
	);
	it("withholds connection management when the current organization role does not grant connect", async () => {
		m.organization.userRole = "viewer";
		m.list.mockResolvedValue({
			...response([], []),
			availability: { state: "UNAVAILABLE", reason: "NOT_ENABLED" },
		});
		view();
		await openPanel();
		await screen.findByText(copy.notEnabled);
		expect(
			screen.queryByRole("link", { name: copy.connections }),
		).not.toBeInTheDocument();
	});
	it("does not enter an organization-less private capture context", () => {
		m.organization.organizationId = "";
		view();
		expect(screen.queryByText(copy.title)).not.toBeInTheDocument();
		expect(m.list).not.toHaveBeenCalled();
	});
	it("removes loaded private sources when list availability changes", async () => {
		const { queryClient } = view();
		await openWatch();
		m.list.mockResolvedValue({
			...response(),
			availability: {
				state: "UNAVAILABLE",
				reason: "STORAGE_UNAVAILABLE",
			},
		});
		await act(async () => {
			await queryClient.refetchQueries({
				predicate: (q) => q.queryKey.at(-1) === "list",
			});
		});
		expect(await screen.findByText(copy.storageUnavailable)).toBeVisible();
		expect(screen.queryByText(watch.label)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.capture }),
		).not.toBeInTheDocument();
	});
	it("withholds previously loaded evidence during a fresh check and on a network failure", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const { queryClient } = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		let reject!: (reason: unknown) => void;
		m.evidence.mockImplementationOnce(
			() =>
				new Promise((_resolve, rejectRequest) => {
					reject = rejectRequest;
				}),
		);
		let pending!: Promise<unknown>;
		await act(async () => {
			pending = queryClient.refetchQueries({
				predicate: (q) => q.queryKey.includes("evidence"),
			});
		});
		await waitFor(() =>
			expect(
				screen.queryByText("<script>example literal message</script>"),
			).not.toBeInTheDocument(),
		);
		await act(async () => {
			reject(new Error("source network unavailable"));
			await pending;
		});
		expect(
			screen.queryByText("<script>example literal message</script>"),
		).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("dialog")).toHaveTextContent(copy.error),
		);
	});
	it("closes evidence when another fresh private-source query is unavailable", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const { queryClient } = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		m.status.mockRejectedValue(new Error("native service unavailable"));
		await act(async () => {
			await queryClient.refetchQueries({
				predicate: (q) => q.queryKey.at(-1) === "status",
			});
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByText("<script>example literal message</script>"),
		).not.toBeInTheDocument();
	});
	it("drops an open drawer when the source configuration version changes", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const { queryClient } = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		m.list.mockResolvedValue(response([{ ...watch, version: 5 }]));
		await act(async () => {
			await queryClient.refetchQueries({
				predicate: (q) => q.queryKey.at(-1) === "list",
			});
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});
	it("retries the exact cancellation request when native cancellation is unconfirmed", async () => {
		m.status.mockResolvedValue({ ...idle, state: "RUNNING" });
		m.cancel.mockResolvedValue({ ...idle, state: "OUTCOME_UNKNOWN" });
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.cancelCapture }),
		);
		await screen.findByText(copy.uncertain);
		const first = m.cancel.mock.calls[0][0];
		expect(
			screen.queryByText(copy.runStates.CANCELLED),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.retryAction }),
		);
		await waitFor(() => expect(m.cancel).toHaveBeenCalledTimes(2));
		expect(m.cancel.mock.calls[1][0]).toEqual(first);
	});
	it.each(["actor", "organization", "project"] as const)(
		"clears private text and old query data when only %s changes",
		async (changed) => {
			m.observations.mockResolvedValue({
				version: 1,
				items: [observation],
				nextCursor: null,
			});
			const rendered = view();
			await openWatch();
			await userEvent.click(
				await screen.findByRole("button", { name: /Captured message/ }),
			);
			await screen.findByText("<script>example literal message</script>");
			if (changed === "actor") {
				m.actor.id = "example-other-user";
			}
			if (changed === "organization") {
				m.organization.organizationId = "example-other-org";
			}
			m.list.mockResolvedValue(response([], []));
			rendered.rerenderProject(
				changed === "project"
					? "example-other-project"
					: "example-project",
			);
			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(
				rendered.queryClient
					.getQueryCache()
					.getAll()
					.some((q) => q.queryKey.includes("evidence")),
			).toBe(false);
		},
	);
	it("purges already loaded evidence when a subsequent fresh source check denies access", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const { queryClient } = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		m.evidence.mockRejectedValue({
			code: "FORBIDDEN",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		await act(async () => {
			await queryClient.refetchQueries({
				predicate: (q) => q.queryKey.includes("evidence"),
			});
		});
		await waitFor(() =>
			expect(screen.queryByText(copy.title)).not.toBeInTheDocument(),
		);
		// The mounted disabled list observer can recreate an empty query, never private data.
		expect(
			queryClient
				.getQueryCache()
				.getAll()
				.every((query) => query.state.data === undefined),
		).toBe(true);
		expect(
			queryClient
				.getQueryCache()
				.getAll()
				.some((query) => query.queryKey.includes("evidence")),
		).toBe(false);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
	it("keeps the checked evidence drawer stable during an unrelated native status poll", async () => {
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		const { queryClient } = view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: /Captured message/ }),
		);
		await screen.findByText("<script>example literal message</script>");
		let resolve!: (value: typeof idle) => void;
		m.status.mockImplementationOnce(
			() =>
				new Promise((resolveRequest) => {
					resolve = resolveRequest;
				}),
		);
		let pending!: Promise<unknown>;
		await act(async () => {
			pending = queryClient.refetchQueries({
				predicate: (q) => q.queryKey.at(-1) === "status",
			});
		});
		await waitFor(() => expect(m.status).toHaveBeenCalledTimes(2));
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(
			screen.getByText("<script>example literal message</script>"),
		).toBeVisible();
		await act(async () => {
			resolve(idle);
			await pending;
		});
		expect(m.evidence).toHaveBeenCalledTimes(1);
	});
	async function startTimedStatus(run: typeof idle) {
		// Keep observer notifications on microtasks while asserting exact fake timer delays.
		notifyManager.setScheduler((callback) => {
			void Promise.resolve().then(callback);
		});
		m.status.mockResolvedValueOnce(idle).mockResolvedValue(run);
		const rendered = view();
		await openWatch();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: copy.capture }),
			).toBeEnabled(),
		);
		vi.useFakeTimers();
		await act(async () => {
			rendered.queryClient.setQueriesData(
				{ predicate: (q) => q.queryKey.at(-1) === "status" },
				run,
			);
			await vi.advanceTimersByTimeAsync(0);
		});
		return rendered;
	}
	async function advanceStatus(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}
	it("backs off unknown status, stops after six reads, and rechecks only on explicit request", async () => {
		await startTimedStatus({ ...idle, state: "OUTCOME_UNKNOWN" });
		expect(m.status).toHaveBeenCalledTimes(1);
		for (const [index, delay] of [
			2000, 5000, 10000, 20000, 30000,
		].entries()) {
			await advanceStatus(delay - 1);
			expect(m.status).toHaveBeenCalledTimes(index + 1);
			await advanceStatus(1);
			expect(m.status).toHaveBeenCalledTimes(index + 2);
		}
		expect(screen.getByText(copy.pollingPaused)).toBeVisible();
		expect(screen.getByText(copy.unknownGuidance)).toBeVisible();
		expect(
			screen.getByRole("button", { name: copy.capture }),
		).toBeDisabled();
		await advanceStatus(3 * 60 * 60 * 1000);
		expect(m.status).toHaveBeenCalledTimes(6);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: copy.recheckStatus }),
			);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(m.status).toHaveBeenCalledTimes(7);
		expect(screen.queryByText(copy.pollingPaused)).not.toBeInTheDocument();
		await advanceStatus(2000);
		expect(m.status).toHaveBeenCalledTimes(8);
		expect(m.capture).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("keeps active progress updates and stops polling when native completion is confirmed", async () => {
		await startTimedStatus({ ...idle, state: "RUNNING" });
		m.status
			.mockResolvedValueOnce({ ...idle, state: "RUNNING" })
			.mockResolvedValue({ ...idle, state: "COMPLETED", captured: 1 });
		await advanceStatus(2000);
		expect(screen.getByText(copy.runStates.RUNNING)).toBeVisible();
		await advanceStatus(5000);
		expect(screen.getByText(/Capture completed/)).toBeVisible();
		await advanceStatus(60 * 60 * 1000);
		expect(m.status).toHaveBeenCalledTimes(3);
		expect(m.capture).not.toHaveBeenCalled();
	});
	it("stops automatic polling after an unavailable status response", async () => {
		await startTimedStatus({ ...idle, state: "RUNNING" });
		m.status.mockRejectedValue(new Error("example-status-unavailable"));
		await advanceStatus(2000);
		expect(screen.getByRole("alert")).toHaveTextContent(copy.error);
		await advanceStatus(60 * 60 * 1000);
		expect(m.status).toHaveBeenCalledTimes(2);
		expect(
			screen.getByRole("button", { name: copy.capture }),
		).toBeDisabled();
	});
	it("resets the bounded status budget when a different durable capture request is selected", async () => {
		const rendered = await startTimedStatus({
			...idle,
			state: "OUTCOME_UNKNOWN",
		});
		for (const delay of [2000, 5000, 10000, 20000, 30000]) {
			await advanceStatus(delay);
		}
		expect(m.status).toHaveBeenCalledTimes(6);
		const next = "44444444-4444-4444-8444-444444444444";
		m.list.mockResolvedValue(response([{ ...watch, lastRequestId: next }]));
		m.status.mockResolvedValue({
			...idle,
			state: "RUNNING",
			requestId: next,
		});
		await act(async () => {
			await rendered.queryClient.refetchQueries({
				predicate: (q) => q.queryKey.at(-1) === "list",
			});
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(m.status).toHaveBeenCalledTimes(7);
		await advanceStatus(2000);
		expect(m.status).toHaveBeenCalledTimes(8);
		expect(screen.queryByText(copy.pollingPaused)).not.toBeInTheDocument();
	});
	it("allows only an explicit new UUID after server-qualified recovery and retains saved observations", async () => {
		const previous = {
			requestId: "55555555-5555-4555-8555-555555555555",
			expectedVersion: watch.version,
			mode: "RECENT",
		};
		m.list.mockResolvedValue(
			response([
				{
					...watch,
					lastRequestId: previous.requestId,
					lastCaptureInput: previous,
				},
			]),
		);
		m.status.mockResolvedValue({
			...idle,
			state: "OUTCOME_UNKNOWN",
			requestId: previous.requestId,
			canStartNewCapture: true,
		});
		m.observations.mockResolvedValue({
			version: 1,
			items: [observation],
			nextCursor: null,
		});
		m.capture.mockImplementation(async (input) => {
			m.list.mockResolvedValue(
				response([
					{
						...watch,
						lastRequestId: input.requestId,
						lastCaptureInput: input,
					},
				]),
			);
			const run = {
				...idle,
				state: "RUNNING",
				requestId: input.requestId,
			};
			m.status.mockResolvedValue(run);
			return run;
		});
		view();
		await openWatch();
		expect(
			await screen.findByText(copy.unknownRecoveredGuidance),
		).toBeVisible();
		expect(
			screen.queryByRole("button", { name: copy.retryLast }),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.capture }),
		);
		await waitFor(() => expect(m.capture).toHaveBeenCalledTimes(1));
		expect(m.capture.mock.calls[0][0].requestId).not.toBe(
			previous.requestId,
		);
		expect(m.capture.mock.calls[0][0]).toMatchObject({
			expectedVersion: watch.version,
			mode: "RECENT",
		});
		expect(
			await screen.findByRole("button", { name: /Captured message/ }),
		).toBeVisible();
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("clears a consumed recovery flag after a new request loses acknowledgment and retries that exact new request", async () => {
		m.status.mockResolvedValue({
			...idle,
			state: "OUTCOME_UNKNOWN",
			requestId: "66666666-6666-4666-8666-666666666666",
			canStartNewCapture: true,
		});
		m.capture.mockRejectedValue(new Error("example-lost-acknowledgement"));
		view();
		await openWatch();
		await screen.findByText(copy.unknownRecoveredGuidance);
		await userEvent.click(
			screen.getByRole("button", { name: copy.capture }),
		);
		await screen.findByText(copy.uncertain);
		const request = m.capture.mock.calls[0][0];
		expect(
			screen.getByRole("button", { name: copy.capture }),
		).toBeDisabled();
		expect(
			screen.queryByText(copy.unknownRecoveredGuidance),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.retryAction }),
		);
		await waitFor(() => expect(m.capture).toHaveBeenCalledTimes(2));
		expect(m.capture.mock.calls[1][0]).toEqual(request);
	});
	it("releases an unconfirmed cancel intent only when the server qualifies new capture", async () => {
		m.status.mockResolvedValue({ ...idle, state: "OUTCOME_UNKNOWN" });
		m.cancel.mockImplementation(async () => {
			const run = {
				...idle,
				state: "OUTCOME_UNKNOWN",
				canStartNewCapture: true,
			};
			m.status.mockResolvedValue(run);
			return run;
		});
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.cancelCapture }),
		);
		await screen.findByText(copy.unknownRecoveredGuidance);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: copy.capture }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByText(copy.runStates.CANCELLED),
		).not.toBeInTheDocument();
		expect(m.capture).not.toHaveBeenCalled();
	});
	it("describes access expiry separately from later physical cleanup", async () => {
		view();
		await openWatch();
		expect(
			screen.getByText(
				/Access expires after 7 days. Stored text is deleted later only when cleanup is configured/,
			),
		).toBeVisible();
	});
	it.each([undefined, false])(
		"does not infer recovery permission from unknown state when the server grant is %s",
		async (canStartNewCapture) => {
			m.status.mockResolvedValue({
				...idle,
				state: "OUTCOME_UNKNOWN",
				canStartNewCapture,
			});
			view();
			await openWatch();
			await screen.findByText(copy.unknownGuidance);
			expect(
				screen.getByRole("button", { name: copy.capture }),
			).toBeDisabled();
			expect(
				screen.getByRole("button", { name: copy.recheckStatus }),
			).toBeEnabled();
			expect(m.capture).not.toHaveBeenCalled();
			expect(m.cancel).not.toHaveBeenCalled();
		},
	);
	it("rechecks an unconfirmed cancellation and releases controls after verified native completion without claiming cancellation", async () => {
		m.status.mockResolvedValue({ ...idle, state: "RUNNING" });
		m.cancel.mockResolvedValue({ ...idle, state: "OUTCOME_UNKNOWN" });
		view();
		await openWatch();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.cancelCapture }),
		);
		await screen.findByText(copy.uncertain);
		m.status.mockResolvedValue({ ...idle, state: "COMPLETED" });
		await userEvent.click(
			screen.getByRole("button", { name: copy.recheckStatus }),
		);
		await screen.findByText(copy.runStates.COMPLETED);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: copy.capture }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByText(copy.runStates.CANCELLED),
		).not.toBeInTheDocument();
		expect(screen.queryByText(copy.uncertain)).not.toBeInTheDocument();
		expect(m.capture).not.toHaveBeenCalled();
	});
});

describe("bounded history capture UX", () => {
	it("keeps history behind a disclosure and submits local-time dates as one fixed UTC intent", async () => {
		view();
		await openWatch();
		expect(
			screen.getByText(copy.historyTitle).closest("details"),
		).not.toHaveAttribute("open");
		await userEvent.click(screen.getByText(copy.historyTitle));
		const from = new Date(Date.now() - 30 * 86400000);
		const to = new Date(Date.now() - 29 * 86400000);
		const local = (date: Date) =>
			new Date(date.getTime() - date.getTimezoneOffset() * 60000)
				.toISOString()
				.slice(0, 16);
		fireEvent.change(screen.getByLabelText(copy.historyFrom), {
			target: { value: local(from) },
		});
		fireEvent.change(screen.getByLabelText(copy.historyTo), {
			target: { value: local(to) },
		});
		await userEvent.click(
			screen.getByRole("button", { name: copy.historyCapture }),
		);
		expect(m.capture).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "BACKFILL",
				window: {
					start: new Date(local(from)).toISOString(),
					end: new Date(local(to)).toISOString(),
				},
			}),
		);
	});
	it("explains invalid history bounds and prevents submission", async () => {
		view();
		await openWatch();
		await userEvent.click(screen.getByText(copy.historyTitle));
		fireEvent.change(screen.getByLabelText(copy.historyFrom), {
			target: { value: "2026-01-01T12:00" },
		});
		fireEvent.change(screen.getByLabelText(copy.historyTo), {
			target: { value: "2026-11-01T12:00" },
		});
		expect(
			screen.getByRole("button", { name: copy.historyCapture }),
		).toBeDisabled();
		expect(screen.getByText(copy.historyInvalid)).toHaveAttribute(
			"role",
			"alert",
		);
		expect(m.capture).not.toHaveBeenCalled();
	});
});

it("refreshes persisted window coverage when an asynchronous capture completes",async()=>{
 const rendered=view();await openWatch();const before=m.list.mock.calls.length;
 m.list.mockResolvedValue(response([{...watch,captureWindow:{start:"2026-10-05T00:00:00.000Z",end:"2026-10-07T00:00:00.000Z",complete:true}}]));
 await act(async()=>{rendered.queryClient.setQueriesData({predicate:q=>q.queryKey.at(-1)==="status"},{version:1,state:"COMPLETED",requestId:"11111111-1111-4111-8111-111111111111",coverage:"ROOT_MESSAGES_ONLY",captured:1,hasMore:false,message:null});});
 await waitFor(()=>expect(m.list.mock.calls.length).toBeGreaterThan(before));
 expect(await screen.findByText(/Window exhausted/)).toBeVisible();
});

it("provides accessible selected-history controls",async()=>{
 const rendered=view();await openWatch();await userEvent.click(screen.getByText(copy.historyTitle));
 expect((await axe(rendered.container)).violations).toEqual([]);
});
