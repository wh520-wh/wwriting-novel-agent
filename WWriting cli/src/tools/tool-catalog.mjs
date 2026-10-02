// 工具目录：一个工具的**静态事实**只有这一处定义——给模型的 JSON Schema、
// 工具服务对象上的方法名、给人看的中文标签。三张视图（TOOL_SCHEMAS / TOOL_METHODS /
// TOOL_LABELS）都从 TOOLS 长出来，新增一个工具 = 在 TOOLS 里加一项，别处不再各记一份。
//
// 为什么住在 tools 层：schema 与方法名是 agent 层的事实，标签是终端层的事实，
// 而本仓库的分层先例（tool-summary.mjs）就是「跨层共用的工具事实下沉 tools，
// agent 与 terminal 都向下 import」。住进任何一侧都会造出一条反向依赖边。
//
// 不是所有条目都下发给模型：delete_file 等 6 个极端工具只存在于权限分级里
// （模型没有它们的 schema，运行时也没有方法），目录里只记标签——确认卡要用人话说出
// 「删除文件」而不是「工具 delete_file」。有 description + parameters 的条目才进 TOOL_SCHEMAS。
//
// 顺序即契约：TOOL_SCHEMAS 按这里对象的键序下发（与拆分前的数组顺序逐项一致），
// 模型看到的工具清单不因本次收敛而改变。

