import path from "node:path";
import { createAppShellServer } from "../src/core/app-server.mjs";

const staticRoot = path.resolve("src", "app-shell");
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? ".");
const selectedProjectRoot = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : null;
const secretsRoot = path.resolve(process.env.WWRITING_SECRETS_ROOT ?? path.join(workspaceRoot, ".local"));
const port = Number(process.env.PORT ?? 4173);

const server = createAppShellServer({
  workspaceRoot,
  selectedProjectRoot,
  staticRoot,
  secretsRoot,
  port
});

server.listen(port, "127.0.0.1", () => {
  console.log(`App shell preview: http://127.0.0.1:${port}`);
});
