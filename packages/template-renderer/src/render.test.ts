import { describe, expect, it } from "vitest";

import {
  IronforgeRenderError,
  renderTemplate,
  renderTree,
} from "./render.js";

describe("renderTemplate — happy path", () => {
  it("substitutes a single placeholder", () => {
    const result = renderTemplate("hello __IRONFORGE_NAME__", { NAME: "world" });
    expect(result).toBe("hello world");
  });

  it("substitutes multiple distinct placeholders", () => {
    const result = renderTemplate(
      "<title>__IRONFORGE_SERVICE_NAME__ on __IRONFORGE_DOMAIN__</title>",
      { SERVICE_NAME: "my-blog", DOMAIN: "ironforge.example.com" },
    );
    expect(result).toBe("<title>my-blog on ironforge.example.com</title>");
  });

  it("substitutes the same placeholder appearing multiple times", () => {
    const result = renderTemplate(
      "https://__IRONFORGE_SERVICE_NAME__.example.com — __IRONFORGE_SERVICE_NAME__ home",
      { SERVICE_NAME: "blog" },
    );
    expect(result).toBe("https://blog.example.com — blog home");
  });

  it("returns the input unchanged when no placeholders are present", () => {
    const result = renderTemplate("static html", {});
    expect(result).toBe("static html");
  });

  it("ignores extra map entries that don't match any placeholder", () => {
    const result = renderTemplate("hello __IRONFORGE_NAME__", {
      NAME: "world",
      UNUSED: "ignored",
    });
    expect(result).toBe("hello world");
  });
});

describe("renderTemplate — leftover placeholder detection", () => {
  it("throws IronforgeRenderError when a placeholder is unsubstituted", () => {
    expect(() =>
      renderTemplate("hello __IRONFORGE_NAME__", {}),
    ).toThrow(IronforgeRenderError);
  });

  it("includes the unsubstituted marker name in the error context", () => {
    try {
      renderTemplate("hello __IRONFORGE_DEPLOY_ROLE_ARN__", {});
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IronforgeRenderError);
      const e = err as IronforgeRenderError;
      expect(e.context.remaining).toContain("__IRONFORGE_DEPLOY_ROLE_ARN__");
    }
  });

  it("deduplicates the same marker appearing multiple times", () => {
    try {
      renderTemplate(
        "first __IRONFORGE_X__ then __IRONFORGE_X__ again",
        {},
      );
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeRenderError;
      expect(e.context.remaining).toEqual(["__IRONFORGE_X__"]);
    }
  });

  it("reports all distinct unsubstituted markers", () => {
    try {
      renderTemplate(
        "a __IRONFORGE_FOO__ b __IRONFORGE_BAR__ c __IRONFORGE_BAZ__",
        { FOO: "1" },
      );
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeRenderError;
      expect(e.context.remaining.sort()).toEqual([
        "__IRONFORGE_BAR__",
        "__IRONFORGE_BAZ__",
      ]);
    }
  });

  it("does not match malformed marker shapes (single underscore)", () => {
    // _IRONFORGE_X_ has only single underscores at the boundaries —
    // not our marker pattern. Should pass through unchanged.
    const result = renderTemplate("partial _IRONFORGE_X_ marker", {});
    expect(result).toBe("partial _IRONFORGE_X_ marker");
  });
});

describe("renderTree", () => {
  it("renders multiple files", () => {
    const result = renderTree(
      {
        "index.html": "<title>__IRONFORGE_NAME__</title>",
        "README.md": "# __IRONFORGE_NAME__",
      },
      { NAME: "blog" },
    );
    expect(result).toEqual({
      "index.html": "<title>blog</title>",
      "README.md": "# blog",
    });
  });

  it("does not mutate the input map", () => {
    const input = { "f.txt": "__IRONFORGE_X__" };
    renderTree(input, { X: "y" });
    expect(input["f.txt"]).toBe("__IRONFORGE_X__");
  });

  it("throws with the offending file path when a placeholder leaks", () => {
    try {
      renderTree(
        {
          "good.html": "<p>__IRONFORGE_NAME__</p>",
          "bad.yml": "role: __IRONFORGE_DEPLOY_ROLE_ARN__",
        },
        { NAME: "blog" },
      );
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeRenderError;
      expect(e.message).toContain("bad.yml");
      expect(e.context.remaining).toContain("__IRONFORGE_DEPLOY_ROLE_ARN__");
    }
  });
});
