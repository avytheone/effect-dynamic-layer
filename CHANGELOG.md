# Changelog

**English** | [Русский](docs/ru/CHANGELOG.md)

## 0.1.0 — experimental release, unpublished

- Added immutable `Requirement` dependency descriptors and the `DynamicLayer.fromLayer` and `DynamicLayer.fromEffect` constructors. Input dependencies and the provided service are type-checked.
- Added the `DynamicRuntime` mechanism, which runs within a `Scope`. It supports service registration; the `enable`, `disable`, `replace`, `unregister`, and `retry` commands; atomic validation of the directed acyclic dependency graph; and rebuilding only the affected branch.
- Management commands have been migrated completely from string node identifiers to `Context` service tags. The `LifecycleState` constants are now exported. The target service is resolved across the entire registry, including pending, disabled, and retiring nodes, while `awaitState` remains bound to the selected node record.
- Each startup attempt receives its own generation, `Scope`, and `MemoMap`. Resources are released from dependent services to providers. On replacement, the old generation stops completely before the new one starts, while unaffected branches are not restarted.
- Added mutable startup conditions through `when: SubscriptionRef<boolean>` and the managed `use` call. It preserves the calling code's `Context`, supports interruption, and accounts for call completion during resource release.
- Added diagnostic state snapshots, safe concise `Cause` summaries, interruptible waits for state and idleness, and idempotent `shutdown`.
- `shutdown` waits uninterruptibly for orderly graph release. Release failures remain in diagnostics, while ambiguous composite defects during construction conservatively isolate a node because a rollback failure may have occurred. The limitations of this behavior are documented in the README and ADRs.
- The exact version `effect@4.0.0-rc.115` is specified in both `peerDependencies` and `devDependencies`. The former requires the application using the library to provide Effect; the latter installs it for developing and verifying the library itself. Bun `1.4.2` is used for installation, testing, and builds; strict TypeScript checking, declaration-file generation, Biome, and Lefthook are also configured.
- Added executable examples, type-error checks, and verification of the built package archive in an external project.
- Prepared package metadata and documentation for the scoped npm identity `@avytheone/effect-dynamic-layer`, public access under the MIT license, and tag-driven publication through npm OIDC provenance. The package remains at version `0.1.0` and unpublished; repository visibility, first-package bootstrap, Trusted Publisher configuration, and a real tagged publication require separate authorized operations and verification.

Actual results and the T01–T40 matrix: [docs/status.md](docs/status.md). Production readiness, browser compatibility, and support for other Effect release candidates are not claimed.
