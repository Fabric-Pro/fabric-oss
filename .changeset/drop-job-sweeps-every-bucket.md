---
"fabric-app": patch
---

Sweep every storage bucket when dropping a user's personal files, not just one

The job read an `S3_BUCKET_NAME` the application does not define, falling back to the avatars bucket. Personal files live in seven buckets — avatars, chat documents, project contexts, workspace documents, skills, document assets and QA run evidence — so it deleted a user's avatar, reported their files removed, and cleared them for the row sweep while six buckets of their content stayed behind.

Every bucket name carries a default in config, so there is no "not configured" state to fall back from; what can fail is reaching one, and that refuses the user rather than passing them on — the same rule the vector delete follows.

Found because a staging run refused all sixty-nine users for a missing variable that was never going to exist.
