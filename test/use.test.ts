import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Fiber } from "effect";
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "../src/index.js";

const Service = Context.Service<{ readonly generation: number }>("test/use/Service");
const Caller = Context.Service<{ readonly label: string }>("test/use/Caller");
const CallerRef = Context.Reference("test/use/CallerRef", { defaultValue: () => "default" });

const description = (generation: number) =>
  DynamicLayer.fromEffect(Service)({
    id: "service",
    requires: Requirement.empty,
    acquire: Effect.succeed({ generation }),
  });

describe("DynamicRuntime managed use", () => {
  test("T27 unavailable service rejects without invoking callback", async () => {
    let callbacks = 0;
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          return yield* Effect.exit(runtime.use(Service, () => Effect.sync(() => ++callbacks)));
        }),
      ),
    );
    expect(Exit.hasFails(exit)).toBe(true);
    expect(callbacks).toBe(0);
  });

  test("T28 T30 admitted use is pinned, interrupted by replace, and never retried", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const cleaned = await Effect.runPromise(Deferred.make<void>());
    let callbacks = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(description(1));
          yield* runtime.awaitState(Service, LifecycleState.Active);
          const call = yield* Effect.forkChild(
            runtime.use(Service, (service) =>
              Effect.gen(function* () {
                callbacks++;
                expect(service.generation).toBe(1);
                yield* Deferred.succeed(started, void 0);
                yield* Effect.never.pipe(
                  Effect.onInterrupt(() => Deferred.succeed(cleaned, void 0)),
                );
                return service.generation;
              }),
            ),
          );
          yield* Deferred.await(started);
          yield* runtime.replace(Service, description(2));
          const afterAck = yield* Effect.exit(runtime.use(Service, () => Effect.succeed(0)));
          expect(Exit.hasFails(afterAck)).toBe(true);
          yield* Deferred.await(cleaned);
          expect(Exit.hasInterrupts(yield* Fiber.await(call))).toBe(true);
          yield* runtime.awaitState(Service, LifecycleState.Active);
          expect(yield* runtime.use(Service, (service) => Effect.succeed(service.generation))).toBe(
            2,
          );
          expect(callbacks).toBe(1);
        }),
      ),
    );
  });

  test("T29 caller cancellation releases call tracking and scoped cleanup", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const cleaned = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(description(1));
          yield* runtime.awaitState(Service, LifecycleState.Active);
          const call = yield* Effect.forkChild(
            runtime.use(Service, () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Deferred.succeed(cleaned, void 0));
                yield* Deferred.succeed(started, void 0);
                return yield* Effect.never;
              }),
            ),
          );
          yield* Deferred.await(started);
          yield* Fiber.interrupt(call);
          yield* Deferred.await(cleaned);
          yield* runtime.awaitIdle();
          expect((yield* runtime.snapshot).managedCalls).toBe(0);
        }),
      ),
    );
  });

  test("T31 use preserves caller Service and Context.Reference", async () => {
    const inherited = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(description(1));
          yield* runtime.awaitState(Service, LifecycleState.Active);
          return yield* runtime.use(Service, () =>
            Effect.gen(function* () {
              const caller = yield* Caller;
              const reference = yield* CallerRef;
              return [caller.label, reference] as const;
            }),
          );
        }).pipe(
          Effect.provideService(Caller, { label: "caller" }),
          Effect.provideService(CallerRef, "reference"),
        ),
      ),
    );
    expect(inherited).toEqual(["caller", "reference"]);
  });

  test("T32 scoped callback children are stopped before provider release", async () => {
    const childStarted = await Effect.runPromise(Deferred.make<void>());
    const childStopped = await Effect.runPromise(Deferred.make<void>());
    let providerReleased = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Service)({
              id: "service",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    providerReleased = true;
                  }),
                );
                return { generation: 1 };
              }),
            }),
          );
          yield* runtime.awaitState(Service, LifecycleState.Active);
          yield* runtime.use(Service, () =>
            Effect.gen(function* () {
              yield* Effect.forkScoped(
                Deferred.succeed(childStarted, void 0).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(childStopped, void 0)),
                ),
              );
              yield* Deferred.await(childStarted);
            }),
          );
          yield* Deferred.await(childStopped);
          expect(providerReleased).toBe(false);
          yield* runtime.disable(Service);
          yield* runtime.awaitIdle();
          expect(providerReleased).toBe(true);
        }),
      ),
    );
  });
});
