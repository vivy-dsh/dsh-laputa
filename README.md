# dsh-laputa

Phase 1 of the [laputa](https://github.com/ProjectViVy/laputa) port for DeepSeek
Harness: **manual persona editing, guided first-run setup, a same-level web
panel, system-prompt injection, and immutable revisions with compare-and-swap
publishing and rollback**.

The plugin reads six Markdown documents from the persona directory, joins them
in a fixed order, and contributes the result to the system prompt of every
top-level agent. The directory is an editable draft; the injected text comes
from the live immutable revision until someone publishes the draft. While
`IDENTITY.MD` or `MISSION.MD` is blank, it injects onboarding instructions
instead and exposes `laputa_init`, a create-only tool that fills missing files.
Neither path changes tool permissions or approval rules.

## Install in this template

```sh
npm run stop                                  # required while the panel runs
npm run setup:laputa                          # build only
npm run setup:laputa -- --init vivy           # create an empty persona and enable it
npm run setup:laputa -- --init vivy --no-enable
npm run setup:laputa -- --verify              # import check only
```

`--init` creates `.artifacts/dsh-home/laputa/vivy/` with `0700` and six empty
`0600` files, then writes an `- id: laputa` entry into the profile
`cordis.patch.yml` (backed up as `cordis.patch.pre-laputa.yml`). Existing files
are never overwritten, so re-running `--init` is safe.

Use `--data-root <dir>` to keep personas somewhere else inside the project; the
profile then records that absolute path as `sourceDir`. `--force` rebuilds the
plugin, and `--registry <url>` overrides the package registry for the install.

## Guided first run

With the plugin enabled and an empty template, the first conversation guides
the user through two questions, one at a time:

1. **Who am I?** — `IDENTITY.MD`: a name if desired, plus identity, tone, and
   values. A name alone is acceptable.
2. **What is my mission?** — `MISSION.MD`: what this agent exists to do.

The user can then choose an advanced setup and add `RELATIONSHIP.MD` (how the
agent and user relate) and `REDLINE.MD` (hard boundaries). `DREAM.MD` and
`DARK.MD` are never asked as questions: the agent drafts them from the
conversation and writes them in the same `laputa_init` call.

`laputa_init` only fills files that are missing or empty. A file with content
is preserved verbatim, so the model cannot rewrite a persona the user already
wrote. The tool takes no path arguments; the target always comes from the
plugin binding.

An uninitialized persona is a normal state, not an activation error. Unsafe
sources (symlinks, world-writable files, invalid UTF-8, over-budget files) still
fail visibly.

## Management panel

The web panel appears in the DSH sidebar at the same level as Superagent,
voice, memory, and mempalace, under the label **人格**.

- **Overview** shows whether injection is enabled, whether the persona is
  initialized, the live revision (`rN`), the retention policy, and whether the
  draft has unpublished changes, pending files, directory, character count,
  fingerprint, last read, and the last boundary error. While uninitialized it
  repeats the two setup questions.
- **Files** edits the six documents as a draft. Each save replaces one file,
  keeps `0600`/`0700` permissions, and checks the per-file byte and total
  character budgets. A save does not change the injected persona.
- **Publish draft** creates a new immutable revision from the draft. The
  request carries the expected base revision and draft digest; if either
  changed first, the panel reports a conflict and refreshes instead of
  overwriting.
- **History** lists immutable revisions newest first with `rN`, origin
  (`初始版本`, `发布基于 rN`, or `回滚自 rN`), creation time, and the current
  badge. Selecting a revision asks the server for its manifest and a bounded
  line diff from the live revision (`当前 rM → rN`); the panel receives hunks
  and counts, never the six full file bodies. Unchanged files are marked
  `无变化`; an oversized difference is reduced to a whole-file marker.
- **Rollback** from the History detail creates a new revision through the same
  owner API as `/laputa rollback`, then restores the draft to the target
  content. The panel confirms first and warns that unpublished draft edits will
  be lost. A stale base revision or draft digest returns a conflict and only
  refreshes the view.
- Saves carry the digest that was loaded. If another process or the
  `laputa_init` tool changed the file first, the panel returns a conflict and
  asks you to reload instead of overwriting.
- Blanking `IDENTITY.MD` or `MISSION.MD` is allowed after a confirmation. The
  draft returns to guided setup and cannot be published until refilled; the
  live revision and running sessions are unchanged.
- The panel never changes the profile, so enabling the plugin or switching
  personas still uses `npm run setup:laputa`.
- The API is loopback-only, same-origin, requires the DSH session check, and
  only accepts the six known file names. It never accepts a path.

## Persona directory

Default: `$DSH_HOME/laputa/<personaId>/` — in this template
`.artifacts/dsh-home/laputa/<personaId>/`.

| File | Gates initialization | Empty allowed | Purpose |
|---|---|---|---|
| `MISSION.MD` | yes | no | why the persona exists |
| `IDENTITY.MD` | yes | no | identity, voice, style |
| `RELATIONSHIP.MD` | no | yes | how it relates to the user |
| `REDLINE.MD` | no | yes | user boundaries and refusals |
| `DREAM.MD` | no | yes | aspirations and direction |
| `DARK.MD` | no | yes | fears and shadow |

The files are opaque text — no frontmatter, headings, or truncation. They are
joined in the order above with `"\n\n"`; empty and absent files are skipped.
The assembled text must stay within `maxPersonaChars` and each source file
within `maxSourceBytes`.

## Revision state

Revision state lives outside the editable persona directory:

```text
$DSH_HOME/laputa/.state/<personaId>/
  current.json              # live pointer, replaced atomically
  revisions/
    r000001/
      manifest.json
      MISSION.MD ... DARK.MD
    r000002/
  .revision.lock            # short-lived advisory lock
```

`stateDir` overrides this location and must be an absolute path outside the
persona directory. The default is used even when `sourceDir` points elsewhere,
so a read-only or git-managed persona source never receives runtime state.

- The draft is the six files in the persona directory. While a store exists,
  the draft is never injected directly.
- Publishing copies the draft byte-for-byte into a new `rNNNNNN` directory,
  writes `manifest.json`, then atomically replaces `current.json`. Revision
  directories are immutable after creation.
- `contentDigest` is SHA-256 over the six fixed-order name and file-digest
  pairs. The same function fingerprints the draft.
- `current.json` records the revision, directory name, manifest digest, and
  update time. Every load re-verifies the pointer, manifest, and six files; a
  mismatch raises `revision_state_corrupt` instead of falling back silently.
- On startup, a missing pointer with existing revisions adopts the highest
  complete revision; an initialized draft with no state becomes `r000001`. An
  uninitialized draft creates no state.
- Rollback copies the target revision into a new revision (`parent` and
  `restoredFrom` are recorded), moves the pointer, then restores the draft.
  Older revisions are kept unless a retention window prunes them (see
  「保留策略」).
- Publish, rollback, and bootstrap hold a synchronous fail-fast lock. A live,
  fresh holder returns `revision_lock_timeout`; a dead pid or a lock older
  than 30 seconds is taken over once.
- Directories are `0700` and files `0600`; symlinks, hardlinks, world-writable
  entries, invalid UTF-8, and over-budget content are refused.

## 保留策略

`retainRevisions` sets how many revisions survive a publish or rollback. The
default `0` keeps every revision:

```yaml
config:
  retainRevisions: 20   # 0 = 保留全部版本
```

- 保留数**包含**本次即将创建的新版本：`retainRevisions: 3` 在发布后保留最新的
  三个版本，更早的版本目录被删除。
- 发布或回滚在创建新版本**之前**逐个重新校验待清理的旧版本。任何一个候选损坏，
  整次操作以 `revision_state_corrupt` 失败：新版本不创建、`current.json` 不变、
  草稿不变。
- 只有新版本写入成功、`current.json` 原子替换且（回滚时）草稿恢复之后，才删除
  候选目录并 fsync `revisions/`。活版本永远不在删除范围内。
- 无操作的发布（草稿内容与活版本一致）不创建版本，也不清理；首次写入
  `r000001` 的初始化同样不清理。
- 被清理的版本不再是回滚目标，也不会出现在 `/laputa revisions` 或面板历史里。
- 面板概览与 `/status` 响应显示当前策略：`保留最近 N 个版本` 或
  `保留全部版本`。

## 版本来源

Every revision manifest carries an optional `source` field naming who asked for
the revision and, optionally, what the request was:

```json
{ "actor": "tool", "note": "laputa_init" }
```

The actor is one of `panel` (the panel's publish or rollback), `tool`
(`laputa_init`), `command` (`/laputa publish` or `/laputa rollback`), or
`bootstrap` (the first revision created from an initialized draft). `note` is
free text and optional.

Manifests written before this field existed still load and report no source. A
source that is not an object, names an unknown actor, or carries an empty note
makes the revision unreadable: it raises `revision_state_corrupt` instead of
being ignored.

The panel's version history and revision detail show the actor label (面板 /
助手工具 / 命令 / 首次初始化) plus the note.

## Publishing and running sessions

A draft edit becomes live only through an explicit publish: the panel's
**发布草稿** button, `/laputa publish`, or `laputa_init` after guided setup.
`laputa_init` is the only automatic publish path.

Every top-level agent pins the live revision when it is installed. Publish and
rollback move the pointer for new sessions only; running sessions keep the text
they started with. `/laputa reload` refreshes the invoking session; the panel's
"重新读取" refreshes the cache without moving existing pins.

The panel is a projection: it loads revision manifests and server-computed
bounded diffs from `/dsh-laputa/api/revision`, and rollback posts to the owner
API. It never reads revision files itself, never writes them directly, and
never receives the six full file bodies through the revision endpoint.

A malformed draft edit does not break a running session: the live revision is
unaffected, the error is recorded, and publish refuses with a boundary error.
Corrupt revision state is recorded and falls back to the last good text or
onboarding; it does not block plugin activation.

Useful commands in a session:

```text
/laputa status        # enabled, live revision, draft sync state, sizes, chars, last error
/laputa validate      # re-check the draft and live revision without touching the cache
/laputa reload        # refresh the invoking session's pinned revision
/laputa init          # show the two setup questions and the remaining draft files
/laputa publish       # publish the draft with an expected-base-revision check
/laputa revisions     # list immutable revisions in ascending order
/laputa rollback <n>  # restore revision n as a new revision
```

## Safety boundaries

- Guided writes use a `0700` directory and `0600` files, same-directory temp
  files, and an atomic rename. Existing non-empty files are never replaced.
- Panel saves replace exactly one known file after a concurrent-change check;
  they cannot rename, delete, or address a path outside the binding.
- Publish is a compare-and-swap on `current.json` under a fail-fast lock; a
  stale base revision or draft digest is refused. Rollback creates a new
  revision; history is deleted only by the configured retention window, after
  the new revision and pointer are committed.
- Revision state directories are `0700` and files `0600`; `stateDir` must be
  absolute and outside the persona directory. Revision reads reject symlinks,
  hardlinks, world-writable entries, invalid UTF-8, and over-budget content.
- Running top-level sessions stay pinned to their startup revision; a publish
  cannot change text already injected into an existing session.
- The persona directory and files must not be symlinks or hardlinks; files must
  be regular, non-world-writable, and UTF-8.
- `sourceDir` must be absolute; the resolved directory must stay inside the
  configured path.
- `laputa_init` is exposed only to top-level agents of an enabled plugin; it
  rejects any other caller.
- The injected section carries a fixed note that persona text does not change
  tool permissions, approval requirements, or safety rules.
- Persona text is injected with `interpolate: false`, so `{{...}}` stays literal.
- Only top-level agents receive the sections and the tool; subagents and
  delegated sessions do not.

## Disable

Set `enabled: false` in the profile `- id: laputa` entry and restart, or stop
the panel and remove that entry. The persona files remain untouched.

## Not included yet

Automatic proposals and rewrites, `SOUL.md` generation, consent/approval,
profile switching from the panel, and cross-device sync are not part of the
current implementation. Publishing, history, diffs, retention, and rollback
are available in the panel; listing and rollback are also available through
`/laputa revisions` and `/laputa rollback <n>`.

## License

MIT. See [NOTICE.md](NOTICE.md) for the upstream revision and the exact ported
surface.

## Provenance and license

This repository was one module inside the `dsh-superagent-template` workspace and is now versioned on its own.

- **Upstream**: [ProjectViVy/laputa](https://github.com/ProjectViVy/laputa), revision `c4d649d` —
  original author: dashimaki. License: MIT. [NOTICE.md](NOTICE.md) records exactly what was ported and what
  Phase 1 leaves out.
