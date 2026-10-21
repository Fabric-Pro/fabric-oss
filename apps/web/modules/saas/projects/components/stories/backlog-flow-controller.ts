import type { orpcClient } from "../../../../shared/lib/orpc-client";
import { validateBacklogAnalysisSources } from "../../lib/backlog-analysis-sources";
import type { ApplyResult } from "./BacklogChangeProposal";
import type { ReviewSourcesResult } from "./ReviewSourcesSelector";

type Progress = Awaited<
	ReturnType<typeof orpcClient.projects.backlog.analysisProgress>
>;
export type BacklogProposal = NonNullable<Progress["proposal"]>;
export type Selector = "teams" | "notion";
export type FlowPhase =
	| "admitted"
	| "selecting"
	| "analyzing"
	| "applying"
	| "apply-failed"
	| "reviewing"
	| "no-changes"
	| "failed"
	| "done";
export type FlowEntry =
	| "select_review_sources"
	| "select_notion_pages"
	| "analyze_backlog";
export interface FlowApplyState {
	progress: string;
	approvedCount: number;
	workflowId?: string;
	proposalId?: string;
	result?: ApplyResult;
	error?: string;
}
export interface BacklogFlow {
	version: 1;
	sessionId: string;
	messageId: string;
	flowId: string;
	phase: FlowPhase;
	sourcePlan: Selector[];
	selectorIndex: number;
	intakeMode: "standard" | "explore";
	userPrompt: string;
	fetchSlackMessages?: boolean;
	sources: ReturnType<typeof validateBacklogAnalysisSources>;
	workflowId?: string;
	proposal?: BacklogProposal;
	decisionConflicts?: BacklogProposal["decisionConflicts"];
	progress: string;
	outcome?: "approved" | "rejected" | "cancelled" | "superseded";
	startRetryable?: boolean;
	apply?: FlowApplyState;
	failureStatus?: "failed" | "timeout";
	logContextNote?: string;
	decisionPrecheckPending?: boolean;
}
export interface FlowServices {
	start: (flow: BacklogFlow) => Promise<{ workflowId: string }>;
	poll: (workflowId: string) => Promise<Progress>;
}

/** Bound a single remote call, including calls whose transport does not settle. */
export async function beforeDeadline<T>(
	work: Promise<T>,
	deadline: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							Object.assign(new Error(message), {
								name: "TimeoutError",
							}),
						),
					Math.max(0, deadline - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** Read text without treating image-only genuine messages as tool results. */
function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part) => part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}
export function genuineUserMessages(
	messages: unknown[],
): { id: string; content: string }[] {
	return messages.flatMap((raw) => {
		if (!raw || typeof raw !== "object") {
			return [];
		}
		const message = raw as {
			role?: string;
			type?: string;
			id?: string;
			content?: unknown;
			_getType?: () => string;
		};
		return typeof message.id === "string" &&
			(message.role === "user" ||
				message.role === "human" ||
				message.type === "human" ||
				message._getType?.() === "human")
			? [{ id: message.id, content: messageText(message.content) }]
			: [];
	});
}
export function genuineUserMessage(messages: unknown[]) {
	return genuineUserMessages(messages).at(-1);
}

export const REVIEW_UNAVAILABLE_RESULT =
	"There is no proposal waiting for review.";

/** Session-owned store. Admission and phase claims precede async work (sequence tests). */
export class BacklogFlowController {
	readonly sessionId = crypto.randomUUID();
	private flows = new Map<string, BacklogFlow>();
	private admittedMessages = new Set<string>();
	private listeners = new Set<() => void>();
	private activeId?: string;
	private services = new Map<string, FlowServices>();
	private stopped = false;
	private applyRuns = new Map<string, () => Promise<void>>();
	private approvalSequence = new Map<string, number>();
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	get = (flowId: string) => this.flows.get(flowId);
	current = () => (this.activeId ? this.get(this.activeId) : undefined);
	private update(flowId: string, patch: Partial<BacklogFlow>) {
		const flow = this.get(flowId);
		if (!flow) {
			return;
		}
		this.flows.set(flowId, { ...flow, ...patch });
		for (const listener of this.listeners) {
			listener();
		}
	}
	private owns(flowId: string, phase?: FlowPhase) {
		return (
			!this.stopped &&
			this.activeId === flowId &&
			(!phase || this.get(flowId)?.phase === phase)
		);
	}
	canStart(flowId: string) {
		return this.owns(flowId, "analyzing");
	}

