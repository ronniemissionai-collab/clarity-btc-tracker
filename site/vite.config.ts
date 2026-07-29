/**
 * Vite config for the site.
 *
 * The only non-default behavior is serveRepoData(): the site lazily fetches
 * /data/portfolio/index.json and /data/portfolio/{memberId}.json at runtime
 * (they are far too big to bundle — see the bundle-budget test). In
 * production, Pages serves the repository files directly, so those URLs
 * resolve to the repo's data/ directory next to the built site. Locally,
 * `vite dev` and `vite preview` only serve the site root, so this middleware
 * maps /data/* onto the repo-root data/ directory to make the same fetches
 * resolve. Nothing is copied into dist/.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");

function serveRepoData(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (!url.startsWith("/data/")) {
      next();
      return;
    }
    const relative = decodeURIComponent(url.slice("/data/".length));
    const file = path.resolve(dataDir, relative);
    // Never follow ".." (or absolute segments) out of the data directory.
    if (!file.startsWith(dataDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`no such data file: ${url}`);
      return;
    }
    readFile(file).then(
      (body) => {
        res.setHeader(
          "content-type",
          file.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
        );
        res.end(body);
      },
      (error: unknown) => {
        next(error);
      },
    );
  };

  return {
    name: "serve-repo-data",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [serveRepoData()],
});
