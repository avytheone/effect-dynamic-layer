import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Fiber, SubscriptionRef } from "effect";
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "../src/index.js";

interface ValueService {
  readonly value: string;
}

const Controlled = Context.Service<ValueService>("test/tag-control/export-key");
const Other = Context.Service<ValueService>("test/tag-control/other-export-key");
const Missing = Context.Service<ValueService>("test/tag-control/missing-export-key");

const controlled = (
  value: string,
  options: {
    readonly id?: string;
    readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
    readonly acquire?: Effect.Effect<void>;
  } = {},
) =>
  DynamicLayer.fromEffect(Controlled)({
    id: options.id ?? "internal-node-id-unrelated-to-export-key",
    requires: Requirement.empty,
    ...(options.when === undefined ? {} : { when: options.when }),
    acquire: (options.acquire ?? Effect.void).pipe(Effect.as({ value })),
  });

describe("DynamicRuntime tag controls", () => {
  test("tag controls resolve pending and disabled registrations whose ids differ from tag keys", async () => {
    let acquisitions = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(false);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            controlled("ready", {
              when: gate,
              acquire: Effect.sync(() => acquisitions++),
            }),
          );

          yield* runtime.awaitState(Controlled, LifecycleState.Pending);
          yield* runtime.disable(Controlled);
          yield* runtime.awaitState(Controlled, LifecycleState.Disabled);
          yield* runtime.enable(Controlled);
          yield* runtime.awaitState(Controlled, LifecycleState.Pending);
          expect(acquisitions).toBe(0);

          yield* SubscriptionRef.set(gate, true);
          yield* runtime.awaitState(Controlled, LifecycleState.Active);
          expect(yield* runtime.use(Controlled, (service) => Effect.succeed(service.value))).toBe(
            "ready",
          );
          expect(acquisitions).toBe(1);
        }),
      ),
    );
  });

  test("missing registrations and retiring registrations report distinct target errors", async () => {
    const finalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const finalizerRelease = await Effect.runPromise(Deferred.make<void>());

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          const missing = yield* Effect.flip(runtime.enable(Missing));
          expect(missing._tag).toBe("ServiceNotRegistered");

          const missingReplace = yield* Effect.flip(
            runtime.replace(
              Missing,
              DynamicLayer.fromEffect(Missing)({
                id: "missing-internal-id",
                requires: Requirement.empty,
                acquire: Effect.succeed({ value: "never-acquired" }),
              }),
            ),
          );
          expect(missingReplace._tag).toBe("ServiceNotRegistered");
          if (missingReplace._tag === "ServiceNotRegistered") {
            expect(missingReplace.serviceKey).toBe(Missing.key);
          }
          if (missing._tag === "ServiceNotRegistered") {
            expect(missing.serviceKey).toBe(Missing.key);
          }

          yield* runtime.register(
            DynamicLayer.fromEffect(Controlled)({
              id: "retiring-internal-id",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(finalizerStarted, void 0).pipe(
                    Effect.andThen(Deferred.await(finalizerRelease)),
                  ),
                );
                return { value: "held" };
              }),
            }),
          );
          yield* runtime.awaitState(Controlled, LifecycleState.Active);
          yield* runtime.unregister(Controlled);
          yield* Deferred.await(finalizerStarted);

          const retiring = yield* Effect.flip(runtime.disable(Controlled));
          expect(retiring._tag).toBe("NodeRetiring");
          if (retiring._tag === "NodeRetiring") {
            expect(retiring.id).toBe("retiring-internal-id");
            expect(retiring.exportKey).toBe(Controlled.key);
          }

          const unavailable = yield* Effect.flip(
            runtime.awaitState(Controlled, LifecycleState.Disabled),
          );
          expect(unavailable._tag).toBe("AwaitStateUnavailable");
          if (unavailable._tag === "AwaitStateUnavailable") {
            expect(unavailable.id).toBe("retiring-internal-id");
            expect(unavailable.expected).toBe(LifecycleState.Disabled);
          }

          yield* Deferred.succeed(finalizerRelease, void 0);
          yield* runtime.awaitIdle();
        }).pipe(Effect.ensuring(Deferred.succeed(finalizerRelease, void 0))),
      ),
    );
  });

  test("replace rejects id and export-key mismatches without disturbing the live recipe", async () => {
    let acquisitions = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            controlled("original", { acquire: Effect.sync(() => acquisitions++) }),
          );
          yield* runtime.awaitState(Controlled, LifecycleState.Active);

          const idMismatch = yield* Effect.flip(
            runtime.replace(Controlled, controlled("wrong-id", { id: "different-internal-id" })),
          );
          expect(idMismatch._tag).toBe("ReplaceMismatch");

          const keyMismatch = yield* Effect.flip(
            runtime.replace(
              Controlled,
              DynamicLayer.fromEffect(Other)({
                id: "internal-node-id-unrelated-to-export-key",
                requires: Requirement.empty,
                acquire: Effect.succeed({ value: "wrong-key" }),
              }),
            ),
          );
          expect(keyMismatch._tag).toBe("ReplaceMismatch");

          expect(yield* runtime.use(Controlled, (service) => Effect.succeed(service.value))).toBe(
            "original",
          );
          expect(acquisitions).toBe(1);
        }),
      ),
    );
  });

  test("a wait rejected by unregister cannot attach to a later registration", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(false);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(controlled("old", { when: gate }));
          yield* runtime.awaitState(Controlled, LifecycleState.Pending);

          const waiting = yield* Effect.forkChild(
            Effect.flip(runtime.awaitState(Controlled, LifecycleState.Active)),
          );
          yield* Effect.yieldNow;
          yield* runtime.snapshot;
          yield* runtime.unregister(Controlled);
          const oldWait = yield* Fiber.join(waiting);
          expect(oldWait._tag).toBe("AwaitStateUnavailable");
          if (oldWait._tag === "AwaitStateUnavailable") {
            expect(oldWait.id).toBe("internal-node-id-unrelated-to-export-key");
            expect(oldWait.expected).toBe(LifecycleState.Active);
          }

          yield* runtime.awaitIdle();
          yield* runtime.register(controlled("new"));
          yield* runtime.awaitState(Controlled, LifecycleState.Active);
          expect(yield* runtime.use(Controlled, (service) => Effect.succeed(service.value))).toBe(
            "new",
          );
          expect(oldWait._tag).toBe("AwaitStateUnavailable");
        }),
      ),
    );
  });

  test("a wait remains bound to the same node across replacement", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(controlled("old"));
          yield* runtime.awaitState(Controlled, LifecycleState.Active);
          yield* runtime.disable(Controlled);
          yield* runtime.awaitState(Controlled, LifecycleState.Disabled);

          const waiting = yield* Effect.forkChild(
            runtime.awaitState(Controlled, LifecycleState.Active),
          );
          yield* Effect.yieldNow;
          yield* runtime.snapshot;
          yield* runtime.replace(Controlled, controlled("replacement"));
          yield* runtime.enable(Controlled);
          yield* Fiber.join(waiting);

          expect(yield* runtime.use(Controlled, (service) => Effect.succeed(service.value))).toBe(
            "replacement",
          );
        }),
      ),
    );
  });
});
