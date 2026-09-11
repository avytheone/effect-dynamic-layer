import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Fiber, type Scope, SubscriptionRef } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement } from "../src/index.js";

const Resource = Context.Service<{ readonly generation: number }>("test/shutdown/Resource");

const resource = (acquire: Effect.Effect<{ readonly generation: number }, never, Scope.Scope>) =>
  DynamicLayer.fromEffect(Resource)({ id: "resource", requires: Requirement.empty, acquire });

describe("DynamicRuntime shutdown", () => {
  test("T24 repeated enable disable and shutdown commands are idempotent", async () => {
    let acquired = 0;
    let released = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            resource(
              Effect.gen(function* () {
                acquired++;
                yield* Effect.addFinalizer(() => Effect.sync(() => released++));
                return { generation: acquired };
              }),
            ),
          );
          yield* runtime.awaitState("resource", "Active");
          yield* runtime.enable("resource");
          yield* runtime.disable("resource");
          yield* runtime.disable("resource");
          yield* runtime.awaitState("resource", "Disabled");
          yield* runtime.enable("resource");
          yield* runtime.enable("resource");
          yield* runtime.awaitState("resource", "Active");
          yield* runtime.shutdown;
          yield* runtime.shutdown;
        }),
      ),
    );
    expect(acquired).toBe(2);
    expect(released).toBe(2);
  });

  test("T33 shutdown interrupts Starting, then watcher, and consumes every completion", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const stopped = await Effect.runPromise(Deferred.make<void>());
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(true);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "resource",
              requires: Requirement.empty,
              when: gate,
              acquire: Deferred.succeed(started, void 0).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(stopped, void 0)),
                Effect.as({ generation: 1 }),
              ),
            }),
          );
          yield* Deferred.await(started);
          yield* runtime.shutdown;
          yield* Deferred.await(stopped);
          return yield* runtime.snapshot;
        }),
      ),
    );
    expect(snapshot.state).toBe("Closed");
    expect(snapshot.liveGenerations).toBe(0);
    expect(snapshot.gateWatchers).toBe(0);
    expect(snapshot.lifecycleWorkers).toBe(0);
  });

  test("T39 one hundred full lifecycle cycles balance resources without tracked leaks", async () => {
    let acquired = 0;
    let released = 0;
    const finalSnapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          const makeResource = () =>
            resource(
              Effect.gen(function* () {
                const generation = ++acquired;
                yield* Effect.addFinalizer(() => Effect.sync(() => released++));
                return { generation };
              }),
            );
          for (let cycle = 0; cycle < 100; cycle++) {
            yield* runtime.register(makeResource());
            yield* runtime.awaitState("resource", "Active");
            yield* runtime.replace("resource", makeResource());
            yield* runtime.awaitState("resource", "Active");
            yield* runtime.disable("resource");
            yield* runtime.awaitState("resource", "Disabled");
            yield* runtime.enable("resource");
            yield* runtime.awaitState("resource", "Active");
            yield* runtime.unregister("resource");
            yield* runtime.awaitIdle();
          }
          yield* runtime.shutdown;
          return yield* runtime.snapshot;
        }),
      ),
    );
    expect(acquired).toBe(300);
    expect(released).toBe(300);
    expect(finalSnapshot.liveGenerations).toBe(0);
    expect(finalSnapshot.managedCalls).toBe(0);
    expect(finalSnapshot.gateWatchers).toBe(0);
    expect(finalSnapshot.lifecycleWorkers).toBe(0);
  });

  test("T40 await effects are cancellable, reusable concurrently, and fail after removal or closure", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const blocker = yield* Deferred.make<void>();
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            resource(Deferred.await(blocker).pipe(Effect.as({ generation: 1 }))),
          );
          const reusable = runtime.awaitState("resource", "Active");
          const first = yield* Effect.forkChild(reusable);
          const second = yield* Effect.forkChild(reusable);
          yield* Fiber.interrupt(first);
          yield* Deferred.succeed(blocker, void 0);
          yield* Fiber.join(second);
          yield* runtime.awaitIdle();
          const removedWait = yield* Effect.forkChild(runtime.awaitState("resource", "Disabled"));
          yield* runtime.unregister("resource");
          expect(Exit.hasFails(yield* Fiber.await(removedWait))).toBe(true);
          yield* runtime.awaitIdle();
          const closedWait = runtime.awaitIdle();
          yield* runtime.shutdown;
          expect(Exit.hasFails(yield* Effect.exit(closedWait))).toBe(true);
        }),
      ),
    );
  });

  test("T33 concurrent shutdown requests on an empty runtime both complete", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          const first = yield* Effect.forkChild(runtime.shutdown);
          const second = yield* Effect.forkChild(runtime.shutdown);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          expect((yield* runtime.snapshot).state).toBe("Closed");
        }),
      ),
    );
  });

  test("T33 shutdown cancellation cannot detach from an ordered cleanup drain", async () => {
    const finalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const finalizerRelease = await Effect.runPromise(Deferred.make<void>());
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            resource(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(finalizerStarted, void 0).pipe(
                    Effect.andThen(Deferred.await(finalizerRelease)),
                  ),
                );
                return { generation: 1 };
              }),
            ),
          );
          yield* runtime.awaitState("resource", "Active");
          const shuttingDown = yield* Effect.forkChild(runtime.shutdown);
          yield* Deferred.await(finalizerStarted);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(shuttingDown));
          const during = yield* runtime.snapshot;
          yield* Deferred.succeed(finalizerRelease, void 0);
          yield* Fiber.join(interrupting);
          expect(during.state).toBe("Closing");
          return yield* runtime.snapshot;
        }),
      ),
    );
    expect(snapshot.state).toBe("Closed");
    expect(snapshot.liveGenerations).toBe(0);
    expect(snapshot.lifecycleWorkers).toBe(0);
  });
});
