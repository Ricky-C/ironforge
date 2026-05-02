// Map-driven placeholder substitution for Ironforge starter-code.
//
// Substitutes `__IRONFORGE_<NAME>__` markers in file contents using a
// caller-supplied `Record<string, string>` map. The placeholder convention
// (PR-C.1, locked in `templates/static-site/ironforge.yaml`) is "double
// underscore + IRONFORGE + underscore + UPPER_CASE_NAME + double underscore".
//
// Two safety properties this module enforces:
//
//   1. **Map-key contract.** Map keys are the bare names (e.g.,
//      `SERVICE_NAME`), not the full marker. The renderer wraps each key
//      with `__IRONFORGE_<key>__` before substitution. This forces callers
//      to think in terms of placeholder identity, not surface syntax.
//
//   2. **Post-render leftover check.** After substitution, the rendered
//      string is scanned for any remaining `__IRONFORGE_<NAME>__` markers.
//      If any survive, an `IronforgeRenderError` is thrown with the list
//      of unsubstituted markers. This catches template-vs-renderer drift:
//      adding a placeholder to a template without updating the renderer's
//      map (or vice versa) surfaces immediately at first invocation, not
//      as a silent half-rendered file in production.
//
// The substitution boundary (which placeholders go through this renderer
// vs which use GitHub Actions `${{ secrets.X }}` references) is documented
// in `docs/conventions.md` § "Template substitution boundary".

const PLACEHOLDER_PATTERN = /__IRONFORGE_[A-Z0-9_]+__/g;

export type RenderMap = Record<string, string>;

export class IronforgeRenderError extends Error {
  override readonly name = "IronforgeRenderError";

  constructor(
    message: string,
    public readonly context: {
      // The unsubstituted markers found post-render. Surfaced for
      // operator visibility in CloudWatch and JobStep.errorMessage.
      remaining: string[];
    },
  ) {
    super(message);
  }
}

// Renders a single file's content. Substitutes every `__IRONFORGE_<key>__`
// marker for the matching map entry, then validates no markers remain.
//
// Throws `IronforgeRenderError` if any marker is left unsubstituted. The
// caller (generate-code Lambda) translates this to a workflow-level
// failure with sanitized error messaging.
export const renderTemplate = (content: string, map: RenderMap): string => {
  let rendered = content;
  for (const [key, value] of Object.entries(map)) {
    const marker = `__IRONFORGE_${key}__`;
    rendered = rendered.replaceAll(marker, value);
  }

  const remaining = rendered.match(PLACEHOLDER_PATTERN);
  if (remaining !== null) {
    const unique = [...new Set(remaining)];
    throw new IronforgeRenderError(
      `Template references ${unique.length} unsubstituted placeholder${unique.length === 1 ? "" : "s"}: ${unique.join(", ")}`,
      { remaining: unique },
    );
  }

  return rendered;
};

// Renders a full file tree (path → content map). Returns a new map with
// every value replaced by its rendered version. Original map is not
// mutated. Errors propagate from `renderTemplate` and include the
// offending file's path in the message — turns "renderer drift" failures
// from "which file?" into "this exact file."
export const renderTree = (
  files: Readonly<Record<string, string>>,
  map: RenderMap,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    try {
      result[path] = renderTemplate(content, map);
    } catch (err) {
      if (err instanceof IronforgeRenderError) {
        throw new IronforgeRenderError(
          `${err.message} (in ${path})`,
          err.context,
        );
      }
      throw err;
    }
  }
  return result;
};
