# Library architecture and resource ownership

**English** | [Русский](ru/architecture.md)

The central architectural decision is that the availability of **service generations** changes at runtime. JavaScript value references that have already been handed out are not reassigned and do not become invalid automatically. A `DynamicLayer` description is not a kind of `Layer` and does not itself own live resources.

## Module responsibilities

- `Requirement` — an immutable dependency description with the variants `Empty`, `Service`, and `All`, containing actual service keys. A TypeScript type union alone is insufficient to obtain the dependency graph at runtime.
- `DynamicLayer` — a typed recipe for creating a service. Its types verify the remaining external inputs and correspondence with the exported key. The `fromEffect` variant is converted into an ordinary `Layer` with a scoped resource lifetime.
- `internal/erased` — the only internal location where descriptions of different services are converted to a common representation for the heterogeneous registry. The public generic types remain intact. Before publication, the module verifies that the actual output `Context` really contains the declared key.
- `internal/graph` — pure logic for validating the prospective directed acyclic graph, topological sorting, and computing the complete affected branch. It neither executes user `Effect` code nor owns a `Scope`.
- `DynamicRuntime` — the entry point whose lifetime is bounded by an external `Scope`. It serially manages registrations, generations, external-condition observers, calls, and shutdown.
- `Snapshot` and `Errors` — public state and error diagnostics. They do not expose the service objects themselves.

## Control loop

```text
commands ────────────────────────┐
start-condition changes ─────────┼─→ lossless queue → single controller
internal-work completion ────────┘                         ├→ desired graph
                                                           ├→ publications
                                                           ├→ generation accounting
                                                           └→ creation and stop workers
                                                                  └→ completion message → controller
```

The controller makes only short, sequential decisions. Resource creation and release, as well as functions passed to `use`, do not execute under a global lock. This allows `disable` to be applied while a service is still in `Starting`.

A public command carries a service key from `Context`. The controller resolves it across the complete primary registry, including registrations in `Pending` and `Disabled` and records that are still releasing resources after removal. Lookup is not limited to published instances and does not use the node's diagnostic `id` as an address. Selecting a provider and applying a command therefore form one sequential decision with no intervening race.

A completion message from internal work must not be lost: without it, the controller could consider that work unfinished forever. The first release's queue does not suspend senders when the controller falls behind, so it may grow during a prolonged backlog. State snapshots travel through a separate channel and are intended to diagnose current state, not to provide a complete event log.

## Lifetime and ownership

```text
external owning Scope
  └─ ordered DynamicRuntime shutdown
      ├─ controller and control loop (alive through the final cleanup messages)
      ├─ registration → external start-condition observer
      ├─ generation → creation task + Scope + fresh MemoMap
      │    └─ tracked implementation tasks with bounded lifetimes
      └─ use call → task in caller environment + call Scope + child work
```

Each generation is created in a separate `Scope` with a fresh `MemoMap`. Identical inner layers may share a result within one build according to the ordinary Effect rules, but this memoization does not carry across generations.

`DynamicRuntime.make()` captures the `Context` environment available when the control mechanism is created, exactly once. It becomes the immutable foundation for all subsequent generation builds. Already created instances of the selected required dependencies are added to it. Their consumer borrows them: the corresponding `Layer` does not recreate the provider and does not acquire the right to release its resource independently. Unlike generation creation, the function passed to `use` inherits the environment of the `Effect` that invoked it.

A consumer begins retaining the selected dependency generations when the controller records its inputs before creation. The retention remains in place during creation, during rollback of a failed or stale attempt, and until all of the consumer's finalizers have completed. A provider therefore cannot be closed immediately after publication is revoked: the old consumer may still access it while releasing its own resources.

Global shutdown order is determined by the dependency graph, not by an incidental reverse order of `Scope` creation. After several replacements, the actual chronology of resource creation may no longer match the “provider → consumer” direction. The controller must remain alive until it receives the results of every release operation; the external owning `Scope` cannot automatically destroy it earlier.

## Generation creation and publication

Before starting a build, the controller records the stable registration record, current description version, enablement and external-condition revision numbers, and generation numbers of the selected providers. A successful build result alone does not authorize publication. The controller checks again that all recorded data is still current and that the output `Context` contains the declared exported key. A stale result is sent for resource release and never appears among publications.

The service first receives a separate `Scope` and a fresh `MemoMap`; user creation then runs in a separate worker. The worker's result returns to the controller as an event. The user I/O itself may be interrupted, but capturing its `Exit` and sending the completion event are protected from interruption: otherwise, stopping between those two actions would leave a tracked worker forever.

## Revocation and resource release

When the graph changes, the controller first removes publications for the entire affected branch in one decision and stops admitting new `use` calls for it. The branch includes not only running consumers but also their unfinished generations in `Starting`. Only then may the mutation command be acknowledged. The acknowledgement guarantees branch revocation, but not completion of subsequent resource release.

After revocation, the controller interrupts and awaits the tracked calls and creation workers. Each call's `Scope` is closed, so completion includes cleanup of child work created by the supplied function. Consumer generations are then closed, followed by provider generations. If two consumers form a dependency diamond and use one provider, its resource is released exactly once, after both consumers have finished.

A node's next generation does not begin creation until release of the previous one is complete. `replace` changes the recipe within the same stable registration record; pending `awaitState` calls continue to observe that exact record. By contrast, `unregister` ends the record's lifetime. A new registration of the same key is a different component, and an old wait cannot automatically switch to it.

A `shutdown` call applies the same procedure to the entire graph and cannot be interrupted midway. First, the controller waits for complete resource release: consumers finish before providers. It then acknowledges every already admitted `shutdown` request and exits. Only after the controller exits is the internal worker `Scope` closed. Failure of one finalizer does not cancel attempts to release independent resources, and the result is retained as a shutdown failure.

## Why ScopedRef or LayerMap is not enough

`ScopedRef` and `LayerMap` already solve useful individual problems: replacing a value with a bounded lifetime and leasing resources by key. On their own, however, they do not rebind a service that received an old provider generation during creation, nor do they provide automatic revocation of the entire dependent branch with resource release in reverse topological order. The selected Effect RC version has no `Reloadable` mechanism.

Executable probes of these capabilities and the zero-TTL behavior of `LayerMap` are described in [compatibility.md](compatibility.md). The rationale for the architectural choice is recorded in [ADR 0003](adr/0003-why-not-only-reloadable.md).

## How guarantees are verified

Tests exercise public operations with controlled `Deferred` barriers. They deliberately delay creation, a function passed to `use`, or a finalizer, and verify rejection of new calls, resource-release order, and registration identity. The behavior of `Scope` and `MemoMap` was verified separately before they were used in `DynamicRuntime`. Type checks actually run through the compiler, including negative cases for dependencies and output value shape. The external example installs the built package archive rather than importing source files.

The complete list of invariants I1–I12 and required scenarios T01–T40 is in the [original handoff](../HANDOFF-dynamic-layer.md). The current evidence matrix is in [status.md](status.md).