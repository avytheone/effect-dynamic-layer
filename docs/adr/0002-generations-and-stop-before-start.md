# ADR 0002: Generations and Stop Before Start

**English** | [Русский](../ru/adr/0002-generations-and-stop-before-start.md)

Status: accepted as an implementation rule; evidence that it is followed is available in the tests and in `../status.md`.

## Decision

Resources are owned by a specific component generation, not by a string `id` or a reference to a service object. Every registration and every startup attempt receives its own monotonically increasing identifier. A generation records the descriptor version, the revision numbers of its permission to start and its external `when` condition, and the generations of the dependencies with which it was created.

Management commands accept `Context` service tags; the string `id` remains a diagnostic name. This separates node selection through the public API from the identifier of a specific registration or startup attempt.

A single controller that processes commands sequentially owns the target graph, generations, and published service instances. Its queue must not lose either commands or lifecycle-operation completion messages. User resource acquisition and release, as well as functions passed to `use`, do not run within a controller step: separate workers perform this work and return the result as an event.

When a change invalidates a branch of the graph, the controller first revokes the published instances of the entire affected transitive branch. This also applies to dependent services in the `Starting` state and to managed calls that have already been admitted. Command acknowledgment means that the desired change has been applied and old instances are no longer provided to new calls. It does not mean that all I/O operations and cleanup have already completed.

After instances are revoked, cleanup proceeds from dependent services to providers. A dependent service's finalizer may access the previous provider: that provider's resource remains physically open until the dependent service's cleanup attempt has completed.

Replacement follows a strict **stop the old generation first, then start the new one** order. Two live generations of the same node are not allowed at the same time. While the previous registration releases resources, its `id` and exported key remain occupied. A late completion message is matched to the identifier of the specific operation, not merely to the string `id`.

## `Scope` Ownership and Reuse Within a Build

Each startup attempt receives a separate `Scope` and a new `MemoMap`. Identical nested layers within one build are shared through Effect's ordinary mechanism, but memoized results are not carried between generations. Providers are passed to dependent services as an already built `Context` containing borrowed services; their `Layer` is not built again.

The controller must continue running until it has received all required cleanup-completion messages. The owning `Scope` initiates orderly `DynamicRuntime` shutdown; graph release order must not depend on the incidental order in which child `Scope` instances close.

## Consequences

- Replacement may involve a period of unavailability. Seamless switching without downtime is not promised.
- After an old instance has been closed, the library does not automatically fall back to it.
- Unaffected branches retain their generations and resources.
- A resource-release failure remains visible and prevents an automatic restart: the external resource may still be occupied.
- A resource acquisition operation, a call through `use`, or a finalizer that does not respond to interruption may hold the `Stopping` state for a long time and prevent `shutdown` from completing. A wait timeout does not permit the provider to close while a dependent service is still running.
- `use` operates on one pinned generation, does not retry a business operation on a new instance, and preserves the environment of the calling `Effect`. The prohibition against retaining a service beyond `use` remains a contract with the user: TypeScript has no linear types and cannot enforce this restriction automatically.

## Clarifications After Executable Verification of the Effect Release Candidate

`shutdown` terminates the entire graph uninterruptibly and in the specified order. Interrupting one waiting caller must not close the worker `Scope` in the middle of resource release. The controller acknowledges every already accepted `shutdown` request before it stops; only then is the worker `Scope` closed. Therefore, a timeout around `shutdown` does not guarantee an immediate return of control. `awaitState` and `awaitIdle` provide interruptible observation, while `snapshot` can also be read in the `Closing` state.

A worker's result message is part of resource management, not interruptible user work. In a build or startup-condition worker, only the I/O operation itself remains interruptible. Obtaining the `Exit` and sending the completion message are protected by an interruption mask. Without it, interruption between operation completion and result delivery would leave the worker permanently tracked as unfinished.

In the Effect release candidate being used, `Cause` does not identify the origin of each defect within a `Layer`. Therefore, a combination of `Die` with `Fail` or `Interrupt`, as well as multiple `Die` values during construction, is conservatively treated as a possible rollback failure after a resource was partially acquired. The node retains the original `Cause` and remains isolated because release may have failed; the `enable`, `replace`, and `retry` commands do not remove this isolation.

This safe choice has a cost: a composite error that occurred only while acquiring a resource may also require a new `DynamicRuntime` rather than `retry`. The library deliberately does not try to infer the source of an error from exception text or from the private internal representation of `Layer`.
