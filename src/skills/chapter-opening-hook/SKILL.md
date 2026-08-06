---
name: chapter-opening-hook
description: 每章开头必须用正在发生的事抓人：动作、冲突或悬念开场，不写天气和环境铺垫。
version: 1.0.0
metadata:
  wwriting:
    scope: chapter
    priority: 40
    hooks:
      - stage: planning
        action: append_prompt
      - stage: reviewing
        action: check
        check: chapter-opening
---

# Chapter Opening Hook

## Instructions

本章开头前两句话必须进入一个正在发生的事件（人物行动、冲突、悬念或意外）。

禁止以天气、环境描写或背景说明开场。

## Review checklist

- **chapter-opening**：检查正文开头约 150 个可见字符内是否有一个正在发生的动作、冲突或悬念。
