import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Install the actual tarball outside this repository: self-referencing imports
// could otherwise accidentally hide missing exports or declaration files.
const projectRoot = resolve(import.meta.dir, "..");
const workspace = await mkdtemp(join(tmpdir(), "dynamic-layer-consumer-"));
const metadata = await Bun.file(join(projectRoot, "package.json")).json();

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn([...command], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Consumer verification failed (${exitCode}): ${command.join(" ")}`);
  }
}

try {
  await run(["bun", "pm", "pack", "--destination", workspace], projectRoot);
  const tarballs = (await readdir(workspace)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error("Expected exactly one package tarball");
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "dynamic-layer-external-consumer",
      private: true,
      type: "module",
      dependencies: {
        [metadata.name]: `file:./${tarballs[0]}`,
        effect: metadata.peerDependencies.effect,
      },
    }),
  );
  await writeFile(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ["ES2022", "DOM"],
      },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(
    join(workspace, "consumer.ts"),
    `import { Context, Effect } from "effect";
import { DynamicLayer, DynamicRuntime, LifecycleState, Requirement } from "${metadata.name}";

// @ts-expect-error Internal implementation modules are not a public export.
import type * as InternalGraph from "${metadata.name}/internal/graph";
// @ts-expect-error Consumers cannot bypass the bundle through source imports.
import type * as SourceEntry from "${metadata.name}/src/index";

class Greeting extends Context.Service<Greeting, { readonly message: string }>()("consumer/Greeting") {}

const program = Effect.scoped(Effect.gen(function* () {
  const runtime = yield* DynamicRuntime.make();
  yield* runtime.register(DynamicLayer.fromEffect(Greeting)({
    id: "greeting",
    requires: Requirement.empty,
    acquire: Effect.succeed({ message: "built package works" }),
  }));
  yield* runtime.awaitState(Greeting, LifecycleState.Active);
  yield* runtime.disable(Greeting);
  yield* runtime.awaitState(Greeting, LifecycleState.Disabled);
  yield* runtime.enable(Greeting);
  yield* runtime.awaitState(Greeting, LifecycleState.Active);
  const message = yield* runtime.use(Greeting, (service) => Effect.succeed(service.message));
  if (message !== "built package works") throw new Error("Unexpected service result");
  yield* runtime.shutdown;
}));

await Effect.runPromise(program);
`,
  );
  await run(["bun", "install", "--ignore-scripts"], workspace);
  await run(
    ["bun", join(projectRoot, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    workspace,
  );
  await run(["bun", "run", "consumer.ts"], workspace);
  console.log("Built tarball: external TypeScript consumer and lifecycle passed.");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
