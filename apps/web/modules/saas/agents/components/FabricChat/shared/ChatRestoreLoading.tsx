import { Spinner } from "@shared/components/Spinner";

export function ChatRestoreLoading() {
	return (
		<output className="flex h-full items-center justify-center">
			<Spinner />
			<span className="sr-only">Loading conversation</span>
		</output>
	);
}
