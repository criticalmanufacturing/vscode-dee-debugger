/**
 * Decoding of CMF wire-encoded values. ExecuteAction/ExecuteReadOnlyAction outputs wrap
 * dictionaries as {"$typeCMF": "CMFMap", "CMFMapData": [["key", value], ...]} (verified
 * live against MES 11.2.5); values nest recursively.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function decodeCmfValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeCmfValues);
  if (!isObject(value)) return value;
  if (value["$typeCMF"] === "CMFMap" && Array.isArray(value["CMFMapData"])) {
    const result: Record<string, unknown> = {};
    for (const pair of value["CMFMapData"] as unknown[]) {
      if (Array.isArray(pair) && pair.length >= 2) {
        result[String(pair[0])] = decodeCmfValues(pair[1]);
      }
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) result[key] = decodeCmfValues(inner);
  return result;
}
