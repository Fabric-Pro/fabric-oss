import { Badge } from "@ui/components/badge";
import type { ParlumeRequest } from "../lib/parlume-format";

/**
 * Marks a speaker Fabric could not confirm as able to read the project: a
 * guest, whose words Parlume keeps but whose requests it does not take.
 * Members, and speakers Fabric has no word of yet, show no mark.
 */
export function ParlumeSpeakerMark({
	mark,
}: {
	mark: ParlumeRequest["speakerMark"];
}) {
	return mark === "guest" ? (
		<Badge
			variant="warning"
			title="Fabric could not confirm who this is. Parlume takes no request from them."
		>
			Unverified speaker
		</Badge>
	) : null;
}
