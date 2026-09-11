# Project Handoff: DynamicLayer — a Dynamic Service Graph on Top of Effect

**English** | [Русский](docs/ru/HANDOFF-dynamic-layer.md)

**For:** Codex / development agent  
**Date:** September 11, 2026  
**Deliverable:** a small, standalone TypeScript library, tests, examples, and documentation.  
**Working name:** `dynamic-layer`. npm name availability has not been checked; do not publish anything.  
**Target release:** `0.1.0`, experimental.  
**Status of this file:** a design specification, not a description of an existing API. The examples below illustrate the intended API ergonomics; they must be turned into compilable, testable examples.

**Approved public API clarification:** the full transition from string-based target service designations to actual `Context` services has been completed, without retaining the previous interface. `enable`/`disable`/`retry`/`unregister`/`replace`/`awaitState` have no string overloads, aliases, or separate descriptors. `LifecycleState` is exported as a frozen set of constants and a union type of the same name. This clarification takes precedence over the older signatures using `id` shown below; the examples and table in sections 6–7 have already been updated to the approved form.

**Current packaging override:** the “working name” and original no-publication condition for version 0.1 are retained below as historical evidence. The approved package identity is `@avytheone/effect-dynamic-layer`, under the MIT license with copyright 2026 Alexey Yakimanskiy; the repository is public. Version `0.1.0` has been published through the authorized manual bootstrap and verified by installation from npm. GitHub Trusted Publisher has been created for later tag-driven releases; a real OIDC release has not yet been exercised. Further releases and publisher-setting changes remain separately authorized operations. The exact release contract is maintained in [README.md](README.md) and [docs/status.md](docs/status.md).

---

## 0. Assignment for the Agent

Create a library for **dynamic lifecycle management of Effect services**. Ordinary `Layer` and `Effect` must remain the implementation units. The library must add runtime component registration, dependency availability tracking, and shutdown and rebuilding of the affected portion of the graph.

Do not stop at design: first verify the capabilities of the installed Effect version, then implement the stages in section 19 in order, run the checks, and present a verifiable result. Do not replace working tests with reasoning about why the code “should work.”

Priorities, in descending order:

1. Correct resource ownership and shutdown order.
2. No publication races or use of stale instances.
3. Type-safe dependency declarations.
4. A small, understandable API and compatibility with ordinary Effect `Layer` values.
5. The ability to diagnose the library’s behavior.
6. Performance optimization.

This is **not** an assignment to build a distributed platform, an infrastructure framework, or a full Cordis clone. Do not add transport, an npm plugin loader, a UI, a database, or production integrations.

If working in an existing repository, first read its instructions and examine its current state. Do not delete other people’s files, rewrite Git history, deploy, or publish the package. Small API shape changes are acceptable after a trial type check; the semantic guarantees of this specification must not be changed without an explicit description in an ADR.

## 1. Context and Corrections to the Original Idea

The original motivation is to achieve Cordis-like behavior, but with resources and computations built on Effect: when a dependency appears, the dependent service starts; when the dependency disappears, the dependent service stops; when the dependency returns, the dependent service is rebuilt.

Do not base the implementation on the following incorrect simplifications:

**“Effect Layer values can only be static.”** Effect v3 already has `Layer.suspend`, `Layer.flatMap`, `Layer.unwrapEffect`, and `Layer.unwrapScoped`. Computing a layer recipe using a function or an Effect is an existing capability, not an innovation introduced by this library. [S1]

**“Effect has no service reloading.”** It has `Reloadable` and `ScopedRef`; separately, there is an experimental `LayerMap` with keyed access and invalidation. These must be investigated, but they are not ready-made implementations of all the contracts in this specification. In particular, changing the value in a reference does not, by itself, rebuild dependent services that have already captured the old object. [S2–S4]

**“An arbitrary Effect is a reactive condition.”** An Effect describes a computation. After it runs, it does not automatically report when the external data it read has changed. The source of changes must be explicit: for example, a `SubscriptionRef`, an event stream, or a controlled requirement algebra added later. `SubscriptionRef.changes` provides both the initial value and subsequent changes. [S5]

**“Closing a `Scope` guarantees that everything is destroyed instantly.”** A Scope runs registered finalizers. It is not a mechanism for forcibly terminating arbitrary JS, an untracked Promise, or an external process. Interruptibility, resource release errors, and correct resource registration still matter. [S6–S7]

**“A Cordis Fiber and an Effect Fiber are the same thing.”** Do not use this equivalence as a basis for the implementation. Terms from different libraries do not necessarily have the same semantics.

The development objective is narrower and more precise:

> Maintain a mutable graph of available services, manage implementation generations with bounded resource lifetimes, and coordinate the shutdown and rebuilding of dependent generations.

Do not claim scientific novelty, uniqueness within the ecosystem, or production readiness.

## 2. Primary User Scenario

Graph:

```text
Database → Analytics → ViewModel
```

Here, the arrow points from the service provider to the dependent service.

Sequence:

```text
register Analytics and ViewModel
    Analytics = Pending: Database is missing
    ViewModel = Pending: Analytics is missing

register Database
    Database#1  = Active
    Analytics#1 = Active, uses Database#1
    ViewModel#1 = Active, uses Analytics#1

disable(Database)
    immediately revoke publications for the affected branch
    complete/interrupt managed consumers
    close ViewModel#1
    close Analytics#1
    close Database#1
    Database = Disabled
    Analytics and ViewModel = Pending

enable(Database)
    Database#2 → Analytics#2 → ViewModel#2
```

An independent branch of the graph must not restart because of these changes.

`replace(Database, new recipe)` performs a similar shutdown and restart, even if both recipes provide the same tag. **A new implementation means a new generation**, even if it returns the same object by reference.

## 3. Technical Foundation and Required Compatibility Spike

### 3.1. Choice for 0.1

**Original requirement:** the baseline implementation uses **Effect 3.x**, TypeScript in strict mode, and ESM. This was a deliberate constraint for the first release, not a statement about which major version of Effect is the latest.

**Later approved clarification, which takes precedence:** the actual choice is **Effect 4.0.0-rc.115**. It replaces the original requirement to choose a stable 3.x version. The original v3 selection instructions below are retained as historical requirements, not as a requirement to support both v3 and v4 simultaneously.

The source files checked for this specification belong to the official `v3` branch. At the time of preparation, its `packages/effect/package.json` contains `3.22.2`, but this is **not confirmation that this version has been published to npm**. Under the original requirement, the latest published v3 release number had to be checked before installation. Do not mix the `main` branch, Effect v4 documentation, and v3 packages: the official migration guide describes API changes between major versions. [S8–S9]

Before implementation:

```sh
pnpm view effect dist-tags --json
pnpm view effect versions --json
```

