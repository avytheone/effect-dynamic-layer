# ADR 0001: One Effect Version for Release 0.1

**English** | [Русский](../ru/adr/0001-effect-major.md)

- Status: accepted
- Date: 2026-09-11

## Context

The original project description proposed using Effect 3.x and not installing a prerelease version without a separate decision. The user later explicitly changed this requirement: the first version of the library must be developed exclusively against the published `effect@4.0.0-rc.115` package.

Supporting Effect 3 and Effect 4 simultaneously would complicate the types and prevent compatibility from being verified unambiguously. When an error occurred, it would be difficult to determine whether it came from the library itself or from differences between the two major Effect versions.

The installed package was verified locally. It reports version `4.0.0-rc.115`, blocks access to `effect/internal/*` through its `exports` field, and includes the source code of its public modules. Verification also revealed important differences from the original assumptions:

- a service key is created with `Context.Service`;
- this version has no `Reloadable` module;
- `ScopedRef` and `LayerMap` are available through the package's root exports.

## Decision

1. Support only the exact version `effect@4.0.0-rc.115` in release 0.1.
2. Import only public modules from the `effect` package. Library code must not access `effect/internal/*` or inspect the private internal representation of `Layer`.
3. Check exact signatures against the public source code of the installed version. Additionally confirm behavior important to the library with executable compatibility checks in Bun.
4. Do not add compatibility aliases for Effect 3 or claim support for a version range that has not actually been verified.
5. Before moving to another release candidate or a stable version, repeat the full compatibility verification. Only then may a separate decision change the dependency range and documentation.

## Consequences

Benefits:

- the implementation relies on one coherent type system and one set of concurrency and resource-management facilities;
- incompatibilities are found before the `DynamicRuntime` management mechanism is built on incorrect assumptions;
- Effect remains an external dependency, so a second copy of its runtime is not included in the library bundle.

Limitations:

- release-candidate interfaces may change before the stable release;
- an application using the library needs the same exact Effect prerelease version;
- because `Reloadable` is absent, mutable-graph semantics must be implemented directly rather than through an adapter for the old module.

## APIs This Decision Relies On

- `Context.Service`, `Context.Reference`;
- `Layer.makeMemoMap`, `Layer.buildWithMemoMap`;
- `Scope.make`, `Scope.close`;
- `Effect.forkChild`, `Effect.forkIn`, `Effect.forkScoped`;
- `Fiber.await`, `Fiber.join`, `Fiber.interrupt`;
- `SubscriptionRef.changes`;
- `ScopedRef`, `LayerMap`.

The exact ways these APIs are used and the results of the executable checks are documented in `docs/compatibility.md`.
