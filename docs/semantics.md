# DynamicRuntime 0.1 Semantics

**English** | [Русский](ru/semantics.md)

This document defines the public API contract. Actual scenario execution results are collected in [status.md](status.md), while the original T01–T40 criteria are in the [original handoff](../HANDOFF-dynamic-layer.md).

## Registration, service key, and generation

The control mechanism distinguishes three kinds of identifiers:

1. A **registration** is defined by a required diagnostic `id`, an exported service key, a dependency list, an external start condition, and a description version.
2. A **generation**, meaning an individual attempt to create an instance, receives a unique monotonically increasing number, its own `Scope` and `MemoMap`, references to the selected dependency generations, and the revision numbers of its enablement and external condition.
3. A **publication** associates a service key with the current fully created generation in the `Active` state.

The public methods `enable`, `disable`, `retry`, `unregister`, `replace`, and `awaitState`, as well as `use`, accept an actual service tag from `Context`. A node's string `id` is not an address for `DynamicRuntime` operations. The controller resolves the tag across the entire registry, not only among published instances, so registrations in `Pending` and `Disabled`, as well as registrations still releasing resources after removal, are not treated as absent. Two descriptions with the same service key cannot be registered at the same time.

JavaScript object reference equality does not mean that two generations are identical. Counters are not reset after `unregister` followed by a new registration. A late creation result, external-condition change, or stop completion is checked against the stable registration record and generation number, not merely against the string `id` or mutable description version.

`replace` changes the description within the same stable registration record. `unregister` ends that record's lifetime; a subsequent registration of the same tag creates a different component with a new identity.

## Service states

| State | Meaning |
|---|---|
| `Pending` | Operation is enabled, but starting is not yet possible: the external condition is closed or a required dependency is unavailable |
| `Starting` | An instance-creation attempt owned by the node is running |
| `Active` | Creation has completed, the generation is still current, and it has been published |
| `Stopping` | Publication has been revoked, but interrupting work, awaiting its completion, or releasing resources is still in progress |
| `Disabled` | Operation is disabled and no live generation remains |
| `Failed` | A diagnosable error occurred during creation, external-condition observation, or resource release |

In `Pending`, diagnostics distinguish an absent service provider (`MissingService`), a provider that is not operational (`DependencyNotActive`), an external condition whose first value has not yet been received (`GateInitializing`), and a closed condition (`GateClosed`). A dependency failure is reported on the provider itself; a dependent service never receives a partially created instance.

The `Failed` state retains the `Cause`, stage, and attempt number. A typed error, defect, and interruption are not collapsed into a single string. Cancellation of an already stale generation's creation is treated as normal stopping and does not trigger endless retries. A resource-release failure prevents automatic restart because the external resource's state is unknown afterward.

## Commands and acknowledgements

| Operation | What it does |
|---|---|
| `register(description)` | Validates the prospective graph before changing current state; a new registration is enabled by default |
| `enable(Service)` / `disable(Service)` | Enables or disables operation; repeating an already applied command changes nothing |
| `replace(Service, description)` | Validates that the description matches the tag and validates the prospective graph, preserves the target's required `id` and exported key, then creates a new description version |
| `unregister(Service)` | Immediately revokes publications and retains the registration record until all of its resources have been released |
| `retry(Service)` | Allows one new attempt after a creation failure; changes nothing in `Active`, `Pending`, and `Disabled` |

If the service key is not registered, the command returns `ServiceNotRegistered { serviceKey }`. A command targeting a registration already being removed returns `NodeRetiring` rather than disguising it as absent. The dependency list may refer to providers that have not yet been registered. A disabled provider continues to reserve its exported key. If a provider added later would close a cycle, the new command is rejected without changing the running graph. While a removed registration is releasing resources, reuse of its `id` or exported key returns `NodeRetiring`; after cleanup completes and `awaitIdle()` returns, they may be reused.

A successful acknowledgement of `disable`, `replace`, or `unregister` means that the controller has already revoked the entire affected graph branch: published instances have been removed, dependent generations under construction have been marked for stopping, and new calls through `use` are no longer admitted. Therefore, after the command is acknowledged, a new `use` cannot receive the old generation. Interrupting already admitted calls, awaiting their completion, and releasing resources may still be in progress. Use `awaitState` to await a required state and `awaitIdle` to await completion of current work.

## Graph rebuild order

```text
validate prospective graph → apply desired state → revoke affected publications
→ stop dependent services, generation creation, and admitted calls → stop provider
→ start ready provider → validate again and publish → start dependent services
```

Unaffected generations continue running. Each generation gets its own fresh `MemoMap`; it is not shared across the entire `DynamicRuntime`. A consumer receives already created implementations of the selected providers through its input `Context`, so their `Layer` is not created again.

`DynamicRuntime.make()` captures the `Context` environment available when the control mechanism is created, exactly once. This environment is the immutable foundation for every subsequent generation-creation attempt; the calling code's environment when executing `register`, `enable`, or another command does not replace it. Separately, the function passed to `use` executes in the environment of the `Effect` that invoked it.

