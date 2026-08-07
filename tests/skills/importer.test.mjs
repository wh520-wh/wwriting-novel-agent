// src/core/skills/importer.mjs 的安全导入契约（计划 Task 13 Step 1）。
//
// 冻结契约（brief verbatim）：
//   - 文件夹与 ZIP 都先落到目标盘（targetRoot 所在盘）的临时目录，逐 entry 校验后
//     展开，验证 SKILL.md 后原子 rename；
//   - ZIP entry 拒绝：绝对路径、盘符、`..`、symlink、单文件 > 10MiB、总展开 > 50MiB；
//   - 重名默认 skill_exists（服务 seam 转 409），replace:true 只在 UI 二次确认后传入。
//
// 测试直接测内部 seam（tests/skills/ 允许），并用 createSkillService 验证 seam 升级
//（临时目录 + 原子 rename + 中文技能名的导入/删除对齐）。ZIP 用 STORED 条目手工构造，
// 不引入第二个依赖。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { createSkillService } from "../../src/core/skills/index.mjs";
import { PROTECTED_BUILTIN_SKILLS } from "../../src/core/skills/catalog.mjs";
import {
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
  stageSkillSource
} from "../../src/core/skills/importer.mjs";

const RESERVED_NAMES = [...PROTECTED_BUILTIN_SKILLS];

// ---------------------------------------------------------------------------
// 夹具：手工构造 STORED（无压缩）ZIP。
// ---------------------------------------------------------------------------

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

function toU16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function toU32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

// files: [{ name, content, mode }]；mode 提供时写入外部属性高位（Unix 权限位，
// symlink 用 0o120000 类型位）。目录条目以 "/" 结尾。
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content ?? "", "utf8");
    const crc = crc32(data);
    const isDir = file.name.endsWith("/");
    // 本地文件头（无 data descriptor；extra 为空）
    const localHeader = Buffer.concat([
      toU32(ZIP_LOCAL_SIG),
      toU16(20),          // version needed
      toU16(0),           // flags
      toU16(0),           // method: stored
      toU16(0),           // mod time
      toU16(0x21),        // mod date (1980-01-01)
      toU32(crc),
      toU32(data.length),
      toU32(data.length),
      toU16(nameBuffer.length),
      toU16(0),
      nameBuffer
    ]);
    localParts.push(localHeader, data);
    const externalAttr = file.mode !== undefined
      ? ((file.mode << 16) >>> 0)
      : (isDir ? 0x10 : 0o100644);
    const centralHeader = Buffer.concat([
      toU32(ZIP_CENTRAL_SIG),
      toU16(0x031e),      // version made by（Unix 高位字段 → 可读到 mode）
      toU16(20),          // version needed
      toU16(0),           // flags
      toU16(0),           // method: stored
      toU16(0),           // mod time
      toU16(0x21),        // mod date
      toU32(crc),
      toU32(data.length),
      toU32(data.length),
      toU16(nameBuffer.length),
      toU16(0),           // extra len
      toU16(0),           // comment len
      toU16(0),           // disk start
      toU16(0),           // internal attrs
      toU32(externalAttr),
      toU32(offset),      // local header offset
      nameBuffer
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    toU32(ZIP_EOCD_SIG),
    toU16(0),
    toU16(0),
    toU16(files.length),
    toU16(files.length),
    toU32(centralDir.length),
    toU32(offset),
    toU16(0)
  ]);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

const SKILL_MD = (name, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n# ${name}\n\n${extra}`;

function makeTemp(prefix = "wwr-importer-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanup(...dirs) {
  await Promise.all(
    dirs.filter(Boolean).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
}

async function writeZip(zipBuffer) {
  const dir = await makeTemp();
  const zipPath = path.join(dir, "skill.zip");
  await fs.writeFile(zipPath, zipBuffer);
  return { dir, zipPath };
}

function listAllFiles(dir) {
  const out = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).replace(/\\/gu, "/"));
    }
  };
  return walk(dir).then(() => out.sort());
}

// ---------------------------------------------------------------------------
// 文件夹导入
// ---------------------------------------------------------------------------

