import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Exit, Fiber, References, type Scope, Stream } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement, safeSummary } from "../src/index.js";

const Service = Context.Service<{ readonly value: number }>("test/ownership-regression/Service");
const ShutdownService = Context.Service<{ readonly value: number }>(
  "test/ownership-regression/ShutdownService",
);

// rc.115 does not make progress at quantum 1; 16 is deliberately low while remaining runnable.
const LowSchedulerQuantum = 16;

const service = (acquire: Effect.Effect<{ readonly value: number }, never, Scope.Scope>) =>
  DynamicLayer.fromEffect(Service)({
    id: "service",
    requires: Requirement.empty,
    acquire,
  });

describe("DynamicRuntime ownership regressions", () => {
  test("T29 cancellation in the admission/start race frees admissions and any scoped children", async () => {
    let childLive = 0;
    let providerReleases = 0;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            service(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    providerReleases++;
                  }),
                );
                return { value: 1 };
              }),
            ),
          );
          yield* runtime.awaitState("service", "Active");

          const startAdmittedCallback = yield* Deferred.make<void>();
          let observedManagedCalls = 0;
          let admittedCallbackStarts = 0;
          const admissionObserver = yield* runtime.changes.pipe(
            Stream.filter((snapshot) => snapshot.managedCalls === 1),
            Stream.take(1),
            Stream.tap((snapshot) =>
              Effect.sync(() => {
                observedManagedCalls = snapshot.managedCalls;
              }),
            ),
            Stream.runDrain,
            Effect.forkChild,
          );
          const admittedCall = yield* Effect.forkChild(
            runtime.use(Service, () =>
              Deferred.await(startAdmittedCallback).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    admittedCallbackStarts++;
                  }),
                ),
                Effect.andThen(
                  Effect.forkScoped(
                    Effect.acquireRelease(
                      Effect.sync(() => {
                        childLive++;
                      }),
                      () =>
                        Effect.sync(() => {
                          childLive--;
                        }),
                    ).pipe(Effect.andThen(Effect.never)),
                  ),
                ),
                Effect.andThen(Effect.never),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            yield* Fiber.join(admissionObserver);
            expect(observedManagedCalls).toBe(1);
            yield* Fiber.interrupt(admittedCall);
            expect(Exit.hasInterrupts(yield* Fiber.await(admittedCall))).toBe(true);
            yield* runtime.awaitIdle();
            expect((yield* runtime.snapshot).managedCalls).toBe(0);
            expect(admittedCallbackStarts).toBe(0);
            expect(childLive).toBe(0);
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(startAdmittedCallback, void 0).pipe(
                Effect.andThen(Fiber.interrupt(admittedCall)),
                Effect.asVoid,
              ),
            ),
          );

          for (let attempt = 0; attempt < 32; attempt++) {
            const call = yield* Effect.forkChild(
              runtime.use(Service, () =>
                Effect.gen(function* () {
                  yield* Effect.forkScoped(
                    Effect.acquireRelease(
                      Effect.sync(() => {
                        childLive++;
                      }),
                      () =>
                        Effect.sync(() => {
                          childLive--;
                        }),
                    ).pipe(Effect.andThen(Effect.never)),
                  );
                  return yield* Effect.never;
                }),
              ),
            );
            yield* Fiber.interrupt(call);
            expect(Exit.hasInterrupts(yield* Fiber.await(call))).toBe(true);
          }

          yield* runtime.awaitIdle();
          const afterCancellation = yield* runtime.snapshot;
          expect(afterCancellation.managedCalls).toBe(0);
          expect(afterCancellation.liveGenerations).toBe(1);
          expect(childLive).toBe(0);

          yield* runtime.disable("service");
          yield* runtime.awaitIdle();
          expect(providerReleases).toBe(1);
          expect((yield* runtime.snapshot).liveGenerations).toBe(0);
        }).pipe(Effect.provideService(References.MaxOpsBeforeYield, LowSchedulerQuantum)),
      ),
    );
  });

  test("synchronous throwing runtime.use callback is a defect and leaves shutdown leak-free", async () => {
    let releases = 0;
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            service(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    releases++;
                  }),
                );
                return { value: 1 };
              }),
            ),
          );
          yield* runtime.awaitState("service", "Active");

          const useExit = yield* Effect.exit(
            runtime.use(Service, (): Effect.Effect<never> => {
              throw new Error("synchronous callback defect");
            }),
          );
          expect(Exit.hasDies(useExit)).toBe(true);

          yield* runtime.awaitIdle();
          expect((yield* runtime.snapshot).managedCalls).toBe(0);
          yield* runtime.disable("service");
          yield* runtime.awaitIdle();
          expect(releases).toBe(1);
          yield* runtime.shutdown;
          return yield* runtime.snapshot;
        }),
      ),
    );

    expect(snapshot.state).toBe("Closed");
    expect(snapshot.liveGenerations).toBe(0);
    expect(snapshot.managedCalls).toBe(0);
  });

  test("runtime.use scoped-finalizer defect reaches caller and CloseFailed while provider cleanup is attempted", async () => {
    let providerCleanupAttempts = 0;
    let runtimeState: string | undefined;
    let managedCalls: number | undefined;
    let useSawDefect = false;
    let shutdownSawFailure = false;

    const owningExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* DynamicRuntime.make();
            yield* runtime.register(
              service(
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      providerCleanupAttempts++;
                    }),
                  );
                  return { value: 1 };
                }),
              ),
            );
            yield* runtime.awaitState("service", "Active");

            const useExit = yield* Effect.exit(
              runtime.use(Service, () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() => Effect.die("call finalizer defect"));
                  return 1;
                }),
              ),
            );
            useSawDefect = Exit.hasDies(useExit);

            yield* runtime.awaitState("service", "Failed");
            const beforeShutdown = yield* runtime.snapshot;
            managedCalls = beforeShutdown.managedCalls;
            const serviceState = beforeShutdown.nodes.find((node) => node.id === "service")?.state;
            if (serviceState?._tag !== "Failed")
              throw new Error("service did not retain callback cleanup failure");
            expect(serviceState.failure.phase).toBe("release");
            expect(safeSummary(serviceState.failure).hasDefects).toBe(true);
            expect(providerCleanupAttempts).toBe(1);

            const shutdownExit = yield* Effect.exit(runtime.shutdown);
            shutdownSawFailure = Exit.hasFails(shutdownExit);
            runtimeState = (yield* runtime.snapshot).state;
          }),
        ),
      ),
    );

    expect(useSawDefect).toBe(true);
    expect(managedCalls).toBe(0);
    expect(providerCleanupAttempts).toBe(1);
    expect(shutdownSawFailure).toBe(true);
    expect(runtimeState).toBe("CloseFailed");
    expect(Exit.hasDies(owningExit)).toBe(true);
  });

  test("T32 acquisition forkScoped workers survive build and are joined before disable and shutdown release", async () => {
    const disabledWorkerStarted = await Effect.runPromise(Deferred.make<void>());
    const disabledWorkerStopped = await Effect.runPromise(Deferred.make<void>());
    const shutdownWorkerStarted = await Effect.runPromise(Deferred.make<void>());
    const shutdownWorkerStopped = await Effect.runPromise(Deferred.make<void>());
    const events: Array<string> = [];

    const finalSnapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(
            DynamicLayer.fromEffect(Service)({
              id: "disabled-worker",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => events.push("disabled:release")),
                );
                yield* Effect.forkScoped(
                  Deferred.succeed(disabledWorkerStarted, void 0).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(disabledWorkerStopped, void 0).pipe(
                        Effect.tap(() => Effect.sync(() => events.push("disabled:worker-stopped"))),
                      ),
                    ),
                  ),
                );
                return { value: 1 };
              }),
            }),
          );
          yield* runtime.register(
            DynamicLayer.fromEffect(ShutdownService)({
              id: "shutdown-worker",
              requires: Requirement.empty,
              acquire: Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => events.push("shutdown:release")),
                );
                yield* Effect.forkScoped(
                  Deferred.succeed(shutdownWorkerStarted, void 0).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(shutdownWorkerStopped, void 0).pipe(
                        Effect.tap(() => Effect.sync(() => events.push("shutdown:worker-stopped"))),
                      ),
                    ),
                  ),
                );
                return { value: 2 };
              }),
            }),
          );

          yield* runtime.awaitState("disabled-worker", "Active");
          yield* runtime.awaitState("shutdown-worker", "Active");
          yield* Deferred.await(disabledWorkerStarted);
          yield* Deferred.await(shutdownWorkerStarted);
          expect(yield* Deferred.isDone(disabledWorkerStopped)).toBe(false);
          expect(yield* Deferred.isDone(shutdownWorkerStopped)).toBe(false);

          yield* runtime.disable("disabled-worker");
          yield* runtime.awaitState("disabled-worker", "Disabled");
          yield* Deferred.await(disabledWorkerStopped);
          expect(events.slice(0, 2)).toEqual(["disabled:worker-stopped", "disabled:release"]);
          expect(yield* Deferred.isDone(shutdownWorkerStopped)).toBe(false);

          yield* runtime.shutdown;
          yield* Deferred.await(shutdownWorkerStopped);
          return yield* runtime.snapshot;
        }),
      ),
    );

    expect(events).toEqual([
      "disabled:worker-stopped",
      "disabled:release",
      "shutdown:worker-stopped",
      "shutdown:release",
    ]);
    expect(finalSnapshot.state).toBe("Closed");
    expect(finalSnapshot.liveGenerations).toBe(0);
  });

  test("concurrent public requests settle when shutdown crosses a low-quantum enqueue boundary", async () => {
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* DynamicRuntime.make();
          yield* runtime.register(service(Effect.succeed({ value: 1 })));
          yield* runtime.awaitState("service", "Active");

          const requests: Array<Fiber.Fiber<void, never>> = [];
          for (let index = 0; index < 16; index++) {
            const request = Effect.all(
              [
                Effect.exit(runtime.use(Service, () => Effect.void)),
                Effect.exit(runtime.awaitState("service", "Active")),
                Effect.exit(runtime.awaitIdle()),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.asVoid);
            requests.push(yield* Effect.forkChild(request));
          }
          const shuttingDown = yield* Effect.forkChild(runtime.shutdown);
          yield* Fiber.await(shuttingDown);
          yield* Effect.forEach(requests, (request) => Fiber.await(request), {
            concurrency: "unbounded",
          });
          return yield* runtime.snapshot;
        }).pipe(Effect.provideService(References.MaxOpsBeforeYield, LowSchedulerQuantum)),
      ),
    );

    expect(snapshot.state).toBe("Closed");
    expect(snapshot.managedCalls).toBe(0);
    expect(snapshot.liveGenerations).toBe(0);
  });
});
