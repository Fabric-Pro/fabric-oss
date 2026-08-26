/**
 * Teams channel-meeting transcripts, by way of the recording in SharePoint.
 *
 * `GET /me/onlineMeetings/{id}/transcripts` answers HTTP 200 with an EMPTY
 * collection for channel meetings (`19:…@thread.tacv2`) — for attendees and for
 * the organizer alike — while ordinary meetings return their transcripts
 * normally through the very same call. Channel meetings were never a documented
 * surface for that API (`OnlineMeetingTranscript.Read.Chat` is documented to
 * exclude them), so the empty collection is the API declining rather than the
 * meeting lacking a transcript, and no field in the response tells the two
 * apart.
 *
 * The transcript itself is still reachable — text, timings and speaker names —
 * through the Stream media API hanging off the meeting *recording* in the
 * channel's SharePoint document library. This module walks that route:
 *
 *   joinUrl → channel thread id → team + channel → channel filesFolder (driveId)
 *     → Recordings folder → the recording for this occurrence
 *     → Stream `media/transcripts` → transcript JSON, speaker-attributed
 *
 * Every Graph hop uses an endpoint this package already calls under
 * already-consented delegated scopes (`Team.ReadBasic.All`,
 * `Channel.ReadBasic.All`, `Files.Read.All`, `Sites.Read.All`), so this adds no
 * permission and triggers no re-consent. Only the last two hops are hosted by
 * SharePoint rather than Graph, and those need a token issued for the SharePoint
 * resource — which the same refresh token yields.
 *
 * Constraint worth stating plainly: **only recorded meetings are reachable this
 * way.** The transcript is a media resource of the recording's driveItem, so a
 * meeting that was transcribed but not recorded has nothing to hang off.
 */

/** Injected `graphRequest` — carries token refresh and throttle backoff. */
export type GraphFetch = (
	url: string,
	options?: RequestInit,
) => Promise<Response>;

/** A transcript reachable through a meeting recording. */
interface RecordingTranscriptDescriptor {
	/**
	 * Dedup key. Derived from the recording's driveItem id, not from the Stream
	 * media id: one recording is one occurrence and its driveItem id is stable
	 * across calls, where nothing documents the media id as stable. Prefixed so
	 * it can never collide with a Graph transcript id.
	 */
	id: string;
	createdDateTime: string;
	driveId: string;
	recordingItemId: string;
	recordingWebUrl: string;
}

interface RecordingTranscriptEntry {
	speaker: string;
	text: string;
	start?: string;
	end?: string;
}

interface ChannelDriveLocation {
	teamId: string;
	channelId: string;
	driveId: string;
	/** Null when the channel has never had a recorded meeting. */
	recordingsFolderId: string | null;
}

interface RecordingFile {
	id: string;
	name: string;
	webUrl: string;
	lastModifiedDateTime?: string;
}

/**
 * How far a recording's own timestamp may sit from the calendar occurrence and
 * still be considered the same meeting. Generous on purpose: the recording is
 * stamped when Teams finished writing the file, calendar occurrences carry the
 * series' time, and timezone handling upstream has been wrong before. A daily
 * meeting's occurrences are 24h apart, so a ±12h window still resolves to
 * exactly one of them — and among several candidates the closest always wins.
 */
const RECORDING_MATCH_TOLERANCE_MS = 12 * 60 * 60 * 1000;

/** Bound on teams walked while resolving a channel thread to its team. */
const MAX_TEAMS_SCANNED = 200;

/** Most-recent recordings pulled per listing. */
const RECORDINGS_PAGE_SIZE = 100;

const CHANNEL_LOCATION_TTL_MS = 15 * 60 * 1000;
const CHANNEL_LOCATION_MISS_TTL_MS = 2 * 60 * 1000;

