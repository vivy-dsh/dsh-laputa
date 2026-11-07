# Upstream notice

`dsh-laputa` is a DeepSeek Harness port of the host-independent parts of
**laputa**.

- Upstream: <https://github.com/ProjectViVy/laputa>
- Revision ported: `c4d649d`
- License: MIT

Ported semantics:

- the six opaque UTF-8 persona documents (`MISSION.MD`, `IDENTITY.MD`,
  `RELATIONSHIP.MD`, `REDLINE.MD`, `DREAM.MD`, `DARK.MD`);
- the fixed assembly order and `"\n\n"` join;
- the safe-read boundaries: no symlinks, no hardlinks, no world-writable
  files, per-file byte caps, strict UTF-8, and a required non-empty
  `MISSION.MD`;
- the total assembled character budget.

Not ported in Phase 1:

- `SOUL.md` generation, managed-SOUL digests, and version pinning;
- atomic source/SOUL apply, recovery, and rollback;
- the Hermes `background_review_persona_stage` integration;
- LLM-driven proposals, consent, and automatic writes.

Phase 1 is read-only: the plugin never modifies persona files.
