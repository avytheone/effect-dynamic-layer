# Experimental version 0.1.0 status

**English** | [Русский](ru/status.md)

The library has been implemented and verified locally. This includes the approved clean cutover from string node identifiers to control through `Context` services and `LifecycleState`. The package has not been published to npm, deployed, or verified in a production integration. The original requirements are recorded in `HANDOFF-dynamic-layer.md`; the owner separately clarified that **Effect RC and Bun** must be used instead of the original Effect 3.x, pnpm, and Vitest foundation.

## Exact versions

| Component | Version |
|---|---|
| Effect: supplied by the consuming application (`peerDependencies`) and used in development (`devDependencies`) | `4.0.0-rc.115` |
| Bun: package manager, test runtime, and bundler | `1.4.2` |
| TypeScript | `7.0.2` |
| Biome | `2.5.13` |
| Lefthook, project dependency | `2.1.12` |
| `@types/bun` | `1.4.2` |
| Available Node version, which was not the primary verified runtime | `24.15.0` |

Effect is not bundled into the built package. The `peerDependencies` range is restricted to the exact verified prerelease. npm tags and the list of published versions were checked; results of the dedicated compatibility probe are in [compatibility.md](compatibility.md).

## Commands run and results obtained

After the complete cutover from string node identifiers to service tags, every check was run again. Before the cutover, the baseline result was 63 tests and 208 assertion checks. The current result includes five additional behavioral regression tests for tag-based control.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | Completed successfully: 12 installs, 47 packages; lockfile unchanged, hooks installed |
| `bun test` | **68 tests passed, 0 failures, 231 assertion checks, 11 files**, 299 ms |
| `bun run typecheck` | Completed successfully for the core, control-mechanism tests, examples, and package verification scenario |
| `bun run test:types` | Completed successfully: TypeScript actually checked positive and negative generic-type contracts |
| `bun run lint` | Completed successfully: Biome checked 29 files and made no fixes |
| `bun run build` | Completed successfully: Bun built the ESM package from 8 project modules, totaling 52.42 KB; TypeScript emitted declaration files |
| `bun run test:package` | Completed successfully: a separate application installed the actual package archive, imported `LifecycleState`, and executed a tag-based Active → disable → Disabled → enable → Active sequence; strict type checking and negative checks of internal imports passed |
| `bun run examples` | All three examples completed successfully: basic, effect-factory, and failure-and-retry |

The build used `--target browser --format esm --external effect`. These options verifiably produce ESM without platform APIs in the core, but **do not prove that the library works in a browser**.

Additional regression scenarios in `test/tag-control.test.ts` cover distinct node identifier and service key values, control of registrations in Pending and Disabled, distinction between an absent and a retiring registration, atomic rejection of an incompatible replacement, and wait lifetime across a replace/unregister/re-register sequence. The `test-d/api.test-d.ts` file confirms that all six operations reject string targets, and also rejects an unknown state and an incompatible replacement. String overloads, `UnknownNode`, and `StateTag` have been removed. The `id` field remains in descriptions and diagnostics.

## What was implemented by phase

| Phase | Result |
|---|---|
| Tooling and Git | Separate repository, Bun lockfile, strict TypeScript, Biome, Lefthook, and continuous integration on Bun |
| 0 — compatibility | 10 executable probes for Scope/MemoMap, resource release, Effect child tasks, SubscriptionRef, Context.Reference, ScopedRef, and LayerMap |
| 1 — model and scheduler | Immutable Requirement tree, opaque descriptions, type checking, and atomic validation of the directed acyclic graph |
| 2 — creation and shutdown | One control loop, protected completion protocol, separate Scope for each generation's resources, borrowed dependency services, and ordered resource release |
| 3 — graph and races | replace/unregister/retry, protection from publishing a stale instance, reservation of a retiring registration, and quarantine after a release failure |
| 4 — start condition and use | Registration-condition observers, atomic call admission, caller context, child tasks with managed lifetimes, cancellation, and diagnostics |
| 5 — delivery | Exports, declaration files, package-archive verification by a separate consumer application, three examples, documentation, and release checklist |

## Required scenario matrix T01–T40

Paths are relative to the repository root. A scenario may have several sources of evidence; the number in a test name helps locate the relevant case. Type checks are not included in the 68 runtime tests.

