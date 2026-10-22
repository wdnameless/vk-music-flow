# Recon S1 — UI-честность (designer, worktree `.worktrees/s1`)

Scope: `openspec/changes/gap-plan/tasks.md` T1.1–T1.4 (R01–R07);
contracts: `openspec/changes/gap-plan/interfaces.md` § S1/S2 popup.

Files to touch: `src/popup/popup.ts`, `src/popup/popup.html`,
`src/popup/popup.css` (as needed) + ONE new test file
(e.g. `test/unit-ui-honesty.test.ts`). Nothing else.

Frozen: `src/platforms/**` (MusicProvider.setLiked already supports unlike),
DNR/PAC (`src/lib/dnr.ts`, `src/lib/proxy.ts`), journal codec, `src/types.ts`
shape changes (extend only if unavoidable, then flag in return contract).

Acceptance (verbatim from tasks.md):

- T1.1: my/radio views issue exactly one default-list request; empty state
  only on empty data.
- T1.2: Mix/Recs are distinct queries + active chip; homeHero single listener
  across revisits.
- T1.3: player/queue errors visible in the active view.
- T1.4: like toggles via provider; both buttons sync on track change.

Worktree: `.worktrees/s1`, branch `feat/s1-ui-honesty` (from
`feat/phase1-storage-queue` after planning commit). Toolchain: run binaries
from the parent checkout as `../../node_modules/.bin/{tsc,eslint,vitest,vite}`
(worktree has no own node_modules; Node resolution walks up, so this works).
