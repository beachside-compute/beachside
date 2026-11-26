import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { docsMarkdownPath } from "./lib/docs-markdown-path";

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const { entry, head } = locals.starlightRoute;
  const markdown = docsMarkdownPath(entry.id);

  if (markdown) {
    head.push(
      { tag: "link", attrs: { rel: "alternate", type: "text/markdown", href: markdown } },
      { tag: "link", attrs: { rel: "describedby", href: "/llms.txt" } },
    );
  }
});