| ID | Verified behavior | Evidence |
|---|---|---|
| T01 | A simple registration becomes Active; its resource is released exactly once | `test/lifecycle.test.ts` |
| T02 | A dependent service without a provider remains Pending; creation does not start | `test/lifecycle.test.ts` |
| T03 | Adding the provider starts dependent services in the correct order | `test/lifecycle.test.ts`, `examples/basic.ts` |
| T04 | After `disable` is acknowledged, the entire chain is unavailable to `use` until the dependent service's held finalizer completes; resources are released from presentation layer to provider | `test/interop.test.ts`, `test/lifecycle.test.ts` |
| T05 | Re-enabling creates new identities and new dependencies | `test/lifecycle.test.ts` |
| T06 | Replacement rebuilds dependent services without affecting an independent branch | `test/replacement.test.ts` |
| T07 | In a true diamond graph with a joining dependent service, the shared provider is created once and released last | `test/lifecycle.test.ts` |
| T08 | Rollback after partial creation releases resources and publishes nothing | `test/lifecycle.test.ts` |
| T09 | A typed failure and a defect remain distinguishable in the Cause and in a safe summary | `test/errors.test.ts` |
| T10 | A state snapshot, repeated start-condition value, and commands targeting independent services do not trigger endless retries | `test/errors.test.ts` |
| T11 | An explicit retry and a new generation of a required provider allow the next attempt; a change in an unrelated branch does not | `test/errors.test.ts`, `test/interop.test.ts` |
| T12 | A false condition prevents creation; true allows starting | `test/gates.test.ts` |
| T13 | A repeated true value does not restart the service; a false → true transition creates a new generation | `test/gates.test.ts` |
| T14 | The start-condition observer continues running after disable and is cleaned up by unregister or shutdown | `test/gates.test.ts`, `test/shutdown.test.ts` |
| T15 | A change while connecting the start-condition observer is not lost | `test/gates.test.ts`, `test/compatibility.test.ts` |
| T16 | A delayed build does not publish a stale service after disable | `test/replacement.test.ts` |
| T17 | Replacing a provider while a dependent service is being built prevents publication of the old instance and starts a new one with the new input value | `test/replacement.test.ts` |
| T18 | A start-condition change cycle makes the current build stale even if the final value is true again | `test/gates.test.ts` |
| T19 | A rapid replace/disable/enable sequence converges on the final description | `test/replacement.test.ts` |
| T20 | The control loop accepts commands and produces a state snapshot while creation is still unfinished | `test/lifecycle.test.ts` |
| T21 | A provider physically remains live during a dependent service's finalizer | `test/lifecycle.test.ts`, `test/interop.test.ts` |
| T22 | Collisions and cycles are rejected atomically without damaging the running graph | `test/graph.test.ts`, `test/errors.test.ts` |
| T23 | The identifier and key of a retiring registration remain reserved until cleanup finishes, after which they may be reused | `test/replacement.test.ts` |
| T24 | enable, disable, and shutdown are idempotent | `test/shutdown.test.ts` |
| T25 | The same Layer object receives a new dependency context and a fresh MemoMap | `test/replacement.test.ts`, `test/compatibility.test.ts` |
| T26 | A repeated nested layer within one control-mechanism build is created and released once | `test/interop.test.ts` |
| T27 | An unavailable `use` does not invoke the supplied function | `test/use.test.ts` |
| T28 | A `use` call during replacement is bound to one generation and does not outlive release of that generation's resources | `test/use.test.ts` |
| T29 | The public state snapshot shows an admitted call before its cancellation; call accounting and child tasks with managed lifetimes are cleaned up. An additional 32 cancellation attempts were executed with a small scheduler quantum | `test/ownership-regression.test.ts`, `test/use.test.ts` |
| T30 | Access revocation interrupts a call, awaits completion of its cleanup, and does not retry the supplied application function | `test/use.test.ts` |
| T31 | The caller's Service and Context.Reference, as well as an additional type requirement, are preserved | `test/use.test.ts`, `test-d/api.test-d.ts`, `test/compatibility.test.ts` |
| T32 | A service background task whose lifetime is bounded by Scope remains live after creation and stops before the provider finalizer; child tasks of the supplied function do not leak either | `test/ownership-regression.test.ts`, `test/use.test.ts` |
| T33 | Shutdown behaves correctly during Starting, with a start condition, with concurrent requests, and when the caller is cancelled; the control loop does not lose a completion message | `test/shutdown.test.ts`, `test/ownership-regression.test.ts` |
| T34 | A release defect and a stale-instance rollback defect remain visible; quarantine is not cleared by commands, and a false Closed state does not appear | `test/errors.test.ts`, `test/ownership-regression.test.ts` |
| T35 | Cleanup that does not respond to cancellation keeps the service in Stopping until its barrier is released manually | `test/errors.test.ts` |
| T36 | Two control-mechanism instances with identical identifiers and tags are independent | `test/replacement.test.ts` |
| T37 | The compiler rejects a missing requirement, incorrect creation or result types, and an unjustified widening to unknown | `test-d/api.test-d.ts` |
| T38 | Internal Layer.provide and control-mechanism-owned Scope values do not require extra dependencies or type casts | `test-d/api.test-d.ts`, examples |
| T39 | Across 100 complete register/replace/disable/enable/unregister cycles, creation and release counts match: 300 and 300; all tracked counters are zero after shutdown | `test/shutdown.test.ts` |
| T40 | Waits can be cancelled and used concurrently safely; after registration removal or control-mechanism closure, they fail instead of hanging | `test/shutdown.test.ts` |