Original installation instruction: choose a published stable `3.x` version, pin the exact version in `devDependencies`, and commit the dependency lockfile. The later approved choice of Effect 4.0.0-rc.115 takes precedence with respect to the version; the requirements to pin the exact version in `devDependencies` and commit the dependency lockfile remain in force. For `@effect/vitest`, check compatible `peerDependencies`. Do not implicitly install `effect@rc` or `effect@beta`. If npm is unavailable, explicitly record this limitation; do not present an unverified set of versions as verified.

The package must list `effect` in `peerDependencies`: this dependency is supplied by the consuming application. For development, the verified version is pinned separately in `devDependencies`; the library build must not bundle its own copy of Effect. The `peerDependencies` range must not promise support for versions that lack the APIs used. Initially declare only the tested range, then expand it after CI checks.

### 3.2. What to Verify with Small Executable Tests Before Writing the Main Code

Create `docs/compatibility.md` with exact versions and results:

- `Layer.buildWithMemoMap` together with a `Scope` explicitly owned by the generation.
- Finalizer execution on success, resource acquisition failure, and interruption.
- Rebuilding the same `Layer` object with different input `Context` values and different `MemoMap` values.
- Continued execution of an Effect task started through `forkScoped` after resource acquisition completes, and its shutdown together with the generation.
- Receiving the initial value and changes from `SubscriptionRef.changes` without a gap between reading and subscribing in which a change could be missed.
- The behavior of `Reloadable`, `ScopedRef`, and `LayerMap`: what can be reused and what is missing for this library’s contracts.
- Preservation of the caller’s `Context`/`FiberRefs` in a managed user call.

Use **public** Effect APIs. Reading source code is acceptable; importing from `effect/internal/*`, replacing internal behavior at runtime, or inspecting the private Layer AST is not.

Do not attempt to support v3 and v4 simultaneously in the first release. Do not continue writing unverified signatures “from memory.”

## 4. Scope of Version 0.1

### Included

Runtime registration of predefined TS descriptions; one published tag per component; required dependencies; tracking the presence or absence of a service provider; an independent Boolean start condition; enabling and disabling; recipe replacement; unregistration; cascading invalidation; resource acquisition within a `Scope`; state diagnostics; safe managed service calls; manual retry of failed resource acquisition.

### Excluded

Multiple service providers for a single tag, priorities, and automatic failover to a backup provider; optional requirements, OR requirements, and dynamic requirement `flatMap`; arbitrary Effect computations as automatically reactive conditions; automatic health checks; workflow state persistence; RPC/NATS/HTTP; loading code from files/npm; HMR; UI components; distributed resource leases; a sandbox for untrusted plugins; zero-downtime replacement; automatic retries of business commands; full compatibility with all FiberRefs changes that arbitrary Layer values may introduce.

Files, network events, and health checks are future **change-source adapters**, not part of the core.

For the first release, it is acceptable to recompute a small DAG in full after a change. An incremental computation mechanism is not needed. However, this must not recreate all running services: unaffected generations must be preserved.

## 5. Type Model

Preferred name for the main type:

```ts
DynamicLayer<ROut, E, RIn>
```

The parameters have meanings similar to those of `Layer<ROut, E, RIn>`:

- `ROut` is the identifier of the provided Effect service, not an arbitrary service value.
- `E` represents errors in building the specific component.
- `RIn` represents the typed identifiers of its external dependencies.

A `DynamicLayer` is itself a **description**, not a mutable `Layer` or a running service. It must not pretend to be a subtype of `Layer`. A separate `DynamicRuntime` manages the description’s lifecycle.

Functions or Effect values belong in **value fields or constructors**; they do not replace the third type parameter with the word `function`.

### 5.1. Minimal Requirement Algebra

```ts
Requirement.empty                         // Requirement<never>
Requirement.service(Database)             // Requirement<Database>
Requirement.all(
  Requirement.service(Database),
  Requirement.service(Auth)
)                                         // Requirement<Database | Auth>
```

This is a small immutable requirement tree made up of known service tags. It stores runtime-accessible keys and establishes a type-level relationship with the implementation’s inputs. Do not run arbitrary user effects to compute it.

For version 0.1, the `Empty`, `Service`, and `All` variants are sufficient. `all` must deduplicate occurrences of the same tag and support nested composition. An empty `all` is equivalent to `empty`.

Type-level dependencies do not turn into runtime data on their own, so tag values must be passed explicitly. Do not attempt to extract the dependency list from an erased TypeScript type union or Effect’s internal description tree.

### 5.2. Type Checking the Description

The constructor must verify:

```text
all external inputs of the supplied Layer are listed in `requires`
the output Tag is actually compatible with the Layer outputs
`acquire` in `fromEffect` returns a service of the required shape
Scope for `acquire` is supplied by `DynamicRuntime`, not by a user-provided service provider
```

Declaring additional dependencies for lifecycle management is acceptable. Omitting an external dependency that is used is not. Dependencies already supplied by an internal `Layer.provide` do not need to be declared again.

Important type check: the compiler must not “fix” an omitted dependency by widening a generic parameter to `unknown`/`any`. If necessary, use separate type inference for requires and `NoInfer`, or check for the remaining uncovered inputs.

Do not require users to use type assertions for the ordinary scenario. A heterogeneous registry inevitably erases some types: isolate this boundary in `internal/erased.ts`, document it, and back it with runtime checks of keys and the presence of the published tag. Do not turn the public API into `any`.

## 6. Desired API

**All names `DynamicLayer`, `Requirement`, and `DynamicRuntime` below refer to the library to be created, not to the existing Effect package.** Prefer to retain this API shape; type correctness matters more than the exact number of parentheses.

### 6.1. A Regular `Layer` as the Implementation

