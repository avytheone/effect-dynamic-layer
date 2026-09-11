# Working on effect-dynamic-layer

**English** | [Русский](docs/ru/agent-guide.md)

## About the project

An experimental TypeScript library for changing a graph of Effect services while an application is running. Implementations are ordinary `Effect` and `Layer` values; `DynamicRuntime` manages their availability, generations, and resources.

Priorities: correct resource ownership, freedom from races, clear types, and a small API. Convenience and optimization must not weaken these guarantees.

The npm package identity is `@avytheone/effect-dynamic-layer`; the current version is the experimental `0.1.0`, and the library is not claimed to be production-ready. The GitHub repository is public and MIT-licensed by the owner's decision. Publishing a package version, pushing a release tag, deploying, changing repository visibility, or changing credentials requires explicit authorization for the corresponding operation.

## Where to find the contract

- [README.md](README.md) — purpose, example, and quick start.
- [docs/semantics.md](docs/semantics.md) — current lifecycle contract. Read it before changing lifecycle behavior or the public API.
- [docs/architecture.md](docs/architecture.md) — implementation structure and resource ownership.
- [docs/compatibility.md](docs/compatibility.md) — verified capabilities of the selected Effect version.
- [docs/status.md](docs/status.md) — actual verification results and limitations.
- [docs/adr/](docs/adr/) — architectural decisions and reasons for rejecting alternatives.
- [docs/roadmap.md](docs/roadmap.md) — seven future application scenarios, their order, and acceptance criteria.
- [HANDOFF-dynamic-layer.md](HANDOFF-dynamic-layer.md) — original specification, invariants I1–I12, and scenarios T01–T40.

Read the sections relevant to the task, not every document for every edit. The original specification retains historical references to Effect 3, pnpm, and Vitest. These do not override the later approved choice of Effect 4 RC and Bun. `package.json` and `bun.lock` define exact dependencies and commands; lifecycle semantics and architectural decisions describe the current behavior.

A scenario appearing in the roadmap does not mean it is implemented or should be started without a request. Do not reopen the completed 0.1.0 acceptance work solely because of historical wording in the original specification.

## How to make changes

1. Distinguish discussion, research, and a request to implement. Identify the result, boundaries, and verification method; briefly state them before substantial work.
2. Study the current implementation and existing patterns first. Find accessible facts yourself; ask about significant choices of outcome or risk.
3. Keep one owner for a connected change. Independent work can run in parallel, but one person or agent must coordinate shared files and integrated verification.
4. Do not add adjacent improvements, new subsystems, or general-purpose wrappers without a concrete need. Do not change library guarantees to make a single example convenient.
5. Do not overwrite someone else's unfinished work, rewrite Git history, or bypass checks just to make a command succeed.
6. Deliver a working result. State what changed, how it was verified, and what remains unverified; do not present a scaffold as a completed feature.

## Technical foundation and style

- Use Bun for dependencies, tests, and builds. Bun `1.4.2` and Effect `4.0.0-rc.115` are currently pinned; see `package.json` for the other exact versions.
- Do not mix Effect 3 and Effect 4 APIs. Before using an unfamiliar API, check the installed version's public types; verify important behavior with a small real execution.
- Do not import `effect/internal/*`, inspect private `Layer` internals, or bundle a copy of Effect with the library. A version upgrade requires a separate compatibility check.
- Preserve strict types and existing conventions. Do not hide errors with type assertions or diagnostic suppression. The shared representation of heterogeneous descriptors is already centralized in `src/internal/erased.ts`; do not spread type-system workarounds across the project.
- When changing an interface, update every caller, example, and type check. Do not retain obsolete overloads or aliases without an explicitly agreed reason.
- Prefer straightforward implementations and clear names. Comments should explain resource ownership, ordering, or the reason for a decision rather than narrating a line of code.
- **English is the official project language.** Write canonical documentation, code comments, test descriptions, and commit messages in clear English. Keep exact API identifiers unchanged. Reply to the user in their preferred language; this does not change the language of project artifacts.
- Maintain Russian translations in `docs/ru/`, including `agent-guide.md` as the translation of this file. Do not create a second `AGENTS.md` there: it would introduce nested agent instructions rather than ordinary translated documentation. When changing documented behavior or policy, update the affected Russian translations in the same change. English is authoritative if versions disagree; reconcile the translation rather than silently keeping conflicting contracts.
- Prefer precise, plain language in both versions. In Russian, `Scope` means a resource lifetime scope, not lexical scope or security isolation. Do not translate API identifiers or alter historical evidence merely to modernize its wording.

## Guarantees that must not be weakened accidentally

The full contract is in the [lifecycle semantics](docs/semantics.md). When changing the core, pay particular attention to these points:

- **Service addressing.** Control operations and `use` accept a service tag. `id` remains a diagnostic name. Control lookup uses the full registry, including pending, disabled, and retiring registrations; each key has one registration within a `DynamicRuntime`.
- **Validation before mutation.** Validate the proposed graph before changing the running state. Disabling, replacing, or unregistering revokes new calls across the affected branch before acknowledging the command. Acknowledgement does not mean cleanup has finished.
- **Release order.** Dependent services and managed calls finish cleanup before the resource provider does. Independent branches do not restart. Replacement stops the old generation before creating the new one.
- **Generations and ownership.** Each attempt gets its own `Scope` and a fresh `MemoMap`. Existing dependencies are borrowed without rebuilding them or transferring the right to release them. A stale result is never published.
- **Waits and startup conditions.** `awaitState` binds to a specific registration: it survives `replace` but does not switch to a new registration after `unregister`. The subscription to `when` belongs to the registration, not a single active generation.
- **Managed calls.** `use` preserves the calling Effect's environment. Revocation accounts for interruption and cleanup of the call, including child fibers. A service object must not escape the call; TypeScript does not enforce this automatically. Business operations are not replayed on a new generation.
- **Shutdown and failures.** `shutdown` waits for ordered cleanup and cannot be interrupted halfway through it. The controller stays alive until required completion messages arrive; capturing a worker's result and sending its completion message are protected from interruption. Release failures and ambiguous rollback failures cannot be cleared by `enable`, `retry`, or `replace`.

