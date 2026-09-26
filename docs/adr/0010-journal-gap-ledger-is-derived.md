# ADR 0010：journal 缺口台账是派生数据，损坏时从段文件重算

日期：2026-09-25 ｜ 状态：已采纳（口径）｜ 实现排后续轮（欠账 21-3）

## 背景

`journal-segments.mjs` 的文件头把 `journal-manifest.json` 声明为「可删除重建的派生数据（generation / roots / last seqs / gaps）」。实测这条不变量**只对了一半**：

- `readManifestFile`（`:128`）解析失败一律返回 `null`；
- `ensureManifest`（`:138-148`）见「没有 generation_id」就写一份全新 manifest，**原子覆盖**掉损坏的那份；
- 而 `gaps` 在实现上是缺口恢复的**唯一触发源**（`journal.mjs:384-392` 读 `eventsStore.gaps`），全仓没有独立于 manifest 的 seq 连续性校验（`journal-segments.mjs:584` 那条只在写入路径）。

于是 manifest 一旦损坏：`.corrupt` 段文件不改回原名、不再匹配 `SEGMENT_RE`（`:42`、`:403`），永不被重扫；缺口同时从 API 和恢复逻辑里消失——**数据还在磁盘上，系统却宣称一切连续**。`last_seq` 会自愈（`:501-505` 用尾段重算），丢的是缺口与 generation 归属。

## 决定

口径定格为「**缺口台账是派生数据**」：manifest 损坏或缺失时，从段文件按 seq 断层**重算** `gaps`，而不是把它当作必须备份的状态。段文件是唯一真相源。

可重算性已核实：generation 归属也能重算——历史目录名固定为 `<generation_id>-<stream>`（`journal-segments.mjs:841`、`:889`），扫 `historyDir` 即可还原。

## 考虑过的选项

- **只保留现场 + 告警**（损坏文件改名 `.corrupt`、写日志、不覆盖）：采纳为「重算」的附带动作，但不足以作为终点——它只做到「不静默」，没解决「不可重建」。
- **校验和 + `.bak` 副本**：拒绝。多出一份需要同步的状态，且没有回答「为什么会损坏」；重算本就能得到同一个答案。
- **只修 `last_seq` 类字段**：拒绝。缺口正是唯一不可自愈的字段，绕开它等于不修。

## 后果

- manifest 降级为纯缓存：所有字段都必须能由段文件（+ `historyDir` 目录名）重算。
- 「manifest 损坏」从数据损失事件降级为一次可观测的重算。
- 本轮（第二十一轮）只做路径身份，不实现本条；登记为欠账 21-3，实现时按 ADR 口径写「重算」而不是「备份」。
