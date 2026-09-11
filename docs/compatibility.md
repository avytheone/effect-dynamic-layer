# Effect compatibility

**English** | [Русский](ru/compatibility.md)

## Verified foundation

| Component | Exact version | What was confirmed |
| --- | --- | --- |
| Effect | `4.0.0-rc.115` | Installed through Bun; public TypeScript sources and `package.json` inspected in `node_modules/effect` |
| Bun | `1.4.2` | The project uses this version as package manager, runtime, and test runner |
| Dedicated compatibility probe | `test/compatibility.test.ts` | Executed successfully: 10 of 10 tests, 17 assertion checks, 79 ms |

The project deliberately selected the `4.0.0-rc.115` prerelease instead of the original handoff's recommendation to use Effect 3.x. The Effect 3 research remains historical source material, but the package does not promise Effect 3 compatibility and does not import `effect/internal/*`.

## What the statuses mean

- **Confirmed from source** — the signature or implementation was found in a public file of the installed package.
- **Confirmed by test** — the specified executable probe ran successfully.
- **Awaiting executable verification** — an observable-behavior test has been written or corrected, but its current revision has not yet been run.
- Final `bun test test/compatibility.test.ts` run on Bun `1.4.2`: **10 tests passed, 0 failures, 17 assertion checks, 79 ms**.
- The first run produced 9 passing tests and 1 failure, revealing an important behavioral detail. Three sequential, separate `Effect.scoped` calls released ownership after each read, and `RcMap` has a default `idleTimeToLive` of zero, so `LayerMap` returned `[1, 2, 3]`. The corrected test holds two overlapping leases concurrently and confirmed `[1, 1, 2]`. After `invalidate`, the next lease receives a new generation.

## Dedicated probe matrix

| Contract | Executable scenario | Current status |
| --- | --- | --- |
| Separate Scope and MemoMap for every generation | One `Layer` object is built twice with different input `Context` values, fresh `Layer.makeMemoMap` values, and `Scope.make`; distinct generations result, and both Scope instances are released independently | Confirmed by test |
| Successful creation | The resource remains live after `Layer.buildWithMemoMap` and is released by `Scope.close` | Confirmed by test |
| Creation failure | A resource acquired before a typed failure is released | Confirmed by test |
| Creation interruption | A suspended build is interrupted through `Fiber.interrupt`; a previously acquired resource is released, and `Exit.hasInterrupts` returns true | Confirmed by test |
| `forkScoped` lifetime | A child task continues running after creation finishes and is interrupted when the generation Scope closes | Confirmed by test |
| `SubscriptionRef.changes` | The stream emits the initial value first, then two updates; the subscriber reports readiness before the writes | Confirmed by test |
| Caller Context/Reference | `Effect.forkIn`, started from the caller's child task, inherits the provided `Context.Service` and `Context.Reference` override | Confirmed by test |
| `ScopedRef` | Replacement releases the old resource, but a previously obtained object still refers to the old value | Confirmed by test |
| `LayerMap` | Two overlapping leases use one value for a key; `invalidate` removes it from the map, and a later lease creates a new value | Confirmed by test |
| Module availability | The root export contains `ScopedRef` and `LayerMap`, but does not contain `Reloadable` | Confirmed from source and by test |

## Public APIs in rc.115

Only signatures found in the installed package's public sources are listed below.

### Context and Reference

```ts
const Database = Context.Service<DatabaseShape>("app/Database")

class Config extends Context.Service<Config, ConfigShape>()("app/Config") {}

const CorrelationId = Context.Reference("app/CorrelationId", {
  defaultValue: () => "none"
})

const context = Context.make(Database, database).pipe(
  Context.add(Config, config)
)

const databaseFromContext = Context.get(context, Database)
const databaseFromFiber = yield* Database
```

The string `key` defines runtime identity. `Context.Reference` obtains its default value lazily and caches it; the value can be overridden through `Effect.provideService`. The current context is inherited when a child task is created. A dedicated executable probe confirms this for `forkIn`.

