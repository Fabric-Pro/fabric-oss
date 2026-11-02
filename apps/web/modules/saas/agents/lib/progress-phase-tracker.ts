/** Track source changes independently so steady polling sources do not alternate captions. */
export class ProgressPhaseTracker {
	private readonly phases = new Map<string, string>();
	private emitted: string | undefined;
	private heartbeatChanged = false;

	/** Pollers apply heartbeats first; a changed activity caption takes precedence for this poll. */
	beginPoll(): void {
		this.heartbeatChanged = false;
	}

	changed(source: string, phase: string | undefined): boolean {
		if (!phase || this.phases.get(source) === phase) {
			return false;
		}
		this.phases.set(source, phase);
		if (source === "heartbeat") {
			this.heartbeatChanged = true;
		} else if (this.heartbeatChanged) {
			return false;
		}
		if (this.emitted === phase) {
			return false;
		}
		this.emitted = phase;
		return true;
	}
}