/**
 * Resolved channel locations, keyed by `userId:threadId`.
 *
 * Keyed by user because team membership is per-user: two people reading the same
 * channel meeting must each resolve it under their own token. (Nothing is
 * exposed by a shared entry — every read is still authorized by the caller's own
 * token — but a per-user key keeps that property obvious rather than incidental.)
 *
 * A sync cycle calls in once per occurrence, so without this the same four Graph
 * hops would repeat for every occurrence of every recurring meeting, every hour.
 */
const channelLocationCache = new Map<
	string,
	{ value: ChannelDriveLocation | null; expiresAt: number }
>();

/**
 * SharePoint access tokens, keyed by `integrationId:host`.
 *
 * Not merely a saving: every exchange rotates the refresh token, so without this
 * a single sync cycle would rotate it once per occurrence.
 */
const sharePointTokenCache = new Map<
	string,
	{ token: string; expiresAt: number }
>();

/** Discard a token this many ms before it actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/**
 * Pull the channel thread id out of a Teams meeting join URL, when the URL
 * belongs to a channel meeting. Returns null for ordinary meetings — whose
 * transcripts the Graph API serves normally and which must not be routed here.
 */
export function extractChannelThreadId(joinUrl: string): string | null {
	const match = joinUrl.match(/meetup-join\/([^/?]+)/);
	if (!match?.[1]) {
		return null;
	}
	let threadId: string;
	try {
		threadId = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	return threadId.includes("@thread.tacv2") ? threadId : null;
}

/** Reduce a subject or filename to comparable form. */
function normalizeForMatch(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Read the UTC timestamp Teams embeds in a recording's filename, which follows
 * `<Subject>-<YYYYMMDD>_<HHMMSS>UTC-Meeting Recording.mp4`.
 *
 * Exported for testing.
 */
export function parseRecordingTimestamp(fileName: string): number | null {
	const match = fileName.match(/(\d{8})_(\d{6})UTC/);
	if (!match) {
		return null;
	}
	const [, date, time] = match;
	const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : null;
}

export interface SelectRecordingParams {
	recordings: RecordingFile[];
	meetingSubject: string;
	occurrenceMs: number;
}

/**
 * Pick the recording belonging to one occurrence.
 *
 * A channel's Recordings folder holds every recorded meeting of that channel, so
 * both the subject and the time have to agree. Candidates matching the subject
 * are preferred outright; time alone decides only when nothing matches by name
 * (a meeting renamed after the fact), and among equals the closest in time wins.
 *
 * Exported for testing.
 */
export function selectRecordingForOccurrence(
	params: SelectRecordingParams,
): RecordingFile | null {
	const { recordings, meetingSubject, occurrenceMs } = params;
	const normalizedSubject = normalizeForMatch(meetingSubject);

	const candidates = recordings
		.map((recording) => {
			const timestamp = parseRecordingTimestamp(recording.name);
			if (timestamp === null) {
				return null;
			}
			const delta = Math.abs(timestamp - occurrenceMs);
			if (delta > RECORDING_MATCH_TOLERANCE_MS) {
				return null;
			}
			const subjectMatches =
				normalizedSubject.length > 0 &&
				normalizeForMatch(recording.name).startsWith(normalizedSubject);
			return { recording, delta, subjectMatches };
		})
		.filter((candidate) => candidate !== null);

	if (candidates.length === 0) {
		return null;
	}

	const named = candidates.filter((candidate) => candidate.subjectMatches);
	const pool = named.length > 0 ? named : candidates;
	pool.sort((a, b) => a.delta - b.delta);
	return pool[0].recording;
}

/**
 * Split a driveItem's webUrl into the SharePoint origin and site path the
 * `_api/v2.1` endpoints live under — `https://host/sites/Foo/…` yields
 * `https://host` and `/sites/Foo`. Both are per-tenant and must always be
 * derived, never assumed.
 *
 * Exported for testing.
 */
export function parseSharePointSite(
	webUrl: string,
): { origin: string; sitePath: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(webUrl);
	} catch {
		return null;
	}
	const segments = parsed.pathname.split("/").filter(Boolean);
	if (segments.length < 2) {
		// A drive hanging off the tenant root rather than a site collection.
		return { origin: parsed.origin, sitePath: "" };
	}
	const [first, second] = segments;
	if (first !== "sites" && first !== "teams") {
		return { origin: parsed.origin, sitePath: "" };
	}
	return {
		origin: parsed.origin,
		sitePath: `/${first}/${decodeURIComponent(second)}`,
	};
}

/** Resolve a channel thread id to the team, channel and drive that back it. */
async function resolveChannelLocation(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	threadId: string;
	userId: string;
}): Promise<ChannelDriveLocation | null> {
	const { graphFetch, graphBaseUrl, threadId, userId } = params;
	const cacheKey = `${userId}:${threadId}`;
	const cached = channelLocationCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.value;
	}

	const location = await resolveChannelLocationUncached({
		graphFetch,
		graphBaseUrl,
		threadId,
	});
	channelLocationCache.set(cacheKey, {
		value: location,
		expiresAt:
			Date.now() +
			(location ? CHANNEL_LOCATION_TTL_MS : CHANNEL_LOCATION_MISS_TTL_MS),
	});
	return location;
}