	canApply(flowId: string) {
		return this.owns(flowId, "applying");
	}

	stop() {
		this.stopped = true;
	}
	activate() {
		this.stopped = false;
	}
	admit(
		message: { id: string; content: string } | undefined,
		entry: FlowEntry,
		plan: Selector[],
		services: FlowServices,
		options: {
			intakeMode: "standard" | "explore";
			fetchSlackMessages?: boolean;
			userPrompt?: string;
		},
	) {
		if (!message) {
			return "There is no new message to start a request from. Send a message describing what to review.";
		}
		if (this.admittedMessages.has(message.id)) {
			return "This request already has a flow in the card above. Send a new message to start another.";
		}
		const previous = this.current();
		const activeMessages: Partial<Record<FlowPhase, string>> = {
			admitted: "An analysis is being prepared.",
			selecting: "The source selector is open.",
			analyzing: "An analysis is running.",
			reviewing: "A review is open.",
			applying: "Changes are being applied.",
		};
		const refusal = previous && activeMessages[previous.phase];
		if (refusal) {
			return `${refusal} Use the active card.${previous.phase === "applying" || previous.phase === "admitted" ? " Wait for it to finish before a new request." : " Choose Start over before a new request if you want to replace it."}`;
		}
		this.admittedMessages.add(message.id);
		const flowId = crypto.randomUUID();
		const sourcePlan =
			entry === "analyze_backlog" ? [] : [...new Set(plan)];
		this.activeId = flowId;
		this.flows.set(flowId, {
			version: 1,
			sessionId: this.sessionId,
			messageId: message.id,
			flowId,
			phase: "admitted",
			sourcePlan,
			selectorIndex: 0,
			...options,
			userPrompt:
				options.userPrompt ||
				message.content ||
				"Analyze selected context and suggest backlog updates.",
			sources: validateBacklogAnalysisSources({}),
			progress: "Starting analysis...",
		});
		this.services.set(flowId, services);
		this.advance(flowId);
		return {
			flowId,
			message:
				"The application is managing selection, analysis and review in this card.",
		};
	}
	startOver(flowId: string) {
		if (!this.owns(flowId)) {
			return "This flow is stale.";
		}
		if (
			!["selecting", "analyzing", "reviewing"].includes(
				this.get(flowId)?.phase ?? "",
			)
		) {
			return "Start over is only available during source selection, analysis or review.";
		}
		this.update(flowId, {
			phase: "done",
			outcome: "superseded",
			decisionPrecheckPending: false,
		});
		return "Flow ended. Send a new request to start again.";
	}
	retryStart(flowId: string) {
		const flow = this.get(flowId);
		if (
			!flow ||
			!this.owns(flowId, "failed") ||
			flow.workflowId ||
			!flow.startRetryable
		) {
			return "This analysis cannot be retried here.";
		}
		this.update(flowId, {
			phase: "analyzing",
			progress: "Retrying analysis...",
			startRetryable: false,
		});
		void this.analyze(flowId);
		return "Retrying the same analysis operation.";
	}
	async applyProposal(
		flowId: string,
		proposal: BacklogProposal,
		count: number,
		run: (operationKey: string) => Promise<void>,
	) {
		if (
			!this.owns(flowId, "reviewing") ||
			this.get(flowId)?.proposal !== proposal
		) {
			return;
		}
		const attempt = (this.approvalSequence.get(flowId) ?? 0) + 1;
		this.approvalSequence.set(flowId, attempt);
		const operationKey = `${flowId}:${this.get(flowId)?.workflowId ?? "proposal"}:${attempt}`;
		this.applyRuns.set(flowId, () => run(operationKey));
		this.update(flowId, {
			phase: "applying",
			apply: {
				progress: "Starting to apply changes...",
				approvedCount: count,
			},
		});
		await this.runApply(flowId, count, true);
	}
	async retryApply(flowId: string) {
		const flow = this.get(flowId);
		if (!flow?.apply || !this.owns(flowId, "apply-failed")) {
			return;
		}
		this.update(flowId, {
			phase: "applying",
			apply: {
				approvedCount: flow.apply.approvedCount,
				progress: "Retrying the approved apply request...",
			},
		});
		await this.runApply(flowId, flow.apply.approvedCount, false);
	}
	private async runApply(flowId: string, count: number, firstSend: boolean) {
		try {
			await this.applyRuns.get(flowId)?.();
			if (this.get(flowId)?.phase === "applying") {
				this.update(flowId, { phase: "done", outcome: "approved" });
			}
		} catch (error) {
			const flow = this.get(flowId);
			if (!flow?.apply) {
				return;
			}
			const message =
				error instanceof Error
					? error.message
					: "Failed to apply changes";
			this.patchApply(flowId, {
				progress: "",
				error: message,
				result: {
					status: "failed",
					createdCount: 0,
					updatedCount: 0,
					failedCount: count,
					batchTotal: count,
					syncedToPM: false,
					items: [],
					message:
						flow.apply.workflowId || !firstSend
							? `${message}. Open Review proposals to retry or cancel the existing operation.`
							: message,
				},
			});
			if (flow.phase === "applying") {
				const refused =
					firstSend &&
					[
						"BAD_REQUEST",
						"FORBIDDEN",
						"UNAUTHORIZED",
						"NOT_FOUND",
						"PRECONDITION_FAILED",
						"CONFLICT",
						"RESOURCE_EXHAUSTED",
					].includes(String((error as { code?: unknown })?.code));
				this.update(
					flowId,
					!firstSend
						? { phase: "apply-failed" }
						: refused
							? { phase: "reviewing" }
							: flow.apply.workflowId
								? { phase: "done", outcome: "approved" }
								: { phase: "apply-failed" },
				);
				if (refused) {
					this.applyRuns.delete(flowId);
				}
			}
		}
	}
	patchApply(flowId: string, patch: Partial<FlowApplyState>) {
		const apply = this.get(flowId)?.apply;
		if (apply) {
			this.update(flowId, { apply: { ...apply, ...patch } });
		}
	}
	private advance(flowId: string) {
		const flow = this.get(flowId);
		if (!flow || !this.owns(flowId)) {
			return;
		}
		if (flow.selectorIndex < flow.sourcePlan.length) {
			this.update(flowId, { phase: "selecting" });
			return;
		}
		this.update(flowId, { phase: "analyzing" });
		void this.analyze(flowId);
	}
	confirm(
		flowId: string,
		selector: Selector,
		result?: Partial<ReviewSourcesResult>,
	) {
		const flow = this.get(flowId);
		if (
			!flow ||
			!this.owns(flowId, "selecting") ||
			flow.sourcePlan[flow.selectorIndex] !== selector
		) {
			return "This selector is stale or already completed.";
		}
		// Copy validated primitives rather than retaining a mutable selector payload.
		this.update(flowId, {
			sources:
				selector === "teams"
					? validateBacklogAnalysisSources(result ?? { daysBack: 30 })
					: flow.sources,
			selectorIndex: flow.selectorIndex + 1,
			phase: "admitted",
		});
		this.advance(flowId);
		return "Source confirmed. The application is advancing the flow.";
	}
	cancel(flowId: string) {
		if (!this.owns(flowId, "selecting")) {
			return "This selector is stale or already completed.";
		}
		this.update(flowId, { phase: "done", outcome: "cancelled" });
		return "Request cancelled.";
	}
	review() {
		return this.current()?.phase === "reviewing"
			? "The proposal is already shown in the existing review card."
			: REVIEW_UNAVAILABLE_RESULT;
	}
	decide(
		flowId: string,
		proposal: BacklogProposal,
		outcome: "approved" | "rejected",
	) {
		if (
			!this.owns(flowId, "reviewing") ||
			this.get(flowId)?.proposal !== proposal
		) {
			return false;
		}
		this.update(flowId, {
			phase: "done",
			outcome,
			decisionPrecheckPending: false,
		});
		return true;
	}
	private async analyze(flowId: string) {
		const services = this.services.get(flowId);
		const admitted = this.get(flowId);
		if (!services || !admitted) {
			return;
		}
		try {
			const started = await beforeDeadline(
				services.start(admitted),
				Date.now() + 300000,
				"Analysis start timed out after 5 minutes. Retry the same analysis operation.",
			);
			if (!started.workflowId) {
				throw new Error("Failed to start analysis workflow.");
			}
			// Retain the known id even when a newer flow superseded this one during start.
			this.update(flowId, { workflowId: started.workflowId });
			if (!this.owns(flowId, "analyzing")) {
				return;
			}
			await this.monitor(flowId, started.workflowId, services);
		} catch (error) {
			if (this.owns(flowId, "analyzing")) {
				this.update(flowId, {
					phase: "failed",
					startRetryable:
						!this.get(flowId)?.workflowId &&
						![
							"CONFLICT",
							"FORBIDDEN",
							"UNAUTHORIZED",
							"BAD_REQUEST",
							"NOT_FOUND",
						].includes(String((error as { code?: unknown })?.code)),
					failureStatus:
						error instanceof Error && error.name === "TimeoutError"
							? "timeout"
							: "failed",
					progress:
						error instanceof Error
							? error.message
							: "Analysis failed",
				});
			}
		}
	}
	private async monitor(
		flowId: string,
		workflowId: string,
		services: FlowServices,
		immediate = false,
	) {
		const began = Date.now();
		let pollImmediately = immediate;
		while (Date.now() - began < 300000) {
			if (!pollImmediately) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
			pollImmediately = false;
			if (!this.owns(flowId, "analyzing")) {
				return;
			}
			const progress = await this.pollBeforeDeadline(
				services,
				workflowId,
				began + 300000,
			);
			if (!this.owns(flowId, "analyzing")) {
				return;
			}
			this.update(flowId, {
				progress: progress.progress?.message ?? "Analyzing...",
				logContextNote: progress.progress?.logContextNote,
			});
			if (progress.progress?.status === "failed") {
				throw new Error(progress.progress.message ?? "Analysis failed");
			}
			if (progress.progress?.status === "complete" && progress.proposal) {
				const hasChanges = (progress.proposal.changes?.length ?? 0) > 0;
				this.update(flowId, {
					phase: hasChanges ? "reviewing" : "no-changes",
					proposal: progress.proposal,
					decisionPrecheckPending:
						hasChanges && !progress.proposal.decisionConflicts,
				});
				if (hasChanges && !progress.proposal.decisionConflicts) {
					void this.pollDecision(flowId, workflowId, services);
				}
				return;
			}
		}
		this.update(flowId, {
			phase: "failed",
			failureStatus: "timeout",
			progress:
				"Analysis timed out after 5 minutes. Its workflow may still be running.",
		});
	}

