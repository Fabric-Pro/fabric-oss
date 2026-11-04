import en from "@repo/i18n/translations/en.json";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	inspect,
	evaluate,
	download,
	capabilities,
	createRun,
	listRuns,
	getRun,
	cancelRun,
	compareRuns,
} = vi.hoisted(() => ({
	inspect: vi.fn(),
	evaluate: vi.fn(),
	download: vi.fn(),
	capabilities: vi.fn(),
	createRun: vi.fn(),
	listRuns: vi.fn(),
	getRun: vi.fn(),
	cancelRun: vi.fn(),
	compareRuns: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		contextQuality: {
			inspect,
			evaluate,
			runs: {
				capabilities,
				create: createRun,
				list: listRuns,
				get: getRun,
				cancel: cancelRun,
				compare: compareRuns,
			},
		},
	},
}));
vi.mock("../../lib/markdown-to-document", () => ({
	triggerBlobDownload: download,
}));
vi.mock("next-intl", () => ({
	useFormatter: () => ({
		dateTime: (date: Date) => date.toISOString(),
	}),
	useTranslations:
		() => (key: string, values?: Record<string, string | number>) => {
			let message: unknown = en.projects.contexts.quality;
			for (const part of key.split(".")) {
				message = (message as Record<string, unknown>)[part];
			}
			return typeof message === "string"
				? message.replace(/\{(\w+)\}/g, (_, name) =>
						String(values?.[name] ?? name),
					)
				: key;
		},
}));

import { ContextQualityDialog } from "../ContextQualityDialog";

const copy = en.projects.contexts.quality;
const revision = "a".repeat(64);
const sources = [
	{ id: "example-source", title: "Example source", version: "revision-1" },
	{
		id: "example-other-source",
		title: "Other source",
		version: "revision-1",
	},
];

function inspection(sourceId = "example-source") {
	return {
		sourceId,
		sourceKind: "project_context",
		projectId: "example-project",
		organizationId: "example-org",
		title: "Example source",
		content: "Synthetic source text that should not enter a report.",
		revision,
		byteLength: 53,
		indexingExcluded: false,
		readMode: "direct",
	};
}

function report(status = "passed") {
	return {
		version: 1,
		mode: "recorded-output",
		scorerVersion: "fabric-deterministic-context-v1",
		datasetHash: "b".repeat(64),
		configurationHash: "c".repeat(64),
		snapshotHash: "d".repeat(64),
		status,
		counts: {
			cases: 1,
			passed: status === "passed" ? 1 : 0,
			failed: status === "failed" ? 1 : 0,
			integrityFailures: 0,
			qualityFailures: status === "failed" ? 1 : 0,
		},
		sources: [{ id: "example-source", revision }],
		cases: [
			{
				id: "case-1",
				status,
				checks: [
					{
						id: "recorded-answer-present",
						category: "integrity",
						status: "passed",
					},
					{ id: "required-phrases", category: "quality", status },
				],
				retrieval: { precision: 1, recall: 1 },
				citations: { precision: 1, recall: 1 },
			},
		],
		projectId: "example-project",
		organizationId: "example-org",
	};
}

type Props = React.ComponentProps<typeof ContextQualityDialog>;

function setup(overrides: Partial<Props> = {}) {
	const props = {
		projectId: "example-project",
		organizationId: "example-org",
		sources,
		...overrides,
	};
	const view = render(<ContextQualityDialog {...props} />);
	return {
		user: userEvent.setup(),
		rerender: (next: Partial<Props>) =>
			view.rerender(<ContextQualityDialog {...props} {...next} />),
	};
}

async function open(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: copy.trigger }));
	return screen.getByRole("dialog", { name: copy.title });
}

async function selectSource(
	user: ReturnType<typeof userEvent.setup>,
	name = "Example source",
) {
	await user.click(screen.getByRole("combobox", { name: copy.source }));
	await user.click(screen.getByRole("option", { name }));
}

async function inspectSource(user: ReturnType<typeof userEvent.setup>) {
	await selectSource(user);
	await user.click(screen.getByRole("button", { name: copy.inspect }));
	await screen.findByTestId("context-quality-inspection");
}

function fillAnswer(value = "Patients may cancel appointments online.") {
	fireEvent.change(
		screen.getByRole("textbox", { name: copy.recordedAnswer }),
		{ target: { value } },
	);
}

