import { Card } from "@ui/components/card";
import {
	AudioLinesIcon,
	MicIcon,
	NotebookTabsIcon,
	ShieldCheckIcon,
} from "lucide-react";
import { CARD_TITLE, MONO_LABEL } from "../lib/parlume-styles";

const WAKE_PHRASES = ["Hey Fabric", "Hey Parlume", "Hey Fabric Parlume"];

const CAPABILITIES = [
	{
		icon: MicIcon,
		text: "Records and transcribes meeting audio.",
	},
	{
		icon: AudioLinesIcon,
		text: "Replies in an AI-generated voice. Another speaker can interrupt it.",
	},
	{
		icon: NotebookTabsIcon,
		text: "Saves a project-scoped transcript and meeting notes to Context afterwards.",
	},
	{
		icon: ShieldCheckIcon,
		text: "Logs every request, change and outcome under Requests. Speaker labels come from Teams.",
	},
];

/** What Parlume does once it is in the room; the invite form links here. */
export function ParlumeHowItWorks() {
	return (
		<Card id="pr-how" className="scroll-mt-6 space-y-4.5 px-6 pt-5.5 pb-6">
			<h3 className={CARD_TITLE}>In the meeting</h3>
			<div className="space-y-2">
				<span className={`block ${MONO_LABEL}`}>
					Say one of these to ask
				</span>
				<ul className="flex flex-wrap gap-1.5">
					{WAKE_PHRASES.map((phrase) => (
						<li
							key={phrase}
							className="whitespace-nowrap rounded-[4px] border border-border bg-muted/40 px-2 py-[3px] font-mono text-xs"
						>
							{phrase}
						</li>
					))}
				</ul>
				<p className="text-xs text-muted-foreground">
					Any attendee can use them to reach the selected agent and
					its connected knowledge.
				</p>
			</div>
			<ul className="space-y-3.5 border-t border-border pt-4">
				{CAPABILITIES.map(({ icon: Icon, text }) => (
					<li
						key={text}
						className="flex gap-3 text-[13px] leading-[19px]"
					>
						<Icon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span>{text}</span>
					</li>
				))}
			</ul>
			<p className="text-xs text-muted-foreground">
				Review your meeting policies and tell participants before
				inviting it.
			</p>
		</Card>
	);
}
