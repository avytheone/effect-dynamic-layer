import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement } from "../src/index.js";

const Provider = Context.Service<{ readonly value: string }>("test/replacement/Provider");
const Consumer = Context.Service<{ readonly value: string }>("test/replacement/Consumer");
const Other = Context.Service<{ readonly value: string }>("test/replacement/Other");

const provider = (value: string, acquire: Effect.Effect<void> = Effect.void) =>
  DynamicLayer.fromEffect(Provider)({
    id: "provider",
    requires: Requirement.empty,
    acquire: acquire.pipe(Effect.as({ value })),
  });

const consumer = (onAcquire: (value: string) => void = () => undefined) =>
  DynamicLayer.fromEffect(Consumer)({
    id: "consumer",
    requires: Requirement.service(Provider),
    acquire: Effect.gen(function* () {
      const dependency = yield* Provider;
      onAcquire(dependency.value);
      return { value: dependency.value };
    }),
  });

describe("DynamicRuntime replacement", () => {
  test("T06 replace rebuilds transitive consumers but preserves an independent branch", async () => {
    let consumerAcquires = 0;
    let otherAcquires = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(provider("A"));
          yield* runtime.register(consumer(() => consumerAcquires++));
          yield* runtime.register(
            DynamicLayer.fromEffect(Other)({
              id: "other",
              requires: Requirement.empty,
              acquire: Effect.sync(() => ({ value: String(++otherAcquires) })),
            }),
          );
          yield* runtime.awaitState("consumer", "Active");
          yield* runtime.awaitState("other", "Active");
          const otherGeneration = (yield* runtime.snapshot).nodes.find(
            (node) => node.id === "other",
          )?.generationId;
          yield* runtime.replace("provider", provider("B"));
          yield* runtime.awaitState("consumer", "Active");
          expect(yield* runtime.use(Consumer, (service) => Effect.succeed(service.value))).toBe(
            "B",
          );
          expect(
            (yield* runtime.snapshot).nodes.find((node) => node.id === "other")?.generationId,
          ).toBe(otherGeneration);
          expect(consumerAcquires).toBe(2);
          expect(otherAcquires).toBe(1);
        }),
      ),
    );
  });

  test("T16 disable during held build prevents stale publication", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            provider(
              "A",
              Deferred.succeed(started, void 0).pipe(Effect.andThen(Deferred.await(release))),
            ),
          );
          yield* Deferred.await(started);
          yield* runtime.disable("provider");
          expect(Exit.hasFails(yield* Effect.exit(runtime.use(Provider, Effect.succeed)))).toBe(
            true,
          );
          yield* Deferred.succeed(release, void 0);
          yield* runtime.awaitState("provider", "Disabled");
          expect(Exit.hasFails(yield* Effect.exit(runtime.use(Provider, Effect.succeed)))).toBe(
            true,
          );
        }),
      ),
    );
  });

  test("T17 T25 dependency replacement rejects stale consumer and rebuilds with fresh context", async () => {
    const values: Array<string> = [];
    const firstStarted = await Effect.runPromise(Deferred.make<void>());
    const firstRelease = await Effect.runPromise(Deferred.make<void>());
    let attempts = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(provider("A"));
          yield* runtime.register(
            DynamicLayer.fromEffect(Consumer)({
              id: "consumer",
              requires: Requirement.service(Provider),
              acquire: Effect.gen(function* () {
                const dependency = yield* Provider;
                const attempt = ++attempts;
                if (attempt === 1) {
                  yield* Deferred.succeed(firstStarted, void 0);
                  yield* Deferred.await(firstRelease);
                }
                values.push(dependency.value);
                return { value: dependency.value };
              }),
            }),
          );
          yield* Deferred.await(firstStarted);
          yield* runtime.replace("provider", provider("B"));
          expect(
            Exit.hasFails(
              yield* Effect.exit(runtime.use(Consumer, (service) => Effect.succeed(service.value))),
            ),
          ).toBe(true);
          yield* Deferred.succeed(firstRelease, void 0);
          yield* runtime.awaitState("consumer", "Active");
          expect(yield* runtime.use(Consumer, (service) => Effect.succeed(service.value))).toBe(
            "B",
          );
          expect(values.at(-1)).toBe("B");
        }),
      ),
    );
  });

  test("T19 rapid replace disable enable converges to the last recipe", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(provider("A"));
          yield* runtime.awaitState("provider", "Active");
          const operations = yield* Effect.all(
            [
              runtime.replace("provider", provider("B")),
              runtime.disable("provider"),
              runtime.enable("provider"),
              runtime.replace("provider", provider("C")),
            ],
            { concurrency: "unbounded" },
          );
          expect(operations).toHaveLength(4);
          yield* runtime.awaitState("provider", "Active");
          expect(yield* runtime.use(Provider, (service) => Effect.succeed(service.value))).toBe(
            "C",
          );
        }),
      ),
    );
  });

  test("T23 retiring id and key stay reserved until cleanup completes", async () => {
    const releaseStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseFinish = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Provider)({
              id: "provider",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(releaseStarted, void 0).pipe(
                    Effect.andThen(Deferred.await(releaseFinish)),
                  ),
                );
                return { value: "old" };
              }),
            }),
          );
          yield* runtime.awaitState("provider", "Active");
          yield* runtime.unregister("provider");
          yield* Deferred.await(releaseStarted);
          const rejected = yield* Effect.exit(runtime.register(provider("new")));
          expect(Exit.hasFails(rejected)).toBe(true);
          yield* Deferred.succeed(releaseFinish, void 0);
          yield* runtime.awaitIdle();
          yield* runtime.register(provider("new"));
          yield* runtime.awaitState("provider", "Active");
        }),
      ),
    );
  });

  test("T36 runtimes with identical ids and tags are isolated", async () => {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const left = yield* DynamicRuntime.make();
          const right = yield* DynamicRuntime.make();
          yield* left.register(provider("left"));
          yield* right.register(provider("right"));
          yield* left.awaitState("provider", "Active");
          yield* right.awaitState("provider", "Active");
          yield* left.disable("provider");
          return yield* right.use(Provider, (service) => Effect.succeed(service.value));
        }),
      ),
    );
    expect(values).toBe("right");
  });
});