test("文件夹导入：复制 SKILL.md + 资源到目标盘临时目录并验证 SKILL.md", async () => {
  const sourceRoot = await makeTemp("wwr-src-");
  const targetRoot = await makeTemp("wwr-target-");
  try {
    const sourceDir = path.join(sourceRoot, "style-skill");
    await fs.mkdir(path.join(sourceDir, "references"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), SKILL_MD("style-skill"), "utf8");
    await fs.writeFile(path.join(sourceDir, "references", "guide.md"), "# 指南\n", "utf8");

    const staged = await stageSkillSource({ source: sourceDir, targetRoot });
    try {
      assert.equal(staged.name, "style-skill");
      // staging 建在 targetRoot 的父目录下（同一文件系统，rename 原子）
      assert.equal(
        path.resolve(path.dirname(path.dirname(staged.dir))),
        path.resolve(path.dirname(targetRoot)),
        "staging 必须位于 targetRoot 父目录（同盘）"
      );
      assert.deepEqual(await listAllFiles(staged.dir), ["SKILL.md", "references/guide.md"]);
    } finally {
      await cleanup(staged.stagingRoot);
    }
  } finally {
    await cleanup(sourceRoot, targetRoot);
  }
});

test("文件夹导入：源目录名与 frontmatter name 不一致拒绝（readSkillFile 校验）", async () => {
  const sourceRoot = await makeTemp("wwr-src-");
  const targetRoot = await makeTemp("wwr-target-");
  try {
    const sourceDir = path.join(sourceRoot, "wrong-name");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), SKILL_MD("right-name"), "utf8");
    await assert.rejects(
      stageSkillSource({ source: sourceDir, targetRoot }),
      (error) => error.code === "skill_name_mismatch"
    );
  } finally {
    await cleanup(sourceRoot, targetRoot);
  }
});

test("文件夹导入：来源不存在 → skill_source_not_found", async () => {
  const targetRoot = await makeTemp("wwr-target-");
  try {
    await assert.rejects(
      stageSkillSource({ source: path.join(targetRoot, "no-such-dir"), targetRoot }),
      (error) => error.code === "skill_source_not_found"
    );
  } finally {
    await cleanup(targetRoot);
  }
});

// ---------------------------------------------------------------------------
// ZIP 导入（合法布局）
// ---------------------------------------------------------------------------

test("ZIP 导入：单顶层目录布局剥离前缀，按 frontmatter name 落盘", async () => {
  const { dir, zipPath } = await writeZip(
    buildZip([
      { name: "my-skill/SKILL.md", content: SKILL_MD("zip-skill") },
      { name: "my-skill/scripts/check.mjs", content: "export default 1;\n" },
      { name: "my-skill/", content: "" }
    ])
  );
  const targetRoot = await makeTemp("wwr-target-");
  try {
    const staged = await stageSkillSource({ source: zipPath, targetRoot });
    try {
      assert.equal(staged.name, "zip-skill", "目录名按 frontmatter name，与 zip 顶层目录名无关");
      assert.deepEqual(await listAllFiles(staged.dir), ["SKILL.md", "scripts/check.mjs"]);
    } finally {
      await cleanup(staged.stagingRoot);
    }
  } finally {
    await cleanup(dir, targetRoot);
  }
});

test("ZIP 导入：SKILL.md 在 zip 根（无顶层目录）也可导入", async () => {
  const { dir, zipPath } = await writeZip(
    buildZip([
      { name: "SKILL.md", content: SKILL_MD("root-skill") },
      { name: "assets/tone.md", content: "tone\n" }
    ])
  );
  const targetRoot = await makeTemp("wwr-target-");
  try {
    const staged = await stageSkillSource({ source: zipPath, targetRoot });
    try {
      assert.equal(staged.name, "root-skill");
      assert.deepEqual(await listAllFiles(staged.dir), ["SKILL.md", "assets/tone.md"]);
    } finally {
      await cleanup(staged.stagingRoot);
    }
  } finally {
    await cleanup(dir, targetRoot);
  }
});

