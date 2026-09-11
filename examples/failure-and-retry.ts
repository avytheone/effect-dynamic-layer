import { Context, Effect } from "effect";
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "../src/index.js";

class Report extends Context.Service<Report, { readonly title: string }>()("retry/Report") {}

const program = Effect.scoped(
  Effect.gen(function* () {
    const runtime = yield* DynamicRuntime.make();
    let attempts = 0;
    yield* runtime.register(
      DynamicLayer.fromEffect(Report)({
        id: "report",
        requires: Requirement.empty,
        acquire: Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail("simulated acquisition failure")
            : Effect.succeed({ title: "Report ready after explicit retry" });
        }),
      }),
    );
    yield* runtime.awaitState(Report, LifecycleState.Failed);
    yield* runtime.awaitIdle();
    if (attempts !== 1) throw new Error("Acquisition must not retry automatically");
    yield* Effect.log("Failure observed; explicitly allowing one new attempt");
    yield* runtime.retry(Report);
    yield* runtime.awaitState(Report, LifecycleState.Active);
    yield* runtime.use(Report, (report) => Effect.log(report.title));
  }),
);

try {
  await Effect.runPromise(program);
} catch (error) {
  console.error("Failure/retry example failed:", error);
  process.exitCode = 1;
}
