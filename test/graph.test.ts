import { describe, expect, test } from "bun:test";
import { Context } from "effect";
import {
  affectedClosure,
  type GraphNode,
  topologicalOrder,
  validateGraph,
} from "../src/internal/graph.js";
import * as Requirement from "../src/Requirement.js";

const node = (
  id: string,
  exportKey: string,
  requirementKeys: readonly string[] = [],
): GraphNode => ({ id, exportKey, requirementKeys });

describe("requirements", () => {
  test("flattens nested conjunctions, de-duplicates keys, and freezes the AST", () => {
    const Database = Context.Service<{ readonly label: string }>("graph/Database");
    const Auth = Context.Service<{ readonly subject: string }>("graph/Auth");
    const requirement = Requirement.all(
      Requirement.service(Database),
      Requirement.all(Requirement.empty, Requirement.service(Auth), Requirement.service(Database)),
    );

    expect(requirement._tag).toBe("All");
    expect(requirement.keys).toEqual(["graph/Database", "graph/Auth"]);
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(Object.isFrozen(requirement.keys)).toBe(true);
  });
});

describe("candidate graph validation", () => {
  test("permits unresolved providers without mutating the candidate", () => {
    const candidate = [node("consumer", "service/consumer", ["service/missing"])] as const;

    expect(validateGraph(candidate)).toBeUndefined();
    expect(candidate).toEqual([
      { id: "consumer", exportKey: "service/consumer", requirementKeys: ["service/missing"] },
    ]);
  });

  test("rejects duplicate node ids and export keys structurally", () => {
    expect(validateGraph([node("same", "one"), node("same", "two")])).toEqual({
      _tag: "DuplicateId",
      id: "same",
    });
    expect(validateGraph([node("first", "same"), node("second", "same")])).toEqual({
      _tag: "DuplicateExport",
      exportKey: "same",
      ids: ["first", "second"],
    });
  });

  test("rejects direct and transitive cycles", () => {
    expect(validateGraph([node("self", "self-key", ["self-key"])])).toEqual({
      _tag: "SelfDependency",
      id: "self",
      exportKey: "self-key",
    });

    expect(
      validateGraph([
        node("a", "a-key", ["c-key"]),
        node("b", "b-key", ["a-key"]),
        node("c", "c-key", ["b-key"]),
      ]),
    ).toEqual({ _tag: "Cycle", ids: ["a", "c", "b", "a"] });
  });

  test("detects a cycle only when its previously missing provider appears", () => {
    const accepted = [node("a", "a-key", ["missing-key"]), node("b", "b-key", ["a-key"])];
    expect(validateGraph(accepted)).toBeUndefined();

    const candidate = [...accepted, node("missing", "missing-key", ["b-key"])];
    expect(validateGraph(candidate)).toEqual({
      _tag: "Cycle",
      ids: ["a", "missing", "b", "a"],
    });
    expect(accepted).toHaveLength(2);
  });
});

describe("pure graph planning", () => {
  test("orders providers before consumers and keeps independent order stable", () => {
    const nodes = [
      node("view", "view-key", ["analytics-key"]),
      node("independent", "independent-key"),
      node("analytics", "analytics-key", ["database-key"]),
      node("database", "database-key"),
    ];

    expect(topologicalOrder(nodes)).toEqual(["independent", "database", "analytics", "view"]);
  });

  test("computes only the transitive consumer branch of changed roots", () => {
    const nodes = [
      node("database", "database-key"),
      node("analytics", "analytics-key", ["database-key"]),
      node("view", "view-key", ["analytics-key"]),
      node("audit", "audit-key", ["database-key"]),
      node("unrelated", "unrelated-key"),
    ];

    expect([...affectedClosure(nodes, new Set(["analytics"]))]).toEqual(["analytics", "view"]);
    expect([...affectedClosure(nodes, new Set(["database"]))]).toEqual([
      "database",
      "analytics",
      "audit",
      "view",
    ]);
  });
});
