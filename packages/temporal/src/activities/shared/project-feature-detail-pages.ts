import { sliceUnicodeCharacters } from "@repo/database/src/project-context-presentation";

export const FEATURE_RESULT_CHARS = 10_000;
export const FEATURE_DETAIL_SECTIONS = [
	"description",
	"acceptanceCriteria",
	"tasks",
] as const;
export type FeatureDetailSection = (typeof FEATURE_DETAIL_SECTIONS)[number];

interface FeatureTask {
	identifier: string;
	title: string;
	isCompleted: boolean;
	description: string | null;
	subtasks: string;
}
interface FeatureSections {
	id: string;
	identifier: string;
	description: string | null;
	acceptanceCriteria: string | null;
	tasks: FeatureTask[];
}

/** Keep the separator in the page so consecutive pages reconstruct the text. */
function atTextBoundary(text: string): string {
	const newline = text.lastIndexOf("\n");
	if (newline >= text.length / 2) {
		return text.slice(0, newline + 1);
	}
	const sentences = [...text.matchAll(/[.!?](?=\s)/g)];
	const sentence = sentences.at(-1);
	return sentence && sentence.index >= text.length / 2
		? text.slice(0, sentence.index + 1)
		: text;
}

export function readFeatureSection(
	feature: FeatureSections,
	section: FeatureDetailSection,
	offset: number,
): Record<string, unknown> {
	const identity = {
		id: feature.id,
		identifier: feature.identifier,
		section,
		offset,
	};
	if (section === "tasks") {
		const tasks: FeatureTask[] = [];
		const result = () => {
			const nextOffset = offset + tasks.length;
			const hasMore = nextOffset < feature.tasks.length;
			return {
				...identity,
				tasks,
				total: feature.tasks.length,
				returnedCount: tasks.length,
				hasMore,
				...(hasMore
					? { nextOffset, next: { section, offset: nextOffset } }
					: {}),
			};
		};
		for (const task of feature.tasks.slice(offset)) {
			tasks.push(task);
			if (JSON.stringify(result()).length > FEATURE_RESULT_CHARS) {
				tasks.pop();
				break;
			}
		}
		if (!tasks.length && offset < feature.tasks.length) {
			const task = feature.tasks[offset].identifier;
			const nextOffset = offset + 1;
			return {
				error:
					`Task ${task.slice(0, 200)} alone exceeds the result budget. Open feature ${feature.identifier.slice(0, 200)} on the project's roadmap, then open that task to read its full text.` +
					(nextOffset < feature.tasks.length
						? ` Read later tasks with fabric_get_project_feature(${JSON.stringify({ feature: feature.id, section, offset: nextOffset })}).`
						: ""),
				feature: feature.id,
				task: task.slice(0, 200),
				section,
				offset,
				hasMore: nextOffset < feature.tasks.length,
				...(nextOffset < feature.tasks.length
					? { nextOffset, next: { section, offset: nextOffset } }
					: {}),
			};
		}
		return result();
	}
	const body = feature[section] ?? "";
	const contentLength = Array.from(body).length;
	let content = "";
	const result = () => {
		const returnedLength = Array.from(content).length;
		const nextOffset = offset + returnedLength;
		const hasMore = nextOffset < contentLength;
		return {
			...identity,
			content,
			contentLength,
			returnedLength,
			hasMore,
			...(hasMore
				? { nextOffset, next: { section, offset: nextOffset } }
				: {}),
		};
	};
	let low = 0;
	let high = Math.min(
		FEATURE_RESULT_CHARS,
		Math.max(0, contentLength - offset),
	);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		content = sliceUnicodeCharacters(body, offset, mid).content;
		if (JSON.stringify(result()).length <= FEATURE_RESULT_CHARS) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	const page = sliceUnicodeCharacters(body, offset, low).content;
	// Cut at a line or sentence break only when the page stops before the end;
	// a remainder that fits is returned whole.
	content = offset + low < contentLength ? atTextBoundary(page) : page;
	return result();
}
