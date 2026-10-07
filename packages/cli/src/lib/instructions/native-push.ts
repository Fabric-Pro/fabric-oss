import type {
	DirectInstructionRepositoryState,
	FabricClient,
	PublishedInstructionRepository,
} from "@fabricorg/sdk";
import {
	CliFailure,
	describeError,
	type OutputFormat,
} from "../command-boundary.js";
import { printOutput } from "../output.js";
import { classifyCheckout } from "./checkout.js";
import * as git from "./git.js";
import { computeNativePushPlan } from "./native-push-plan.js";
import { lookUpOpenProposals } from "./open-proposals.js";
import { materializePushChanges, setAsideProposed } from "./push.js";
import { splitMessage, waitForPullRequest } from "./pull-request-wait.js";
import {
	pullRequestVerdict,
	pushPullRequest,
	type PushPullRequestStatus,
} from "./pull-request-verdict.js";

export async function runNativeInstructionPush(input: {
	client: FabricClient;
	projectId: string;
	root: string;
	repository: PublishedInstructionRepository;
	direct: Extract<
		DirectInstructionRepositoryState,
		{ availability: "READY" }
	>;
	org?: string;
	remote?: string;
	add?: string[];
	publish?: boolean;
	message?: string;
	wait?: boolean;
	includeProposed?: boolean;
	dryRun?: boolean;
	format: OutputFormat;
}): Promise<void> {
	if (input.publish)
		throw new CliFailure(
			"Repository instructions are changed through Git commits or reviewed suggestions. Run push without --publish to open a suggestion.",
			2,
		);
	const deadline = Date.now() + 30_000;
	const checkout = await classifyCheckout({
		destination: input.root,
		repository: input.repository,
		deadline,
		remote: input.remote,
	});
	if (checkout.class !== "matching")
		throw new CliFailure(
			"Run this command in the attached repository's instruction folder. No files were sent.",
			7,
		);
	const head = await git.headSha(checkout.toplevel, deadline);
	if (head.kind !== "ok" || head.value !== input.direct.currentCommitSha) {
		throw new CliFailure(
			"This checkout's HEAD does not match the repository revision read through Fabric. Update the checkout before proposing working-tree changes. Local edits were preserved.",
			7,
		);
	}
	const operation = await git.operationInProgress(
		checkout.toplevel,
		deadline,
	);
	if (operation.kind !== "ok" || operation.value !== null) {
		throw new CliFailure(
			"Finish the current Git operation before proposing changes. No files were sent.",
			7,
		);
	}
	const changed = await git.changedTrackedPaths(input.root, deadline);
	if (changed.kind !== "ok")
		throw new CliFailure(
			"Git could not list this checkout's changes. No files were sent.",
			7,
		);
	const nativeBase = {
		generation: input.direct.generation,
		commitSha: input.direct.currentCommitSha,
	};
	const listed = await input.client.instructions.listRepositoryFiles(
		input.projectId,
		{ ...nativeBase, org: input.org },
	);
	if (
		listed.generation !== nativeBase.generation ||
		listed.commitSha !== nativeBase.commitSha ||
		listed.incomplete ||
		listed.refusal !== null
	) {
		throw new CliFailure(
			"The repository tree could not be read completely at the selected revision. Refresh and try again; no files were sent.",
			7,
		);
	}
	let plan = await computeNativePushPlan({
		root: input.root,
		files: listed.files,
		changedPaths: changed.value,
		added: input.add,
	});
	if (plan.entries.length === 0)
		throw new CliFailure(
			"Nothing to push: Git reports no instruction content changes. Add a new file with --add <path>.",
			7,
		);
	let alreadyProposed: ReturnType<
		typeof setAsideProposed
	>["alreadyProposed"] = [];
	let openProposalCheck: "checked" | "skipped" | "unavailable" = "skipped";
	if (!input.includeProposed) {
		const lookup = await lookUpOpenProposals(
			input.client,
			input.projectId,
			{ org: input.org },
		);
		if (lookup.kind === "found") {
			({ plan, alreadyProposed } = setAsideProposed(
				plan,
				lookup.proposals,
				nativeBase,
			));
			openProposalCheck = "checked";
		} else {
			openProposalCheck = "unavailable";
			process.stderr.write(
				`Could not check your open proposals (${lookup.reason}); the selected changes will be sent.\n`,
			);
		}
	}
	const outcome: {
		projectId: string;
		destination: string;
		nativeBase: { generation: number; commitSha: string };
		dryRun: boolean;
		put: string[];
		deleted: string[];
		unchanged: number;
		openProposalCheck: "checked" | "skipped" | "unavailable";
		alreadyProposed: Array<{
			path: string;
			operationId: string;
			pullRequestUrl: string | null;
		}>;
		operationId: string | null;
		pullRequest: PushPullRequestStatus | null;
		timedOut: boolean;
	} = {
		projectId: input.projectId,
		destination: input.root,
		nativeBase,
		dryRun: Boolean(input.dryRun),
		put: plan.entries
			.filter((entry) => entry.action === "put")
			.map((entry) => entry.path),
		deleted: plan.entries
			.filter((entry) => entry.action === "delete")
			.map((entry) => entry.path),
		unchanged: plan.unchanged.length,
		openProposalCheck,
		alreadyProposed: alreadyProposed.map((entry) => ({
			path: entry.path,
			operationId: entry.proposal.snapshotId,
			pullRequestUrl: entry.proposal.pullRequest?.url ?? null,
		})),
		operationId: null,
		pullRequest: null,
		timedOut: false,
	};
	let sawBranchWithoutPullRequest = false;
	if (!input.dryRun && plan.entries.length > 0) {
		const changes = await materializePushChanges({
			root: input.root,
			entries: plan.entries,
		});
		const currentHead = await git.headSha(checkout.toplevel, deadline);
		if (
			currentHead.kind !== "ok" ||
			currentHead.value !== nativeBase.commitSha
		)
			throw new CliFailure(
				"HEAD changed while planning. No files were sent; run push again.",
				7,
			);
		const submitted =
			await input.client.instructions.submitRepositoryChange(
				input.projectId,
				nativeBase,
				changes,
				{
					org: input.org,
					...(input.message === undefined
						? {}
						: { note: splitMessage(input.message) }),
				},
			);
		outcome.operationId = submitted.operationId;
		if (input.wait !== false) {
			try {
				const waited = await waitForPullRequest(
					input.client,
					input.projectId,
					submitted.operationId,
					{
						org: input.org,
						observe: (status) => {
							if (
								status.branch &&
								status.branch.pullRequest === null
							)
								sawBranchWithoutPullRequest = true;
						},
					},
				);
				if (waited.kind !== "none") {
					outcome.pullRequest = waited.pullRequest
						? pushPullRequest(
								waited.pullRequest,
								waited.kind === "timed_out",
							)
						: null;
					outcome.timedOut = waited.kind === "timed_out";
				}
			} catch (error) {
				throw new CliFailure(
					`Suggestion ${submitted.operationId} was accepted, but its pull request could not be checked: ${describeError(error)}. Check the project's Coding Instructions tab.`,
					7,
				);
			}
		}
	}
	const verdict = outcome.pullRequest
		? pullRequestVerdict(outcome.pullRequest, {
				waited: input.wait !== false,
				openedHere: sawBranchWithoutPullRequest,
			})
		: null;
	if (input.format === "json") printOutput(outcome, { format: "json" });
	else {
		if (input.dryRun)
			process.stdout.write(
				`Would suggest ${plan.entries.length} changes against Git ${nativeBase.commitSha.slice(0, 7)}.\n`,
			);
		else if (outcome.operationId)
			process.stdout.write(
				`Suggestion accepted: ${outcome.operationId}.\n`,
			);
		else
			process.stdout.write(
				"These changes are already in your open suggestions.\n",
			);
		for (const entry of plan.entries)
			process.stdout.write(`  ${entry.action} ${entry.path}\n`);
		if (verdict && !verdict.fails)
			process.stdout.write(`${verdict.text}\n`);
	}
	if (verdict?.fails) throw new CliFailure(verdict.text, 7);
}
