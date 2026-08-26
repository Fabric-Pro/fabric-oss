/**
 * Behaviour tests for the "Run tests" dialog.
 *
 * Every case here exists because the behaviour broke once. The dialog derives
 * its form state from a react-query result, and react-query hands back a FRESH
 * array identity on every refetch — refetching on window focus by default. Any
 * state keyed on that identity is therefore rewritten the moment the user
 * alt-tabs away and back, which is precisely when they are least expecting it.
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so translated strings
 * surface as their keys ("refLabel", "start", ...).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Source = {
	integrationId: string;
	provider: string;
	owner: string;
	repo: string;
	defaultRef: string;
	kind: "definition" | "ref" | "unsupported";
	pipelines: { id: string; name: string }[];
	error: string | null;
};

let sourcesData: Source[] | undefined;
let triggerOutcome: unknown;
const mutateSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: sourcesData,
		isLoading: false,
		isError: false,
	}),
	useMutation: (opts: { onSuccess?: (r: unknown) => void }) => ({
		mutate: (vars: unknown) => {
			mutateSpy(vars);
			opts.onSuccess?.(triggerOutcome);
		},
		isPending: false,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				triggerable: { queryOptions: (o: unknown) => o },
				trigger: { mutationOptions: (o: unknown) => o },
				listRuns: { key: () => ["listRuns"] },
				syncStates: { key: () => ["syncStates"] },
			},
		},
	},
}));

const { TriggerRunDialog } = await import("../TriggerRunDialog");

/** A GitLab-shaped source: runs a ref, so there is no pipeline to pick. */
function gitlabSource(defaultRef = "main"): Source {
	return {
		integrationId: "int-1",
		provider: "GITLAB",
		owner: "acme",
		repo: "store",
		defaultRef,
		kind: "ref",
		pipelines: [],
		error: null,
	};
}

function renderDialog() {
	return render(
		<TriggerRunDialog
			projectId="p1"
			open={true}
			onOpenChange={() => undefined}
			onTriggered={() => undefined}
		/>,
	);
}

const refInput = () => screen.getByLabelText("refLabel") as HTMLInputElement;

beforeEach(() => {
	vi.clearAllMocks();
	sourcesData = [gitlabSource()];
	triggerOutcome = { ok: true, runId: "9", runUrl: null };
});