/**
 * Every request here deliberately mirrors a call shape already running in
 * production — `list_teams`, `list_channels` and `get_shared_files` respectively.
 * An unproven query option is not a small risk in this path: Graph answers a
 * rejected one with a non-2xx, which reads here as "this team doesn't own the
 * channel", and the fallback would then quietly never fire in any tenant while
 * every test stayed green. So: no `$top` on `joinedTeams`, the channel found by
 * matching a listing rather than addressed by id in a path, and the channel id
 * interpolated raw — exactly as `get_shared_files` has done all along.
 */
async function resolveChannelLocationUncached(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	threadId: string;
}): Promise<ChannelDriveLocation | null> {
	const { graphFetch, graphBaseUrl, threadId } = params;

	const teamsRes = await graphFetch(
		`${graphBaseUrl}/me/joinedTeams?$select=id,displayName`,
	);
	if (!teamsRes.ok) {
		console.warn(
			`[MicrosoftTeams] Could not list joined teams while resolving a channel meeting: ${teamsRes.status}`,
		);
		return null;
	}
	const teamsData = (await teamsRes.json()) as { value?: { id: string }[] };
	const teams = (teamsData.value ?? []).slice(0, MAX_TEAMS_SCANNED);

	for (const team of teams) {
		const channelsRes = await graphFetch(
			`${graphBaseUrl}/teams/${team.id}/channels?$select=id,displayName`,
		);
		if (!channelsRes.ok) {
			continue;
		}
		const channelsData = (await channelsRes.json()) as {
			value?: { id: string }[];
		};
		const owns = (channelsData.value ?? []).some(
			(channel) => channel.id === threadId,
		);
		if (!owns) {
			continue;
		}

		const folderRes = await graphFetch(
			`${graphBaseUrl}/teams/${team.id}/channels/${threadId}/filesFolder`,
		);
		if (!folderRes.ok) {
			console.warn(
				`[MicrosoftTeams] Channel resolved but its files folder did not: ${folderRes.status}`,
			);
			return null;
		}
		const folder = (await folderRes.json()) as {
			id?: string;
			parentReference?: { driveId?: string };
		};
		if (!folder.id || !folder.parentReference?.driveId) {
			return null;
		}

		// A channel with no Recordings folder is resolved, not unresolvable —
		// it simply has never had a recorded meeting, which is the ordinary case
		// and must not be reported as a membership problem. Carried as null so
		// the caller can say which of the two it is.
		return {
			teamId: team.id,
			channelId: threadId,
			driveId: folder.parentReference.driveId,
			recordingsFolderId: await findRecordingsFolderId({
				graphFetch,
				graphBaseUrl,
				driveId: folder.parentReference.driveId,
				filesFolderId: folder.id,
			}),
		};
	}

	return null;
}

