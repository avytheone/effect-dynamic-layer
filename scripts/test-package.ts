import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Install the actual tarball outside this repository: self-referencing imports
// could otherwise accidentally hide missing exports or declaration files.
const projectRoot = resolve(import.meta.dir, "..");
const arguments_ = Bun.argv.slice(2);
if (arguments_.length > 1) {
  throw new Error("Usage: bun run test:package [absolute-package-tarball.tgz]");
}
const suppliedTarball = arguments_[0] === undefined ? undefined : resolve(arguments_[0]);
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
  let tarballPath: string;
  if (suppliedTarball === undefined) {
    await run(["bun", "pm", "pack", "--destination", workspace], projectRoot);
    const tarballs = (await readdir(workspace)).filter((name) => name.endsWith(".tgz"));
    const tarball = tarballs[0];
    if (tarballs.length !== 1 || tarball === undefined) {
      throw new Error("Expected exactly one package tarball");
    }
    tarballPath = join(workspace, tarball);
  } else {
    if (!(await Bun.file(suppliedTarball).exists())) {
      throw new Error(`Package tarball does not exist: ${suppliedTarball}`);
    }
    tarballPath = suppliedTarball;
  }
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "dynamic-layer-external-consumer",
      private: true,
      type: "module",
      dependencies: {
        [metadata.name]: `file:${tarballPath}`,
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
        outDir: "compiled",
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

let acquisitions = 0;
let releases = 0;
function assertCount(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(label + ": expected " + expected + ", received " + actual);
  }
}

const program = Effect.scoped(Effect.gen(function* () {
  const runtime = yield* DynamicRuntime.make();
  yield* runtime.register(DynamicLayer.fromEffect(Greeting)({
    id: "greeting",
    requires: Requirement.empty,
    acquire: Effect.gen(function* () {
      acquisitions++;
      yield* Effect.addFinalizer(() => Effect.sync(() => releases++));
      return { message: "built package works" };
    }),
  }));
  yield* runtime.awaitState(Greeting, LifecycleState.Active);
  yield* runtime.disable(Greeting);
  yield* runtime.awaitState(Greeting, LifecycleState.Disabled);
  assertCount("releases after disable", releases, 1);
  yield* runtime.enable(Greeting);
  yield* runtime.awaitState(Greeting, LifecycleState.Active);
  const message = yield* runtime.use(Greeting, (service) => Effect.succeed(service.message));
  if (message !== "built package works") throw new Error("Unexpected service result");
  yield* runtime.shutdown;
  assertCount("acquisitions after re-enable", acquisitions, 2);
  assertCount("releases after shutdown", releases, 2);
}));

await Effect.runPromise(program);
`,
  );
  await run(["npm", "install", "--no-audit", "--no-fund"], workspace);
  await run(
    ["node", join(projectRoot, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    workspace,
  );
  const compiledConsumer = join(workspace, "compiled", "consumer.js");
  await run(["bun", "run", compiledConsumer], workspace);
  await run(["node", compiledConsumer], workspace);
  console.log("Built tarball: npm-installed TypeScript consumer passed in Bun and Node.");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