describe("TriggerRunDialog", () => {
	it("pre-fills the ref with the branch QA already watches", () => {
		sourcesData = [gitlabSource("release/2.0")];
		renderDialog();

		expect(refInput().value).toBe("release/2.0");
	});

	it("does NOT overwrite a typed ref when the sources query refetches", async () => {
		// The regression: priming was keyed on the source OBJECT, so a background
		// refetch — window focus is enough — silently replaced what the user typed
		// with the repo default.
		const user = userEvent.setup();
		const { rerender } = renderDialog();

		await user.clear(refInput());
		await user.type(refInput(), "my-feature-branch");
		expect(refInput().value).toBe("my-feature-branch");

		// A refetch: same content, brand-new array and object identity.
		sourcesData = [gitlabSource()];
		rerender(
			<TriggerRunDialog
				projectId="p1"
				open={true}
				onOpenChange={() => undefined}
				onTriggered={() => undefined}
			/>,
		);

		expect(refInput().value).toBe("my-feature-branch");
	});

	it("keeps a refusal on screen across a refetch", async () => {
		// The refusal is returned as data specifically so the user can leave it on
		// screen, go and add `workflow_dispatch:` to their workflow, and come back
		// to it. Clearing on refetch deleted the instructions at the exact moment
		// window focus returned — i.e. when they came back to read them.
		triggerOutcome = {
			ok: false,
			failure: "NOT_DISPATCHABLE",
			message: "Add workflow_dispatch: under on:",
		};
		const user = userEvent.setup();
		const { rerender } = renderDialog();

		await user.click(screen.getByRole("button", { name: "start" }));
		expect(
			screen.getByText("Add workflow_dispatch: under on:"),
		).toBeInTheDocument();

		sourcesData = [gitlabSource()];
		rerender(
			<TriggerRunDialog
				projectId="p1"
				open={true}
				onOpenChange={() => undefined}
				onTriggered={() => undefined}
			/>,
		);

		expect(
			screen.getByText("Add workflow_dispatch: under on:"),
		).toBeInTheDocument();
	});

	it("drops a stale success panel once the form is edited", async () => {
		// A green "Run started" sitting above a form the user has since changed
		// reads as confirmation of a run that was never started.
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("button", { name: "start" }));
		expect(screen.getByText("startedTitle")).toBeInTheDocument();

		await user.type(refInput(), "-x");

		expect(screen.queryByText("startedTitle")).not.toBeInTheDocument();
	});

	it("sends the trimmed ref and the real integration id", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.clear(refInput());
		await user.type(refInput(), "  develop  ");
		await user.click(screen.getByRole("button", { name: "start" }));

		expect(mutateSpy).toHaveBeenCalledWith({
			projectId: "p1",
			integrationId: "int-1",
			ref: "develop",
		});
	});

	it("refuses a ref the server would reject, without a round trip", async () => {
		// The server's refSchema rejects internal whitespace and `..`. Letting the
		// client send them anyway spends a request to be told, and the answer
		// arrives styled as a provider failure — which it is not.
		const user = userEvent.setup();
		renderDialog();

		await user.clear(refInput());
		await user.type(refInput(), "release build");
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();

		await user.clear(refInput());
		await user.type(refInput(), "../main");
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();

		await user.clear(refInput());
		await user.type(refInput(), "release/2.0");
		expect(screen.getByRole("button", { name: "start" })).toBeEnabled();
	});

	it("refuses a ref longer than the server's 255-character bound", async () => {
		// The client checked whitespace and `..` but not length, so a long ref
		// still cost a round trip to be rejected.
		const user = userEvent.setup();
		renderDialog();

		await user.clear(refInput());
		// `paste` rather than `type` — 256 keystrokes is needlessly slow.
		await user.click(refInput());
		await user.paste("a".repeat(256));

		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});

	it("cannot be started with an empty ref", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.clear(refInput());

		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});

	it("blocks starting a source Fabric cannot trigger, and explains why", () => {
		sourcesData = [
			{
				...gitlabSource(),
				kind: "unsupported",
				error: "Could not determine the GitLab project path.",
			},
		];
		renderDialog();

		expect(
			screen.getByText("Could not determine the GitLab project path."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});

	it("explains an empty project rather than offering a dead button", () => {
		sourcesData = [];
		renderDialog();

		expect(screen.getByText("noSources")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});
});

/**
 * Choosing a pipeline, on a provider that has pipelines to choose.
 *
 * Every test above uses a GitLab-shaped source, which runs a ref and so never
 * reaches this path — which is why the pre-selection this suite now forbids
 * survived unnoticed.
 *
 * The list is every workflow the repository will start on request. In a real
 * one that includes deploys, releases and cleanup jobs, ordered arbitrarily, so
 * a pre-filled pipeline arms the primary button with a choice nobody made.
 */
describe("TriggerRunDialog — choosing a pipeline", () => {
	/** A GitHub-shaped source: runs a named definition, so one must be picked. */
	function githubSource(
		pipelines = [
			{ id: "wf-cleanup", name: "ACR Cleanup" },
			{ id: "wf-types", name: "Type Check" },
		],
	): Source {
		return {
			integrationId: "int-gh",
			provider: "GITHUB",
			owner: "acme",
			repo: "store",
			defaultRef: "main",
			kind: "definition",
			pipelines,
			error: null,
		};
	}

	const startButton = () =>
		screen.getByRole("button", { name: "start" }) as HTMLButtonElement;

	beforeEach(() => {
		sourcesData = [githubSource()];
	});

	it("selects no pipeline when it opens", () => {
		renderDialog();

		// Nothing is chosen, so neither name is showing as the current value.
		// Naming the first alphabetically explicitly: that is the one the old
		// behaviour armed, and it happens to be a destructive job here.
		expect(screen.queryByText("ACR Cleanup")).not.toBeInTheDocument();
		expect(screen.queryByText("Type Check")).not.toBeInTheDocument();
	});

	it("keeps Start run disabled until a pipeline is chosen", () => {
		renderDialog();

		expect(startButton()).toBeDisabled();
	});

	it("dispatches nothing while no pipeline is chosen", async () => {
		renderDialog();

		// pointerEventsCheck off so the click is actually attempted against the
		// disabled control rather than skipped by the harness — the assertion
		// then covers the dispatch, not userEvent's own guard.
		await userEvent.click(startButton(), { pointerEventsCheck: 0 });

		expect(mutateSpy).not.toHaveBeenCalled();
	});

	it("still requires a choice when the repository has exactly one pipeline", () => {
		// "There was only one" is exactly how somebody dispatches without
		// reading, and a repository with one workflow can still have that
		// workflow be a deploy.
		sourcesData = [githubSource([{ id: "wf-only", name: "Deploy" }])];
		renderDialog();

		expect(startButton()).toBeDisabled();
		expect(screen.queryByText("Deploy")).not.toBeInTheDocument();
	});

	it("leaves the ref primed, so requiring a pipeline did not disturb it", () => {
		renderDialog();

		expect(refInput().value).toBe("main");
	});
});
