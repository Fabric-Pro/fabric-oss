import type { SkillDetailDTO, SkillDTO } from "@repo/ai/skill-contracts";
export type SkillDetail = SkillDetailDTO;
export type SkillListItem = SkillDTO;
export type SkillDraft = {
	name: string;
	slug: string;
	description: string;
	content: string;
	category?: string;
	tags: string[];
};
export const EMPTY_SKILL_DRAFT: SkillDraft = {
	name: "",
	slug: "",
	description: "",
	content: "",
	tags: [],
};
export function skillUiError(error: unknown): string {
	if (
		error instanceof Error &&
		"code" in error &&
		[
			"BAD_REQUEST",
			"CONFLICT",
			"FORBIDDEN",
			"NOT_FOUND",
			"SERVICE_UNAVAILABLE",
			"TOO_MANY_REQUESTS",
		].includes(String(error.code))
	) {
		return error.message;
	}
	return "We could not confirm this request. Your draft is preserved. Check your access and try again.";
}
export function skillAvailabilityLabel(value: string) {
	return (
		(
			{
				draft: "Your draft",
				members: "Organization members",
				agents: "Members and agent discovery",
				builtin: "Built-in",
			} as Record<string, string>
		)[value] ?? "Skill"
	);
}
export function skillSlug(name: string, maxLength = 100) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, maxLength)
		.replace(/^-+|-+$/g, "");
}
export function skillReadCanRetry(error: unknown) {
	if (!error || typeof error !== "object") {
		return true;
	}
	const value = error as {
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
	};
	return (
		!["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(
			String(value.code),
		) &&
		![400, 401, 403, 404].includes(Number(value.status ?? value.statusCode))
	);
}
export function skillListReturnHref(basePath: string, candidate?: string) {
	const fallback = `${basePath}/skills`;
	if (!candidate || candidate.includes("#")) {
		return fallback;
	}
	try {
		const parsed = new URL(candidate, "https://example.com");
		return candidate.startsWith(`${fallback}?`) &&
			parsed.origin === "https://example.com" &&
			parsed.pathname === fallback
			? `${fallback}${parsed.search}`
			: fallback;
	} catch {
		return fallback;
	}
}