// ---------------------------------------------------------------------------
// ZIP entry 拒绝规则
// ---------------------------------------------------------------------------

async function assertZipRejected(entries, expectedCode, message) {
  const { dir, zipPath } = await writeZip(buildZip(entries));
  const targetRoot = await makeTemp("wwr-target-");
  try {
    await assert.rejects(
      stageSkillSource({ source: zipPath, targetRoot }),
      (error) => {
        assert.equal(error.code, expectedCode, `期望 ${expectedCode}，实际 ${error.code}（${error.message}）`);
        return true;
      },
      message
    );
  } finally {
    await cleanup(dir, targetRoot);
  }
}

test("ZIP 拒绝绝对路径 entry（/ 开头）", async () => {
  await assertZipRejected(
    [{ name: "/etc/passwd", content: "x" }],
    "skill_zip_unsafe",
    "绝对路径 entry 必须拒绝"
  );
});

test("ZIP 拒绝盘符 entry（C:/…）", async () => {
  await assertZipRejected(
    [{ name: "C:/windows/system32/evil.dll", content: "x" }],
    "skill_zip_unsafe",
    "盘符 entry 必须拒绝"
  );
});

test("ZIP 拒绝 .. 穿越 entry（../ 与 ..\\ 两种书写）", async () => {
  await assertZipRejected(
    [{ name: "../escape.md", content: "x" }],
    "skill_zip_unsafe",
    "../ 穿越必须拒绝"
  );
  await assertZipRejected(
    [{ name: "..\\escape.md", content: "x" }],
    "skill_zip_unsafe",
    "反斜杠 ../ 穿越必须拒绝"
  );
});

test("ZIP 拒绝 symlink entry（Unix 外部属性类型位 0o120000）", async () => {
  await assertZipRejected(
    [{ name: "skill/link", content: "target", mode: 0o120777 }],
    "skill_zip_unsafe",
    "symlink entry 必须拒绝"
  );
});

// 构造「声明大小很大但数据区极小」的 STORED zip：pass 1 只按中央目录声明做大小
// 校验，不展开数据，因此无需真实的大数据。
function buildDeclaredZip(entries) {
  const locals = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, declaredSize } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.concat([
      toU32(0x04034b50), toU16(20), toU16(0), toU16(0), toU16(0), toU16(0x21),
      toU32(0), toU32(declaredSize), toU32(declaredSize),
      toU16(nameBuf.length), toU16(0), nameBuf
    ]);
    locals.push({ local, nameBuf, offset });
    centralParts.push(Buffer.concat([
      toU32(0x02014b50), toU16(0x031e), toU16(20), toU16(0), toU16(0), toU16(0), toU16(0x21),
      toU32(0), toU32(declaredSize), toU32(declaredSize),
      toU16(nameBuf.length), toU16(0), toU16(0), toU16(0), toU16(0), toU32(0o100644), toU32(offset), nameBuf
    ]));
    offset += local.length + 1; // 数据区只放 1 字节
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    toU32(0x06054b50), toU16(0), toU16(0), toU16(entries.length), toU16(entries.length),
    toU32(centralDir.length), toU32(offset), toU16(0)
  ]);
  return Buffer.concat([
    ...locals.map((e) => e.local),
    ...entries.map(() => Buffer.from([0])),
    centralDir,
    eocd
  ]);
}

async function writeDeclaredZip(entries) {
  const dir = await makeTemp("wwr-declared-");
  const zipPath = path.join(dir, "declared.zip");
  await fs.writeFile(zipPath, buildDeclaredZip(entries));
  return { dir, zipPath };
}

test("ZIP 拒绝单文件超过 10MiB（按中央目录声明大小，展开前拦截）", async () => {
  const { dir, zipPath } = await writeDeclaredZip([
    { name: "skill/SKILL.md", declaredSize: MAX_ZIP_ENTRY_BYTES + 1 }
  ]);
  const targetRoot = await makeTemp("wwr-target-");
  try {
    await assert.rejects(
      stageSkillSource({ source: zipPath, targetRoot }),
      (error) => error.code === "skill_zip_too_large",
      "单文件超过 10MiB 必须拒绝"
    );
  } finally {
    await cleanup(dir, targetRoot);
  }
});

