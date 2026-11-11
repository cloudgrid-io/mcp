// Capture every tool both editions register, and walk the text tools/list
// advertises for each one: the description and every input and output
// describe() string at any depth.
import { registerTools } from "../../src/tools.js";

export function captureTools(edition) {
  const configs = {};
  const handlers = {};
  const server = {
    registerTool: (name, cfg, h) => { configs[name] = cfg; handlers[name] = h; },
    tool: () => {},
    registerResource: () => {},
  };
  registerTools(server, {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    logger: null,
  });
  return { configs, handlers };
}

// Walk a zod schema (or a raw shape) and yield [path, text] for every
// describe() string: nested objects, arrays, enums, optionals, nullables.
export function* schemaDescribes(node, path, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  const def = node._def;
  if (def) {
    if (typeof def.description === "string") yield [path, def.description];
    if (typeof node.description === "string" && node.description !== def.description) yield [path, node.description];
    if (def.shape) {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      for (const [k, v] of Object.entries(shape)) yield* schemaDescribes(v, `${path}.${k}`, seen);
    }
    for (const key of ["innerType", "type", "schema", "element"]) {
      if (def[key]) yield* schemaDescribes(def[key], path, seen);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) yield* schemaDescribes(v, `${path}.${k}`, seen);
}

// Every advertised string for one tool: [path, text].
export function* toolTexts(name, cfg) {
  yield [`${name}.description`, String(cfg.description ?? "")];
  yield* schemaDescribes(cfg.inputSchema, `${name}.input`);
  yield* schemaDescribes(cfg.outputSchema, `${name}.output`);
}
