import { describe, expect, test } from "bun:test";
import * as EffectPackage from "effect";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  LayerMap,
  Scope,
  ScopedRef,
  Stream,
  SubscriptionRef,
} from "effect";

const Input = Context.Service<{ readonly name: string }>("compatibility/Input");
const Output = Context.Service<{ readonly name: string; readonly generation: number }>(
  "compatibility/Output",
);
const Resource = Context.Service<{ readonly generation: number }>("compatibility/Resource");

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

describe("Effect 4.0.0-rc.115 compatibility spike", () => {
  test("fresh MemoMaps build the same Layer independently with their own Context and Scope", async () => {
    let acquisitions = 0;
    const releases: Array<string> = [];
    const layer = Layer.effect(
      Output,
      Effect.gen(function* () {
        const input = yield* Input;
        const generation = ++acquisitions;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(input.name);
          }),
        );
        return { name: input.name, generation };
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        const firstMemo = yield* Layer.makeMemoMap;
        const secondMemo = yield* Layer.makeMemoMap;

        const first = yield* Layer.buildWithMemoMap(layer, firstMemo, firstScope).pipe(
          Effect.provideService(Input, { name: "first" }),
        );
        const second = yield* Layer.buildWithMemoMap(layer, secondMemo, secondScope).pipe(
          Effect.provideService(Input, { name: "second" }),
        );

        const values = [Context.get(first, Output), Context.get(second, Output)] as const;
        yield* close(firstScope);
        yield* close(secondScope);
        return values;
      }),
    );

    expect(result).toEqual([
      { name: "first", generation: 1 },
      { name: "second", generation: 2 },
    ]);
    expect(releases).toEqual(["first", "second"]);
  });

  test("successful acquisition remains alive until its explicit generation Scope closes", async () => {
    const events: Array<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const memo = yield* Layer.makeMemoMap;
        const layer = Layer.effect(
          Resource,
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire");
              return { generation: 1 };
            }),
            () => Effect.sync(() => events.push("release")),
          ),
        );

        yield* Layer.buildWithMemoMap(layer, memo, scope);
        expect(events).toEqual(["acquire"]);
        yield* close(scope);
      }),
    );
    expect(events).toEqual(["acquire", "release"]);
  });

  test("failed acquisition releases resources acquired earlier in the Layer", async () => {
    const events: Array<string> = [];
    const layer = Layer.effect(
      Resource,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => events.push("acquire")),
          () => Effect.sync(() => events.push("release")),
        );
        return yield* Effect.fail("acquisition failed" as const);
      }),
    );

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const memo = yield* Layer.makeMemoMap;
        const result = yield* Effect.exit(Layer.buildWithMemoMap(layer, memo, scope));
        yield* close(scope);
        return result;
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toEqual(["acquire", "release"]);
  });

  test("interrupting acquisition releases resources acquired before suspension", async () => {
    const events: Array<string> = [];
    const started = await Effect.runPromise(Deferred.make<void>());
    const blocker = await Effect.runPromise(Deferred.make<void>());
    const layer = Layer.effect(
      Resource,
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Deferred.succeed(started, void 0).pipe(
            Effect.as({ generation: 1 }),
            Effect.tap(() => Effect.sync(() => events.push("acquire"))),
          ),
          () => Effect.sync(() => events.push("release")),
        );
        yield* Deferred.await(blocker);
        return { generation: 1 };
      }),
    );

    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const memo = yield* Layer.makeMemoMap;
        const fiber = yield* Effect.forkChild(Layer.buildWithMemoMap(layer, memo, scope));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        yield* close(scope);
        return exit;
      }),
    );

    expect(Exit.hasInterrupts(interrupted)).toBe(true);
    expect(events).toEqual(["acquire", "release"]);
  });

  test("forkScoped child outlives acquisition and is interrupted with the generation Scope", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const stopped = await Effect.runPromise(Deferred.make<void>());
    const layer = Layer.effect(
      Resource,
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Deferred.succeed(started, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, void 0)),
          ),
        );
        return { generation: 1 };
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const memo = yield* Layer.makeMemoMap;
        yield* Layer.buildWithMemoMap(layer, memo, scope);
        yield* Deferred.await(started);
        expect(yield* Deferred.isDone(stopped)).toBe(false);
        yield* close(scope);
        yield* Deferred.await(stopped);
      }),
    );
  });

  test("SubscriptionRef.changes emits the initial value and subsequent updates without a read/subscribe gap", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* SubscriptionRef.make(0);
        const observing = yield* Deferred.make<void>();
        const fiber = yield* SubscriptionRef.changes(ref).pipe(
          Stream.tap(() => Deferred.succeed(observing, void 0)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(observing);
        yield* SubscriptionRef.set(ref, 1);
        yield* SubscriptionRef.set(ref, 2);
        return Array.from(yield* Fiber.join(fiber));
      }),
    );

    expect(values).toEqual([0, 1, 2]);
  });

  test("forkIn inherits caller Service and Context.Reference values", async () => {
    const CallerService = Context.Service<{ readonly value: string }>(
      "compatibility/CallerService",
    );
    const CallerReference = Context.Reference("compatibility/CallerReference", {
      defaultValue: () => "default",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* Scope.make();
        const fiber = yield* Effect.forkIn(
          Effect.gen(function* () {
            const service = yield* CallerService;
            const reference = yield* CallerReference;
            return [service.value, reference] as const;
          }),
          owner,
        );
        const inherited = yield* Fiber.join(fiber);
        yield* close(owner);
        return inherited;
      }).pipe(
        Effect.provideService(CallerService, { value: "caller-service" }),
        Effect.provideService(CallerReference, "caller-reference"),
      ),
    );

    expect(result).toEqual(["caller-service", "caller-reference"]);
  });

  test("ScopedRef replaces one owned value but does not rebuild consumers holding the old value", async () => {
    const events: Array<string> = [];
    const acquire = (generation: number) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`acquire:${generation}`);
          return { generation };
        }),
        () => Effect.sync(() => events.push(`release:${generation}`)),
      );

    const snapshots = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* ScopedRef.fromAcquire(acquire(1));
          const captured = yield* ScopedRef.get(ref);
          yield* ScopedRef.set(ref, acquire(2));
          const current = yield* ScopedRef.get(ref);
          return [captured.generation, current.generation] as const;
        }),
      ),
    );

    expect(snapshots).toEqual([1, 2]);
    expect(events).toEqual(["acquire:1", "acquire:2", "release:1", "release:2"]);
  });

  test("LayerMap shares a key while leases overlap and invalidation causes a later acquisition", async () => {
    let generation = 0;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const map = yield* LayerMap.make((key: string) =>
            Layer.effect(
              Resource,
              Effect.sync(
                () => ({ generation: ++generation, key }) as { generation: number; key: string },
              ),
            ),
          );

          // The default idle TTL is zero. Keep all three leases in one child
          // scope so the second read overlaps the first and must share it.
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const firstContext = yield* map.contextEffect("same");
              const cachedContext = yield* map.contextEffect("same");
              yield* map.invalidate("same");
              const replacedContext = yield* map.contextEffect("same");
              return [
                Context.get(firstContext, Resource).generation,
                Context.get(cachedContext, Resource).generation,
                Context.get(replacedContext, Resource).generation,
              ] as const;
            }),
          );
        }),
      ),
    );

    expect(result).toEqual([1, 1, 2]);
  });

  test("rc root exports ScopedRef and LayerMap but not the removed Reloadable module", () => {
    expect("ScopedRef" in EffectPackage).toBe(true);
    expect("LayerMap" in EffectPackage).toBe(true);
    expect("Reloadable" in EffectPackage).toBe(false);
  });
});
