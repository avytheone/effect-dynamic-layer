import { Context, Effect, Layer, SubscriptionRef } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement } from "../src/index.js";

class Database extends Context.Service<Database, { readonly label: string }>()(
  "example/Database",
) {}
class Analytics extends Context.Service<Analytics, { readonly read: Effect.Effect<string> }>()(
  "example/Analytics",
) {}
class ViewModel extends Context.Service<ViewModel, { readonly render: Effect.Effect<string> }>()(
  "example/ViewModel",
) {}

const databaseLayer = (label: string) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      yield* Effect.log(`acquire database ${label}`);
      yield* Effect.addFinalizer(() => Effect.log(`release database ${label}`));
      return { label };
    }),
  );

const analyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const database = yield* Database;
    yield* Effect.addFinalizer(() => Effect.log(`release analytics using ${database.label}`));
    return { read: Effect.succeed(`analytics using ${database.label}`) };
  }),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const enabled = yield* SubscriptionRef.make(true);
    const runtime = yield* DynamicRuntime.make();
    yield* runtime.register(
      DynamicLayer.fromLayer(Analytics)({
        id: "analytics",
        requires: Requirement.service(Database),
        when: enabled,
        layer: analyticsLayer,
      }),
    );
    yield* runtime.register(
      DynamicLayer.fromEffect(ViewModel)({
        id: "view-model",
        requires: Requirement.service(Analytics),
        acquire: Effect.gen(function* () {
          const analytics = yield* Analytics;
          yield* Effect.addFinalizer(() => Effect.log("release view model"));
          return { render: analytics.read.pipe(Effect.map((value) => `view: ${value}`)) };
        }),
      }),
    );
    yield* runtime.awaitState("analytics", "Pending");
    yield* runtime.register(
      DynamicLayer.fromLayer(Database)({
        id: "database",
        requires: Requirement.empty,
        layer: databaseLayer("A"),
      }),
    );
    yield* runtime.awaitState("view-model", "Active");
    yield* runtime.use(ViewModel, (service) => service.render.pipe(Effect.flatMap(Effect.log)));

    // Command completion includes revocation, not physical release completion.
    yield* runtime.disable("database");
    yield* runtime.awaitState("database", "Disabled");
    yield* runtime.awaitState("analytics", "Pending");
    yield* runtime.enable("database");
    yield* runtime.awaitState("view-model", "Active");

    yield* runtime.replace(
      "database",
      DynamicLayer.fromLayer(Database)({
        id: "database",
        requires: Requirement.empty,
        layer: databaseLayer("B"),
      }),
    );
    yield* runtime.awaitState("view-model", "Active");
    yield* runtime.use(ViewModel, (service) => service.render.pipe(Effect.flatMap(Effect.log)));

    // Ref writes and controller observations have separate acknowledgements.
    yield* SubscriptionRef.set(enabled, false);
    yield* runtime.awaitState("analytics", "Pending");
    yield* SubscriptionRef.set(enabled, true);
    yield* runtime.awaitState("view-model", "Active");
    yield* runtime.awaitIdle();
    // Closing this owning Scope performs ordered shutdown automatically.
  }),
);

try {
  await Effect.runPromise(program);
} catch (error) {
  console.error("Basic example failed:", error);
  process.exitCode = 1;
}
