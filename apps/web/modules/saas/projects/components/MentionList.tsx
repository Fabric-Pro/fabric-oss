"use client";

import { UsersIcon } from "lucide-react";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

type MentionCandidate =
	| {
			kind: "user";
			id: string;
			name: string | null;
			email: string | null;
			avatarUrl: string | null;
	  }
	| {
			kind: "group";
			tag: string;
			label: string;
			memberCount: number;
	  };

interface MentionListProps {
	items: MentionCandidate[];
	command: (
		payload:
			| { kind: "user"; id: string; label: string }
			| { kind: "group"; groupTag: string; label: string },
	) => void;
	listboxId: string;
	setActiveDescendant: (index: number) => void;
}

export const MentionList = forwardRef<
	{ onKeyDown: (props: { event: KeyboardEvent }) => boolean },
	MentionListProps
>((props, ref) => {
	const [selectedIndex, setSelectedIndex] = useState(0);
	// Tracks the latest selectedIndex for keyboard handlers, which fire
	// outside React's render scheduling and otherwise see a stale closure
	// when multiple keypresses queue before a re-render.
	const selectedIndexRef = useRef(0);
	const itemsRef = useRef(props.items);

	useEffect(() => {
		setSelectedIndex(0);
		selectedIndexRef.current = 0;
		itemsRef.current = props.items;
	}, [props.items]);

	// Keep aria-activedescendant on the contenteditable in sync whenever the
	// selected index changes (including on initial mount).
	useEffect(() => {
		props.setActiveDescendant(selectedIndex);
	}, [selectedIndex, props.setActiveDescendant]);

	const select = (index: number) => {
		const item = props.items[index];
		if (!item) {
			return;
		}
		if (item.kind === "group") {
			props.command({
				kind: "group",
				groupTag: item.tag,
				label: item.label,
			});
		} else {
			props.command({
				kind: "user",
				id: item.id,
				label: item.name ?? "Unknown",
			});
		}
	};

	useImperativeHandle(ref, () => ({
		onKeyDown: ({ event }) => {
			const items = itemsRef.current;
			if (items.length === 0) {
				return false;
			}
			if (event.key === "ArrowUp") {
				const next =
					(selectedIndexRef.current + items.length - 1) %
					items.length;
				selectedIndexRef.current = next;
				setSelectedIndex(next);
				return true;
			}
			if (event.key === "ArrowDown") {
				const next = (selectedIndexRef.current + 1) % items.length;
				selectedIndexRef.current = next;
				setSelectedIndex(next);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				select(selectedIndexRef.current);
				return true;
			}
			return false;
		},
	}));

	const liveRegion = (
		<div role="status" aria-live="polite" className="sr-only">
			{props.items.length === 0
				? "No suggestions"
				: `${props.items.length} suggestion${props.items.length === 1 ? "" : "s"}`}
		</div>
	);

	if (props.items.length === 0) {
		return (
			<div className="mention-popover bg-card border border-border rounded-lg shadow-lg p-3 text-sm text-muted-foreground">
				{liveRegion}
				No matching members.
			</div>
		);
	}

	return (
		<div className="mention-popover bg-card border border-border rounded-lg shadow-lg overflow-hidden max-h-[320px] overflow-y-auto p-1 w-72">
			{liveRegion}
			<div
				role="listbox"
				aria-label="Mention suggestions"
				id={props.listboxId}
				className="list-none m-0 p-0"
			>
				{props.items.map((item, index) => (
					<div
						key={item.kind === "group" ? `g:${item.tag}` : item.id}
						id={`${props.listboxId}-opt-${index}`}
						role="option"
						aria-selected={index === selectedIndex}
						tabIndex={-1}
						onMouseEnter={() => {
							selectedIndexRef.current = index;
							setSelectedIndex(index);
						}}
						onClick={() => select(index)}
						className={`w-full flex items-center gap-3 px-3 py-2 rounded text-left transition-colors cursor-pointer ${
							index === selectedIndex
								? "bg-primary/10 text-primary"
								: "text-foreground hover:bg-muted"
						}`}
					>
						{item.kind === "group" ? (
							<>
								<span className="h-6 w-6 rounded-full bg-muted flex items-center justify-center overflow-hidden">
									<UsersIcon className="h-3.5 w-3.5 text-muted-foreground" />
								</span>
								<span className="flex-1 min-w-0">
									<span className="block text-sm font-medium truncate">
										{`${item.label} · ${item.memberCount}`}
									</span>
								</span>
							</>
						) : (
							<>
								<span className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium overflow-hidden">
									{item.avatarUrl ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={item.avatarUrl}
											alt=""
											className="h-6 w-6 object-cover"
										/>
									) : (
										(item.name ?? "?").slice(0, 1)
									)}
								</span>
								<span className="flex-1 min-w-0">
									<span className="block text-sm font-medium truncate">
										{item.name ?? "Unknown"}
									</span>
									{item.email ? (
										<span className="block text-xs text-muted-foreground truncate">
											{item.email}
										</span>
									) : null}
								</span>
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
});

MentionList.displayName = "MentionList";
