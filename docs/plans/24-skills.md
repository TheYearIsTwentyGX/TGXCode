# 24 — The Skills page

Skills reach a session from many places:

- `~/.claude/skills` and a project's `.claude/skills`
- every installed plugin's `skills/`
- the claude.ai-synced bucket under `~/.claude/skills/synced/`
- for Codex, `$CODEX_HOME/skills`, its `.system` folder, and a repository's
  `.agents/skills` or `.codex/skills`

Nothing in the app listed them together or let you write one. Plan 20 put this off
because "the value there is *authoring*, which is a small file manager". This is that
file manager, plus an importer.

Bridge: `bridge/skills.js`, `bridge/skill-import.js`, `bridge/routes/skills.js`.
Page: `web/skills/`. Contract: `docs/api.md` §*Skills*.

## Decided

**Both runtimes, from the start.** Claude and Codex lay a skill out the same way: a
directory with a `SKILL.md`. So one scanner serves both, and every row says
`runtime: "claude" | "codex"`. Covering Codex cost a few more roots, not a second
design. `$CODEX_HOME` is honoured, which is also what lets a manual check point the
Codex half at a scratch directory.

**Disk, not Codex's `skills/list`.** `bridge/codex/skills.js` asks an app-server for
the palette, and that is the right source for "what can I invoke here". This page asks
"what files are there", which is a readdir. An app-server per page load would cost a
process. It would also hide the skills Codex has disabled, which are the ones somebody
most wants to find here. That module is untouched. Its 30-second cache is why a skill
created here shows up in a Codex composer without any wiring. That was measured with a
scratch `CODEX_HOME`, not assumed.

**Read-only rows say why.** These are refused for writing and offered as a copy into
your own skills instead:

- a plugin's skill (the next plugin update replaces it)
- the synced bucket (the next claude.ai sync replaces it)
- Codex `.system` (the next Codex release replaces it)

**A write carries a stamp, always.** This is the claude-docs rule: every write
replaces a whole file. `null` means "create it, and refuse if it is there".

**Addressed by directory, checked against the roots every time.** The client names a
skill by the absolute directory the list gave it. The bridge accepts that directory
only when its parent *is* a root. Relative file paths refuse `..`, absolute forms,
backslashes and NUL. Every existing component is lstat'ed, so a symlink anywhere on
the way is refused.

**Delete is a move to the trash** (`$XDG_CACHE_HOME/tgxcode/skills-trash/`), because
the button sits one misclick from Save.

## Import, and why it is two calls

A skill is instructions a model follows and often scripts it runs. Importing one puts
a stranger's files where every session reads them. So:

1. **Stage** fetches into a staging directory under the cache and answers with a
   manifest: every skill found, and every file with its size, sha256, its executable
   and binary flags, and its text up to 64KB. Warnings flag executables, scripts,
   binaries, frontmatter `hooks:` and `allowed-tools`.
2. **Install** names the staging, the ticked skills, and the `digest` of the manifest
   that was shown. The bridge hashes the staged files again and refuses unless they
   are still exactly that. What lands is therefore byte-for-byte what was on screen.
   A staging edited in between, or a client that skipped the preview, gets a 409.
   That is tested by tampering with a staged file.

The fetch runs nothing it fetched:

- `git clone --depth 1` with hooks pointed at `/dev/null`
- `file` and `ext` transports off, and `GIT_ALLOW_PROTOCOL=https:ssh`
- no submodules, no LFS smudge, no prompts

A raw `SKILL.md` URL is a single https GET. Source parsing reuses
`github-clone.js`'s `parseRepoInput`, which refuses local paths and option-shaped
input.

Per skill the caps are 5MB and 500 files, and a skill with a symlink is listed with a
`problem` instead of failing the whole repository. Measured on `anthropics/skills`: 20
skills, one of them (`canvas-design`, mostly fonts) over 5MB.

Every skill starts **unticked**, including the one a search result named. That one is
marked and sorted first, but ticking it is still a decision. Install lists the exact
directories it will create.

## `npx skills`, for search only

`npx skills add` would write straight into a skills directory, which is the one step
the preview exists to stand in front of. So the CLI is used only for `skills find`.
Each result becomes a source (`owner/repo` plus the skill name) that goes through the
same stage → preview → install. Each result links to its skills.sh page and its GitHub
repository.

The version is pinned (`skills@1.9.1`) so that the output format the parser is tested
against is the one that runs. Without a TTY it prints plain
`owner/repo@skill N installs` lines, each followed by `└ https://skills.sh/…`. The
parser strips ANSI anyway, treats the count and the link as optional, and skips
anything else. `test/fixtures/skills/` holds captured output: plain, coloured and
empty. It is a subprocess run from a scratch cwd under the cache, so `package.json`
keeps `"dependencies": {}`.

## Not done

- **No live event.** Nothing else in the app reacts to a skill changing, and the page
  re-reads on open and after its own writes.
- **No YAML.** Frontmatter is scanned for top-level keys. A skill whose `name` is
  something exotic shows its folder name instead.
- **No agents or commands.** The same file-manager shape would fit them, but nothing
  asked.
