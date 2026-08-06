---
name: suspense-chapter-end
description: 每章结尾都要留下悬念钩子：震惊性话语、推翻认知的新事实或突然逼近的危险。
version: 1.0.0
metadata:
  wwriting:
    scope: chapter
    priority: 50
    hooks:
      - stage: planning
        action: append_prompt
      - stage: reviewing
        action: check
        check: suspense-ending
---

# Suspense Chapter End

## Instructions

本章计划必须包含一个结尾悬念钩子。

优先使用以下类型：一句令人震惊的话、一个推翻此前认知的新事实、或一个突然逼近的危险。

## Review checklist

- **suspense-ending**：Check whether the final 500 visible characters contain a meaningful suspense hook.
