import en from "@repo/i18n/translations/en.json";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	inspect: vi.fn(),
	evaluate: vi.fn(),
	download: vi.fn(),
	save: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		contextQuality: {
			agentResults: { inspect: m.inspect, evaluate: m.evaluate },
			runs: { create: m.save },
		},
	},
}));
vi.mock("../../lib/markdown-to-document", () => ({
	triggerBlobDownload: m.download,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		(en.projects.contexts.quality.agentResult as Record<string, string>)[
			key
		] ?? key,
}));

import { AgentResultQualityDialog } from "../AgentResultQualityDialog";

const copy = en.projects.contexts.quality.agentResult;
const props = {
	projectId: "example-project",
	organizationId: "example-org",
	executionId: "example-execution",
	improveHref: "/app/example-team/agents/example-agent/edit",
};
const snapshot = {
	revision: "a".repeat(64),
	recordedAnswer: "Example blocker owner is recorded.",
	executionId: props.executionId,
	executionStateSource: "temporal",
};
const checked = {
	status: "passed",
	origin: snapshot,
	expectations: { requiredPhrases: ["owner"], forbiddenPhrases: [] },
	expectationResults: [{ kind: "required", phrase: "owner", passed: true }],
};
beforeEach(() => {
	vi.resetAllMocks();
	m.inspect.mockResolvedValue(snapshot);
	m.evaluate.mockResolvedValue(checked);
});
async function open() {
	await userEvent.click(screen.getByRole("button", { name: copy.trigger }));
	await screen.findByDisplayValue(snapshot.recordedAnswer);
}
describe("actual agent result Quality", () => {
	it("loads no output until asked and never saves or reruns on open", async () => {
		render(<AgentResultQualityDialog {...props} />);
		expect(m.inspect).not.toHaveBeenCalled();
		await open();
		expect(screen.getByLabelText(copy.answer)).toHaveAttribute("readonly");
		expect(screen.getByText(copy.notEvaluated)).toBeVisible();
		expect(m.inspect).toHaveBeenCalledWith({
			projectId: props.projectId,
			organizationId: props.organizationId,
			executionId: props.executionId,
		});
		expect(m.evaluate).not.toHaveBeenCalled();
		expect(m.save).not.toHaveBeenCalled();
	});
	it("submits only an inspected run pin and expectations, then offers an explicit edit", async () => {
		render(<AgentResultQualityDialog {...props} />);
		await open();
		await userEvent.type(screen.getByLabelText(copy.required), "owner");
		await userEvent.click(screen.getByRole("button", { name: copy.check }));
		await screen.findByText(copy.passed);
		expect(m.evaluate).toHaveBeenCalledWith({
			projectId: props.projectId,
			organizationId: props.organizationId,
			executionId: props.executionId,
			expectedRevision: snapshot.revision,
			requiredPhrases: ["owner"],
			forbiddenPhrases: [],
		});
		expect(
			screen.getByRole("link", { name: copy.improve }),
		).toHaveAttribute("href", props.improveHref);
		expect(m.save).not.toHaveBeenCalled();
	});
	it("revalidates the actual result before downloading rather than exporting cached private output", async () => {
		render(<AgentResultQualityDialog {...props} />);
		await open();
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: { value: "owner" },
		});
		await userEvent.click(screen.getByRole("button", { name: copy.check }));
		await screen.findByText(copy.passed);
		m.evaluate.mockRejectedValueOnce(new Error("revoked"));
		await userEvent.click(
			screen.getByRole("button", { name: copy.download }),
		);
		await screen.findByText(copy.error);
		expect(m.evaluate).toHaveBeenCalledTimes(2);
		expect(m.download).not.toHaveBeenCalled();
		expect(
			screen.queryByDisplayValue(snapshot.recordedAnswer),
		).not.toBeInTheDocument();
	});
	it("rejects empty or excessive expectations and invalidates a previous result when edited", async () => {
		render(<AgentResultQualityDialog {...props} />);
		await open();
		expect(screen.getByRole("button", { name: copy.check })).toBeDisabled();
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: {
				value: Array.from({ length: 21 }, (_, i) => `phrase-${i}`).join(
					"\n",
				),
			},
		});
		expect(screen.getByRole("button", { name: copy.check })).toBeDisabled();
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: { value: "owner" },
		});
		await userEvent.click(screen.getByRole("button", { name: copy.check }));
		await screen.findByText(copy.passed);
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: { value: "changed" },
		});
		expect(
			screen.queryByRole("button", { name: copy.download }),
		).not.toBeInTheDocument();
	});
	it("discards late inspection on close and late checks on unmount", async () => {
		let release: (v: unknown) => void = () => {};
		m.inspect.mockImplementationOnce(
			() =>
				new Promise((r) => {
					release = r;
				}),
		);
		const view = render(<AgentResultQualityDialog {...props} />);
		await userEvent.click(
			screen.getByRole("button", { name: copy.trigger }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		await act(async () => release(snapshot));
		expect(
			screen.queryByDisplayValue(snapshot.recordedAnswer),
		).not.toBeInTheDocument();
		await open();
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: { value: "owner" },
		});
		m.evaluate.mockImplementationOnce(
			() =>
				new Promise((r) => {
					release = r;
				}),
		);
		await userEvent.click(screen.getByRole("button", { name: copy.check }));
		view.unmount();
		await act(async () => release(checked));
		expect(m.download).not.toHaveBeenCalled();
	});
	it("guards duplicate submissions while the real result is being verified", async () => {
		render(<AgentResultQualityDialog {...props} />);
		await open();
		fireEvent.change(screen.getByLabelText(copy.required), {
			target: { value: "owner" },
		});
		m.evaluate.mockImplementationOnce(() => new Promise(() => {}));
		const button = screen.getByRole("button", { name: copy.check });
		fireEvent.click(button);
		fireEvent.click(button);
		await waitFor(() => expect(m.evaluate).toHaveBeenCalledOnce());
	});
});
