import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Layer } from "effect";
import {
  DynamicLayer,
  DynamicRuntime,
  LifecycleState,
  Requirement,
  type RuntimeSnapshot,
} from "../src/index.js";

const Database = Context.Service<{ readonly generation: number }>("test/interop/Database");
const Analytics = Context.Service<{ readonly generation: number }>("test/interop/Analytics");
const View = Context.Service<{ readonly generation: number }>("test/interop/View");

const node = (snapshot: RuntimeSnapshot, id: string) => {
  const found = snapshot.nodes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing node ${id}`);
  return found;
};

describe("DynamicRuntime Layer and graph interop", () => {
  test("T26 repeated use of one sublayer inside one Layer build shares its acquisition", async () => {
    const Shared = Context.Service<{ readonly value: number }>("test/interop/T26/Shared");
    const Left = Context.Service<{ readonly value: number }>("test/interop/T26/Left");
    const Right = Context.Service<{ readonly value: number }>("test/interop/T26/Right");
    let sharedAcquisitions = 0;
    let sharedReleases = 0;
    let leftAcquisitions = 0;
    let rightAcquisitions = 0;

    const shared = Layer.effect(
      Shared,
      Effect.gen(function* () {
        sharedAcquisitions++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sharedReleases++;
          }),
        );
        return { value: sharedAcquisitions };
      }),
    );
    const left = Layer.effect(
      Left,
      Effect.gen(function* () {
        leftAcquisitions++;
        return { value: (yield* Shared).value };
      }),
    ).pipe(Layer.provide(shared));
    const right = Layer.effect(
      Right,
      Effect.gen(function* () {
        rightAcquisitions++;
        return { value: (yield* Shared).value };
      }),
    ).pipe(Layer.provide(shared));
    const whole = Layer.merge(left, right);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromLayer(Left)({
              id: "whole-layer",
              requires: Requirement.empty,
              layer: whole,
            }),
          );
          yield* runtime.awaitState(Left, LifecycleState.Active);
          expect(yield* runtime.use(Left, (service) => Effect.succeed(service.value))).toBe(1);
          expect(sharedAcquisitions).toBe(1);
          expect(leftAcquisitions).toBe(1);
          expect(rightAcquisitions).toBe(1);

          yield* runtime.disable(Left);
          yield* runtime.awaitIdle();
          expect(sharedReleases).toBe(1);
        }),
      ),
    );
  });

  test("T11 failed consumer retries only when its required provider generation changes", async () => {
    const Unrelated = Context.Service<{ readonly value: number }>("test/interop/T11/Unrelated");
    let providerGeneration = 0;
    let consumerAttempts = 0;

    const provider = () =>
      DynamicLayer.fromEffect(Database)({
        id: "database",
        requires: Requirement.empty,
        acquire: Effect.sync(() => ({ generation: ++providerGeneration })),
      });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(provider());
          yield* runtime.awaitState(Database, LifecycleState.Active);
          yield* runtime.register(
            DynamicLayer.fromEffect(Analytics)({
              id: "analytics",
              requires: Requirement.service(Database),
              acquire: Effect.gen(function* () {
                const database = yield* Database;
                consumerAttempts++;
                if (database.generation === 1)
                  return yield* Effect.fail("first provider rejected" as const);
                return { generation: database.generation };
              }),
            }),
          );
          yield* runtime.awaitState(Analytics, LifecycleState.Failed);
          expect(consumerAttempts).toBe(1);

          yield* runtime.register(
            DynamicLayer.fromEffect(Unrelated)({
              id: "unrelated",
              requires: Requirement.empty,
              acquire: Effect.succeed({ value: 1 }),
            }),
          );
          yield* runtime.awaitState(Unrelated, LifecycleState.Active);
          yield* runtime.disable(Unrelated);
          yield* runtime.awaitState(Unrelated, LifecycleState.Disabled);
          yield* runtime.awaitIdle();
          expect(consumerAttempts).toBe(1);
          expect(node(yield* runtime.snapshot, "analytics").state._tag).toBe("Failed");

          yield* runtime.replace(Database, provider());
          yield* runtime.awaitState(Analytics, LifecycleState.Active);
          expect(consumerAttempts).toBe(2);
          expect(
            yield* runtime.use(Analytics, (service) => Effect.succeed(service.generation)),
          ).toBe(2);
        }),
      ),
    );
  });

  test("T04 disable ACK atomically revokes the whole closure before slow consumer cleanup", async () => {
    const viewFinalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseViewFinalizer = await Effect.runPromise(Deferred.make<void>());
    const events: Array<string> = [];
    let databaseAlive = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Database)({
              id: "database",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                databaseAlive = true;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    events.push("database");
                    databaseAlive = false;
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
                    events.push("analytics");
                  }),
                );
                return { generation: database.generation };
              }),
            }),
          );
          yield* runtime.register(
            DynamicLayer.fromEffect(View)({
              id: "view",
              requires: Requirement.service(Analytics),
              acquire: Effect.gen(function* () {
                const analytics = yield* Analytics;
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(viewFinalizerStarted, void 0).pipe(
                    Effect.andThen(Deferred.await(releaseViewFinalizer)),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        events.push("view");
                      }),
                    ),
                    Effect.uninterruptible,
                  ),
                );
                return { generation: analytics.generation };
              }),
            }),
          );
          yield* runtime.awaitState(View, LifecycleState.Active);

          yield* runtime.disable(Database);
          const databaseUse = yield* Effect.exit(
            runtime.use(Database, () => Effect.succeed("database")),
          );
          const analyticsUse = yield* Effect.exit(
            runtime.use(Analytics, () => Effect.succeed("analytics")),
          );
          const viewUse = yield* Effect.exit(runtime.use(View, () => Effect.succeed("view")));
          expect([databaseUse, analyticsUse, viewUse].every(Exit.hasFails)).toBe(true);

          yield* Deferred.await(viewFinalizerStarted);
          expect(databaseAlive).toBe(true);
          expect(events).toEqual([]);
          const stopping = yield* runtime.snapshot;
          for (const id of ["database", "analytics", "view"] as const) {
            const current = node(stopping, id);
            expect(current.state._tag).toBe("Stopping");
            expect(current.lastRevocation?.reason).toBe("Disable");
            expect(current.lastRevocation?.rootId).toBe("database");
          }

          yield* Deferred.succeed(releaseViewFinalizer, void 0);
          yield* runtime.awaitIdle();
          expect(events).toEqual(["view", "analytics", "database"]);
          expect(databaseAlive).toBe(false);
        }).pipe(Effect.ensuring(Deferred.succeed(releaseViewFinalizer, void 0))),
      ),
    );
  });
});
