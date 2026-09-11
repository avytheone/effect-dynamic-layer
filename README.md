# effect-dynamic-layer

**English** | [Русский](docs/ru/README.md)

**Connect, disconnect, and replace Effect services without restarting your application.**

The library tracks dependencies between services: it starts them in the right order, stops the affected branch, and releases resources. Implementations remain ordinary `Effect` and `Layer` values.

> This project is experimental. The package has not been published to npm and is not claimed to be production-ready. The verified Effect version is **4.0.0-rc.115**.

[Example](#example) · [Local setup](#local-setup) · [Documentation](#documentation) · [Roadmap](#roadmap)

## Why use it?

Suppose an analytics service depends on a database connection. If the connection arrives later, analytics should wait for it. If it is disabled, analytics should stop accepting new calls and finish its cleanup **before** the database closes. If the connection is replaced, analytics should start with the new connection without restarting unrelated parts of the application.

`DynamicRuntime` handles this coordination. You describe services and their dependencies; the library manages their lifecycle.

It is useful when the composition of an application changes at runtime: agent tools are connected, message handlers are replaced, or individual integrations are enabled. It is not a plugin loader or a transport: its responsibility is dependencies and resource ownership.

## Example

Register analytics before the database. It starts when the database becomes available. Then disable the database: the library stops the dependent analytics service first.

```ts
import { Context, Effect } from "effect";
import {
  DynamicLayer,
  DynamicRuntime,
  LifecycleState,
  Requirement,
} from "effect-dynamic-layer";

class Database extends Context.Service<Database, { readonly label: string }>()(
  "app/Database",
) {}

class Analytics extends Context.Service<
  Analytics,
  { readonly read: Effect.Effect<string> }
>()("app/Analytics") {}

const program = Effect.scoped(
  Effect.gen(function* () {
    const runtime = yield* DynamicRuntime.make();

    yield* runtime.register(
      DynamicLayer.fromEffect(Analytics)({
        id: "analytics",
        requires: Requirement.service(Database),
        acquire: Effect.gen(function* () {
          const database = yield* Database;
          return { read: Effect.succeed(`Source: ${database.label}`) };
        }),
      }),
    );

    yield* runtime.register(
      DynamicLayer.fromEffect(Database)({
        id: "database",
        requires: Requirement.empty,
        acquire: Effect.succeed({ label: "primary database" }),
      }),
    );

    yield* runtime.awaitState(Analytics, LifecycleState.Active);
    const result = yield* runtime.use(Analytics, (analytics) => analytics.read);
    yield* Effect.log(result);

    yield* runtime.disable(Database);
    yield* runtime.awaitState(Database, LifecycleState.Disabled);
  }),
);

await Effect.runPromise(program);
```

The database in this example is a simple object. For a real connection, use `Effect.acquireRelease` or an existing `Layer` through `DynamicLayer.fromLayer`: resource release becomes part of the same lifecycle.

- `requires` lists required dependencies. Combine several dependencies with `Requirement.all(...)`.
- A service is addressed by its tag, such as `Database`, not the string `"database"`. The `id` field is for diagnostics.
- `runtime.use` provides access to the currently active instance for the duration of the call.
- Closing the outer `Effect.scoped` automatically shuts down `DynamicRuntime` and releases its resources.

## What the library guarantees

- **Start when ready.** A service does not start until all required dependencies are available. A missing dependency means waiting, not a registration error.
- **Correct shutdown order.** Dependent services and their cleanup finish before the resources they use are released.
- **Protection against stale instances.** Once disabling or replacing a service is acknowledged, new calls cannot obtain the old instance. Calls already running through `use` are interrupted; resource release waits for them to finish, including cleanup.
- **Changes stay within the affected branch.** Unrelated services are not restarted.
- **Explicit recovery after failure.** A failed start is not retried indefinitely. `retry` allows another attempt; a change to a required dependency or replacement of the descriptor can also allow one.
- **Dependency validation.** Cycles and duplicate registration of a service key are rejected before the running graph changes. Types help verify that a descriptor lists its implementation's requirements.

Replacement stops the old instance before starting the new one. There is a period of unavailability between them; the library does not promise a seamless switchover.

## Managing services

| Operation | Purpose |
|---|---|
| `register(description)` | Register a service descriptor |
| `enable(Service)` / `disable(Service)` | Allow or prevent the service from running |
| `replace(Service, description)` | Replace the descriptor while preserving its `id` and service key |
| `unregister(Service)` | Revoke the service and remove its registration after cleanup |
| `retry(Service)` | Allow another attempt after a startup failure |
| `use(Service, callback)` | Run an operation with the active instance |
| `awaitState(Service, state)` | Wait for a state from `LifecycleState` |
| `awaitIdle()` | Wait for current transitions and managed calls to finish |
| `shutdown` | Shut down the entire `DynamicRuntime` |

**Acknowledging a command does not mean startup or cleanup has finished.** Use `awaitState` or `awaitIdle` to wait for completion. These waits can be cancelled through Effect.

Service states are available through `snapshot` and the `changes` stream: waiting (`Pending`), starting (`Starting`), running (`Active`), stopping (`Stopping`), disabled (`Disabled`), and failed (`Failed`).

Use `when: SubscriptionRef<boolean>` for an external startup condition. `false` stops the service; `true` allows it to start once dependencies are ready. The library does not detect network failures or reconnect by itself: that is the responsibility of an adapter or the service.

## Important limitations

- **Do not let a service instance escape `use`.** Do not retain it for future calls or start untracked background operations with it. TypeScript cannot enforce this automatically.
- **Interruption does not undo an external action that has already happened.** The library does not replay business operations on a new instance. A request timeout does not prove that the server did not execute the request.
- **Shutdown waits for resource release.** `shutdown` cannot be interrupted halfway through cleanup. An uninterruptible operation or a stuck finalizer can delay completion; a timeout does not permit closing a resource underneath a running service.
- **Release failures need attention.** They remain in diagnostics and prevent automatic restart. See the [lifecycle semantics](docs/semantics.md) for details, including ambiguous failures during partial startup.
- **One service key means one registration in a `DynamicRuntime`.** Multiple providers for the same service, optional dependencies, automatic failover, and dynamic code loading are not supported.
- **Compatibility has been verified on Bun and the specified Effect version.** An ESM build alone does not prove that the library works in browsers or other environments.

A snapshot can contain an original error with sensitive data. Do not send the entire snapshot to public logs; use a sanitized error summary instead.

## Local setup

You need **Bun 1.4.2**. Since the package has not been published, start with the repository examples:

```sh
git clone https://github.com/avytheone/effect-dynamic-layer.git
cd effect-dynamic-layer
bun install --frozen-lockfile
bun run example:basic
```

Other examples:

```sh
bun run example:effect-factory
bun run example:failure-and-retry
```

Checks and build:

```sh
bun test
bun run typecheck
bun run test:types
bun run lint
bun run build
bun run test:package
```

The last command checks the built package in a separate application: installation, public types, and service operations. Effect is not bundled with the library and remains a dependency provided by the application.

Bun installs dependencies, runs tests, and builds JavaScript. TypeScript checks types and emits declaration files. Biome checks code style; Lefthook runs checks before commits and pushes.

## Documentation

English is the official project language. Russian translations are maintained in [docs/ru](docs/ru/README.md). Contribution and maintenance rules are in [AGENTS.md](AGENTS.md).

| Document | Contents |
|---|---|
| [Lifecycle semantics](docs/semantics.md) | States, commands, waits, cancellation, and resource release |
| [Architecture](docs/architecture.md) | Dependency graph, service instances, and resource ownership |
| [Verification status](docs/status.md) | Executed scenarios, tool versions, and limitations |
| [Effect compatibility](docs/compatibility.md) | Verified capabilities of the selected Effect version |
| [Roadmap](docs/roadmap.md) | Seven application scenarios and their acceptance criteria |
| [Changelog](CHANGELOG.md) | Changes to the library |

## Roadmap

The next step is to exercise the library in real applications:

1. Migrate a UI with independently attachable parts from Cordis while preserving its behavior.
2. Build an agent runtime with attachable tools and MCP connections.
3. Implement NATS message handlers that can be replaced at runtime.
4. Exercise configuration and credential changes for external integrations.
5. Exercise independent sessions and tenant environments with shared resources.
6. Implement reversible registrations for commands, tools, routes, and other extensions.
7. Exercise devices and data streams in a local application.

This is a **plan**, not a list of completed integrations. The implementation order and acceptance criteria for every scenario are preserved in the [roadmap](docs/roadmap.md).
