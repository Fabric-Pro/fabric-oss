import { Skeleton } from "@ui/components/skeleton";

/**
 * The wait, shaped like what follows it (Fizzy #2340).
 *
 * This list is the landing surface for a project manager and its one read
 * crosses every project they can reach, so the wait is long enough to be
 * looked at. A centred spinner tells that reader nothing and then reflows the
 * page under them when rows arrive; rows-in-outline hold the layout and say
 * what is coming.
 */
export function TodoListSkeleton({ rows = 5 }: { rows?: number }) {
	return (
		<div className="space-y-2" data-testid="todo-list-skeleton">
			{Array.from({ length: rows }, (_, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder, nothing reorders
					key={index}
					className="flex items-start gap-3 rounded-lg border p-3"
				>
					<Skeleton className="size-5 shrink-0 rounded-full" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-3 w-1/2" />
					</div>
					<Skeleton className="hidden h-6 w-28 shrink-0 rounded-full sm:block" />
				</div>
			))}
		</div>
	);
}