```ts
import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "@avytheone/effect-dynamic-layer"

class Database extends Context.Tag("example/Database")<
  Database,
  { readonly label: string }
>() {}

class Analytics extends Context.Tag("example/Analytics")<
  Analytics,
  { readonly read: Effect.Effect<string> }
>() {}

const databaseLayer = (label: string) =>
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      yield* Effect.log(`acquire database ${label}`)
      yield* Effect.addFinalizer(() => Effect.log(`release database ${label}`))
      return { label }
    })
  )

const analyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const db = yield* Database
    return { read: Effect.succeed(`analytics using ${db.label}`) }
  })
)

const program = Effect.scoped(
  Effect.gen(function* () {
    const enabled = yield* SubscriptionRef.make(true)
    const runtime = yield* DynamicRuntime.make()

    yield* runtime.register(
      DynamicLayer.fromLayer(Analytics)({
        id: "analytics",
        requires: Requirement.service(Database),
        when: enabled,
        layer: analyticsLayer
      })
    )

    yield* runtime.awaitState(Analytics, LifecycleState.Pending)

    yield* runtime.register(
      DynamicLayer.fromLayer(Database)({
        id: "database",
        requires: Requirement.empty,
        layer: databaseLayer("A")
      })
    )

    yield* runtime.awaitState(Analytics, LifecycleState.Active)
    yield* runtime.use(Analytics, (service) => service.read)

    yield* runtime.disable(Database)
    yield* runtime.awaitState(Database, LifecycleState.Disabled)
    yield* runtime.awaitState(Analytics, LifecycleState.Pending)

    yield* runtime.enable(Database)
    yield* runtime.awaitState(Analytics, LifecycleState.Active)

    yield* runtime.replace(
      Database,
      DynamicLayer.fromLayer(Database)({
        id: "database",
        requires: Requirement.empty,
        layer: databaseLayer("B")
      })
    )

    yield* runtime.awaitState(Analytics, LifecycleState.Active)
    yield* runtime.use(Analytics, (service) => service.read)

    yield* SubscriptionRef.set(enabled, false)
    yield* runtime.awaitState(Analytics, LifecycleState.Pending)

    yield* SubscriptionRef.set(enabled, true)
    yield* runtime.awaitState(Analytics, LifecycleState.Active)
  })
)

// In the executable example, handle Exit/errors and run program.
// Closing the outer Scope must shut down the runtime in the correct order.
```

This is a template for the acceptance example. The agent must include the actual `examples/basic.ts` in type checking and run it. The log lines are illustrative only; counters and invariants are checked by separate tests.

### 6.2. An Effect Instead of a Manually Created `Layer`

The second constructor is a thin wrapper around resource acquisition in a `Scope`:

```ts
const analytics = DynamicLayer.fromEffect(Analytics)({
  id: "analytics",
  requires: Requirement.service(Database),
  acquire: Effect.gen(function* () {
    const db = yield* Database
    return { read: Effect.succeed(`analytics using ${db.label}`) }
  })
})
```

It must use the same execution mechanism as `fromLayer`, conceptually through `Layer.scoped`. An Effect-based implementation does not need a separate lifecycle.

### 6.3. An Effect That Computes a Layer Recipe

Do not introduce a third, incompatible mechanism. The original requirement used Effect v3, where this can already be expressed through `Layer.unwrapEffect` or `Layer.unwrapScoped`: [S1]

```ts
const selectedLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* BackendConfig
    return config.mode === "remote" ? RemoteAnalyticsLive : LocalAnalyticsLive
  })
)
```

The original Effect v3 requirement is retained for historical reference. The subsequently approved actual choice of Effect 4.0.0-rc.115 takes precedence as a version clarification.

Such a recipe is passed to `DynamicLayer.fromLayer`. `requires` covers the remaining external inputs of the **entire** recipe. If the static input type is a union of the inputs of both branches, version 0.1 conservatively requires that entire union. Branching in a `Layer` does not mean that only the branch selected at runtime is automatically tracked.

The selecting Effect runs when a new generation is built. It does not run continuously, and an ordinary change to a hidden variable does not trigger a rebuild. Such a change requires replacing the configuration service provider, an explicit call to `replace`, or an observable startup gate.

## 7. DynamicRuntime Contract

`DynamicRuntime.make()` returns an Effect tied to a `Scope`. A running instance is not created when the module is imported. Two `DynamicRuntime` instances in the same process are completely independent.

Minimum public API:

| Operation | Meaning |
|---|---|
| `register(description)` | Validate the description and atomically add it to the desired-state graph. The required `description.id` remains diagnostic metadata. A registration is enabled by default. |
| `enable(Service)` / `disable(Service)` | Find the registration by the actual service key and change its desired enabled state. Repeating the same command changes nothing. |
| `replace(Service, description)` | Replace the recipe for the same service in a type-safe manner; preserve the node's identity, its `id`, and the published service key, stopping the old instance before starting the new one. |
| `unregister(Service)` | Revoke the component, retaining the retiring node's record until internal cleanup completes correctly. |
| `retry(Service)` | Allow another attempt after a resource acquisition failure for the same set of inputs. |
| `snapshot` | Obtain an immutable diagnostic state snapshot without service objects. |
| `changes` | A stream of current state snapshots: the initial state and subsequent versions. |
| `awaitState(Service, LifecycleState.Active)` | Wait for the selected registration's state, with proper cancellation and an error if the registration is removed or `DynamicRuntime` is closed. |
| `awaitIdle()` | A barrier: at the observation point, there are no unfinished lifecycle operations or changes that have already been accepted but not yet processed. |
| `use(Service, callback)` | Run an Effect with the current service generation pinned and with managed cancellation. |
| `shutdown` | Shut down idempotently in the prescribed order; also invoked when the `Scope` that owns the `DynamicRuntime` instance closes. |

### 7.1. Command Acknowledgment Does Not Mean I/O Completion

`register`, `enable`, `disable`, `replace`, `unregister`, and `retry` acknowledge **the controller's acceptance and application of a desired-state change**, not the completion of all resource acquisition operations and finalizers. The controller resolves the service key against the full registration map, which is the source of truth, including records in the `Pending` and `Disabled` states and records undergoing removal. Looking only among publications is prohibited.

However, revoking old publications in response to a command that invalidates them is part of the same atomic step. After `disable` returns successfully, a new `use` must not obtain an old generation from the affected branch.

`awaitState` and `awaitIdle` are used separately. `awaitState` pins the selected stable registration record: replacement continues the wait on the same record, but removing the registration and subsequently registering the same service key does not redirect a previously started wait.

`awaitIdle` does not mean “all nodes are Active”: `Pending`/`Disabled`/`Failed` states are allowed. It does not wait for long-lived Effect worker tasks or control subscriptions to finish. Future external changes may immediately break the idle state; this barrier does not lock the entire system.

A change to a `SubscriptionRef` is acknowledged by the reference itself, not by the `DynamicRuntime` controller. Therefore, after `SubscriptionRef.set`, you must wait for the corresponding state rather than assume that the startup gate has been processed synchronously.

`awaitState` must first check for the requested state. If the node transitions to `Failed` instead of the expected state, the wait must terminate with a diagnosable error rather than hang forever. Waiting for `LifecycleState.Failed` is allowed. It must be possible to bound the wait using Effect's standard timeout mechanism.

After `DynamicRuntime` transitions to `Closing`, new control commands, new `use` calls, and waits for impossible states fail with `RuntimeClosing`/`RuntimeClosed` rather than getting lost in the queue. A service key that has never been registered returns `ServiceNotRegistered { serviceKey }`; a control command targeting a record undergoing removal returns `NodeRetiring`; an unreachable wait on a record being removed returns `AwaitStateUnavailable { id, expected }`.

## 8. Node States

Use a discriminated union, not a set of independent boolean fields:

