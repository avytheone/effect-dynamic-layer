import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Fiber, SubscriptionRef } from "effect";
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "../src/index.js";

const Gated = Context.Service<{ readonly generation: number }>("test/gates/Gated");

const recipe = (
  gate: SubscriptionRef.SubscriptionRef<boolean>,
  acquire: Effect.Effect<{ readonly generation: number }, never, never>,
) =>
  DynamicLayer.fromEffect(Gated)({ id: "gated", requires: Requirement.empty, when: gate, acquire });

describe("DynamicRuntime gates", () => {
  test("T12 false gate is Pending and performs no acquisition", async () => {
    let acquisitions = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(false);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            recipe(
              gate,
              Effect.sync(() => ({ generation: ++acquisitions })),
            ),
          );
          yield* runtime.awaitState(Gated, LifecycleState.Pending);
          expect(acquisitions).toBe(0);
        }),
      ),
    );
  });

  test("T13 duplicate true does not restart while false then true does", async () => {
    let acquisitions = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(true);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            recipe(
              gate,
              Effect.sync(() => ({ generation: ++acquisitions })),
            ),
          );
          yield* runtime.awaitState(Gated, LifecycleState.Active);
          yield* SubscriptionRef.set(gate, true);
          yield* runtime.awaitIdle();
          expect(acquisitions).toBe(1);
          yield* SubscriptionRef.set(gate, false);
          yield* runtime.awaitState(Gated, LifecycleState.Pending);
          yield* SubscriptionRef.set(gate, true);
          yield* runtime.awaitState(Gated, LifecycleState.Active);
          expect(acquisitions).toBe(2);
        }),
      ),
    );
  });

  test("T14 registration gate watcher survives disable and is removed by unregister", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(true);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(recipe(gate, Effect.succeed({ generation: 1 })));
          yield* runtime.awaitState(Gated, LifecycleState.Active);
          yield* runtime.disable(Gated);
          yield* runtime.awaitState(Gated, LifecycleState.Disabled);
          expect((yield* runtime.snapshot).gateWatchers).toBe(1);
          yield* runtime.unregister(Gated);
          yield* runtime.awaitIdle();
          expect((yield* runtime.snapshot).gateWatchers).toBe(0);
        }),
      ),
    );
  });

  test("T15 lost wake-up during watcher startup is observed", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(false);
          const runtime = yield* DynamicRuntime.make();
          const registering = yield* Effect.forkChild(
            runtime.register(recipe(gate, Effect.succeed({ generation: 1 }))),
          );
          yield* SubscriptionRef.set(gate, true);
          yield* Fiber.join(registering);
          yield* runtime.awaitState(Gated, LifecycleState.Active);
        }),
      ),
    );
  });

  test("T18 gate false true invalidates a build started under the prior gate revision", async () => {
    let attempts = 0;
    const firstStarted = await Effect.runPromise(Deferred.make<void>());
    const firstRelease = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(true);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            recipe(
              gate,
              Effect.gen(function* () {
                const attempt = ++attempts;
                if (attempt === 1) {
                  yield* Deferred.succeed(firstStarted, void 0);
                  yield* Deferred.await(firstRelease);
                }
                return { generation: attempt };
              }),
            ),
          );
          yield* Deferred.await(firstStarted);
          yield* SubscriptionRef.set(gate, false);
          yield* runtime.awaitState(Gated, LifecycleState.Stopping);
          yield* SubscriptionRef.set(gate, true);
          yield* Deferred.succeed(firstRelease, void 0);
          yield* runtime.awaitState(Gated, LifecycleState.Active);
          const value = yield* runtime.use(Gated, (service) => Effect.succeed(service.generation));
          expect(value).toBe(2);
        }),
      ),
    );
  });
});