/**
 * Locate the channel's `Recordings` folder by listing the channel folder, rather
 * than addressing it by path. Same reasoning as above: `filesFolder/children` is
 * the listing `get_shared_files` already runs, where `items/{id}:/Recordings:/`
 * path addressing is not exercised anywhere in this codebase. Resolved once and
 * cached with the rest of the location.
 */
async function findRecordingsFolderId(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	filesFolderId: string;
}): Promise<string | null> {
	const { graphFetch, graphBaseUrl, driveId, filesFolderId } = params;
	const res = await graphFetch(
		`${graphBaseUrl}/drives/${driveId}/items/${filesFolderId}/children?$select=id,name,folder`,
	);
	if (!res.ok) {
		console.warn(
			`[MicrosoftTeams] Could not list the channel folder: ${res.status}`,
		);
		return null;
	}
	const data = (await res.json()) as {
		value?: { id: string; name?: string; folder?: unknown }[];
	};
	const recordings = (data.value ?? []).find(
		(child) => child.folder && child.name?.toLowerCase() === "recordings",
	);
	return recordings?.id ?? null;
}

/**
 * List the channel's most recent recordings.
 *
 * Ordered newest-first deliberately: the folder listing is alphabetical by
 * default, which for a long-running recurring meeting buries the recent
 * recordings pages deep.
 */
async function listRecentRecordings(params: {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	driveId: string;
	recordingsFolderId: string;
}): Promise<RecordingFile[]> {
	const { graphFetch, graphBaseUrl, driveId, recordingsFolderId } = params;
	const base = `${graphBaseUrl}/drives/${driveId}/items/${recordingsFolderId}/children?$select=id,name,webUrl,lastModifiedDateTime&$top=${RECORDINGS_PAGE_SIZE}`;

	let res = await graphFetch(`${base}&$orderby=lastModifiedDateTime desc`);
	if (!res.ok && res.status !== 404) {
		// Not every drive accepts $orderby on children; an unordered page is
		// still better than nothing.
		res = await graphFetch(base);
	}
	if (!res.ok) {
		if (res.status !== 404) {
			console.warn(
				`[MicrosoftTeams] Could not list channel recordings: ${res.status}`,
			);
		}
		return [];
	}

	const data = (await res.json()) as { value?: RecordingFile[] };
	return (data.value ?? []).filter((item) => Boolean(item?.id && item?.name));
}

interface SharePointTokenParams {
	refreshToken: string;
	integrationId: string;
	origin: string;
	onRefreshTokenRotated: (newRefreshToken: string) => Promise<void>;
}

/**
 * Exchange the stored refresh token for one issued against the SharePoint
 * resource. No new consent is involved: the app's delegated permissions are
 * mirrored onto the SharePoint resource, so `.default` yields what is already
 * granted.
 *
 * Entra issues a fresh refresh token on every redemption, so the rotated value
 * is handed back for persistence — dropping it would leave the stored token
 * one redemption behind and risk breaking the whole connection.
 */