test("ZIP 拒绝总展开超过 50MiB（累计声明大小）", async () => {
  const perEntry = Math.floor(MAX_ZIP_TOTAL_BYTES / 2) + 5; // 每个略高于 25MiB
  const { dir, zipPath } = await writeDeclaredZip([
    { name: "skill/a.bin", declaredSize: perEntry },
    { name: "skill/b.bin", declaredSize: perEntry }
  ]);
  const targetRoot = await makeTemp("wwr-target-");
  try {
    await assert.rejects(
      stageSkillSource({ source: zipPath, targetRoot }),
      (error) => error.code === "skill_zip_too_large",
      "总展开超过 50MiB 必须拒绝"
    );
  } finally {
    await cleanup(dir, targetRoot);
  }
});

test("ZIP 不含 SKILL.md → 拒绝", async () => {
  await assertZipRejected(
    [{ name: "skill/readme.txt", content: "no skill here" }],
    "skill_file_not_found",
    "缺 SKILL.md 的 zip 必须拒绝"
  );
});

test("ZIP 文件损坏 / 非 zip → 拒绝", async () => {
  const { dir, zipPath } = await writeZip(Buffer.from("not a zip archive at all"));
  const targetRoot = await makeTemp("wwr-target-");
  try {
    await assert.rejects(
      stageSkillSource({ source: zipPath, targetRoot }),
      (error) => error.code !== undefined,
      "损坏的 zip 必须抛技能错误"
    );
  } finally {
    await cleanup(dir, targetRoot);
  }
});

// ---------------------------------------------------------------------------
// seam 升级：临时目录 + 原子 rename + 重名 409 + 中文技能名对齐
// ---------------------------------------------------------------------------

test("seam importSkill：导入落目标根、无 staging 残留、重名 skill_exists、replace 覆盖", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  const sourceRoot = await makeTemp("wwr-src-");
  try {
    const sourceDir = path.join(sourceRoot, "seam-skill");
    await fs.mkdir(path.join(sourceDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), SKILL_MD("seam-skill"), "utf8");
    await fs.writeFile(path.join(sourceDir, "scripts", "run.mjs"), "export default 1;\n", "utf8");

    const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
    const imported = await service.importSkill({ projectRoot, source: sourceDir, scope: "project" });
    assert.equal(imported.name, "seam-skill");
    assert.deepEqual(
      await listAllFiles(path.join(projectRoot, "skills", "seam-skill")),
      ["SKILL.md", "scripts/run.mjs"]
    );
    // 目标根下只有技能目录，无临时 staging 残留
    assert.deepEqual(await fs.readdir(path.join(projectRoot, "skills")), ["seam-skill"]);

    await assert.rejects(
      service.importSkill({ projectRoot, source: sourceDir, scope: "project" }),
      (error) => error.code === "skill_exists"
    );
    await service.importSkill({ projectRoot, source: sourceDir, scope: "project", replace: true });
    assert.equal(existsSync(path.join(projectRoot, "skills", "seam-skill", "SKILL.md")), true);
  } finally {
    await cleanup(projectRoot, userHome, sourceRoot);
  }
});

test("seam importSkill：ZIP 导入到 global scope，随后可删除", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  const { dir, zipPath } = await writeZip(
    buildZip([
      { name: "g-skill/SKILL.md", content: SKILL_MD("g-skill") }
    ])
  );
  try {
    const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
    await service.importSkill({ projectRoot, source: zipPath, scope: "global" });
    const globalDir = path.join(userHome, ".wwriting", "skills", "g-skill");
    assert.equal(existsSync(path.join(globalDir, "SKILL.md")), true, "全局导入写入 userHome 技能根");

    const removed = await service.removeSkill({ projectRoot, name: "g-skill", scope: "global" });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(globalDir), false);
  } finally {
    await cleanup(projectRoot, userHome, dir);
  }
});

