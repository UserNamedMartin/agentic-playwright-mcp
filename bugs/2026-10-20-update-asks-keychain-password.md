---
status: fixed
area: gated-browser
found: 2026-10-19
filed: 2026-10-20
reproducible: yes (any update after a reboot, with the identity in a keychain of its own)
fixed-in: 9a705de, bc5f553 (test/gated-update.mjs)
---

# Gated browser updates run codesign against a locked keychain, which asks the user for its password

## Symptoms
After Google Chrome updated, a system dialog "codesign wants to use the "<keychain>" keychain.
Please enter the keychain password." appeared on the user's screen overnight and kept coming back.
The user typed their login password; nothing happened (the keychain has a password of its own).
`gateway.log` of both profiles:

```
gated browser: source is <new version>, no copy of it yet: building
gated browser: building the show gate
gated browser: <home>/browsers/.building-<new version>/Google Chrome.app/Contents/Frameworks/AgenticShowGate.dylib: errSecInternalComponent
gated browser: … codesign failed: …/AgenticShowGate.dylib: replacing existing signature
```

The profiles kept running the previous copy, so agents were not affected; the new version was
never built.

## Environment
macOS, two profiles on the gated browser, signed with a stable self-signed identity kept in a
keychain of its own (`gated-browser build --sign <sha> --keychain <file>`). The Mac rebooted
three days after the last successful build; Chrome updated after that.

## Steps to reproduce
1. Build a gated copy with `--keychain <file>` holding the identity.
2. Lock that keychain (a reboot does it: keychains other than the login keychain stay locked).
3. Change the source browser's version and run `gated-browser update` (the services do it hourly).
4. Expected: no UI; the update says the keychain is locked.
   Actual: codesign shows the password dialog and waits for it; Cancel fails the build with
   `errSecInternalComponent`, and the next hourly update shows it again.

## Evidence
- `security`'s status of the keychain (read without UI): readable, not unlocked.
- System boot 2026-10-16 09:49 local; last successful build 2026-10-16 03:08 (before it).
- A `codesign --keychain <file>` process from `gated-browser update` waiting since 11:18, with
  `SecurityAgent` started the same second.

## Cause
Confirmed:
1. `buildGatedBrowser` (src/gatedbrowser.ts) runs `codesign` without checking the keychain. A
   locked keychain makes codesign ask in a dialog; the update runs unattended, so nobody answers
   (or the user cannot: the password is not theirs). The keychain's password was not stored
   anywhere the update could use it.
2. The waiting codesign has no timeout and holds `.update-lock`. `withLock` treated a lock older
   than 15 minutes as left by a dead process, so the next service's update took it over while the
   first still ran, rebuilt into the same `.building-…` folder (codesign: "replacing existing
   signature") and showed another dialog.

## Fix
- The keychain password can be given once (`gated-browser build --keychain-password`) and is saved
  in `gated-browser.json` (mode 0600). Before copying anything, a build with `--keychain` reads
  the keychain's status through the Security framework with user interaction off, unlocking it
  with the saved password first; still locked → the build stops with a message, no codesign.
- The update lock holds its owner's pid and is taken over only once that process is gone.
- Every build step has a 10-minute timeout.
- Test: `test/gated-update.mjs` (scratch keychain: locked without password stops before copying,
  wrong password reported, right password unlocks; lock with a live pid kept, with a dead one
  taken over).

## Workaround
Unlock the keychain by hand (`security unlock-keychain <file>`, with its own password), or press
Cancel and ignore the dialog: the profiles keep running the previous copy.
