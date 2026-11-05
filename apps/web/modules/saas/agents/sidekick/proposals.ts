/** Legacy Sidekick markers are draft proposals; only a user action may apply them. */
export interface SidekickDraftProposal {
	instructions?: { html: string; text: string };
	tools: Array<{
		action: "add" | "remove";
		toolId: string;
		toolName: string;
	}>;
	name?: string;
	description?: string;
}

export function parseSidekickDraftProposal(
	text: string,
): SidekickDraftProposal | null {
	if (text.length > 128_000) {
		return null;
	}
	const proposal: SidekickDraftProposal = { tools: [] };
	const instructions = text.match(
		/<sidekick_apply_instructions>\s*([\s\S]*?)\s*<\/sidekick_apply_instructions>/,
	)?.[1];
	if (instructions && instructions.length <= 40_000) {
		proposal.instructions = {
			html: "",
			text: instructions
				.replace(/<\/(?:h[1-6]|p|div|ul|ol|li|pre|blockquote)>/gi, "\n")
				.replace(/<br\s*\/?>/gi, "\n")
				.replace(/<[^>]+>/g, "")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/\n{3,}/g, "\n\n")
				.trim(),
		};
		// Rich-text consumers receive escaped text, never model-authored markup.
		proposal.instructions.html = `<p>${proposal.instructions.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>")}</p>`;
	}
	try {
		const value: unknown = JSON.parse(
			text.match(
				/<sidekick_apply_tools>\s*([\s\S]*?)\s*<\/sidekick_apply_tools>/,
			)?.[1] ?? "null",
		);
		if (
			Array.isArray(value) &&
			value.length <= 32 &&
			value.every((entry: unknown) => {
				if (!entry || typeof entry !== "object") {
					return false;
				}
				const item = entry as Record<string, unknown>;
				return (
					(item.action === "add" || item.action === "remove") &&
					typeof item.toolId === "string" &&
					item.toolId.length > 0 &&
					item.toolId.length <= 200 &&
					!/[\p{Cc}]/u.test(item.toolId) &&
					(item.toolName === undefined ||
						(typeof item.toolName === "string" &&
							item.toolName.length <= 200))
				);
			})
		) {
			proposal.tools = value.map((item) => ({
				action: item.action,
				toolId: item.toolId,
				toolName: item.toolName || item.toolId,
			}));
		}
	} catch {
		/* Malformed model output never changes a configuration. */
	}
	try {
		const value: unknown = JSON.parse(
			text.match(
				/<sidekick_apply_metadata>\s*([\s\S]*?)\s*<\/sidekick_apply_metadata>/,
			)?.[1] ?? "null",
		);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const item = value as Record<string, unknown>;
			if (
				typeof item.name === "string" &&
				item.name.trim() &&
				item.name.length <= 200
			) {
				proposal.name = item.name;
			}
			if (
				typeof item.description === "string" &&
				item.description.trim() &&
				item.description.length <= 2000
			) {
				proposal.description = item.description;
			}
		}
	} catch {
		/* Metadata is optional, and untrusted output is ignored. */
	}
	return proposal.instructions ||
		proposal.tools.length ||
		proposal.name ||
		proposal.description
		? proposal
		: null;
}

/** Hide the draft-transfer protocol; the reviewed proposal is rendered separately. */
export function sidekickDisplayText(text: string): string {
	return text
		.replace(
			/<sidekick_apply_(instructions|tools|metadata)>[\s\S]*?(?:<\/sidekick_apply_\1>|$)/g,
			"",
		)
		.trim();
}
