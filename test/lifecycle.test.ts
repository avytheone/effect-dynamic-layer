import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect } from "effect";
import {
  DynamicLayer,
  DynamicRuntime,
  LifecycleState,
  Requirement,
  type RuntimeSnapshot,
} from "../src/index.js";

const Database = Context.Service<{ readonly generation: number }>("test/lifecycle/Database");
const Analytics = Context.Service<{ readonly databaseGeneration: number }>(
  "test/lifecycle/Analytics",
);
const ViewModel = Context.Service<{ readonly analyticsGeneration: number }>(
  "test/lifecycle/ViewModel",
);
const nodeState = (snapshot: RuntimeSnapshot, id: string) => {
  const node = (
    snapshot.nodes as ReadonlyArray<{
      readonly id: string;
      readonly state: { readonly _tag: string };
    }>
  ).find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`missing node ${id}`);
  return node.state._tag;
};

describe("DynamicRuntime lifecycle", () => {
  test("T01 no dependencies register Active and shutdown releases exactly once", async () => {
    let acquired = 0;
    let released = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                acquired++;
                yield* Effect.addFinalizer(() => Effect.sync(() => released++));
                return { generation: acquired };
              }),
            }),
          );
          yield* runtime.awaitState(Database, LifecycleState.Active);
          yield* runtime.shutdown;
          yield* runtime.shutdown;
        }),
      ),
    );
    expect(acquired).toBe(1);
    expect(released).toBe(1);
  });

  test("T02 T03 consumer is Pending before provider and starts after it", async () => {
    let consumerAcquired = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Analytics)({
              id: "analytics",
              requires: Requirement.service(Database),
              acquire: Effect.gen(function* () {
                const database = yield* Database;
                consumerAcquired++;
                return { databaseGeneration: database.generation };
              }),
            }),
          );
          yield* runtime.awaitState(Analytics, LifecycleState.Pending);
          expect(consumerAcquired).toBe(0);
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.succeed({ generation: 1 }),
            }),
          );
          yield* runtime.awaitState(Analytics, LifecycleState.Active);
          expect(consumerAcquired).toBe(1);
        }),
      ),
    );
  });

  test("T04 T05 reverse teardown and re-enable use fresh generations", async () => {
    const events: Array<string> = [];
    let databaseGeneration = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                const generation = ++databaseGeneration;
                events.push(`acquire database ${generation}`);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => events.push(`release database ${generation}`)),
                );
                return { generation };
              }),
            }),
          );
          yield* runtime.register(
            DynamicLayer.fromEffect(Analytics)({
              id: "analytics",
              requires: Requirement.service(Database),
              acquire: Effect.gen(function* () {
                const database = yield* Database;
                events.push(`acquire analytics ${database.generation}`);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => events.push(`release analytics ${database.generation}`)),
                );
                return { databaseGeneration: database.generation };
              }),
            }),
          );
          yield* runtime.register(
            DynamicLayer.fromEffect(ViewModel)({
              id: "view",
              requires: Requirement.service(Analytics),
              acquire: Effect.gen(function* () {
                const analytics = yield* Analytics;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => events.push(`release view ${analytics.databaseGeneration}`)),
                );
                return { analyticsGeneration: analytics.databaseGeneration };
              }),
            }),
          );
          yield* runtime.awaitState(ViewModel, LifecycleState.Active);
          const before = yield* runtime.snapshot;
          yield* runtime.disable(Database);
          yield* runtime.awaitState(Database, LifecycleState.Disabled);
          yield* runtime.enable(Database);
          yield* runtime.awaitState(ViewModel, LifecycleState.Active);
          const value = yield* runtime.use(ViewModel, (service) =>
            Effect.succeed(service.analyticsGeneration),
          );
          const after = yield* runtime.snapshot;
          return { before, after, value };
        }),
      ),
    );
    const releases = events.filter((event) => event.startsWith("release")).slice(0, 3);
    expect(releases).toEqual(["release view 1", "release analytics 1", "release database 1"]);
    expect(result.value).toBe(2);
    const beforeDatabase = result.before.nodes.find((node) => node.id === "database")?.generationId;
    const afterDatabase = result.after.nodes.find((node) => node.id === "database")?.generationId;
    expect(afterDatabase).not.toBe(beforeDatabase);
  });

  test("T07 diamond closes join then both branches before its single provider", async () => {
    let providerAcquires = 0;
    const releases: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const Left = Context.Service<{ readonly value: number }>("test/lifecycle/Left");
          const Right = Context.Service<{ readonly value: number }>("test/lifecycle/Right");
          const Join = Context.Service<{ readonly value: number }>("test/lifecycle/Join");
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                providerAcquires++;
                yield* Effect.addFinalizer(() => Effect.sync(() => releases.push("database")));
                return { generation: providerAcquires };
              }),
            }),
          );
          for (const [id, tag] of [
            ["left", Left],
            ["right", Right],
          ] as const) {
            yield* runtime.register(
              DynamicLayer.fromEffect(tag)({
                id,
                requires: Requirement.service(Database),
                acquire: Effect.gen(function* () {
                  const database = yield* Database;
                  yield* Effect.addFinalizer(() => Effect.sync(() => releases.push(id)));
                  return { value: database.generation };
                }),
              }),
            );
          }
          yield* runtime.register(
            DynamicLayer.fromEffect(Join)({
              id: "join",
              requires: Requirement.all(Requirement.service(Left), Requirement.service(Right)),
              acquire: Effect.gen(function* () {
                const left = yield* Left;
                const right = yield* Right;
                yield* Effect.addFinalizer(() => Effect.sync(() => releases.push("join")));
                return { value: left.value + right.value };
              }),
            }),
          );
          yield* runtime.awaitState(Join, LifecycleState.Active);
          yield* runtime.disable(Database);
          yield* runtime.awaitIdle();
        }),
      ),
    );
    expect(providerAcquires).toBe(1);
    expect(releases[0]).toBe("join");
    expect(new Set(releases.slice(1, 3))).toEqual(new Set(["left", "right"]));
    expect(releases[3]).toBe("database");
  });

  test("T08 partial failed acquisition rolls back and never publishes", async () => {
    let releases = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.sync(() => releases++));
                return yield* Effect.fail("failed" as const);
              }),
            }),
          );
          yield* runtime.awaitState(Database, LifecycleState.Failed);
          const exit = yield* Effect.exit(
            runtime.use(Database, (service) => Effect.succeed(service.generation)),
          );
          expect(exit._tag).toBe("Failure");
          expect(releases).toBe(1);
        }),
      ),
    );
  });

  test("T20 controller accepts disable and snapshot while another acquisition is blocked", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const blocker = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Deferred.succeed(started, void 0).pipe(
                Effect.andThen(Deferred.await(blocker)),
                Effect.as({ generation: 1 }),
              ),
            }),
          );
          yield* Deferred.await(started);
          yield* runtime.disable(Database);
          const snapshot = yield* runtime.snapshot;
          expect(nodeState(snapshot, "database")).toBe("Stopping");
          yield* Deferred.succeed(blocker, void 0);
          yield* runtime.awaitState(Database, LifecycleState.Disabled);
        }),
      ),
    );
  });

  test("T21 consumer finalizer can still use provider before provider closes", async () => {
    let providerAlive = false;
    let observedAlive = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                providerAlive = true;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    providerAlive = false;
                  }),
                );
                return { generation: 1 };
              }),
            }),
          );
          yield* runtime.register(
            DynamicLayer.fromEffect(Analytics)({
              id: "analytics",
              requires: Requirement.service(Database),
              acquire: Effect.gen(function* () {
                const database = yield* Database;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    observedAlive = providerAlive;
                  }),
                );
                return { databaseGeneration: database.generation };
              }),
            }),
          );
          yield* runtime.awaitState(Analytics, LifecycleState.Active);
          yield* runtime.disable(Database);
          yield* runtime.awaitIdle();
        }),
      ),
    );
    expect(observedAlive).toBe(true);
  });
});
