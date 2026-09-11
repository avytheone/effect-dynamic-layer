import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Layer, SubscriptionRef } from "effect";
import {
  DynamicLayer,
  DynamicRuntime,
  LifecycleState,
  Requirement,
  safeSummary,
} from "../src/index.js";

const Resource = Context.Service<{ readonly value: number }>("test/errors/Resource");
const Dependent = Context.Service<{ readonly value: number }>("test/errors/Dependent");

describe("DynamicRuntime failures", () => {
  test("T09 typed acquisition failure and defect retain distinct Cause categories", async () => {
    const failures = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "typed",
              requires: Requirement.empty,
              acquire: Effect.fail("typed" as const),
            }),
          );
          const Defect = Context.Service<{ readonly value: number }>("test/errors/Defect");
          yield* runtime.register(
            DynamicLayer.fromEffect(Defect)({
              id: "defect",
              requires: Requirement.empty,
              acquire: Effect.die("defect"),
            }),
          );
          yield* runtime.awaitState(Resource, LifecycleState.Failed);
          yield* runtime.awaitState(Defect, LifecycleState.Failed);
          const nodes = (yield* runtime.snapshot).nodes;
          const typed = nodes.find((node) => node.id === "typed")?.state;
          const defect = nodes.find((node) => node.id === "defect")?.state;
          return {
            typed: typed?._tag === "Failed" ? safeSummary(typed.failure) : undefined,
            defect: defect?._tag === "Failed" ? safeSummary(defect.failure) : undefined,
          };
        }),
      ),
    );
    expect(failures.typed?.hasFailures).toBe(true);
    expect(failures.typed?.hasDefects).toBe(false);
    expect(failures.defect?.hasDefects).toBe(true);
  });

  test("T10 duplicate gate and unrelated graph changes do not retry a failed fingerprint", async () => {
    let attempts = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* SubscriptionRef.make(true);
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "failed",
              requires: Requirement.empty,
              when: gate,
              acquire: Effect.sync(() => attempts++).pipe(
                Effect.andThen(Effect.fail("no" as const)),
              ),
            }),
          );
          yield* runtime.awaitState(Resource, LifecycleState.Failed);
          yield* SubscriptionRef.set(gate, true);
          const Other = Context.Service<{ readonly value: number }>("test/errors/Other");
          yield* runtime.register(
            DynamicLayer.fromEffect(Other)({
              id: "other",
              requires: Requirement.empty,
              acquire: Effect.succeed({ value: 1 }),
            }),
          );
          yield* runtime.awaitState(Other, LifecycleState.Active);
          yield* runtime.awaitIdle();
          expect(attempts).toBe(1);
        }),
      ),
    );
  });

  test("T11 explicit retry makes exactly one new attempt", async () => {
    let attempts = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "resource",
              requires: Requirement.empty,
              acquire: Effect.suspend(() =>
                ++attempts === 1
                  ? Effect.fail("first" as const)
                  : Effect.succeed({ value: attempts }),
              ),
            }),
          );
          yield* runtime.awaitState(Resource, LifecycleState.Failed);
          yield* runtime.retry(Resource);
          yield* runtime.awaitState(Resource, LifecycleState.Active);
          expect(attempts).toBe(2);
          yield* runtime.retry(Resource);
          yield* runtime.awaitIdle();
          expect(attempts).toBe(2);
        }),
      ),
    );
  });

  test("T22 invalid candidate graphs fail atomically", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "resource",
              requires: Requirement.empty,
              acquire: Effect.succeed({ value: 1 }),
            }),
          );
          yield* runtime.awaitState(Resource, LifecycleState.Active);
          const duplicateId = yield* Effect.exit(
            runtime.register(
              DynamicLayer.fromEffect(Dependent)({
                id: "resource",
                requires: Requirement.empty,
                acquire: Effect.succeed({ value: 2 }),
              }),
            ),
          );
          const duplicateExport = yield* Effect.exit(
            runtime.register(
              DynamicLayer.fromEffect(Resource)({
                id: "duplicate",
                requires: Requirement.empty,
                acquire: Effect.succeed({ value: 2 }),
              }),
            ),
          );
          const selfCycle = yield* Effect.exit(
            runtime.replace(
              Resource,
              DynamicLayer.fromEffect(Resource)({
                id: "resource",
                requires: Requirement.service(Resource),
                acquire: Effect.succeed({ value: 2 }),
              }),
            ),
          );
          expect([duplicateId, duplicateExport, selfCycle].every(Exit.hasFails)).toBe(true);
          expect(yield* runtime.use(Resource, (service) => Effect.succeed(service.value))).toBe(1);
        }),
      ),
    );
  });

  test("T34 release defect is visible and owning Scope is not falsely successful", async () => {
    let stateTag: string | undefined;
    const outer = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* DynamicRuntime.make();
            yield* runtime.register(
              DynamicLayer.fromEffect(Resource)({
                id: "resource",
                requires: Requirement.empty,
                acquire: Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Effect.die("release defect"));
                  return { value: 1 };
                }),
              }),
            );
            yield* runtime.awaitState(Resource, LifecycleState.Active);
            yield* runtime.disable(Resource);
            yield* runtime.awaitState(Resource, LifecycleState.Failed);
            stateTag = (yield* runtime.snapshot).nodes[0]?.state._tag;
          }),
        ),
      ),
    );
    expect(stateTag).toBe("Failed");
    expect(Exit.hasDies(outer)).toBe(true);
  });

  test("T35 uninterruptible cleanup keeps branch Stopping until released", async () => {
    const finalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const finalizerRelease = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Resource)({
              id: "resource",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(finalizerStarted, void 0).pipe(
                    Effect.andThen(Deferred.await(finalizerRelease)),
                    Effect.uninterruptible,
                  ),
                );
                return { value: 1 };
              }),
            }),
          );
          yield* runtime.awaitState(Resource, LifecycleState.Active);
          yield* runtime.disable(Resource);
          yield* Deferred.await(finalizerStarted);
          expect((yield* runtime.snapshot).nodes[0]?.state._tag).toBe("Stopping");
          yield* Deferred.succeed(finalizerRelease, void 0);
          yield* runtime.awaitState(Resource, LifecycleState.Disabled);
        }),
      ),
    );
  });

  test("InvalidExport missing declared Reference output fails instead of synthesizing its default", async () => {
    const ReferenceOutput = Context.Reference("test/errors/ReferenceOutput", {
      defaultValue: () => ({ value: 99 }),
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          const malformed = DynamicLayer.fromLayer(ReferenceOutput)({
            id: "malformed",
            requires: Requirement.empty,
            layer: Layer.empty,
          });
          yield* runtime.register(malformed);
          yield* runtime.awaitState(ReferenceOutput, LifecycleState.Failed);
          const snapshot = yield* runtime.snapshot;
          expect(snapshot.nodes[0]?.state._tag).toBe("Failed");
        }),
      ),
    );
  });

  test("T34 stale acquisition with acquire and rollback defects remains release-quarantined", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const releaseBuild = await Effect.runPromise(Deferred.make<void>());
    let attempts = 0;
    const outer = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* DynamicRuntime.make();
            yield* runtime.register(
              DynamicLayer.fromEffect(Resource)({
                id: "double-defect",
                requires: Requirement.empty,
                acquire: Effect.gen(function* () {
                  attempts++;
                  yield* Effect.addFinalizer(() => Effect.die("rollback defect"));
                  yield* Deferred.succeed(started, void 0);
                  yield* Deferred.await(releaseBuild).pipe(Effect.uninterruptible);
                  return yield* Effect.die("acquire defect");
                }),
              }),
            );
            yield* Deferred.await(started);
            yield* runtime.disable(Resource);
            yield* Deferred.succeed(releaseBuild, void 0);
            yield* runtime.awaitState(Resource, LifecycleState.Failed);
            yield* runtime.enable(Resource);
            yield* runtime.retry(Resource);
            yield* runtime.awaitIdle();
            const state = (yield* runtime.snapshot).nodes[0]?.state;
            expect(state?._tag).toBe("Failed");
            if (state?._tag === "Failed") expect(state.failure.phase).toBe("release");
            expect(attempts).toBe(1);
          }),
        ),
      ),
    );
    expect(Exit.hasDies(outer)).toBe(true);
  });

  test("T34 release quarantine stays visible across enable gate replace and retry commands", async () => {
    const gate = await Effect.runPromise(SubscriptionRef.make(true));
    let attempts = 0;
    const outer = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* DynamicRuntime.make();
            const failedRelease = DynamicLayer.fromEffect(Resource)({
              id: "resource",
              requires: Requirement.empty,
              when: gate,
              acquire: Effect.gen(function* () {
                attempts++;
                yield* Effect.addFinalizer(() => Effect.die("release"));
                return { value: attempts };
              }),
            });
            yield* runtime.register(failedRelease);
            yield* runtime.awaitState(Resource, LifecycleState.Active);
            yield* runtime.disable(Resource);
            yield* runtime.awaitState(Resource, LifecycleState.Failed);
            yield* runtime.enable(Resource);
            yield* SubscriptionRef.set(gate, false);
            yield* SubscriptionRef.set(gate, true);
            yield* runtime.replace(Resource, failedRelease);
            yield* runtime.retry(Resource);
            yield* runtime.awaitIdle();
            const state = (yield* runtime.snapshot).nodes[0]?.state;
            expect(state?._tag).toBe("Failed");
            if (state?._tag === "Failed") expect(state.failure.phase).toBe("release");
            expect(attempts).toBe(1);
          }),
        ),
      ),
    );
    expect(Exit.hasDies(outer)).toBe(true);
  });
});
