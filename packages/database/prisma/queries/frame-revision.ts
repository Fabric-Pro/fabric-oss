export class FrameUpdateConflictError extends Error {
	constructor() {
		super(
			"This page changed since you opened it. Reload the latest version before saving or restoring.",
		);
		this.name = "FrameUpdateConflictError";
	}
}

export function assertFrameRevision(expected: Date | undefined, actual: Date) {
	if (expected && expected.getTime() !== actual.getTime()) {
		throw new FrameUpdateConflictError();
	}
}

export function nextFrameRevision(previous: Date): Date {
	return new Date(Math.max(Date.now(), previous.getTime() + 1));
}