### Explicit Layer construction

```ts
const memoMap = yield* Layer.makeMemoMap
const scope = yield* Scope.make("sequential")
const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
yield* Scope.close(scope, Exit.void)
```

The exact uncurried signature is:

```ts
Layer.buildWithMemoMap<ROut, E, RIn>(
  self: Layer.Layer<ROut, E, RIn>,
  memoMap: Layer.MemoMap,
  scope: Scope.Scope
): Effect.Effect<Context.Context<ROut>, E, RIn>
```

There is also a data-last overload: `Layer.buildWithMemoMap(memoMap, scope)(layer)`. `Layer.makeMemoMap` is an `Effect<MemoMap>` value, not a function. The library must create a separate root MemoMap and a closeable Scope for each new generation. `Layer.forkMemoMap(parent)` inherits already cached layers, so it does not substitute for a fresh generation map.

An input context can be provided through the public API, for example:

```ts
const built = Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
  Effect.provide(inputContext)
)
```

### Scope and finalizers

```ts
const scope = yield* Scope.make() // or "sequential" / "parallel"
yield* Scope.addFinalizer(scope, cleanup)
yield* Scope.close(scope, exit)
```

`Effect.acquireRelease(acquire, release, { interruptible?: boolean })` registers resource release in the current Scope. The `release` function has type `(resource, exit) => Effect<unknown, never, R>`: a typed release failure is impossible, but a defect remains observable as a Cause.

### Fiber child tasks

```ts
const child = yield* Effect.forkChild(work)
const owned = yield* Effect.forkIn(work, ownerScope)
const currentScopeChild = yield* Effect.forkScoped(work)

const exit = yield* Fiber.await(owned) // Exit<A, E>; failure is not propagated
const value = yield* Fiber.join(owned) // A; failure is propagated

yield* Fiber.interrupt(owned)          // interrupt and wait for completion
```

`forkChild`, `forkIn`, and `forkScoped` have options `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }`. The public exported values in rc.115 do not include an `interruptFork` function. Its signature must not be invented to obtain interruption without waiting: the owner must either execute `Fiber.interrupt` or explicitly start that interruption effect itself as a child task with an appropriate lifetime.

`forkChild` is automatically supervised by its parent. `forkIn` binds stopping to the supplied Scope and is suitable for a worker task that must outlive a short creation task. `forkScoped` uses the current Scope, so inside Layer creation the task is bound to the Scope that the Layer provides to that creation.

### Queue and Deferred

```ts
const queue = yield* Queue.unbounded<Message>()
const bounded = yield* Queue.bounded<Message>(capacity)
const accepted = yield* Queue.offer(queue, message) // boolean
const message = yield* Queue.take(queue)
const wasAlreadyDone = yield* Queue.shutdown(queue) // boolean

const deferred = yield* Deferred.make<Value, Error>()
const value = yield* Deferred.await(deferred)
const won = yield* Deferred.succeed(deferred, value) // boolean
const failed = yield* Deferred.fail(deferred, error) // boolean
```

In this prerelease, `Queue` has two type parameters: `Queue<A, E>`. A queue can shut down and fail; for a normal control-loop queue, `E = never` is sufficient. The boolean result of `offer`, `shutdown`, or completing a `Deferred` must not be treated as acknowledgement that a message has been processed: it describes only the operation's own state or the completion race.

### SubscriptionRef

```ts
const ref = yield* SubscriptionRef.make(initial)
const current = yield* SubscriptionRef.get(ref)
yield* SubscriptionRef.set(ref, next)
const stream = SubscriptionRef.changes(ref)
```

The public implementation creates `PubSub.unbounded({ replay: 1 })`, publishes the initial value during `make`, and serializes changes with a semaphore. Therefore, `changes` provides an atomic transition from the current value to future changes without a separate `get` that would create a gap between reading and subscribing. The observed behavior is additionally locked down by an executable probe.

