/**
 * Publishing Suggestion — Dedupe-Key Computation Activity
 *
 * Maps each summarized topic to the persistable shape:
 *  - stamps its canonical `dedupeKey`.
 *  - maps `suggestedPostTypes` from the LLM's human-readable labels (e.g. "Blog
 *    Post") to the `PublishingTopicPostType` enum via `postTypeLabelToEnum`,
 *    deduped (D6) — a repeated label (e.g. the model emitting `["Tweet",
 *    "Tweet"]`) collapses to a single enum entry.
 *  - seeds `contributorUserIds: []`, populated later by Task 5's
 *    `resolveTopicContributors` activity.
 *
 * This lives in an ACTIVITY (not the workflow body) precisely BECAUSE
 * `computeDedupeKey` uses `node:crypto` (`createHash`) — a Node built-in that
 * the Temporal workflow sandbox forbids. Keeping the hash here lets the
 * deterministic workflow stay free of node built-ins.
 *
 * F4 (typed end-to-end): the input `topics` are exactly the summarizer's output
 * shape and the output `topics` are exactly what `persistCycleTerminal` requires,
 * so the workflow wires summarizer → this → persist with no `unknown` narrowing.
 */

import {
	computeDedupeKey,
	computeSubjectKey,
	MULTIPLICATION_CAP,
	type PersistCycleTerminalInput,
	type PublishingTopicSuggestions,
	postTypeLabelToEnum,
} from "@repo/database";
import { log } from "@temporalio/activity";

export interface ComputeSuggestionTopicsInput {
	projectId: string;
	topics: PublishingTopicSuggestions["topics"];
}

export interface ComputeSuggestionTopicsOutput {
	topics: PersistCycleTerminalInput["topics"];
}

type PersistTopic = PersistCycleTerminalInput["topics"][number];

const normalizeAngle = (s: string | undefined): string =>
	s?.trim() ? s.trim().toLowerCase().replace(/\s+/g, " ") : "";

export async function computeSuggestionTopics(
	input: ComputeSuggestionTopicsInput,
): Promise<ComputeSuggestionTopicsOutput> {
	// 1. Map each LLM topic to a base persist record (subject/subjectKey resolved
	//    in step 4) + grouping metadata. dedupeKey stays title-only (byte-identical).
	const mapped = input.topics.map((topic) => {
		const record: PersistTopic = {
			title: topic.title,
			pitch: topic.pitch,
			provenance: topic.provenance,
			dedupeKey: computeDedupeKey(input.projectId, topic.title),
			suggestedPostTypes: [
				...new Set(
					(topic.suggestedPostTypes ?? []).map(postTypeLabelToEnum),
				),
			],
			contributorUserIds: [],
			relevantFunctionTags: topic.relevantFunctionTags ?? [],
			postTypeRecommendations: (topic.postTypeRecommendations ?? []).map(
				(r) => ({
					type: postTypeLabelToEnum(r.type),
					theme: r.theme,
					rationale: r.rationale,
				}),
			),
			angle: topic.angle,
			subject: null,
			subjectKey: null,
		};
		const subjectRaw = topic.subject?.trim() ? topic.subject.trim() : null;
		return {
			record,
			subjectRaw,
			// Only subject-bearing records carry a grouping key — a subject-less topic
			// is NEVER grouped (Codex plan-review P2), so it can never be pulled into a
			// group by a title that coincidentally equals another pair's subject.
			subjectKeyCandidate: subjectRaw
				? computeSubjectKey(input.projectId, subjectRaw)
				: null,
			angleNorm: normalizeAngle(topic.angle),
		};
	});

	// 2. De-collide by dedupeKey (identical normalized title => same key => would
	//    collide at persist under the (projectId, dedupeKey) unique index).
	const seen = new Set<string>();
	const survivors: typeof mapped = [];
	for (const m of mapped) {
		if (seen.has(m.record.dedupeKey)) {
			log.warn(
				"[publishing-suggestion/compute] dropped a duplicate-title topic (same dedupeKey)",
				{ projectId: input.projectId, title: m.record.title },
			);
			continue;
		}
		seen.add(m.record.dedupeKey);
		survivors.push(m);
	}

	// 3. Subject-less survivors are ALWAYS singletons — emit them directly. Only
	//    subject-bearing survivors are candidates for grouping (Codex plan-review P2).
	const out: PersistTopic[] = [];
	const groupable: typeof survivors = [];
	for (const m of survivors) {
		if (m.subjectRaw === null) {
			out.push({ ...m.record });
		} else {
			groupable.push(m);
		}
	}

	// 4. Group the subject-bearing survivors by subjectKeyCandidate.
	const groups = new Map<string, typeof groupable>();
	for (const m of groupable) {
		const key = m.subjectKeyCandidate as string; // non-null for subject-bearing
		const g = groups.get(key) ?? [];
		g.push(m);
		groups.set(key, g);
	}

	// 5. Resolve each group to EXACTLY 1 (single) or 2 (multiplication).
	for (const [subjectKey, group] of groups) {
		const selected: typeof group = [];
		const usedAngles = new Set<string>();
		for (const m of group) {
			if (selected.length >= MULTIPLICATION_CAP) {
				break;
			}
			if (m.angleNorm === "" || usedAngles.has(m.angleNorm)) {
				continue;
			}
			usedAngles.add(m.angleNorm);
			selected.push(m);
		}
		if (selected.length >= 2) {
			const subjectRaw = selected[0].subjectRaw as string; // non-null within a group
			for (const m of selected) {
				out.push({ ...m.record, subject: subjectRaw, subjectKey });
			}
			for (const m of group) {
				if (!selected.includes(m)) {
					log.warn(
						"[publishing-suggestion/compute] dropped an extra same-subject angle (cap/duplicate)",
						{
							projectId: input.projectId,
							title: m.record.title,
							subjectKey,
						},
					);
				}
			}
		} else {
			// Demote to a singleton. Keep the record the selection loop validated
			// (selected[0] — it has a distinct non-blank angle) when one exists;
			// fall back to group[0] only when NO record carried a usable angle
			// (the zero-valid-angle case). This preserves the "retained subject
			// records are selected by distinct non-blank angles" rule even when a
			// blank-angle record sorts first (Codex final-review finding).
			const keep = selected[0] ?? group[0];
			out.push({ ...keep.record }); // singleton — record already has subject/subjectKey null
			for (const m of group) {
				if (m === keep) {
					continue;
				}
				log.warn(
					"[publishing-suggestion/compute] dropped a non-distinct same-subject record",
					{
						projectId: input.projectId,
						title: m.record.title,
						subjectKey,
					},
				);
			}
		}
	}

	return { topics: out };
}