function fillRequiredPhrase() {
	fireEvent.change(screen.getByRole("textbox", { name: copy.required }), {
		target: { value: "Patients" },
	});
}

beforeEach(() => {
	inspect.mockReset().mockResolvedValue(inspection());
	evaluate.mockReset().mockResolvedValue(report());
	download.mockReset();
	capabilities.mockReset().mockResolvedValue({
		configured: true,
		canCreate: true,
		canCancel: true,
		canConfigure: false,
		bindingId: "example-binding",
		reason: null,
	});
	createRun.mockReset().mockResolvedValue({ run: { id: "example-run" } });
	listRuns.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
	getRun.mockReset().mockResolvedValue({
		run: {
			id: "example-run",
			projectId: "example-project",
			organizationId: "example-org",
			name: "Example evaluation",
			status: "QUEUED",
			report: null,
			evidenceAvailable: true,
			sourceRefs: [],
			errorCode: null,
			cleanupStatus: "NOT_REQUIRED",
			remoteRunUrl: null,
			mlflowRunUrl: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			completedAt: null,
		},
	});
	cancelRun.mockReset();
	compareRuns.mockReset();
});

describe("ContextQualityDialog", () => {
	it("requires a substantive expectation and supports phrase-only checks without a citation declaration", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
		expect(screen.getByText(copy.expectationHint)).toBeInTheDocument();
		await user.click(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		);
		expect(screen.getByRole("button", { name: copy.run })).toBeEnabled();
		await user.click(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		);
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.passed);
		expect(evaluate.mock.calls[0][0].evaluation.cases[0]).toMatchObject({
			citedSourceIds: [],
			expectations: {
				expectedSourceIds: [],
				requiredPhrases: ["Patients"],
			},
		});
	});
	it("requires an explicit source inspection and clearly labels the limited check", async () => {
		const { user } = setup();
		const dialog = await open(user);
		expect(within(dialog).getByText(copy.scopeNotice)).toBeInTheDocument();
		expect(within(dialog).getByText(copy.stateless)).toBeInTheDocument();
		fillAnswer();
		fillRequiredPhrase();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
		expect(inspect).not.toHaveBeenCalled();
		await inspectSource(user);
		expect(inspect).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			sourceId: "example-source",
		});
		expect(screen.getByText(revision)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.run })).toBeEnabled();
	});

	it("submits only the pinned reference, recorded answer and explicit expectations", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		fireEvent.change(screen.getByRole("textbox", { name: copy.required }), {
			target: {
				value: "cancel appointments\n\ncancel appointments\n online ",
			},
		});
		fireEvent.change(
			screen.getByRole("textbox", { name: copy.forbidden }),
			{ target: { value: "call the clinic" } },
		);
		await user.click(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		);
		await user.click(screen.getByRole("checkbox", { name: copy.citation }));
		await user.click(screen.getByRole("button", { name: copy.run }));
		expect(evaluate).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			evaluation: {
				version: 1,
				sources: [
					{ sourceId: "example-source", expectedRevision: revision },
				],
				cases: [
					{
						id: "case-1",
						recordedAnswer:
							"Patients may cancel appointments online.",
						retrievedSourceIds: ["example-source"],
						citedSourceIds: ["example-source"],
						expectations: {
							expectedSourceIds: ["example-source"],
							requiredPhrases: ["cancel appointments", "online"],
							forbiddenPhrases: ["call the clinic"],
						},
					},
				],
			},
		});
		await screen.findByText(copy.passed);
		expect(
			screen.getByRole("region", { name: copy.result }),
		).toBeInTheDocument();
		expect(JSON.stringify(evaluate.mock.calls[0])).not.toContain(
			inspection().content,
		);
	});

	it("shows failed checks without labelling a completed request as a pass", async () => {
		evaluate.mockResolvedValueOnce(report("failed"));
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		);
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.failed);
		expect(
			screen.getByText(copy.checks["required-phrases"]),
		).toBeInTheDocument();
		expect(screen.getByText(copy.checkFailed)).toBeInTheDocument();
		expect(
			evaluate.mock.calls[0][0].evaluation.cases[0].citedSourceIds,
		).toEqual([]);
	});

	it("invalidates a result after the recorded answer, phrase or citation changes", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		for (const edit of [
			() => fillAnswer("Updated recorded answer"),
			() =>
				fireEvent.change(
					screen.getByRole("textbox", { name: copy.required }),
					{ target: { value: "Updated" } },
				),
			() =>
				user.click(
					screen.getByRole("checkbox", { name: copy.citation }),
				),
			() =>
				user.click(
					screen.getByRole("checkbox", {
						name: copy.requireCitation,
					}),
				),
		]) {
			await user.click(screen.getByRole("button", { name: copy.run }));
			await screen.findByText(copy.passed);
			await edit();
			expect(
				screen.queryByRole("region", { name: copy.result }),
			).not.toBeInTheDocument();
			expect(
				screen.getByTestId("context-quality-inspection"),
			).toBeInTheDocument();
		}
	});

	it("requires reinspection after selecting another source", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await selectSource(user, "Other source");
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
	});

	it("invalidates evidence when the current source inventory version changes", async () => {
		const { user, rerender } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.passed);
		rerender({
			sources: [{ ...sources[0], version: "revision-2" }, sources[1]],
		});
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: copy.result }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
	});

	it("clears private draft inputs and selected source when the project scope changes", async () => {
		const { user, rerender } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer("Private draft for the first project");
		fillRequiredPhrase();
		fireEvent.change(
			screen.getByRole("textbox", { name: copy.forbidden }),
			{ target: { value: "Private expectation" } },
		);
		await user.click(screen.getByRole("checkbox", { name: copy.citation }));
		await user.click(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		);
		rerender({
			projectId: "example-other-project",
			organizationId: "example-other-org",
		});
		expect(
			screen.getByRole("textbox", { name: copy.recordedAnswer }),
		).toHaveValue("");
		expect(
			screen.getByRole("textbox", { name: copy.required }),
		).toHaveValue("");
		expect(
			screen.getByRole("textbox", { name: copy.forbidden }),
		).toHaveValue("");
		expect(
			screen.getByRole("combobox", { name: copy.source }),
		).toHaveTextContent(copy.chooseSource);
		expect(
			screen.getByRole("checkbox", { name: copy.citation }),
		).not.toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: copy.requireCitation }),
		).not.toBeChecked();
		expect(
			screen.getByRole("button", { name: copy.inspect }),
		).toBeDisabled();
	});

	it("clears a removed source selection while preserving the same-project draft", async () => {
		const { user, rerender } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer("Same project draft");
		rerender({ sources: [sources[1]] });
		expect(
			screen.getByRole("combobox", { name: copy.source }),
		).toHaveTextContent(copy.chooseSource);
		expect(
			screen.getByRole("textbox", { name: copy.recordedAnswer }),
		).toHaveValue("Same project draft");
		expect(
			screen.getByRole("button", { name: copy.inspect }),
		).toBeDisabled();
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
	});

	it.each([
		[{ code: "BAD_REQUEST" }, "errorInvalid"],
		[{ code: "PAYLOAD_TOO_LARGE" }, "errorTooLarge"],
		[new Error("private network detail"), "errorGeneric"],
	] as const)(
		"retains the inspected pin for a recoverable check failure %j",
		async (failure, messageKey) => {
			evaluate.mockRejectedValueOnce(failure);
			const { user } = setup();
			await open(user);
			await inspectSource(user);
			fillAnswer();
			fillRequiredPhrase();
			await user.click(screen.getByRole("button", { name: copy.run }));
			await screen.findByText(copy[messageKey]);
			expect(
				screen.getByTestId("context-quality-inspection"),
			).toBeInTheDocument();
			fillAnswer("Patients may book online.");
			expect(
				screen.queryByText(copy[messageKey]),
			).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: copy.run }));
			await screen.findByText(copy.passed);
			expect(evaluate).toHaveBeenCalledTimes(2);
			expect(evaluate.mock.calls[1][0].evaluation.sources).toEqual([
				{ sourceId: "example-source", expectedRevision: revision },
			]);
		},
	);

	it("clears content after a stale-source failure and requires another inspection", async () => {
		evaluate.mockRejectedValueOnce({
			code: "CONFLICT",
			message: "private provider exception",
		});
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.errorStale);
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
		expect(
			screen.queryByText("private provider exception"),
		).not.toBeInTheDocument();
		fillAnswer("Edited after a stale source refusal");
		expect(screen.getByText(copy.inspectionRequired)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
	});

	it("clears inspected content and shows a safe permission error after revocation", async () => {
		evaluate.mockRejectedValueOnce({
			code: "FORBIDDEN",
			message: "private connection credential",
		});
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.errorDenied);
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(inspection().content),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("private connection credential"),
		).not.toBeInTheDocument();
	});

	it("resets after closing and ignores a late inspection response", async () => {
		let resolve:
			| ((value: ReturnType<typeof inspection>) => void)
			| undefined;
		inspect.mockImplementationOnce(
			() =>
				new Promise((accept) => {
					resolve = accept;
				}),
		);
		const { user } = setup();
		await open(user);
		await selectSource(user);
		await user.click(screen.getByRole("button", { name: copy.inspect }));
		expect(
			screen.getByRole("button", { name: copy.inspecting }),
		).toBeDisabled();
		await user.click(screen.getByRole("button", { name: copy.close }));
		await open(user);
		await act(async () => {
			resolve?.(inspection());
		});
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("textbox", { name: copy.recordedAnswer }),
		).toHaveValue("");
		expect(
			screen.getByRole("combobox", { name: copy.source }),
		).toHaveTextContent(copy.chooseSource);
	});

	it("ignores a late evaluation response after the project scope changes", async () => {
		let resolve: ((value: ReturnType<typeof report>) => void) | undefined;
		evaluate.mockImplementationOnce(
			() =>
				new Promise((accept) => {
					resolve = accept;
				}),
		);
		const { user, rerender } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		rerender({
			projectId: "example-other-project",
			organizationId: "example-other-org",
		});
		await act(async () => {
			resolve?.(report());
		});
		expect(
			screen.queryByRole("region", { name: copy.result }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
	});

	it("downloads the bounded result without raw source, answer or phrase values", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer("Synthetic confidential recorded answer");
		fireEvent.change(screen.getByRole("textbox", { name: copy.required }), {
			target: { value: "Synthetic confidential expectation" },
		});
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.passed);
		await user.click(screen.getByRole("button", { name: copy.download }));
		expect(download).toHaveBeenCalledWith(
			expect.any(Blob),
			"context-quality-report.json",
		);
		const serialized = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = reject;
			reader.readAsText(download.mock.calls[0][0]);
		});
		expect(JSON.parse(serialized)).toEqual(report());
		expect(serialized).not.toContain(inspection().content);
		expect(serialized).not.toContain(
			"Synthetic confidential recorded answer",
		);
		expect(serialized).not.toContain("Synthetic confidential expectation");
	});

	it("enforces phrase bounds before dispatch", async () => {
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		fireEvent.change(screen.getByRole("textbox", { name: copy.required }), {
			target: {
				value: Array.from(
					{ length: 21 },
					(_, index) => `phrase-${index}`,
				).join("\n"),
			},
		});
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
		expect(
			screen.getByRole("textbox", { name: copy.required }),
		).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("textbox", { name: copy.forbidden }),
		).toHaveAttribute("aria-invalid", "false");
		expect(evaluate).not.toHaveBeenCalled();
	});

	it("keeps history available with an empty inventory and disables only a missing organization", async () => {
		const { user, rerender } = setup({ sources: [] });
		expect(
			screen.getByRole("button", { name: copy.trigger }),
		).toBeEnabled();
		await open(user);
		expect(screen.getByText(copy.noSources)).toBeInTheDocument();
		await user.click(screen.getByRole("tab", { name: copy.saved.title }));
		await screen.findByText(copy.saved.empty);
		expect(listRuns).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			limit: 20,
			cursor: undefined,
		});
		await user.click(screen.getByRole("button", { name: copy.close }));
		rerender({ organizationId: null, sources });
		expect(
			screen.getByRole("button", { name: copy.trigger }),
		).toBeDisabled();
	});
});

