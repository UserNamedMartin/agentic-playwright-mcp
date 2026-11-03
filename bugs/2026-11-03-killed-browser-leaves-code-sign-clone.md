---
status: open
area: launcher
found: 2026-11-03
filed: 2026-11-03
reproducible: yes
suspect: gateway
fixed-in:
---

# Every browser killed without a clean exit leaves a ~2 GB Chrome code-sign clone on disk

## Symptoms
A disk audit found 49 folders `code_sign_clone.XXXXXX` in
`$TMPDIR/../X/com.google.Chrome.code_sign_clone/`, 75 GB by `du` (the clones share blocks, about
4 GB on disk). The oldest was two weeks old; nothing ever removed them. Their bundles were the
gated copy's version and the system Chrome's versions of the weeks before.

## Environment
macOS, two profiles on the gated browser; the self-contained tests run with the system Chrome
(their default executable).

## Steps to reproduce
1. Start a headless Chrome on macOS with remote debugging (as the launcher or a test does).
2. Kill it with SIGKILL, as the tests do by design (CLAUDE.md: tests kill their own browser).
3. Expected: nothing left behind. Actual: a new `code_sign_clone.XXXXXX` folder with the whole
   app bundle stays in `$TMPDIR/../X/<bundle id>.code_sign_clone/`.

## Evidence
- Clone creation times: bursts of 17–25 clones a day on days of test runs (one every few
  minutes), and one clone 2 s after each start of a profile's browser.
- The two clones the running profile browsers hold were created 2 s after those browsers
  started; their main executable is a hard link to the copy's executable.
- Manual check: headless Chrome killed with SIGKILL leaves a clone; with
  `--disable-features=MacAppCodeSignClone` it makes none.

## Cause
Confirmed: Chrome's `CodeSignCloneManager` (feature `MacAppCodeSignClone`,
`chrome/browser/mac/code_sign_clone_manager.mm`) clones the app bundle at every start, so that the
running browser's code signature stays valid while an update replaces the bundle. The clone is
removed by a `--type=code-sign-clone-cleanup` process launched at a clean shutdown only. A
SIGKILL, a crash or a power loss skips it, and macOS does not clean that folder.

The launcher (`browserArgs`, src/launcher.ts) and the tests that spawn their own browser
(test/robustness.mjs, test/reconnect.mjs) kept the feature on.

## Suggested fix
Pass `--disable-features=MacAppCodeSignClone` where the clone protects nothing: a gated copy (never
replaced while a browser runs from it) and a headless profile (tests and throwaway profiles), and
in the tests' own spawns. Keep it for a headed profile on a stock Chrome, which an update replaces
in place. Test: a headless profile's browser killed with SIGKILL leaves no new clone.

## Workaround
Delete the clone folders no running Chrome started (compare their creation time with the start
time of each running Chrome main process).
