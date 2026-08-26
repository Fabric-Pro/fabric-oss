export type FrameHostToEmbedMessage =
	| {
			type: "fabric-frame:request-export-png";
			requestId: string;
	  }
	| {
			type: "fabric-frame:request-display-code";
			requestId: string;
	  };

export type FrameEmbedToHostMessage =
	| {
			type: "fabric-frame:ready";
			frameTitle?: string;
	  }
	| {
			type: "fabric-frame:set-height";
			height: number;
			frameTitle?: string;
	  }
	| {
			type: "fabric-frame:error";
			error: string;
	  }
	| {
			type: "fabric-frame:export-png-result";
			requestId: string;
			dataUrl?: string;
			error?: string;
	  }
	| {
			type: "fabric-frame:display-code";
			requestId: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isFrameHostToEmbedMessage(
	value: unknown,
): value is FrameHostToEmbedMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	if (
		(value.type === "fabric-frame:request-export-png" ||
			value.type === "fabric-frame:request-display-code") &&
		typeof value.requestId === "string"
	) {
		return true;
	}

	return false;
}

export function isFrameEmbedToHostMessage(
	value: unknown,
): value is FrameEmbedToHostMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	switch (value.type) {
		case "fabric-frame:ready":
			return (
				value.frameTitle === undefined ||
				typeof value.frameTitle === "string"
			);
		case "fabric-frame:set-height":
			return (
				typeof value.height === "number" &&
				(value.frameTitle === undefined ||
					typeof value.frameTitle === "string")
			);
		case "fabric-frame:error":
			return typeof value.error === "string";
		case "fabric-frame:export-png-result":
			return (
				typeof value.requestId === "string" &&
				(value.dataUrl === undefined ||
					typeof value.dataUrl === "string") &&
				(value.error === undefined || typeof value.error === "string")
			);
		case "fabric-frame:display-code":
			return typeof value.requestId === "string";
		default:
			return false;
	}
}
