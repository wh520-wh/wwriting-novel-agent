const reasonText = {
  missing_final_path: "章节索引没有最终稿路径",
  missing_checksum: "章节索引没有最终稿校验和",
  missing_file: "磁盘中未找到最终稿文件",
  checksum_mismatch: "文件内容与章节索引不一致",
  invalid_path: "文件路径超出项目目录",
  not_a_file: "目标路径不是可读取文件",
  chapter_not_committed: "章节尚未提交最终稿",
  inspect_error: "读取章节文件失败（可能文件被锁定）",
};

export function presentChapterArtifact({ chapter, artifact, projectStatus }) {
  if (artifact?.state === "committed") {
    const relativePath = artifact.relativePath ?? artifact.relative_path ?? null;
    return {
      tone: "success",
      canOpen: true,
      title: `第 ${chapter} 章已写入本地文件`,
      detail: relativePath ?? "",
    };
  }
  if (artifact?.state === "committing") {
    return {
      tone: "progress",
      canOpen: false,
      title: `第 ${chapter} 章正在定稿`,
      detail: "",
    };
  }
  if (artifact?.state === "draft_only") {
    const cancelling = projectStatus === "cancelling";
    return {
      tone: "warning",
      canOpen: false,
      title: cancelling
        ? "正在停止，草稿将保留"
        : `已停止，第 ${chapter} 章草稿已保留`,
      detail: "",
    };
  }
  return {
    tone: "warning",
    canOpen: false,
    title: `第 ${chapter} 章产物状态异常，可尝试恢复`,
    detail: reasonText[artifact?.reason] ?? "章节索引与磁盘产物不一致",
  };
}