```text
Disabled — `desiredEnabled=false`, no live generation remains.
Pending  — the registration is enabled, but dependencies are missing or the startup gate does not yet permit startup.
Starting — resources for a specific generation are being acquired.
Active   — the generation has been fully built and published.
Stopping — publication has already been revoked; interruption, waiting for completion, and resource release are still in progress.
Failed   — a diagnosable failure specifying the phase and Cause.
```

For `Failed`, distinguish at least the `acquire`, `gate`, and `release` phases. `Pending` contains reasons such as `MissingService`, `DependencyNotActive`, `GateInitializing`, and `GateClosed`. If a dependency is in a failed state, this must be visible in the diagnostics for the reference to it, rather than hidden behind an endless “loading” state.

An enabled registration initially remains in `Pending` until its conditions are checked, then transitions to `Starting` if its input requirements are met. Resource acquisition failure does not result in publication of a partially built service.

The temporary absence of a required service is a normal `Pending` state, **not an exception**.

`Disabled` is set only after stopping has completed. While finalizers are running, the state remains `Stopping`, even if the desired enabled state has already been set to `false`.

A removed node must not remain in the state snapshot forever. Keep the retiring node's internal record for as long as completion of the old generation is necessary for safety, then remove it. Late messages are identified by generation, not by a string id that may match the id of a new registration.

While a node is undergoing removal, its id and published service key remain reserved. A new registration using them before cleanup finishes receives `NodeRetiring` rather than starting a parallel instance. After cleanup completes (`awaitIdle`), they may be reused. This restriction does not eliminate the need to check registration and generation identity for late messages.

## 9. Graph, Generations, and Identity

Separate at least three entities:

**Node description:** node identifier, published tag, dependency requirements, startup gate, recipe, description revision.

**Attempt/generation:** unique generation identifier, resource lifetime Scope, Effect task for building, selected input generations, status, cancellation token/epoch.

**Publication:** service key → published generation in the `Active` state and service value.

Unique generation identifiers must distinguish old and new registrations with the same node identifier. A monotonic `DynamicRuntime` counter is sufficient; it is not reset on removal and re-registration.

The build fingerprint includes at least:

```text
node registration identity
recipe version / activation epoch
required service key → generation identifier of the selected provider
startup gate version affecting the validity of this attempt
```

Do not rely solely on object identity, node count, a global registry version, or a boolean indicating that “the dependency exists.”

### Graph Validation

On `register`/`replace`, construct the proposed new graph and, before changing the current state, check:

- uniqueness of the node identifier;
- that there is no more than one registered service provider for each service key, including disabled providers;
- that no node depends on itself;
- that there are no cycles among the edges of registered nodes whose dependencies could be resolved;
- that the id and export key match when replacing.

Missing service providers are allowed. If a subsequent registration of such a provider closes a cycle, **reject that new command specifically**, leaving the previous state intact.

The tag key serves as the `Context` key at runtime; identical strings may conceal different TypeScript types. Export collisions must not be silently accepted. Use stable, namespaced keys and test collisions. TypeScript does not prove the safety of arbitrarily loaded JavaScript.

## 10. Controller and Execution Layer

Recommended architecture:

```text
commands + startup gate changes + lifecycle operation completions
                        ↓
             serialized controller
             core state + scheduler
                        ↓
                  start / revoke / stop
                        ↓
            managed Effect executors
                        ↓
               completion message to the controller
```

Only the controller may modify the source-of-truth state and publications. A queue with a single Effect task for the controller is acceptable. Do not run multiple concurrent reconciliation procedures over the same `Map`.

**The controller does not wait for long-running user I/O.** Resource acquisition, stopping, and finalizers run in managed executors that send completion messages. Otherwise, it would be impossible to process `disable` while `Starting` is stuck.

Do not hold a global semaphore or lock during user resource acquisition and release or while executing the supplied function. Sequential decision-making must not block acceptance of cancellation.

Lifecycle commands and completion messages must not be silently lost in a queue that drops new items or evicts old ones. For version 0.1, a simple mailbox without a complex backpressure mechanism is acceptable, but this limitation must be documented. Diagnostic state snapshots are a different category: they may be coalesced if the coalescing semantics are explicitly described.

Prefer to make the function that computes the graph and the transitive set of affected nodes pure, and test it separately from execution.

## 11. Startup and Atomic Publication Algorithm

To start a generation:

1. In a single controller step, check the enabled state, the startup condition, and the publications in the `Active` state for all required dependencies.
2. Pin the **specific** input generations and register the generation in the `Starting` state as a service dependent on them before any I/O begins.
3. Create a Scope owned by this attempt and a new `MemoMap`; resource ownership tracking must be protected against cancellation between allocating resources and recording their ownership.
4. Build an immutable input Context from the selected services. These are borrowed references: the dependent service does not recreate the service provider's resources.
5. In a managed Effect fiber, build the Layer using this Context and Scope.
6. Before publication, the controller rechecks the token, recipe, startup condition, and identity of every selected generation.
7. If everything is still current, atomically publish the single declared export and set the state to `Active`.
8. If the build is stale, its result is **never** published; resources owned by it must be closed through the normal shutdown path.

Fully successful resource acquisition does not, by itself, authorize publication.

If the `Layer` builds but the declared export is absent from the output `Context`, this is `InvalidExport` and a resource acquisition failure. The error must be reflected in diagnostics, and the `Scope` must be closed. Availability must not be determined solely from a generic type parameter.

Dependencies remain alive throughout resource acquisition and rollback of the dependent service. A service provider must not be closed while a stale dependent service is still finishing its own build or cleanup.

## 12. Invalidation, Stopping, and Replacement

### 12.1. Logical Revocation Before Physical Resource Release

When a dependency is lost, a service is disabled or replaced, or the startup condition becomes false:

1. Find the affected transitive set of dependent services, including generations in the Starting state and managed user calls.
2. In a single atomic step, remove the publications for the entire affected branch and mark the attempts as stale.
3. Do not allow new builds or calls using these generations.
4. Stop dependent services in reverse topological order.
5. Close service providers only after their dependent services have finished.

Do not close DB first and then notify Analytics, which uses it.

### 12.2. What It Means to “Stop a Generation”

Cancel any unfinished resource acquisition, wait for it to exit and complete its rollback, interrupt the managed Effect fibers owned by the generation and wait for them to finish, then close its `Scope` and run its finalizers. The actual mechanism may use linked `Scope`s and Effect fibers, but these observable guarantees are mandatory.

A dependent service's finalizer may use its previous service provider for a final operation. The service provider must remain alive until that finalizer finishes.

In a diamond-shaped graph, the shared service provider is closed once, and only after both dependent services have finished. Stopped sibling branches may be cleaned up in parallel, but version 0.1 may do this sequentially.

### 12.3. Replacement Policy in Version 0.1