const TOOLS = Object.freeze({
  list_files: {
    label: '查看文件列表',
    method: 'listFiles',
    description: '列出创作目录里的文件和子目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的路径，缺省为根目录。' },
        recursive: { type: 'boolean', description: '是否递归子目录，缺省 false。' },
      },
    },
  },
  read_file: {
    label: '读取文件',
    method: 'readFile',
    description: '读取创作目录里的一个文本文件内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对创作目录的文件路径。' } },
      required: ['path'],
    },
  },
  search_files: {
    label: '搜索文件',
    method: 'searchFiles',
    description: '在创作目录里按字面内容搜索，返回命中行。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本。' },
        path: { type: 'string', description: '搜索起点，缺省为根目录。' },
        maxResults: { type: 'number', description: '最多返回多少条，缺省 50。' },
      },
      required: ['pattern'],
    },
  },
  write_file: {
    label: '写入文件',
    method: 'writeFile',
    description: '整篇写入创作目录里的一个文件，需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的文件路径。' },
        content: { type: 'string', description: '完整文件内容。' },
      },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    label: '修改文件',
    method: 'editFile',
    description: '替换文件里的一段原文，需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的文件路径。' },
        oldText: { type: 'string', description: '要被替换的原文，必须唯一命中。' },
        newText: { type: 'string', description: '替换后的内容。' },
        replaceAll: { type: 'boolean', description: '多处命中时是否全部替换。' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  count_text: {
    label: '统计字数',
    method: 'countText',
    description: '客观统计一段文本的字数；篇幅只以这里的数字为准，不要自己估算。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要统计的文本。' } },
      required: ['text'],
    },
  },
  read_skill: {
    label: '读取技能',
    method: 'readSkill',
    description: '读取已发现 Agent Skill 的 SKILL.md 或其安全资源。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        resource: { type: 'string', description: '默认 SKILL.md；也可为 references/...、scripts/...、assets/...' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  update_plan: {
    label: '更新计划',
    method: 'updatePlan',
    description: '更新任务计划（整表替换）：给出本轮全部步骤与各自进度，供用户查看。多步任务先建计划，随进度更新。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '全部步骤的完整列表，按执行顺序；每次调用都整表替换。',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: '这一步要做什么。' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '缺省 pending。',
              },
            },
            required: ['summary'],
          },
        },
      },
      required: ['steps'],
    },
  },
  append_chapter_segment: {
    label: '写入章节内容',
    method: 'appendFile',
    description: '向创作目录里的一个文件追加一段正文（需要用户确认）；章节分次写作时用它续写，不要整篇覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的文件路径。' },
        content: { type: 'string', description: '要追加的正文片段。' },
      },
      required: ['path', 'content'],
    },
  },
  commit_chapter: {
    label: '提交章节',
    method: 'commitChapter',
    description: '提交一章的当前内容为版本快照，并记入前情账本（自动放行）。一章定稿时提交；之后再用通用修改工具改动，改完要用 finalize_revision 重新入账。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的章节文件路径。' },
        summary: { type: 'string', description: '一句话剧情摘要（前情账本用），可省略。' },
      },
      required: ['path'],
    },
  },
  finalize_revision: {
    label: '入账章节',
    method: 'finalizeRevision',
    description: '把已提交章节的当前内容重新入账：存为新版本快照并更新前情口径（自动放行）。用通用修改工具改完已提交章节后必须调用它，修订才算入账。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的章节文件路径。' },
        summary: { type: 'string', description: '一句话剧情摘要（前情账本用），可省略；不给就沿用上一次的。' },
      },
      required: ['path'],
    },
  },
  rollback_chapter: {
    label: '回滚章节',
    method: 'rollbackChapter',
    description: '把一章恢复到最近一次生效版本的内容（提交或入账的版本；需要用户确认）；回滚前的当前内容会先自动存档，永远可再回滚。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的章节文件路径。' },
      },
      required: ['path'],
    },
  },
  update_memory: {
    label: '更新设定',
    method: 'updateMemory',
    description: '更新设定档案（memory/ 下的结构化事实、时间线与角色状态）：系统校验、合并、落盘并重渲染打印件，重复提交安全。提交、入账或回滚章节后用它维护本章设定，只交本章新增或修正的条目。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本次更新针对的章节文件路径（相对创作目录）。' },
        facts: {
          type: 'array',
          description: '本章新增或修正的客观设定；不要全量重发已记录的条目。',
          items: {
            type: 'object',
            properties: {
              entity: { type: 'string', description: '实体名（人物、地点、物品、组织等）。' },
              attribute: { type: 'string', description: '属性名。' },
              value: { type: 'string', description: '属性值。' },
              path: { type: 'string', description: '该条目所属章节路径，缺省继承顶层 path。' },
              quote: { type: 'string', description: '原文短引，不超过 80 字。' },
            },
            required: ['entity', 'attribute', 'value'],
          },
        },
        timeline: {
          type: 'array',
          description: '本章的时间线节点（故事内时间与事件）。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '该节点所属章节路径，缺省继承顶层 path。' },
              story_time_raw: { type: 'string', description: '故事内时间的原话。' },
              events: { type: 'array', items: { type: 'string' }, description: '本章发生的事件，最多 10 条。' },
              time: {
                type: 'object',
                description: '时间的结构化标注，可省略。',
                properties: {
                  kind: { type: 'string', enum: ['scene', 'flashback', 'parallel', 'dream'], description: '缺省 scene。' },
                  elapsed: { type: 'string', description: '距上一节点的时间跨度，如 +3d；未知则不填。' },
                  anchor: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['date', 'age', 'named'] },
                      raw: { type: 'string' },
                      subject: { type: 'string', description: 'age 锚点的人物。' },
                    },
                  },
                  confidence: { type: 'string', enum: ['high', 'low'], description: '缺省 low。' },
                },
              },
            },
          },
        },
        characters: {
          type: 'array',
          description: '本章有新特征或状态变化的角色。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '角色名。' },
              traits: { type: 'array', items: { type: 'string' }, description: '新观察到的特征，最多 10 条。' },
              status: { type: 'string', description: '本章结束时的状态。' },
              path: { type: 'string', description: '该角色所属章节路径，缺省继承顶层 path。' },
            },
            required: ['name'],
          },
        },
      },
      required: ['path'],
    },
  },
  read_continuity: {
    label: '读取前情',
    method: 'readContinuity',
    description: '读取前情账本：已提交章节的顺序清单与剧情摘要，续写前回顾用。',
    parameters: {
      type: 'object',
      properties: {
        budgetChars: { type: 'number', description: '最多读多少字，缺省 4000。' },
      },
    },
  },
  style_stats: {
    label: '统计文风',
    method: 'styleStats',
    description: '统计一个文件的文风形态：字数、段落、句子节奏、对话占比。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对创作目录的文件路径。' },
      },
      required: ['path'],
    },
  },
  // —— 以下只有标签：极端工具只活在权限分级里（铁律 4），不进模型目录，也没有方法。 ——
  delete_file: { label: '删除文件' },
  delete_dir: { label: '删除目录' },
  clear_session: { label: '清空会话' },
  clear_history: { label: '清空历史' },
  reset_session: { label: '重置会话' },
  run_command: { label: '运行命令' },
});

// 下发给模型的工具声明（OpenAI-compatible function calling）。数组顺序 = 上面的键序。
export const TOOL_SCHEMAS = Object.freeze(
  Object.entries(TOOLS)
    .filter(([, def]) => typeof def.description === 'string' && def.parameters != null)
    .map(([name, def]) => ({
      type: 'function',
      function: { name, description: def.description, parameters: def.parameters },
    })),
);

// 下发给模型的下划线工具名 → 工具对象上的方法名（readSkill 由默认工具工厂并入，见 run-controller）。
export const TOOL_METHODS = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOLS)
      .filter(([, def]) => typeof def.method === 'string')
      .map(([name, def]) => [name, def.method]),
  ),
);

// 工具 → 人话标签（设计规格书 §4.3）。终端的活动行与确认卡都从这里取词。
export const TOOL_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(TOOLS).map(([name, def]) => [name, def.label])),
);
