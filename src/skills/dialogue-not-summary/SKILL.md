---
name: dialogue-not-summary
description: 对话推进剧情：人物各有声音、不重复已知信息；本章对话占比合理。
version: 1.0.0
metadata:
  wwriting:
    scope: chapter
    priority: 40
    hooks:
      - stage: drafting
        action: append_prompt
      - stage: reviewing
        action: check
        check: dialogue-ratio
---

# Dialogue Not Summary

## Instructions

对话规则：

1) 每段对话必须有目的：推进情节、暴露人设或制造冲突；

2) 禁止用对话复述读者已知的信息（“如你所知……”式）；

3) 人物各有口头禅和句式，不要所有人一个腔调；

4) 对话配动作与反应（表情、停顿、小动作），避免“他说道”“她答道”连发。

## Review checklist

- **dialogue-ratio**：计算本章引号内对话占总可见字符的比例，对话过少或过多都要标记。