**Stop-before-start**, with a permitted period of unavailability:

```text
revoke the old affected branch
→ stop dependent services
→ stop the old provider
→ start the new provider
→ start dependent services with new generations
```

Do not implement both a parallel blue/green scheme and stop-before-start. There is no automatic rollback to an old instance that has already been closed. If the new build fails, the service provider transitions to `Failed`, and dependent services transition to `Pending`.

A new instance does not start until the previous instance of the same node has finished stopping. This matters for ports, file locks, and exclusive devices.

### 12.4. Shutting Down the Root `DynamicRuntime`

First, stop accepting new operations and revoke all publications. Stop the graph in the correct order, then close the control subscriptions, workers, and controller, and unblock waiting shutdown callbacks.

Do not rely on the incidental last-in, first-out (LIFO) order determined by the creation of child `Scope`s: after several replacements, it need not match reverse topological order.

The controller must remain operational for as long as stop-completion messages are needed. Do not automatically interrupt the controller through the root `Scope` first and then wait for it to release the remaining resources. Validate the resource ownership scheme with a dedicated shutdown test.

`shutdown` is idempotent. Closing the `Scope` that owns the `DynamicRuntime` instance and explicitly calling `shutdown` must not release resources twice.

## 13. Boolean Startup Condition: Minimal Genuine Reactivity

Version 0.1 provides the field:

```ts
when?: SubscriptionRef.SubscriptionRef<boolean>
```

Without `when`, the startup condition is always satisfied. If `when` is specified, the component waits for the first value from the observable reference and reacts to subsequent changes.

Required semantics:

- `false` prohibits startup and invalidates an active generation or one being built.
- `true` permits startup if all required services are available.
- Repeated `true` values without a state change do not restart a service in the `Active` state.
- A `true → false → true` transition invalidates the old attempt, even if its build finishes after the last true.
- The startup-condition subscription lives at the **registration** level, not the active-generation level. Otherwise, after false, nothing would remain to notice true.
- The subscription is retained while disabled and released when the registration is removed, the description is replaced, or `DynamicRuntime` shuts down. Subscription events contain the registration identifier and description version; a delayed event from an old startup condition is ignored after replacement.
- Do not perform `get` separately and then “subscribe to future events”: a change can be lost between these actions. Use `.changes`, which includes the initial value. [S5]
- When a startup-condition event is received, do not perform I/O from the controller callback.

Availability is the state known to the controller after it processes events. Do not promise atomicity with the outside world or an immediate response to a physical network disconnection.

If a DB client is still registered but has lost its connection, the library does not learn about this automatically. An external adapter must change the startup condition or replace or disable the service provider. Another valid approach is a stable service with internal reconnection and typed operation errors.

Do not add a periodic polling loop to check the startup condition.

## 14. Safe Use of a Service from Outside the Graph

Replacing a reference in Context does not change JS objects that have already been handed out. Therefore, the following approach must not be the primary API:

```ts
const db = yield* runtime.get(Database)
// Retaining db arbitrarily after its resources have been closed
```

The public usage pattern in version 0.1:

```ts
yield* runtime.use(Analytics, (analytics) => analytics.read)
```

The `use` contract:

- Selecting a generation in the `Active` state and registering the call as its consumer happen in a single atomic step.
- If there is no publication in the `Active` state, the call fails with `ServiceUnavailable`, without indefinite implicit waiting.
- The callback starts only after the call has been successfully admitted.
- The call has its own managed lifetime and is cleaned up on success, failure, and cancellation by the caller.
- When the generation is revoked, admission of new calls is closed, and an already admitted callback is interrupted. `DynamicRuntime` waits for it to finish and clean up before releasing the service provider's resources.
- Cancellation due to revocation is Effect interruption; it must not be disguised as a successful result. The reason for revocation must be retained in diagnostics.
- The callback inherits the calling code's Context/FiberRefs, not incidental defaults from the controller's Effect fiber. Its additional requirements `R` remain in the return type; they must not be erased.
- The `Scope` provided to the managed callback operation is closed along with the call. Child fibers attached to the call's `Scope` must not outlive the call.
- Do not automatically retry a business operation on a new generation. Interruption does not prove that an external operation did not occur.

Call admission can race with cancellation by the caller: cancellation between generation selection and callback startup must not leave the generation retained indefinitely. The startup, admission, and release protocol must be validated by tests, not just by checking the happy path.

**Language limitation:** TypeScript has no linear types. A user can save a service object in an external variable, return it from the callback, or start an untracked Promise. Such escape from the managed lifetime is prohibited by the contract, but cannot be fully prevented through types. Do not promise memory safety for arbitrary user code.

Worker Effect fibers inside a service provider must be attached to a `Scope` and tracked. Do not use `forkDaemon`/`runFork` as a hidden way to bypass resource ownership rules. Failure of an arbitrary child Effect fiber does not, by itself, imply automatic service revocation: version 0.1 should not invent a universal health-monitoring and fiber-supervision policy. A service implementation must manage its health explicitly.

## 15. Resources, MemoMap, and Layer Compatibility Boundaries

### 15.1. A Separate `Scope` for Each Generation

A `Scope` belongs to a generation, not merely to a node's string identifier. After a failed or stale build, the temporary `Scope` must not be left without an owner. Immediately after `Scope.make`, responsibility for subsequently closing it must be assigned in a cancellation-safe manner.

Finalizers are responsible for user resources, while the controller is responsible for ordering actions across components. Neither replaces the other.

### 15.2. MemoMap per Generation

Effect provides public `Layer.makeMemoMap` and `Layer.buildWithMemoMap` APIs. They allow the memoization boundary to be specified explicitly. [S1]

The decision for version 0.1: **a new `MemoMap` for each new component generation**. Within a single build, normal sharing of identical nested `Layer`s is preserved; it is not automatically carried over between generations.

The reason for this choice: the same `Layer` object may first be built with Database#1 and then with Database#2. Careless global memoization may retain the old implementation or old input dependencies. Do not treat `Layer.fresh` as a universal solution without validating it with a test.

Resource sharing between components is provided through a published service provider and references to its generation. Do not inject the service provider's original `Layer` into every dependent service in a way that recreates DB resources.

### 15.3. Supported Subset of `Layer`

Supported features are ordinary service-producing `Layer`s, resource acquisition tied to a `Scope`, ordinary internal `Layer` composition, and recipe selection through Effect with known remaining input dependencies.

Do not promise that building a `Layer` in a separate Effect fiber and extracting a single `Context` reproduces all the effects of `Layer.provide` on the calling code's `FiberRefs`, logging and tracing facilities, configuration provider, and runtime flags. Propagating these settings is a separate semantic concern.

For version 0.1:

```text
Context service dependencies — supported;
generation resources — supported;
the static DynamicRuntime build environment — fixed and documented;
arbitrary FiberRef changes from provider → dependent services' runtime — not guaranteed.
```

