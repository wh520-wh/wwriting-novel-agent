// 四档权限定义（settings-modal.js 与 composer.js 共享）
// spec §4.3 矩阵：read_only > safe_edit:false > 归档 > yolo/auto_edit

export const PERMISSION_TIERS = [
  {
    id: "read_only",
    label: "只读",
    short: "只读",
    glyph: null,
    combo: { read_only: true,  safe_edit: true, auto_edit: false, yolo: false },
    desc: "完全只读；智能体不修改任何文件。",
    warn: ""
  },
  {
    id: "confirm",
    label: "确认后修改",
    short: "确认",
    glyph: null,
    combo: { read_only: false, safe_edit: true, auto_edit: false, yolo: false },
    desc: "默认档；写文件前会先让你确认。",
    warn: ""
  },
  {
    id: "auto",
    label: "自动修改",
    short: "自动",
    glyph: null,
    combo: { read_only: false, safe_edit: true, auto_edit: true,  yolo: false },
    desc: "可静默改稿；归档/导出仍需确认。",
    warn: ""
  },
  {
    id: "yolo",
    label: "YOLO",
    short: "YOLO",
    glyph: null,
    combo: { read_only: false, safe_edit: true, auto_edit: true,  yolo: true  },
    desc: "跳过普通确认，并允许访问项目以外的目录。",
    warn: "极端危险操作仍会要求输入确认文字。"
  }
];

// 优先级：yolo（最高权限）> auto > read_only > confirm（默认）
export function detectPermissionTier(perms) {
  const p = perms ?? {};
  if (p.yolo === true) return "yolo";
  if (p.auto_edit === true) return "auto";
  if (p.read_only === true) return "read_only";
  return "confirm";
}

export function getTierById(id) {
  return PERMISSION_TIERS.find((t) => t.id === id) ?? PERMISSION_TIERS[1];
}
