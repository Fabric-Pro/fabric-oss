/**
 * How long the bot waits in a Teams lobby to be admitted before it gives up.
 * The provider bills that wait as bot time. By default Teams holds a bot it
 * detects in the lobby until the organizer, or a presenter where the meeting
 * allows it, admits it, and the Parlume page asks whoever is watching to do
 * so. Auto-join asks to join a minute before the meeting starts, so five
 * minutes still covers an organizer who arrives four minutes late. Kept free
 * of imports: the Parlume page reads it too.
 */
export const PARLUME_LOBBY_WAIT_SECONDS = 300;