The services in the examples capture their dependencies during resource acquisition. If a service method itself returns an Effect with additional requirements, those requirements do not automatically disappear from `runtime.use`.

Compatibility limitations must be documented in the README. Do not export a universal “live ManagedRuntime<R>” that supposedly updates already-captured dependencies safely.

## 16. Errors, Retries, and Non-Cooperative Code

### 16.1. Resource Acquisition Failure

The `Cause`, stage, generation, input fingerprint, and attempt timestamp or sequence number must be retained. Partially acquired resources must be cleaned up. A failure in one component must not terminate the entire `DynamicRuntime`.

By default, **there are no unbounded automatic retries**. After a failure with the same input fingerprint, the component remains in `Failed`. A new attempt is allowed in the following cases:

```text
an explicit `retry(Service)`;
an actual change in the relevant input generation;
a new activation cycle of the startup condition or enablement;
replacement of the description via `replace`.
```

A change in an independent branch of the graph is not grounds for retrying a failed resource acquisition attempt.

For `retry` in the `Active`/`Pending`/`Disabled` states, one of two behaviors must be explicitly chosen and documented: the operation does nothing, or it returns a typed error. The chosen behavior must be covered by tests. The preferred option is a no-op, with no implicit restart of a running service.

### 16.2. Defects, Interruption, and Resource Release Failures

The distinction between a typed error, a defect, and an interruption must not be lost. Do not convert all `Cause` values to strings; a string is only a diagnostic representation.

Interrupting a stale attempt is a normal shutdown path, not a new reason to restart the service indefinitely.

A finalizer failure must remain visible as a resource release failure. Do not write `catchAllCause(() => Effect.void)` merely to make the state snapshot look healthy. After a resource release failure, the node must not restart automatically: the state of external resources is unknown. For version 0.1, it is acceptable to require recreating `DynamicRuntime` after such a failure.

Other independent cleanup operations must still be attempted. Shutdown with resource release failures must not be presented as fully successful. Respecting the ordering means waiting for the dependent service to terminate and for its cleanup attempt to finish, but does not prove that a faulty external resource was successfully released.

### 16.3. Uninterruptible Operations and Operations Outside Effect's Control

Arbitrary non-cooperative code cannot be safely “killed” by this library. If construction, a supplied function, or a finalizer does not terminate, the corresponding branch may remain in `Stopping`, and `DynamicRuntime` shutdown may continue waiting.

A timeout may limit how long the user waits or provide diagnostics, but it does not, by itself, permit closing a service provider while a dependent service is still running, nor does it make unsafe code safe.

`Effect.acquireRelease` has specific acquisition and release interruptibility semantics; these must be checked in the installed version. Do not write a test asserting that “acquireRelease(Effect.never) must be cancelled instantly” without understanding the API. A deterministic interruption test must use an explicitly interruptible region with `Deferred`. [S7]

Supplied lifecycle functions must not wait for the component they serve to reach `Active`/an idle state itself, or initiate cyclic control operations. Reentrant graph mutation from resource acquisition or release operations is not supported in version 0.1; this limitation must be documented.

## 17. Diagnostics and Required Invariants

For errors in individual nodes, the heterogeneous state snapshot may store `Cause<unknown>`: the type `E` is preserved in the description and implementation of the specific component, but the overall `DynamicRuntime` must not promise a statically known union of the error types of all future registrations. Construction errors are not retroactively added to the type of an already completed `register`; they are observed through state and wait operations.

The state snapshot contains at least:

```text
DynamicRuntime state: Running / Closing / Closed / CloseFailed
monotonic state snapshot version
for a node: id, published service key, requires, desiredEnabled, lifecycle state
generation identifier, recipe version, generation identifiers of the selected dependencies
reasons for waiting
last error and stage
number of live generations/attempts and managed calls
```

Do not expose the service objects themselves, configuration secrets, or business request contents. Errors may contain sensitive data: provide a documented safe summary format, and do not serialize arbitrary objects without controls.

`changes` is intended for state, not for an audit event log. State snapshots may be delivered using a bounded buffer or by coalescing intermediate updates, with a monotonic version; the consumer must be able to obtain the current state snapshot. Critical internal lifecycle events must not be lost in this way.

**Invariants that must be expressed in tests:**

| ID | Invariant |
|---|---|
| I1 | A publication in the `Active` state belongs only to an unrevoked generation that has completed resource acquisition. |
| I2 | A published dependent service refers to the same still-published dependency generations that were selected when it started. |
| I3 | When generations are invalidated, publications for the entire affected transitive closure are revoked before new calls are admitted. |
| I4 | A service provider is not closed while tracked dependent services, construction operations, or calls are using it. |
| I5 | A stale completion result is not published after description replacement, disabling, a startup-condition change cycle, or registration removal. |
| I6 | A node does not have two simultaneously running generations; a service key has at most one publication. |
| I7 | Every created Scope has a known owner and cleanup path. |
| I8 | A specific registered finalizer is invoked exactly once in normal test scenarios. This is not a promise that all external resources will be successfully released. |
| I9 | Unaffected generations retain their identity and do not repeat resource acquisition. |
| I10 | A failed registration or replacement leaves the desired graph and current publications unchanged. |
| I11 | After successful `DynamicRuntime` shutdown, there are no live tracked `Scope` instances, calls, startup-condition observers, or lifecycle workers. |
| I12 | Errors and unfinished cleanup are not hidden behind Active/Closed. |

I2 must not be interpreted as prohibiting the existence of a retiring dependent service whose provider's publication has already been revoked: old objects may temporarily remain physically alive for safe cleanup. I2 applies to the **published** graph.

## 18. Acceptance Tests

All concurrent scenarios must be built around `Deferred`, managed Effect fibers, and event-order assertions. Random delays must not be used for synchronization. `TestClock` is intended to control time, not to replace barriers that establish causal ordering.