A failed creation attempt is not retried for the same set of inputs merely because a state snapshot is read, an external-condition event is repeated, or an independent branch changes. A new attempt is allowed by an explicit `retry`, `replace`, a new generation of a required provider, or an actual disable-and-reenable cycle.

## External start condition (`when`)

The `when` field uses `SubscriptionRef<boolean>`. The `SubscriptionRef.changes` stream emits the initial value followed by all changes in order, so no separate read before subscribing is required. The subscription belongs to the registration and remains active in `Disabled` and `Pending`. Replacing the description stops the old subscription; a late event from it is not applied to the new description.

Availability is determined by the value the controller has already processed. A call to `SubscriptionRef.set` is not required to complete simultaneously with the graph rebuild inside `DynamicRuntime`. After a change, await the corresponding service state through `awaitState` rather than treating an arbitrary `awaitIdle()` as acknowledgement of an external event that the controller has not yet accepted.

`when` only permits or prevents starting. The library does not detect network failures itself, reconnect a service, or retry unfinished application operations: those are responsibilities of the adapter or the service itself.

## Calls through `use`

Selecting a published generation and accounting for a new call are performed as one indivisible controller decision. Only then is the supplied function started; it inherits the environment of the calling `Effect`. A separate call `Scope` bounds the lifetime of child work it creates. The call is removed from accounting on success, failure, interruption, and even cancellation before the supplied function starts.

When a generation is revoked, a running call is interrupted and cannot return a successful result. The control mechanism waits for its Effect task to complete and for the call `Scope` to close, including cleanup of child work; only then may provider resources be released. The same supplied function is not started automatically on a new generation, so the library does not retry business operations.

A service instance must not escape `use`: this includes returning the object itself, assigning it to an external variable, and starting untracked `Promise` or background Effect tasks. TypeScript cannot enforce this restriction with linear types, so calling code is responsible for honoring it.

## Waiting and shutdown

`awaitState(Service, state)` accepts a value from the frozen `LifecycleState` object; these values match the string state discriminants in snapshots. On admission, the wait is attached to the selected stable registration record. `replace` changes that record's description and does not cancel the wait. Conversely, `unregister` followed by registration of the same tag cannot silently redirect an old wait to the new component.

`awaitState` first checks whether the desired state has already been reached; waiting for `LifecycleState.Failed` itself is allowed. If the service enters `Failed` instead of another expected state, the method returns a diagnosable error. A tag that has never been registered results in `ServiceNotRegistered`. For a removed or already retiring record whose desired state is unreachable, it returns `AwaitStateUnavailable { id, expected }`. If the control mechanism itself is already closing or closed, the wait fails with `RuntimeClosing` or `RuntimeClosed` rather than remaining pending forever. `awaitIdle` does not require every service to become `Active`, and it does not wait for ordinary long-lived tasks owned by service implementations.

The lifecycle of the control mechanism itself is `Running` → `Closing` → `Closed` or `CloseFailed`. In `Closing`, new graph mutation commands and new `use` calls are rejected, all publications are revoked, but the controller continues to accept completion messages for creation, stopping, calls, and resource release. Even if replacements changed the chronological order in which `Scope` objects were created, dependent services are released before their providers.

Repeated `shutdown` calls are safe. Shutdown awaits ordered resource release, terminates external-condition observers and internal workers, and preserves release failures. Closing the external owning `Scope` starts the same path. Failure of one finalizer does not cancel attempts to release independent nodes, and `CloseFailed` is not reported as `Closed`.

`shutdown` itself is uninterruptible: cancelling the Effect task waiting for it cannot destroy the controller halfway through resource release and is observed only after the entire procedure finishes. Consequently, a timeout around `shutdown` does not guarantee an immediate return of control. In contrast, `awaitState` and `awaitIdle` remain interruptible. Every already admitted concurrent `shutdown` request receives an acknowledgement; the internal `Scope` in which `DynamicRuntime` work runs is closed only after the controller exits. A state snapshot remains available during `Closing`, making it possible to see resources that are still retained.

## Ambiguous creation and rollback failures

The public `Cause` does not identify exactly where inside a `Layer` each defect originated. If creation combines failure or interruption with a defect, or contains multiple defects, it is impossible to determine reliably whether a defect occurred while acquiring a resource or while rolling back an already acquired part. Such a result is therefore safely treated as a possible release failure: the node is quarantined and is not restarted automatically.

The quarantine is not cleared by `enable`, `retry`, or `replace`; continuing operation may require a new `DynamicRuntime`. This conservative rule can sometimes prohibit a retry even when a composite failure actually occurred only during creation. In return, it prevents starting a new generation after a potentially failed release of old resources. The original `Cause` is retained; the detailed rationale is in [ADR 0002](adr/0002-generations-and-stop-before-start.md).

Non-cooperative JavaScript code or an uninterruptible `Effect` can leave a service in `Stopping` for a long time. A timeout does not permit releasing a provider while a dependent service is still running. Creation and resource-release handlers must not recursively mutate the lifecycle graph; nor should those handlers await their own `Active` state or the global `awaitIdle()`.