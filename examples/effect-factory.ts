import { Context, Effect, Layer } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement } from "../src/index.js";

class BackendConfig extends Context.Service<BackendConfig, { readonly mode: "local" | "remote" }>()(
  "factory/BackendConfig",
) {}
class Backend extends Context.Service<Backend, { readonly name: string }>()("factory/Backend") {}

// Recipe selection executes once per generation, not as a reactive computation.
const selectedLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* BackendConfig;
    return config.mode === "remote"
      ? Layer.succeed(Backend, { name: "remote implementation (no network)" })
      : Layer.succeed(Backend, { name: "local implementation" });
  }),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const runtime = yield* DynamicRuntime.make();
    yield* runtime.register(
      DynamicLayer.fromLayer(Backend)({
        id: "backend",
        requires: Requirement.service(BackendConfig),
        layer: selectedLayer,
      }),
    );
    yield* runtime.register(
      DynamicLayer.fromEffect(BackendConfig)({
        id: "config",
        requires: Requirement.empty,
        acquire: Effect.succeed({ mode: "local" }),
      }),
    );
    yield* runtime.awaitState("backend", "Active");
    yield* runtime.use(Backend, (backend) => Effect.log(backend.name));
    yield* runtime.replace(
      "config",
      DynamicLayer.fromEffect(BackendConfig)({
        id: "config",
        requires: Requirement.empty,
        acquire: Effect.succeed({ mode: "remote" }),
      }),
    );
    yield* runtime.awaitState("backend", "Active");
    yield* runtime.use(Backend, (backend) => Effect.log(backend.name));
  }),
);

try {
  await Effect.runPromise(program);
} catch (error) {
  console.error("Effect factory example failed:", error);
  process.exitCode = 1;
}