| ID | Scenario and Expected Result |
|---|---|
| T01 | No dependencies: registration → Active; `DynamicRuntime` shutdown triggers resource release exactly once. |
| T02 | A dependent service is registered before its provider: the state is `Pending`, and resource acquisition is not performed. |
| T03 | A service provider becomes available: the chain starts in topological order. |
| T04 | Disabling the root of a chain: publications are revoked, and resources are released in the order ViewModel → Analytics → Database. |
| T05 | Re-enabling creates new generation identifiers; new references are used. |
| T06 | Replacing a service provider rebuilds transitively dependent services; an independent branch remains unchanged. |
| T07 | Diamond graph: the shared service provider's resources are acquired once and closed after both dependent services. |
| T08 | Partially successful resource acquisition fails: all registered cleanup operations are executed, and there is no publication. |
| T09 | A typed error and a defect during resource acquisition are reflected as distinct Cause values; `DynamicRuntime` remains operational. |
| T10 | The Failed state does not lead to a retry loop because of a state snapshot, a repeated startup-condition value, or a change to an independent node. |
| T11 | An explicit `retry` creates one new attempt; changing a required service provider permits a new attempt. |
| T12 | The startup condition is false at registration: the state is `Pending`, and construction has not started. A true value starts the node. |
| T13 | A true → true transition does not trigger a restart; a false → true transition after stopping creates a new generation. |
| T14 | The startup-condition subscription survives generation shutdown and disabling, but is removed when the registration is removed or `DynamicRuntime` shuts down. |
| T15 | Lost-notification check: a startup-condition change during observer attachment is not lost. |
| T16 | Construction is held using Deferred; disabling arrives before it finishes: the old generation is never published. |
| T17 | Construction is held; a required service provider is replaced: the construction result using the old input dependency is rejected, and its resources are cleaned up. |
| T18 | The startup condition changes true → false → true while construction is held: the old attempt must not be accepted solely on the basis of the latest true value. |
| T19 | Rapid replacements, disabling, and enabling are handled consistently; the publication corresponds to the latest valid generation. |
| T20 | The controller handles disabling and a state snapshot request while another node performs lengthy resource acquisition. |
| T21 | A dependent service's finalizer accesses the service provider: the provider remains alive until the finalizer completes. |
| T22 | A duplicate identifier or export key, a self-cycle, an ordinary cycle, or a cycle created when a missing service provider appears produces an explicit error with no partial graph mutation. |
| T23 | While a node is retiring, re-registering its identifier or key receives NodeRetiring; registration is allowed after cleanup. A late completion from the old registration does not affect the new one. |
| T24 | Repeated enabling, disabling, and `DynamicRuntime` shutdown do not create extra resource acquisition or release operations. |
| T25 | The same `Layer` object is built again with a new dependency Context and does not use the old MemoMap. |
| T26 | Within a single `Layer`, a reused nested `Layer` retains normal sharing semantics. |
| T27 | `use` for a missing service or one whose publication has been revoked fails with `ServiceUnavailable` and does not run the supplied function. |
| T28 | `use` concurrent with replacement is either rejected or bound to one generation; there is no use after resource release. |
| T29 | Caller cancellation during admission or execution of `use` releases tracking entries and child fibers tied to the call's `Scope`. |
| T30 | Revocation interrupts an existing managed call and waits for its cleanup; the supplied business function is not retried automatically. |
| T31 | `use` preserves the caller's `Context`/`FiberRefs`; an additional requirement does not disappear from the type. |
| T32 | A service's child Effect fiber tied to a Scope remains alive after resource acquisition and stops when the generation stops. |
| T33 | `DynamicRuntime` shutdown in `Starting`/`Stopping` states and during multiple replacements correctly terminates all normal cooperative operations. |
| T34 | A defect during resource release is visible; there is no falsely successful Closed state or automatic restart. |
| T35 | A controlled uninterruptible operation is held using Deferred: the branch remains in `Stopping`; after being manually unblocked, it terminates correctly. The test does not hang forever. |
| T36 | Two `DynamicRuntime` instances with identical Tags and identifiers do not affect one another. |
| T37 | A missing external requirement, an incorrect `acquire` shape, and an incorrect output tag are negative type tests. |
| T38 | A `Layer` whose internal dependencies have already been provided is accepted; the normal user-facing API does not require type assertions. |
| T39 | At least 100 cycles of `register`/`replace`/`disable`/`enable`/`unregister`/`shutdown` on a test resource: balanced resource acquisition and release, with no leaks of tracked resources. |
| T40 | `awaitState`/`awaitIdle` cancel correctly, do not hang after registration removal or `DynamicRuntime` shutdown, and do not, by themselves, treat `Pending` as an error. |

Property-based or model-based testing of the pure planner is also desirable: use small random directed acyclic graphs (DAGs) and command sequences with a fixed random seed. This must not replace deterministic concurrency tests.

Type tests must actually run through TypeScript or a suitable test runner. `@ts-expect-error` in a file that is not included in type checking is not a test.

## 19. Implementation Plan

### Stage 0 — Verify Primitives and API

Pin versions, perform a hands-on compatibility check, and write minimal positive and negative type tests. Describe the boundary between our semantics and the built-in `Reloadable`/`LayerMap` in an ADR. Do not prolong the investigation: once confirmed with an executable example, move on to implementation.

### Stage 1 — Model and Pure Planner

Implement the requirements abstract syntax tree, the opaque `DynamicLayer` description, node and generation identity, candidate-graph validation, topological ordering, and the transitive closure of affected nodes. Do not create a custom resource management system at this stage.

### Stage 2 — Resource Acquisition and Ordered Shutdown

Implement a single controller, managed workers, fresh `Scope`/`MemoMap` instances, and publication exclusively through the controller, along with the `register`/`enable`/`disable`/`shutdown` operations. Make the main chain and diamond dependency graph work, including resource acquisition failures.

### Stage 3 — Graph Mutation and Concurrent Scenarios

Implement `replace`/`unregister`, generation tokens, optimistic validation before publication, handling of races in `Starting`/`Stopping`, and resource release failures. Do not proceed to claiming that “hot replacement works” without tests for these scenarios.

### Stage 4 — Startup Condition and Managed Use

Implement a startup condition based on `SubscriptionRef` with the correct lifetime; admission, admission revocation, and cancellation of the supplied function; and preservation of the caller's context. If the API needs refinement, update the examples, type tests, and ADR at the same time.

### Stage 5 — Package, Documentation, and Full Test Run

Prepare public exports, type declaration files, a check that an external project can consume the built package, examples, a README, a description of limitations, and a release checklist. The version remains experimental.

Update `docs/status.md` at every stage: state what has been completed, which commands were run, and the results and limitations. Do not mark unverified items as complete. If the environment blocks installation or testing, leave reproducible commands and an honest status rather than a fabricated report of successful checks.

## 20. Repository Structure and Tooling

A single package is preferred, without monorepo infrastructure:

```text
src/
  index.ts
  DynamicLayer.ts
  DynamicRuntime.ts
  Requirement.ts
  Errors.ts
  Snapshot.ts
  internal/
    graph.ts
    planner.ts
    controller.ts
    generation.ts
    use.ts
    erased.ts
    effect-interop.ts

test/
  graph.test.ts
  lifecycle.test.ts
  replacement.test.ts
  gates.test.ts
  use.test.ts
  errors.test.ts
  shutdown.test.ts
  compatibility.test.ts

test-d/
  api.test-d.ts

examples/
  basic.ts
  effect-factory.ts
  failure-and-retry.ts

docs/
  architecture.md
  semantics.md
  compatibility.md
  status.md
  adr/
    0001-effect-major.md
    0002-generations-and-stop-before-start.md
    0003-why-not-only-reloadable.md

README.md
package.json
tsconfig.json
pnpm-lock.yaml
```

