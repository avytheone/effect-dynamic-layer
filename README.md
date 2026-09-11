# @avytheone/effect-dynamic-layer

**English** | [Русский](docs/ru/README.md)

**Connect, disconnect, and replace Effect services without restarting your application.**

The library tracks dependencies between services: it starts them in the right order, stops the affected branch, and releases resources. Implementations remain ordinary `Effect` and `Layer` values.

> This project is experimental and is not claimed to be production-ready. The npm package is **`@avytheone/effect-dynamic-layer`** at version **`0.1.0`**. The verified Effect version is **4.0.0-rc.115**.

[Example](#example) · [Installation](#installation) · [Local setup](#local-setup) · [Release process](#release-process) · [Documentation](#documentation) · [Roadmap](#roadmap)

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
} from "@avytheone/effect-dynamic-layer";

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

## Installation

Install version `0.1.0` from npm:

```sh
npm install @avytheone/effect-dynamic-layer
```

The package declares the exact `effect@4.0.0-rc.115` peer dependency. npm installs that peer automatically; applications that already use Effect must match this version. Effect is not bundled with the library. Installation of the built tarball, public TypeScript types, and the consumer lifecycle have been verified with npm 11.12.1 under Bun 1.4.2 and Node 24.15.0.

## Local setup

You need **Bun 1.4.2** to run the repository examples:

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

The last command checks the package in a separate application: installation, public types, and service operations. With no archive argument, it creates the archive itself and `prepack` runs the build; the release workflow instead supplies its one already packed tarball by absolute path. Effect is not bundled with the library and remains a dependency provided by the application.

Bun installs dependencies, runs tests, and builds JavaScript. TypeScript checks types and emits declaration files. Biome checks code style; Lefthook runs checks before commits and pushes.

## Release process

The GitHub repository is public and the project uses the [MIT license](LICENSE), copyright 2026 Alexey Yakimanskiy. Version `0.1.0` is [published on npm](https://www.npmjs.com/package/@avytheone/effect-dynamic-layer). Its registry integrity matches the verified archive, and a fresh installation by package name has passed the README example under Bun and Node.

After the package has been bootstrapped and npm Trusted Publisher has been configured, later releases use the tag-driven workflow. A maintainer updates the version in `package.json` and the Bun lockfile, runs the complete local checks shown above, commits the verified state, and only then pushes a tag exactly equal to `v${package.version}`. The `release.yml` workflow runs only for `v*` tags on GitHub-hosted Ubuntu, verifies that the tag exactly matches the package version, uses Bun from `.bun-version` with Node 24 and npm 11.12.1, and runs the existing checks. It builds and packs exactly once with `npm pack`—the package's `prepack` script runs the Bun build—then passes that exact tarball by absolute path to `bun run test:package /absolute/path.tgz`.

The workflow publishes the same verified tarball with `npm publish <tarball> --ignore-scripts --access public --provenance --tag <latest|beta>`; it selects `beta` for a prerelease version and `latest` otherwise. Reusing the tarball prevents publication from rebuilding different contents. Later tag-driven publication must use npm's OIDC trusted publishing and must not use an `NPM_TOKEN` secret. Configure the npm Trusted Publisher with these exact fields:

- organization or user: `avytheone`;
- repository: `effect-dynamic-layer`;
- workflow file: `release.yml`;
- environment: none;
- permission: allow direct npm publication, not only creation of a staging release.

After the first publication, npm 11.19.1 or newer can configure those fields without a global npm or workflow upgrade:

```sh
npm exec --yes --package=npm@11.19.1 -- npm trust github @avytheone/effect-dynamic-layer --file release.yml --repository avytheone/effect-dynamic-layer --allow-publish --yes
```

This command has been executed with interactive 2FA. npm confirmed creation of the GitHub trust configuration for `avytheone/effect-dynamic-layer`, `release.yml`, with `publish` and `stage publish` permissions. Do not recreate it for each release. To inspect it later, use `npm trust list @avytheone/effect-dynamic-layer --json`; npm may require a separate interactive 2FA confirmation even for that read.

Version `0.1.0` was the authorized manual bootstrap: the verified tarball was published unchanged using account authentication and 2FA, without CI provenance. Trusted Publisher was configured afterward. Do not republish `0.1.0` or push its tag expecting the release workflow to publish it again: npm versions are immutable. A later successful tagged release will be the end-to-end proof of OIDC publication. Publishing another version, pushing a release tag, changing repository visibility, or changing credentials still requires explicit authorization for that operation.

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
