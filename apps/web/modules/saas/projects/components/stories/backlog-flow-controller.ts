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
	pmContextNote?: string;
	decisionPrecheckPending?: boolean;
}
export interface FlowServices {
	start: (flow: BacklogFlow) => Promise<{ workflowId: string }>;
	poll: (workflowId: string) => Promise<Progress>;
}

async function withAbort<T>(
	work: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) {
		return work;
	}
	let onAbort = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
		}
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Bound a single remote call, including calls whose transport does not settle. */
export async function beforeDeadline<T>(
	work: Promise<T>,
	deadline: number,
	message: string,
	signal?: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await withAbort(
			Promise.race([
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
			]),
			signal,
		);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

const WORKFLOW_POLL_INTERVAL_MS = 2000;
const WORKFLOW_SLOW_POLL_INTERVAL_MS = 10000;
const WORKFLOW_SLOW_AFTER_MS = 5 * 60 * 1000;
const WORKFLOW_READ_TIMEOUT_MS = 30000;
const WORKFLOW_READ_FAILURE_WINDOW_MS = 2 * 60 * 1000;
const WORKFLOW_POLL_CEILING_MS = 45 * 60 * 1000;

export function workflowPollMessage(
	message: string,
	slow: boolean,
	operation: "apply" | "analysis",
) {
	if (!slow) {
		return message;
	}
	const hint =
		operation === "apply"
			? "Still applying — this batch is taking longer than usual. It keeps running if you leave this page."
			: "Still analyzing. This is taking longer than usual.";
	return message === "Applying..." || message === "Analyzing..."
		? hint
		: `${message} ${hint}`;
}

/** Transport failures end observation only after a sustained outage. */
export async function* pollWorkflowProgress<T>(
	read: () => Promise<T>,
	onWaiting: (slow: boolean) => void,
	isActive: () => boolean,
	immediate = false,
	signal?: AbortSignal,
): AsyncGenerator<{ progress: T; slow: boolean }> {
	if (signal?.aborted) {
		return;
	}
	let sleepTimer: ReturnType<typeof setTimeout> | undefined;
	const began = Date.now();
	const ceiling = began + WORKFLOW_POLL_CEILING_MS;
	let failedSince: number | undefined;
	let pollImmediately = immediate;
	const slowTimer = setTimeout(() => {
		if (isActive()) {
			onWaiting(true);
		}
	}, WORKFLOW_SLOW_AFTER_MS);
	try {
		while (isActive()) {
			const deadline = Math.min(
				ceiling,
				failedSince === undefined
					? ceiling
					: failedSince + WORKFLOW_READ_FAILURE_WINDOW_MS,
			);
			if (!pollImmediately) {
				const interval =
					Date.now() - began >= WORKFLOW_SLOW_AFTER_MS
						? WORKFLOW_SLOW_POLL_INTERVAL_MS
						: WORKFLOW_POLL_INTERVAL_MS;
				await withAbort(
					new Promise((resolve) => {
						sleepTimer = setTimeout(
							resolve,
							Math.max(
								0,
								Math.min(interval, deadline - Date.now()),
							),
						);
					}),
					signal,
				);
				clearTimeout(sleepTimer);
			}
			pollImmediately = false;
			if (!isActive() || Date.now() >= deadline) {
				return;
			}
			const readBegan = Date.now();
			let progress: T;
			try {
				progress = await beforeDeadline(
					read(),
					Math.min(deadline, readBegan + WORKFLOW_READ_TIMEOUT_MS),
					"Could not read workflow progress",
					signal,
				);
			} catch {
				if (signal?.aborted) {
					return;
				}
				failedSince ??= readBegan;
				continue;
			}
			if (!isActive()) {
				return;
			}
			failedSince = undefined;
			yield {
				progress,
				slow: Date.now() - began >= WORKFLOW_SLOW_AFTER_MS,
			};
		}
	} catch (error) {
		if (!signal?.aborted) {
			throw error;
		}
	} finally {
		clearTimeout(slowTimer);
		clearTimeout(sleepTimer);
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

	canObserveApply(flowId: string) {
		const flow = this.get(flowId);
		return (
			this.activeId === flowId &&
			flow?.phase === "applying" &&
			!flow.apply?.result
		);
	}

	finishCancelledApply(flowId: string) {
		const flow = this.get(flowId);
		// The cancel response can arrive after termination made a progress read fail.
		const failedBeforeCancel =
			this.activeId === flowId &&
			(flow?.phase === "applying" || flow?.phase === "done") &&
			flow?.apply?.result?.status === "failed";
		if (
			!flow?.apply ||
			(!this.canObserveApply(flowId) && !failedBeforeCancel)
		) {
			return false;
		}
		this.update(flowId, {
			phase: "done",
			outcome: "approved",
			apply: {
				...flow.apply,
				progress: "",
				result: {
					status: "unconfirmed",
					createdCount: 0,
					updatedCount: 0,
					failedCount: 0,
					batchTotal: flow.apply.approvedCount,
					syncedToPM: false,
					items: [],
					message:
						"Apply cancelled. You can retry it from Review proposals.",
				},
			},
		});
		return true;
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
		let message = "Analyzing...";
		for await (const { progress, slow } of pollWorkflowProgress(
			() => services.poll(workflowId),
			(slow) =>
				this.update(flowId, {
					progress: workflowPollMessage(message, slow, "analysis"),
				}),
			() => this.owns(flowId, "analyzing"),
			immediate,
		)) {
			message = progress.progress?.message ?? "Analyzing...";
			this.update(flowId, {
				progress: workflowPollMessage(message, slow, "analysis"),
				logContextNote: progress.progress?.logContextNote,
				pmContextNote: progress.progress?.pmContextNote,
			});
			if (progress.progress?.status === "failed") {
				this.update(flowId, {
					phase: "failed",
					failureStatus: "failed",
					startRetryable: false,
					progress: progress.progress.message ?? "Analysis failed",
				});
				return;
			}
			if (progress.progress?.status === "cancelled") {
				this.update(flowId, {
					phase: "done",
					outcome: "cancelled",
					progress: "Analysis cancelled.",
				});
				return;
			}
			if (progress.progress?.status === "complete") {
				const hasChanges =
					(progress.proposal?.changes?.length ?? 0) > 0;
				this.update(flowId, {
					phase: hasChanges ? "reviewing" : "no-changes",
					proposal: progress.proposal ?? undefined,
					decisionPrecheckPending:
						hasChanges && !progress.proposal?.decisionConflicts,
				});
				if (hasChanges && !progress.proposal?.decisionConflicts) {
					void this.pollDecision(flowId, workflowId, services);
				}
				return;
			}
		}
		if (!this.owns(flowId, "analyzing")) {
			return;
		}
		this.update(flowId, {
			phase: "failed",
			failureStatus: "timeout",
			progress:
				"Lost track of this analysis. Its workflow may still be running.",
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
			"Could not read the optional decision precheck.",
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