	private async pollBeforeDeadline(
		services: FlowServices,
		workflowId: string,
		deadline: number,
	): Promise<Progress> {
		return beforeDeadline(
			services.poll(workflowId),
			deadline,
			"Analysis timed out after 5 minutes. Its workflow may still be running.",
		);
	}

	/** Reconcile the known operation after failure/timeout; does not call start. */
	async reconcile(flowId: string) {
		const flow = this.get(flowId);
		const services = this.services.get(flowId);
		if (!flow?.workflowId || !services || !this.owns(flowId, "failed")) {
			return "No stopped workflow to reconcile.";
		}
		// Claim before awaiting to collapse double clicks.
		this.update(flowId, {
			phase: "analyzing",
			progress: "Checking existing analysis...",
		});
		try {
			await this.monitor(flowId, flow.workflowId, services, true);
		} catch (error) {
			if (this.owns(flowId, "analyzing")) {
				this.update(flowId, {
					phase: "failed",
					progress:
						error instanceof Error
							? error.message
							: "Could not check analysis",
				});
			}
		}
		return "Existing workflow checked.";
	}
	private async pollDecision(
		flowId: string,
		workflowId: string,
		services: FlowServices,
	) {
		const began = Date.now();
		try {
			while (
				this.owns(flowId, "reviewing") &&
				Date.now() - began < 45000
			) {
				await new Promise((resolve) => setTimeout(resolve, 2500));
				if (!this.owns(flowId, "reviewing")) {
					return;
				}
				const result = await this.pollBeforeDeadline(
					services,
					workflowId,
					began + 45000,
				);
				if (!this.owns(flowId, "reviewing")) {
					return;
				}
				if (result.proposal?.decisionConflicts) {
					// The note does not replace the displayed proposal's approval identity.
					this.update(flowId, {
						decisionConflicts: result.proposal.decisionConflicts,
					});
					return;
				}
			}
		} catch {
			/* The review remains usable if the optional precheck read fails. */
		} finally {
			this.update(flowId, { decisionPrecheckPending: false });
		}
	}
}