Additional regression scenarios confirm that a synchronous exception from the supplied function does not leave an admitted call in accounting; a call-finalizer defect does not cause accounting to be lost; a missing `Context.Reference` export is not replaced with its default value; and concurrent admission of public requests was checked with a small scheduler quantum.

## Problems found and fixed

- Interruption between completion of user I/O and sending the build or start-condition completion message left a worker permanently tracked. The ownership protocol was corrected: only the I/O remains interruptible, while capturing its Exit and enqueuing the completion message are protected from interruption.
- Closing the execution scope before the control loop exited could interrupt the acknowledgement to a second shutdown caller. The control loop now sends every acknowledgement and exits first; only then is the execution scope closed.
- Checking state before asynchronous request preparation left a race with shutdown before the request was enqueued. Now, after the reply is created, the final state check and `Queue.offerUnsafe` run in one synchronous step.
- Dedicated regression scenarios and correct cleanup paths were added for call-finalizer scope, synchronous exceptions from the supplied function, reusable wait effects, and quarantine after a resource-release failure.
- With its default zero `idleTimeToLive`, `LayerMap` does not retain a value between non-overlapping leases that have already closed. The compatibility probe was corrected to test the actual lease lifetime.
- Scheduler quantum 1 in the selected prerelease did not make progress even for a simple Effect without this library. Adverse-scheduling checks use the verified quantum 16; the temporary original probe was removed.

A final source review focused exclusively on lifecycle behavior found no material issues. It supplements the executable tests but does not replace them.

## API clarifications and known limitations

- The selected Effect prerelease uses `Context.Service`, resource-scoped `Layer.effect`, `Layer.unwrap`, and a child-task-local `Context.Reference`. The Effect 3 APIs — `Context.Tag`, `Layer.scoped`, and `Layer.unwrapEffect` — are not mixed with this API.
- Following the approved clean cutover, `enable`, `disable`, `retry`, `unregister`, `replace`, and `awaitState` accept a `Context` service; there are no string overloads or aliases. `LifecycleState` is exported for waits; the node `id` field remains diagnostic snapshot metadata.
- `shutdown` performs ordered, uninterruptible shutdown. A timeout or cancellation does not detach cleanup from shutdown and does not promise an immediate return. `awaitState` and `awaitIdle` can be cancelled; a snapshot remains available during Closing and in the terminal state.
- A composite Cause containing Die+Fail/Interrupt or multiple Die values is conservatively treated as a possible rollback failure and prevents restart. This is safe behavior, but it means that even a composite failure entirely within creation may sometimes require a new control-mechanism instance. See ADR 0002.
- `retry` changes nothing unless the service is in a non-quarantined Failed state. `awaitIdle` also waits for managed calls to finish, but not for Scope-bounded service background tasks or start-condition observers.
- Static Context is captured at make time. Arbitrary propagation of Layer FiberRef changes and runtime settings farther through the graph is not guaranteed.
- TypeScript cannot prevent every service-instance leak or untracked Promise. User code that does not respond to cancellation can hold Stopping or shutdown.
- The mailbox is lossless and does not implement sophisticated flow control. Snapshots show state, not an audit log. An unprocessed Cause can contain sensitive data; `safeSummary` is provided for logging.
- Browser execution, other prerelease or stable Effect versions, a separate Node runtime path, and a remote GitHub Actions run have not been verified. Continuous integration configuration exists, but its commands have only been run locally.
- The library contains no network, database, user interface, HMR, extension loader, multiple providers for one service, distributed leases, or replacement without an availability gap.

## Experimental release checklist

- [x] One genuinely verified Effect line is used without mixing APIs from major versions.
- [x] Both constructors use one unified lifecycle.
- [x] Every graph command, start conditions, managed `use`, and ordered shutdown have been implemented.
- [x] T01–T40 have executable evidence in runtime or type tests; there are no skipped tests or placeholders.
- [x] Scope, generations, caller cancellation, stale publication, and resource-release failures have been verified.
- [x] Independent branches and a fresh MemoMap preserve the required behavior.
- [x] TypeScript declarations, examples, and verification by a separate consuming application have been implemented.
- [x] README, semantics and architecture descriptions, compatibility notes, ADRs, and changelog have been updated.
- [x] Temporary probes and the old `Hello via Bun` launcher have been removed.
- [x] The package remains private and experimental at version 0.1.0; it has not been published.