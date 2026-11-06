/**
 * Resolution of Json.NET reference-preserving JSON ($id / $ref, plus defensive
 * handling of $values array wrappers). The MES host serializes responses with
 * PreserveReferencesHandling.Objects, so repeated entities arrive as {"$ref":"N"}.
 *
 * Resolution mutates a deep structure in place: objects carrying "$id" are indexed,
 * {"$ref": id} placeholders are replaced by the indexed object (identity-shared,
 * cycles allowed), "$id" keys are removed. "$type" keys are left untouched — the
 * host accepts payloads with or without them.
 */

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function resolveJsonRefs<T>(root: T): T {
  const byId = new Map<string, unknown>();

  // Pass 1: index every object that carries $id (and unwrap $values containers).
  const indexStack: unknown[] = [root];
  const indexed = new Set<unknown>();
  while (indexStack.length > 0) {
    const node = indexStack.pop();
    if (Array.isArray(node)) {
      if (indexed.has(node)) continue;
      indexed.add(node);
      for (const item of node) indexStack.push(item);
    } else if (isObject(node)) {
      if (indexed.has(node)) continue;
      indexed.add(node);
      const id = node["$id"];
      if (typeof id === "string") {
        // The referenceable value is the object itself, or its $values payload
        // when Json.NET wrapped a collection.
        byId.set(id, "$values" in node ? node["$values"] : node);
      }
      for (const value of Object.values(node)) indexStack.push(value);
    }
  }

  const resolve = (value: unknown): unknown => {
    if (isObject(value)) {
      const ref = value["$ref"];
      if (typeof ref === "string" && Object.keys(value).length === 1) {
        return byId.has(ref) ? byId.get(ref) : value;
      }
      if ("$values" in value && Array.isArray(value["$values"])) {
        return value["$values"];
      }
    }
    return value;
  };

  // Pass 2: replace $ref placeholders / $values wrappers and drop $id keys.
  const visited = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (visited.has(node)) return;
      visited.add(node);
      for (let i = 0; i < node.length; i++) {
        node[i] = resolve(node[i]);
        walk(node[i]);
      }
    } else if (isObject(node)) {
      if (visited.has(node)) return;
      visited.add(node);
      delete node["$id"];
      for (const key of Object.keys(node)) {
        node[key] = resolve(node[key]);
        walk(node[key]);
      }
    }
  };

  const resolvedRoot = resolve(root) as T;
  walk(resolvedRoot);
  return resolvedRoot;
}
