---
name: avoid-ai-voice
description: 去除 AI 腔：不堆排比、不用模糊修饰词和总结式收尾，读起来像人写的。
version: 1.0.0
metadata:
  wwriting:
    scope: chapter
    priority: 30
    hooks:
      - stage: drafting
        action: append_prompt
      - stage: reviewing
        action: check
        check: ai-voice
---

# Avoid AI Voice

## Instructions

去除 AI 腔，这些写法一律不用：

1) 三连排比堆砌（如“他握住刀，握住恨，握住……”）；

2) 段尾用总结句收束情绪（如“她终于明白了……”）；

3) 模糊修饰词连发（仿佛、似乎、不禁、不由得、莫名、悄然、缓缓、微微、瞬间、顿时、一股莫名的、一种说不出的）；

4) 抒情长句连续不断，情绪改用具体动作和实物承载；

5) “如果说……那么……”式的议论句式。

## Review checklist

- **ai-voice**：统计正文中模糊修饰词（仿佛/似乎/不禁/不由得/莫名/悄然/缓缓/微微/瞬间/顿时等）的出现密度，判断是否超标。
