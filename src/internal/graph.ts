export interface GraphNode {
  readonly id: string;
  readonly exportKey: string;
  readonly requirementKeys: readonly string[];
}

export type GraphValidationError =
  | { readonly _tag: "DuplicateId"; readonly id: string }
  | {
      readonly _tag: "DuplicateExport";
      readonly exportKey: string;
      readonly ids: readonly [string, string];
    }
  | { readonly _tag: "SelfDependency"; readonly id: string; readonly exportKey: string }
  | { readonly _tag: "Cycle"; readonly ids: readonly string[] };

/** Validates a complete candidate before a controller mutates authoritative state. */
export const validateGraph = (nodes: readonly GraphNode[]): GraphValidationError | undefined => {
  const byId = new Map<string, GraphNode>();
  const providerByExport = new Map<string, GraphNode>();

  for (const node of nodes) {
    if (byId.has(node.id)) return { _tag: "DuplicateId", id: node.id };
    byId.set(node.id, node);

    const previous = providerByExport.get(node.exportKey);
    if (previous !== undefined) {
      return {
        _tag: "DuplicateExport",
        exportKey: node.exportKey,
        ids: [previous.id, node.id],
      };
    }
    providerByExport.set(node.exportKey, node);

    if (node.requirementKeys.includes(node.exportKey)) {
      return { _tag: "SelfDependency", id: node.id, exportKey: node.exportKey };
    }
  }

  const state = new Map<string, "Visiting" | "Visited">();
  const stack: Array<string> = [];

  const visit = (node: GraphNode): readonly string[] | undefined => {
    const current = state.get(node.id);
    if (current === "Visited") return undefined;
    if (current === "Visiting") {
      const cycleStart = stack.indexOf(node.id);
      return [...stack.slice(cycleStart), node.id];
    }

    state.set(node.id, "Visiting");
    stack.push(node.id);
    for (const requiredKey of node.requirementKeys) {
      const provider = providerByExport.get(requiredKey);
      // An unresolved edge is a valid Pending dependency, not a graph error.
      if (provider === undefined) continue;
      const cycle = visit(provider);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(node.id, "Visited");
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node);
    if (cycle !== undefined) return { _tag: "Cycle", ids: cycle };
  }
  return undefined;
};

/** Returns provider-before-consumer order, preserving input order where unconstrained. */
export const topologicalOrder = (nodes: readonly GraphNode[]): readonly string[] => {
  const providerByExport = new Map(nodes.map((node) => [node.exportKey, node] as const));
  const indexById = new Map(nodes.map((node, index) => [node.id, index] as const));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Array<string>>();

  for (const node of nodes) {
    const providers = new Set<string>();
    for (const key of node.requirementKeys) {
      const provider = providerByExport.get(key);
      if (provider !== undefined && provider.id !== node.id) providers.add(provider.id);
    }
    indegree.set(node.id, providers.size);
    for (const providerId of providers) {
      const existing = dependents.get(providerId);
      if (existing === undefined) dependents.set(providerId, [node.id]);
      else existing.push(node.id);
    }
  }

  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const ordered: Array<string> = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0));
    const id = ready.shift();
    if (id === undefined) break;
    ordered.push(id);
    for (const dependentId of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }

  // The runtime calls this after validation; retaining every id is defensive for direct callers.
  if (ordered.length !== nodes.length) {
    const orderedIds = new Set(ordered);
    for (const node of nodes) if (!orderedIds.has(node.id)) ordered.push(node.id);
  }
  return Object.freeze(ordered);
};

/** Finds root nodes and every registered consumer transitively depending on them. */
export const affectedClosure = (
  nodes: readonly GraphNode[],
  roots: ReadonlySet<string>,
): ReadonlySet<string> => {
  const providerByExport = new Map(nodes.map((node) => [node.exportKey, node.id] as const));
  const dependents = new Map<string, Array<string>>();

  for (const consumer of nodes) {
    for (const requiredKey of consumer.requirementKeys) {
      const providerId = providerByExport.get(requiredKey);
      if (providerId === undefined) continue;
      const existing = dependents.get(providerId);
      if (existing === undefined) dependents.set(providerId, [consumer.id]);
      else if (!existing.includes(consumer.id)) existing.push(consumer.id);
    }
  }

  const existingIds = new Set(nodes.map((node) => node.id));
  const affected = new Set<string>();
  const pending: Array<string> = [];
  for (const root of roots) {
    if (!existingIds.has(root) || affected.has(root)) continue;
    affected.add(root);
    pending.push(root);
  }

  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index];
    if (id === undefined) continue;
    for (const dependent of dependents.get(id) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      pending.push(dependent);
    }
  }
  return affected;
};
