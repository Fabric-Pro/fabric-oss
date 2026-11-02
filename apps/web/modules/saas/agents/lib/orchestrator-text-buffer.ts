import type { OrchestratorStreamEvent } from "./orchestrator-stream-protocol";

/** Flush text before an event can change the reducer's text-boundary flags. */
export class OrchestratorTextBuffer {
	private pending: string[] = [];
	private messageId = "";
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly apply: (
			event: OrchestratorStreamEvent,
			id: string,
			preserveContentOnResume?: boolean,
		) => void,
	) {}

	push(
		event: OrchestratorStreamEvent,
		id: string,
		preserveContentOnResume = false,
	): void {
		if (
			event.type !== "text_delta" ||
			(this.messageId && this.messageId !== id)
		) {
			this.flush();
		}
		if (event.type !== "text_delta") {
			this.apply(event, id, preserveContentOnResume);
			return;
		}
		if (!event.content) {
			return;
		}
		this.messageId = id;
		this.pending.push(event.content);
		this.timer ??= setTimeout(() => this.flush(), 100);
	}

	get pendingText(): string {
		return this.pending.join("");
	}

	flush(): void {
		const content = this.pending.join("");
		const id = this.messageId;
		this.drop();
		if (content) {
			this.apply({ type: "text_delta", content }, id);
		}
	}

	drop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = [];
		this.messageId = "";
	}
}
