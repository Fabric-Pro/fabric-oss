import type { ParlumeSpeakerUpdate } from "./parlume-stream-auth";

const RETAIN_MS = 5 * 60 * 1000;
// Speaker state is observed in the meeting page, audio a moment later on the
// wire; a little slack keeps a short turn from missing its speaker.
const ALIGNMENT_SLACK_MS = 750;
const RECENT_SPEAKER_MS = 10_000;

export interface ParlumeSpeaker {
	name: string;
	id: string | null;
}

interface SpeakingInterval extends ParlumeSpeaker {
	start: number;
	end: number | null;
}

function sameSpeaker(a: ParlumeSpeaker, b: ParlumeSpeaker): boolean {
	return a.id !== null && b.id !== null ? a.id === b.id : a.name === b.name;
}

/**
 * The provider streams one mixed meeting track and reports separately who is
 * speaking. A transcribed turn belongs to the participant who spoke longest
 * during it, or else to whoever last started speaking before it ended.
 */
export class ParlumeSpeakerTimeline {
	private intervals: SpeakingInterval[] = [];

	update(updates: ParlumeSpeakerUpdate[]): void {
		for (const update of updates) {
			const open = this.intervals.find(
				(interval) =>
					interval.end === null && sameSpeaker(interval, update),
			);
			if (update.isSpeaking && !open) {
				this.intervals.push({
					name: update.name,
					id: update.id,
					start: update.timestamp,
					end: null,
				});
			} else if (!update.isSpeaking && open) {
				open.end = Math.max(open.start, update.timestamp);
			}
		}
		const newest = Math.max(
			0,
			...updates.map((update) => update.timestamp),
		);
		this.intervals = this.intervals.filter(
			(interval) =>
				interval.end === null || interval.end >= newest - RETAIN_MS,
		);
	}

	attribute(startMs: number, endMs: number): ParlumeSpeaker | null {
		const from = startMs - ALIGNMENT_SLACK_MS;
		const to = endMs + ALIGNMENT_SLACK_MS;
		let best: SpeakingInterval | null = null;
		let bestOverlap = 0;
		for (const interval of this.intervals) {
			const overlap =
				Math.min(interval.end ?? to, to) -
				Math.max(interval.start, from);
			if (overlap > bestOverlap) {
				best = interval;
				bestOverlap = overlap;
			}
		}
		if (!best) {
			for (const interval of this.intervals) {
				if (
					interval.start <= to &&
					to - (interval.end ?? to) <= RECENT_SPEAKER_MS &&
					(!best || interval.start > best.start)
				) {
					best = interval;
				}
			}
		}
		return best ? { name: best.name, id: best.id } : null;
	}
}