test("seam：中文技能名可导入也可删除（removeSkill 校验与 readSkillFile 对齐）", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  const sourceRoot = await makeTemp("wwr-src-");
  try {
    const sourceDir = path.join(sourceRoot, "文风技能");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), SKILL_MD("文风技能"), "utf8");

    const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
    const imported = await service.importSkill({ projectRoot, source: sourceDir, scope: "project" });
    assert.equal(imported.name, "文风技能");
    const removed = await service.removeSkill({ projectRoot, name: "文风技能", scope: "project" });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(path.join(projectRoot, "skills", "文风技能")), false);
  } finally {
    await cleanup(projectRoot, userHome, sourceRoot);
  }
});

test("seam removeSkill：危险名字拒绝（.. / 路径分隔符 / 空）", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  try {
    const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
    for (const bad of ["..", ".", "a/b", "a\\b", ""]) {
      await assert.rejects(
        service.removeSkill({ projectRoot, name: bad, scope: "project" }),
        (error) => error.code === "skill_invalid_name",
        `危险技能名必须拒绝: ${JSON.stringify(bad)}`
      );
    }
  } finally {
    await cleanup(projectRoot, userHome);
  }
});

// ---------------------------------------------------------------------------
// Task 8：保留名称（三个内置写作风格）不可 import / replace / remove
// ---------------------------------------------------------------------------

test("seam：保留名称不可导入——importSkill 解析出保留名后、落盘前拒绝（含 replace）", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  const sourceRoot = await makeTemp("wwr-src-");
  try {
    for (const name of RESERVED_NAMES) {
      const sourceDir = path.join(sourceRoot, name);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), SKILL_MD(name), "utf8");

      const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
      await assert.rejects(
        service.importSkill({ projectRoot, source: sourceDir, scope: "project" }),
        (error) => error.code === "skill_reserved",
        `保留名称 ${name} 的导入必须拒绝`
      );
      await assert.rejects(
        service.importSkill({ projectRoot, source: sourceDir, scope: "project", replace: true }),
        (error) => error.code === "skill_reserved",
        `保留名称 ${name} 的 replace 导入也必须拒绝`
      );
      await assert.rejects(
        service.importSkill({ projectRoot, source: sourceDir, scope: "global" }),
        (error) => error.code === "skill_reserved",
        `保留名称 ${name} 的全局导入也必须拒绝`
      );
      // 拒绝必须发生在写盘前：目标技能根不得出现同名技能目录（staging 已清理）。
      assert.equal(existsSync(path.join(projectRoot, "skills", name)), false, `${name} 不得落盘到项目技能根`);
      assert.equal(existsSync(path.join(userHome, ".wwriting", "skills", name)), false, `${name} 不得落盘到全局技能根`);
    }
  } finally {
    await cleanup(projectRoot, userHome, sourceRoot);
  }
});

test("seam：保留名称不可删除——removeSkill 拒绝 skill_reserved 且不触碰同名目录", async () => {
  const projectRoot = await makeTemp("wwr-proj-");
  const userHome = await makeTemp("wwr-home-");
  try {
    // 项目里确实存在一个同名目录：删除必须被拦截，且目录必须原样保留（写盘前拒绝）。
    const fakeDir = path.join(projectRoot, "skills", "balanced");
    await fs.mkdir(fakeDir, { recursive: true });
    await fs.writeFile(path.join(fakeDir, "SKILL.md"), SKILL_MD("balanced"), "utf8");

    const service = createSkillService({ userHome, resourcesPath: await makeTemp(), builtinRoot: await makeTemp() });
    for (const scope of ["project", "global"]) {
      await assert.rejects(
        service.removeSkill({ projectRoot, name: "balanced", scope }),
        (error) => error.code === "skill_reserved",
        `${scope} scope 的 removeSkill 必须拒绝保留名称`
      );
    }
    assert.equal(existsSync(fakeDir), true, "removeSkill 拒绝后不得删除同名目录");
    assert.equal(existsSync(path.join(fakeDir, "SKILL.md")), true, "同名目录内容不得被改动");
  } finally {
    await cleanup(projectRoot, userHome);
  }
});
