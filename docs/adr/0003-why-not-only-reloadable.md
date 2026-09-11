# ADR 0003: Why `Reloadable`, `ScopedRef`, or `LayerMap` Alone Is Not Enough

**English** | [Русский](../ru/adr/0003-why-not-only-reloadable.md)

- Status: accepted
- Date: 2026-09-11

## Context

`DynamicRuntime` manages a graph of services whose availability changes at runtime. When a service provider changes, replacing a single reference is not enough. The entire affected branch of dependent services must be found, new calls must stop being admitted, old generations must be stopped in reverse topological order, and only then may new generations start in forward order.

Publication of a new generation must be atomic with respect to controller state. Calls that have already been admitted have their own tracked lifetimes: a resource they use cannot be released until those calls have completed.

Effect provides related resource-management facilities, but each solves a narrower problem.

### `Reloadable`

The installed `effect@4.0.0-rc.115` has no `src/Reloadable.ts` file, and the root module does not export `Reloadable`. Therefore, the old API from Effect 3 cannot be used or described as available in this version. No compatibility layer is added.

### `ScopedRef`

`ScopedRef.fromAcquire` owns the current resource. When `ScopedRef.set` is called, the new value is acquired in a new `Scope`, the previous value's `Scope` is closed, and the reference is changed under semaphore protection. This is sufficient for correctly replacing one resource-owning value.

However, a dependent service that has already obtained the old object through `ScopedRef.get` continues to hold that exact object. Changing the reference alone:

- does not find dependent components;
- does not prevent new managed calls while the graph is being rebuilt;
- does not wait for already admitted calls to complete;
- does not stop and start dependency-graph nodes in the correct order;
- does not publish the node states `Pending / Starting / Active / Stopping / Disabled / Failed` or the states of the entire `DynamicRuntime`: `Running / Closing / Closed / CloseFailed`;
- does not distinguish a descriptor identifier from the identifier of its specific generation.

### `LayerMap`

`LayerMap.make(lookup, options?)` creates a keyed cache on top of `RcMap`. The `contextEffect(key)` method yields a `Scope`-bound right to use an entry, `get(key)` returns a `Layer` for such a right, and `invalidate(key)` removes the entry from the map and allows the next access to create a new value.

Version rc.115 has an important property: when `idleTimeToLive` is not specified, `RcMap` uses `Duration.zero`. As soon as the last user's `Scope` for an entry closes, the resource is released immediately and the entry is removed. Therefore, two sequential, independent calls to `Effect.scoped(layerMap.contextEffect(key))` are not guaranteed to return the same object. The cache retains the value while usage periods overlap, or when a nonzero retention time without users is explicitly specified. If an entry in use is invalidated, it disappears from the map, but its old resource remains alive until all active usage rights have been released.

`LayerMap` is a useful model for keyed, reference-counted resource ownership, but by itself it does not provide:

- dependency relationships and computation of the entire affected branch;
- cascading shutdown of dependent services;
- stopping an old generation before starting a new one in topological order;
- independent boolean startup conditions;
- validation of the generation number before publishing a result;
- execution of `use` in the calling code's environment with separate admission and revocation rules;
- one sequential state model for the entire graph.

## Decision

Implement `DynamicRuntime` as a separate controller for a mutable directed acyclic graph, with a separate `Scope` for each generation.

- Each generation receives a new `Layer.MemoMap` and `Scope.Closeable`.
- Workers belong to explicitly selected `Scope` instances and are started through the public `Effect.forkIn` or `Effect.forkScoped` APIs according to their lifetime.
- The controller sequentially processes only state changes and admission decisions. A user-supplied function does not run in the same Effect task as the controller.
- A worker created for a `use` call preserves the calling code's `Context` and `Context.Reference` values. The right to use a specific generation and the admission of the call are tracked separately.
- When a generation ends, scopes close in a defined order, and resource-release defects remain observable.

`ScopedRef` and `LayerMap` are not used as hidden substitutes for this model. Their ideas may be applied only where the contract matches literally: ownership of a single value within a `Scope`, or a keyed cache with a user count.

## Consequences

A dedicated controller is more complex than one call to `ScopedRef.set` or `LayerMap.invalidate`. In return, the library's central invariants become explicit and races can be verified independently. The decision does not depend on `Reloadable`, which is absent from this version, and does not attribute graph-rebuilding guarantees to `LayerMap` that its API does not provide.

The boundary of this decision is verified in `test/compatibility.test.ts`. Exact versions, signatures, and verification results are recorded in `docs/compatibility.md`.