### Exit, Cause, and errors

```ts
const exit = yield* Effect.exit(effect)
if (Exit.isFailure(exit)) {
  const cause = exit.cause
  Exit.hasFails(exit)
  Exit.hasDies(exit)
  Exit.hasInterrupts(exit)
  Cause.findErrorOption(cause)
  Cause.squash(cause)
}
```

`Fiber.await` returns an `Exit`, while `Fiber.join` propagates the Cause. In rc.115, the classification functions are named `hasFails`, `hasDies`, and `hasInterrupts`. Older singular names must not be carried over from memory.

## Reloadable, ScopedRef, and LayerMap

### Reloadable

There is no `src/Reloadable.ts` file, and the root `src/index.ts` does not export `Reloadable`. In rc.115, `effect/Reloadable` is unavailable as a public API. The old solution cannot be ported merely by changing a Reloadable signature: the module was removed from the selected version.

### ScopedRef

The following operations are available:

```ts
ScopedRef.fromAcquire(acquire)
ScopedRef.make(() => value)
ScopedRef.get(ref)
ScopedRef.set(ref, acquireReplacement)
```

`set` acquires the replacement value in a new Scope, then closes the old value's Scope and changes the reference under semaphore protection. This primitive is useful for atomically replacing one resource-owning value. It is not sufficient for DynamicLayer: an already running dependent service that retained the old object is not rebuilt. There is no directed acyclic dependency graph, calculation of the affected graph portion, stop-before-start generations, admission and revocation of managed calls, or global graph state.

### LayerMap

`LayerMap.make(lookup, options?)` creates a keyed cache whose resources live in a Scope. The public object provides:

```ts
layerMap.get(key): Layer.Layer<I, E>
layerMap.contextEffect(key): Effect.Effect<Context.Context<I>, E, Scope.Scope>
layerMap.contextEffectOption(key)
layerMap.invalidate(key): Effect.Effect<void>
```

This API can serve as a reference for keyed resource creation, reference-counted leases, and value invalidation. But a LayerMap key selects one creation method; the API does not describe a separate mutable dependency graph, cascading reconstruction of dependent services, generation identity, topological stop-before-start order, start conditions, or managed use with a caller-bounded lifetime. One `invalidate(key)` call does not express the library's access-publication and revocation contracts.

## Mapping earlier names to rc.115

| Earlier assumption or name | Effect `4.0.0-rc.115` |
| --- | --- |
| `Context.Tag` / `GenericTag` for a new service key | `Context.Service<Shape>(key)` or the class form `Context.Service<Self, Shape>()(key)` |
| Context key with a default value, similar to FiberRef | `Context.Reference(key, { defaultValue })` |
| `Layer.buildWithMemoMap(layer, memo, scope)` | Retained; public overload confirmed |
| `Effect.forkScoped` | Retained; returns a `Fiber` and requires the current `Scope` |
| Child task explicitly bound to an owner | `Effect.forkIn(effect, scope)` |
| Ordinary supervised child task | `Effect.forkChild(effect)` |
| `Fiber.interruptFork` | Absent from the public API |
| `Reloadable` | Absent from the package and root exported values |
| `ScopedRef` | Available as a separate public module |
| `LayerMap` | Available as a public module; in the RC it is not under `unstable/*` |
| `SubscriptionRef.changes` | Function `SubscriptionRef.changes(ref)`, a stream that replays the initial value |

## Limits of these conclusions

The dedicated compatibility probe confirms primitive behavior but does not prove that the whole `DynamicRuntime` is correct. In particular, caller-context inheritance in one `forkIn` does not by itself prove that admission through the control loop preserves that context. The supplied function must start in a worker task created from the caller's context, while the control loop must only make the admission decision sequentially. DynamicRuntime tests verify the complete race between admission and revocation after implementation.