describe("saved evaluations in ContextQualityDialog", () => {
	it("uses server capabilities rather than a duplicated client role check", async () => {
		capabilities.mockResolvedValueOnce({
			configured: true,
			canCreate: false,
			canCancel: false,
			canConfigure: false,
			reason: "FORBIDDEN",
		});
		const { user } = setup();
		await open(user);
		await screen.findByText(copy.saved.readOnly);
		expect(
			screen.queryByRole("button", { name: copy.saved.create }),
		).not.toBeInTheDocument();
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		expect(screen.getByRole("button", { name: copy.run })).toBeEnabled();
		await user.click(screen.getByRole("tab", { name: copy.saved.title }));
		await screen.findByText(copy.saved.empty);
		expect(createRun).not.toHaveBeenCalled();
		expect(capabilities).toHaveBeenCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
		});
	});

	it("keeps quick checks usable when saved evaluations are unconfigured or unavailable", async () => {
		capabilities.mockRejectedValueOnce(
			new Error("synthetic private provider detail"),
		);
		const { user } = setup();
		await open(user);
		await screen.findByText(copy.saved.capabilityError);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(screen.getByRole("button", { name: copy.run }));
		await screen.findByText(copy.passed);
		expect(
			screen.queryByText("synthetic private provider detail"),
		).not.toBeInTheDocument();
	});

	it("reuses a UUID across ambiguous create retries and opens the saved run on success", async () => {
		createRun.mockRejectedValueOnce(new Error("synthetic provider detail"));
		const { user } = setup();
		await open(user);
		await screen.findByRole("button", { name: copy.saved.create });
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		fireEvent.change(
			screen.getByRole("textbox", { name: copy.saved.nameOptional }),
			{
				target: { value: " Example evaluation " },
			},
		);
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		await screen.findByText(copy.saved.createError);
		expect(
			screen.queryByText("synthetic provider detail"),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		await screen.findByRole("region", { name: copy.saved.details });
		const first = createRun.mock.calls[0][0];
		const second = createRun.mock.calls[1][0];
		expect(first.idempotencyKey).toMatch(
			/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
		);
		expect(second).toEqual(first);
		expect(first).toMatchObject({
			projectId: "example-project",
			organizationId: "example-org",
			bindingId: "example-binding",
			name: "Example evaluation",
			evaluation: {
				sources: [
					{ sourceId: "example-source", expectedRevision: revision },
				],
				cases: [
					{
						recordedAnswer:
							"Patients may cancel appointments online.",
					},
				],
			},
		});
		expect(JSON.stringify(first)).not.toContain(inspection().content);
		expect(evaluate).not.toHaveBeenCalled();
		expect(
			screen.getByRole("tab", { name: copy.saved.title }),
		).toHaveAttribute("aria-selected", "true");
	});

	it("uses a new key after the actual evaluation payload changes", async () => {
		createRun.mockRejectedValue(new Error("synthetic network failure"));
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		await screen.findByText(copy.saved.createError);
		fillAnswer("Patients may reschedule appointments online.");
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		await screen.findByText(copy.saved.createError);
		expect(createRun.mock.calls[1][0].idempotencyKey).not.toBe(
			createRun.mock.calls[0][0].idempotencyKey,
		);
	});

	it("invalidates a stale saved source pin instead of resubmitting it", async () => {
		createRun.mockRejectedValueOnce({
			code: "CONFLICT",
			message: "synthetic private detail",
		});
		const { user } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		await screen.findByText(copy.errorStale);
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.saved.create }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: copy.run })).toBeDisabled();
	});

	it("ignores late saves after the source inventory changes", async () => {
		let finish!: (value: { run: { id: string } }) => void;
		createRun.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { user, rerender } = setup();
		await open(user);
		await inspectSource(user);
		fillAnswer();
		fillRequiredPhrase();
		await user.click(
			screen.getByRole("button", { name: copy.saved.create }),
		);
		rerender({ sources: [{ ...sources[0], version: "revision-2" }] });
		await act(async () => {
			finish({ run: { id: "example-old-run" } });
		});
		expect(
			screen.getByRole("tab", { name: copy.saved.quick }),
		).toHaveAttribute("aria-selected", "true");
		expect(getRun).not.toHaveBeenCalled();
		expect(
			screen.queryByTestId("context-quality-inspection"),
		).not.toBeInTheDocument();
	});

	it("ignores late capabilities from the previous project", async () => {
		let finish!: (value: unknown) => void;
		capabilities.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		capabilities.mockResolvedValueOnce({
			configured: false,
			canCreate: false,
			canCancel: false,
			canConfigure: false,
			reason: "NOT_CONFIGURED",
		});
		const { user, rerender } = setup();
		await open(user);
		rerender({
			projectId: "example-other-project",
			organizationId: "example-other-org",
		});
		await screen.findByText(copy.saved.notConfigured);
		await act(async () => {
			finish({
				configured: true,
				canCreate: true,
				canCancel: true,
				canConfigure: false,
				bindingId: "old-binding",
				reason: null,
			});
		});
		expect(
			screen.queryByRole("button", { name: copy.saved.create }),
		).not.toBeInTheDocument();
		expect(screen.getByText(copy.saved.notConfigured)).toBeInTheDocument();
	});
});