This is a guide, not a requirement to retain empty files. Do not create a separate module for every function. Domain-specific examples with real connections are not needed.

At runtime, the library uses the `effect` package, supplied by the consuming application through `peerDependencies`; for development, the verified version is pinned separately in `devDependencies`. Additional runtime libraries are allowed only with specific justification. The initial development toolset is pnpm, TypeScript, and Vitest with a compatible `@effect/vitest`; linting and formatting follow the project's existing conventions. Do not add separate state-machine, event-dispatcher, or dependency-injection libraries to replace capabilities already available in Effect.

Required project commands in the original plan:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:types
pnpm lint
pnpm build
pnpm test:package
pnpm example:basic
```

`test:package` verifies imports of the **built** package from a separate TypeScript test consumer project and the absence of accidental imports of internal modules or source files. Examples must pass type checking. Do not choose a bundler that embeds Effect in the package.

The core must not require Node/Bun APIs. The primary CI environment is a supported Node LTS release; versions are pinned in the project. A basic smoke test in Bun is desirable; do not claim it has passed if Bun is not available in the environment. Do not claim browser compatibility without a separate basic smoke test.

The actual, later-approved choice of Effect `4.0.0-rc.115` and Bun, specified in section 21, takes precedence over the original Effect v3/pnpm/Vitest toolset.

## 21. Completion Criteria

Release 0.1 is complete when all of the following conditions are met simultaneously:

**Acceptance is complete:** verification results and the T01–T40 matrix are in [docs/status.md](docs/status.md). By the owner's explicit decision, Effect `4.0.0-rc.115` and Bun were used instead of the original requirement for Effect v3 and the pnpm/Vitest toolchain. This subsequently approved actual choice takes precedence over the original requirement; semantic clarifications are recorded in the ADR.

- [x] One primary Effect version line has been pinned and actually verified, with no mixing of v3/v4 APIs.
- [x] Both constructors, `fromLayer`/`fromEffect`, use the same lifecycle implementation.
- [x] `register`/`enable`/`disable`/`replace`/`unregister`/`retry` are implemented, not replaced with stubs.
- [x] The Boolean startup condition is genuinely reactive and continues to be observed after the service stops.
- [x] All mandatory acceptance tests pass; no skipped tests conceal unimplemented guarantees.
- [x] Dedicated tests demonstrate protection against stale publication, reverse-order shutdown, and cancellation during service use and admission to service use.
- [x] The normal API does not require users to use `any` or type assertions; negative type tests are run.
- [x] Independent branches are not recreated, and old memoized services are not returned.
- [x] Upon successful cooperative shutdown, the number of acquired resources matches the number released; no tracked Effect fibers, `Scope` instances, or calls remain.
- [x] Resource release errors and non-cooperative shutdown are neither hidden nor reported as successful.
- [x] Exports, type declarations, and consumption of the built package by an external project work.
- [x] The README explains guarantees, limitations, interruption of external operations, and the prohibition on services escaping managed use.
- [x] Working `basic`/`effect-factory`/`failure` examples are available without real infrastructure.
- [x] There is no HMR, networking, database, UI, arbitrary plugin loader, or other unrequested subsystem.
- [x] The final report distinguishes between “implemented,” “verified,” and “not verified.”

Line count is not a criterion. Do not sacrifice resource ownership and race-condition tests for a promise of “a 300-line core.”

## 22. Possible Work After 0.1 — Do Not Implement Now

The next meaningful step is a more expressive **tracked requirement algebra**, not an arbitrary `when: Effect<boolean>`:

```text
service(tag)
optional(tag)
all(...)
map(requirement, pureFunction)
choose(observableSelector, declaredBranches)
```

For `optional`, define in advance whether the dependent service is recreated when an optional dependency becomes available. For `choose`, define how read dependencies are recorded, when subscriptions change, how lost wakeups and cycles are prevented, and how old generations are invalidated.

`Requirement.gen` is possible only with controlled primitives passed through `yield` and explicit dependency tracking. Ordinary `Effect.gen` cannot be declared automatically reactive: it may read arbitrary external state internally.

Other directions include bounded retry and backoff policies, exporting multiple services, multiple service providers with an explicit selection policy, adapters for observable configuration and health status, and an API for inspecting internal state. The original plan also included migration to Effect v4 here; the subsequently approved choice of Effect `4.0.0-rc.115` takes precedence over that original plan. Each direction requires its own semantics, not just another entry in a feature list.

## 23. Primary Sources for Verification

These sources were checked while preparing the project handoff materials. Branch links are mutable: when verifying compatibility in practice, record the version actually installed and, if necessary, the commit or tag. The presence of a function on a branch does not confirm its presence in every published version.

[S1] Effect v3 Layer: dynamic constructors, building within a `Scope`, `MemoMap`.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/Layer.ts
```

[S2] Effect v3 Reloadable: a reloadable service, `manual`/`auto`/`reload`/`get` operations.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/Reloadable.ts
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/internal/reloadable.ts
```

[S3] Effect v3 ScopedRef: a resource-managing reference and replacement of the value it owns.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/ScopedRef.ts
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/internal/scopedRef.ts
```

[S4] Effect v3 LayerMap: dynamic keyed resources and their invalidation; marked as experimental in the source examined.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/LayerMap.ts
```

[S5] Effect v3 SubscriptionRef: the current value together with its changes.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/SubscriptionRef.ts
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/internal/subscriptionRef.ts
```

[S6] Effect v3 Scope: resource ownership and closing a `Scope` with finalizer execution.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/Scope.ts
```

[S7] Effect v3 Effect: acquireRelease, interruption, and Effect fibers bound to a `Scope`. Verify the exact signatures in the installed version.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/src/Effect.ts
```

[S8] Package metadata on the official v3 branch. The version in Git is not equivalent to a verified npm distribution tag.

```text
https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/effect/package.json
```

[S9] Official guide to migrating from Effect v3 to v4.

```text
https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
```

## 24. Codex Final Report Format

At completion, include:

```text
1. What has been implemented and where the public API is located.
2. Exact versions of Effect, TypeScript, Node, and testing tools.
3. Commands executed and actual results.
4. Which of T01–T40 are covered by specific tests.
5. What API changes were made relative to the original specification and why.
6. Known limitations/untested scenarios.
7. How to run the `basic` example and package checks.
8. Readiness assessment: experimental version 0.1, without unsubstantiated claims of production readiness.
```

The main success criterion:

> Ordinary Effect implementations automatically appear and disappear in response to explicit dependencies, but no composition magic breaks resource ownership, cancellation, or shutdown order.
