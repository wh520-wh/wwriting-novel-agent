// 模拟 clickability: 加载页面,用 jsdom 找 aria-label="模型"
import { JSDOM } from "jsdom";
const fs = await import("node:fs/promises");
const path = await import("node:path");
const html = await fs.readFile("./src/app-shell/index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
// 截掉 import,简化看 aria-label
console.log("jsdom loaded");