In application scenarios, do not conflate UI lifetime, service dependencies, and network availability. A closed `when` condition stops a generation; it does not promise to preserve DOM or unsaved input.

## Package and release policy

- Keep the package name `@avytheone/effect-dynamic-layer`. Installation and imports use that scoped name; the repository remains `avytheone/effect-dynamic-layer`.
- The license is MIT, copyright 2026 Alexey Yakimanskiy. Do not describe the repository as public until its visibility has actually been changed and verified.
- Bun owns dependency installation, library checks, tests, and builds. npm is used for publication and for a genuine isolated consumer installation of the packed package. Keep Bun `1.4.2`, Effect `4.0.0-rc.115`, and all other exact dependencies unless a separate compatibility update is requested.
- For a later tag-driven release, update `package.json` and `bun.lock` for the intended version, complete all local checks, and commit the verified state. Only then may an authorized maintainer push the exact tag `v${package.version}`.
- After the initial package bootstrap and Trusted Publisher configuration, `release.yml` is the tag-only (`v*`) GitHub-hosted Ubuntu release path. It must verify the exact tag/version match, use Bun from `.bun-version`, Node 24 and npm 11.12.1, and run all existing checks. It builds and packs once with `npm pack` (`prepack` performs the Bun build), verifies that exact tarball with `bun run test:package /absolute/path.tgz`, then publishes the same file with `npm publish <tarball> --ignore-scripts --access public --provenance --tag <latest|beta>`. Use `beta` for a prerelease version and `latest` otherwise.
- Publication uses npm OIDC trusted publishing, never an `NPM_TOKEN` secret. npm Trusted Publisher fields are: user `avytheone`, repository `effect-dynamic-layer`, workflow `release.yml`, no environment, with direct npm publication explicitly allowed rather than stage-only access. After the first publication, npm 11.19.1 or newer can configure this without a global or workflow upgrade through `npm exec --yes --package=npm@11.19.1 -- npm trust github @avytheone/effect-dynamic-layer --file release.yml --repository avytheone/effect-dynamic-layer --allow-publish --yes`; verify the association with `npm trust list @avytheone/effect-dynamic-layer --json`. Do not claim it is configured until that result is observed.
- A new npm package cannot have Trusted Publisher settings before it exists. The explicitly authorized first publication of `0.1.0` is a manual maintainer action under the account's current authentication-and-writes 2FA policy: pack once, verify that exact archive, and publish the same archive with `npm publish <tarball> --ignore-scripts --access public --tag latest`. It does not claim CI provenance. Only afterward can the publisher be configured, and a later successful tagged release is the proof of OIDC publication. Never claim registry installation, provenance, or OIDC publication succeeded until each was actually observed.

## Verification

Verify the changed behavior, not just compilation. For a bug, prepare a reproduction and confirm that the fix removes it. If the public interface changes, check the built package as well as the source.

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run test:types
bun run lint
bun run build
bun run test:package
bun run examples
```

Do not run the full suite after every line: exercise the relevant scenario while working, then run shared checks after the connected edits are complete. During parallel work, run shared checks after writers have finished changing files.

- Behavioral tests live in `test/`, type checks in `test-d/`, examples in `examples/`, and the external consumer check in `scripts/test-package.ts`.
- For race tests, use controlled barriers such as `Deferred`, not arbitrary delays and assumptions about scheduling order.
- A permanent test should protect observable behavior, a boundary, or a real race. Do not pin internal code organization, text wording, or the mere forwarding of an argument. Use a temporary scenario for one-off verification, then remove it.
- In the selected Effect version, `References.MaxOpsBeforeYield = 1` does not make progress even for a simple Effect. Existing adversarial scheduling checks use `16`; do not mistake a hang at `1` for a bug in this library.
- UI changes need verification in a real browser; external integrations need a working protocol or device. An ESM build does not prove browser compatibility, and an imitation of a successful response does not prove that an integration works.
- For documentation-only changes, check meaning, links, and rendering; run any new or changed executable example. Do not add tests just for an editorial change.

## Documentation and Git

- When behavior changes, update the relevant document, examples, and changelog. Record a substantive architectural decision in an ADR; do not create a separate report for every small edit.
- Record only checks that were actually run in `docs/status.md`. Mark roadmap criteria only after verification; retain all seven agreed directions and do not present plans as implementation.
- Do not commit credentials, personal data, local log contents, or personal environment settings. An original `Cause` can also contain sensitive data.
- Make small, atomic commits: one connected result together with its necessary checks and documentation. Before pushing, ensure that the commit contains no unrelated changes.
- Lefthook checks staged files before commits and runs code style checks, type checks, and tests before pushes. Do not disable these checks or address their findings by suppressing errors.
- Complete the working task list when the request is fulfilled. Future scenarios belong in the roadmap, not in the unfinished list for the current task.
