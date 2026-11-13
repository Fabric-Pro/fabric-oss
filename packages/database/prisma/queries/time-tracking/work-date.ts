/**
 * Work dates cross the time-tracking query boundary as `YYYY-MM-DD` strings.
 * The columns are DATEs, which Prisma reads and writes as midnight UTC, so
 * the conversion is exact and never passes through a viewer's time zone.
 *
 * Shared by the entry and suggestion queries; not part of the package's
 * exports.
 */

export function workDateToDb(workDate: string): Date {
	return new Date(`${workDate}T00:00:00.000Z`);
}

export function workDateFromDb(workDate: Date): string {
	return workDate.toISOString().slice(0, 10);
}