async function acquireSharePointToken(
	params: SharePointTokenParams,
): Promise<string> {
	const { refreshToken, integrationId, origin, onRefreshTokenRotated } =
		params;
	const cacheKey = `${integrationId}:${origin}`;
	const cached = sharePointTokenCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.token;
	}

	const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
	const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error(
			"Microsoft Graph OAuth not configured. Missing MICROSOFT_GRAPH_CLIENT_ID or MICROSOFT_GRAPH_CLIENT_SECRET.",
		);
	}

	const response = await fetch(
		"https://login.microsoftonline.com/common/oauth2/v2.0/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
				scope: `${origin}/.default`,
			}),
		},
	);

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Failed to acquire SharePoint token: ${response.status} - ${detail.slice(0, 300)}`,
		);
	}

	const tokens = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};
	if (!tokens.access_token) {
		throw new Error(
			"Invalid token response from Microsoft: missing access_token",
		);
	}

	const expiresInMs = (tokens.expires_in ?? 3600) * 1000;
	sharePointTokenCache.set(cacheKey, {
		token: tokens.access_token,
		expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_MARGIN_MS,
	});

	if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
		await onRefreshTokenRotated(tokens.refresh_token);
	}

	return tokens.access_token;
}

/** One `media/transcripts` entry, as SharePoint returns it. */
interface StreamMediaTranscript {
	id: string;
	size?: number;
	languageTag?: string;
	temporaryDownloadUrl?: string;
}

async function listStreamTranscripts(params: {
	sharePointToken: string;
	origin: string;
	sitePath: string;
	driveId: string;
	itemId: string;
}): Promise<StreamMediaTranscript[]> {
	const { sharePointToken, origin, sitePath, driveId, itemId } = params;
	const res = await fetch(
		`${origin}${sitePath}/_api/v2.1/drives/${driveId}/items/${itemId}/media/transcripts`,
		{ headers: { Authorization: `Bearer ${sharePointToken}` } },
	);
	if (!res.ok) {
		if (res.status === 404) {
			return [];
		}
		throw new Error(
			`SharePoint media transcripts request failed: ${res.status}`,
		);
	}
	const data = (await res.json()) as { value?: StreamMediaTranscript[] };
	return (data.value ?? []).filter((entry) => Boolean(entry?.id));
}

/**
 * Of the transcripts on one recording, take the substantial one. Multiple
 * entries are rare (alternate languages); the largest is the meeting's own.
 */
function pickPrimaryTranscript(
	transcripts: StreamMediaTranscript[],
): StreamMediaTranscript | null {
	if (transcripts.length === 0) {
		return null;
	}
	return [...transcripts].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
}

export interface ListRecordingTranscriptsParams {
	graphFetch: GraphFetch;
	graphBaseUrl: string;
	joinUrl: string;
	meetingSubject: string;
	meetingDate: string;
	userId: string;
}

export interface ListRecordingTranscriptsResult {
	transcripts: RecordingTranscriptDescriptor[];
	/** Why nothing came back, for a caller that must explain itself. */
	diagnostic?: string;
}

/**
 * Find the recording-backed transcript for one occurrence of a channel meeting.
 *
 * Returns at most one descriptor: one occurrence is one recording. Never throws
 * for an ordinary "nothing here" outcome — an unresolvable channel, a channel
 * with no Recordings folder and an occurrence that was not recorded all come
 * back as an empty list with a diagnostic, because this runs as a fallback and
 * must not turn a quiet miss into a failed sync.
 */
export async function listRecordingTranscripts(
	params: ListRecordingTranscriptsParams,
): Promise<ListRecordingTranscriptsResult> {
	const {
		graphFetch,
		graphBaseUrl,
		joinUrl,
		meetingSubject,
		meetingDate,
		userId,
	} = params;

	const threadId = extractChannelThreadId(joinUrl);
	if (!threadId) {
		return {
			transcripts: [],
			diagnostic: "Not a channel meeting join URL.",
		};
	}

	const occurrenceMs = Date.parse(meetingDate);
	if (!Number.isFinite(occurrenceMs)) {
		return {
			transcripts: [],
			diagnostic: `Unusable meeting date: ${meetingDate}`,
		};
	}

	const location = await resolveChannelLocation({
		graphFetch,
		graphBaseUrl,
		threadId,
		userId,
	});
	if (!location) {
		return {
			transcripts: [],
			diagnostic:
				"Could not resolve the Teams channel behind this meeting — the connected account may not be a member of the team that owns it.",
		};
	}

	// Distinct from the above on purpose: the channel resolved fine, it has just
	// never had a recorded meeting. Reporting that as a membership problem would
	// send someone chasing permissions that are working.
	if (!location.recordingsFolderId) {
		return {
			transcripts: [],
			diagnostic:
				"This channel has no Recordings folder — only recorded meetings can be reached this way.",
		};
	}

	const recordings = await listRecentRecordings({
		graphFetch,
		graphBaseUrl,
		driveId: location.driveId,
		recordingsFolderId: location.recordingsFolderId,
	});
	if (recordings.length === 0) {
		return {
			transcripts: [],
			diagnostic:
				"The channel's Recordings folder is empty — only recorded meetings can be reached this way.",
		};
	}

	const recording = selectRecordingForOccurrence({
		recordings,
		meetingSubject,
		occurrenceMs,
	});
	if (!recording) {
		return {
			transcripts: [],
			diagnostic:
				"No recording matches this occurrence — the meeting was most likely not recorded.",
		};
	}

	return {
		transcripts: [
			{
				id: `stream:${recording.id}`,
				createdDateTime:
					recording.lastModifiedDateTime ??
					new Date(occurrenceMs).toISOString(),
				driveId: location.driveId,
				recordingItemId: recording.id,
				recordingWebUrl: recording.webUrl,
			},
		],
	};
}

export interface GetRecordingTranscriptContentParams {
	driveId: string;
	recordingItemId: string;
	recordingWebUrl: string;
	refreshToken: string;
	integrationId: string;
	onRefreshTokenRotated: (newRefreshToken: string) => Promise<void>;
}

export interface GetRecordingTranscriptContentResult {
	entries: RecordingTranscriptEntry[];
	speakerCount: number;
}

/**
 * Download a recording's transcript, speaker-attributed.
 *
 * The `&format=json` on the download URL is the whole trick: the URL as issued
 * serves WebVTT with no speaker information, and the same URL with that
 * parameter serves the Stream transcript schema, where every entry carries
 * `speakerDisplayName`.
 */
export async function getRecordingTranscriptContent(
	params: GetRecordingTranscriptContentParams,
): Promise<GetRecordingTranscriptContentResult> {
	const {
		driveId,
		recordingItemId,
		recordingWebUrl,
		refreshToken,
		integrationId,
		onRefreshTokenRotated,
	} = params;

	const site = parseSharePointSite(recordingWebUrl);
	if (!site) {
		throw new Error(
			"Could not derive the SharePoint site from the recording URL.",
		);
	}

	const sharePointToken = await acquireSharePointToken({
		refreshToken,
		integrationId,
		origin: site.origin,
		onRefreshTokenRotated,
	});

	const transcripts = await listStreamTranscripts({
		sharePointToken,
		origin: site.origin,
		sitePath: site.sitePath,
		driveId,
		itemId: recordingItemId,
	});
	const primary = pickPrimaryTranscript(transcripts);
	if (!primary?.temporaryDownloadUrl) {
		return { entries: [], speakerCount: 0 };
	}

	const separator = primary.temporaryDownloadUrl.includes("?") ? "&" : "?";
	const res = await fetch(
		`${primary.temporaryDownloadUrl}${separator}format=json`,
		{ headers: { Authorization: `Bearer ${sharePointToken}` } },
	);
	if (!res.ok) {
		throw new Error(`Transcript download failed: ${res.status}`);
	}

	const data = (await res.json()) as {
		entries?: {
			text?: string;
			speakerDisplayName?: string;
			startOffset?: string;
			endOffset?: string;
		}[];
	};

	const speakers = new Set<string>();
	const entries: RecordingTranscriptEntry[] = (data.entries ?? [])
		.filter((entry) => Boolean(entry?.text))
		.map((entry) => {
			const speaker = entry.speakerDisplayName || "Unknown";
			speakers.add(speaker);
			return {
				speaker,
				text: entry.text as string,
				start: entry.startOffset,
				end: entry.endOffset,
			};
		});

	return { entries, speakerCount: speakers.size };
}
