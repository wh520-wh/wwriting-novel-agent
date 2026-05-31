function makeChineseText(label, targetCount) {
  const sentence = `${label}，雨声压低了城中的灯火，主角把线索藏进掌心，又在沉默里听见命运逼近。`;
  let text = "";
  while (text.length < targetCount) {
    text += sentence;
  }
  return text;
}

export class MockModel {
  constructor(options = {}) {
    this.invalidFirstDraft = Boolean(options.invalidFirstDraft);
    this.calls = 0;
  }

  async generate(request) {
    this.calls += 1;
    if (this.invalidFirstDraft && this.calls === 1) {
      return {
        type: "status_message",
        message: "这是错误示范：模型把章节正文直接发到了聊天回复里，而不是调用工具。"
      };
    }
    if (request.kind === "revision_shortfall" || request.kind === "revision_quality_gate") {
      return {
        type: "tool_call",
        id: `mock-revision-${request.chapter_no}-${request.segment_no}`,
        tool: "append_chapter_segment",
        input: {
          project_id: request.project_id,
          chapter_no: request.chapter_no,
          segment_no: request.segment_no,
          content: makeChineseText(`第${request.chapter_no}章补写段${request.segment_no}`, (request.shortfall ?? 300) + 180)
        }
      };
    }
    return {
      type: "tool_call",
      id: `mock-draft-${request.chapter_no}-${request.segment_no}`,
      tool: "append_chapter_segment",
      input: {
        project_id: request.project_id,
        chapter_no: request.chapter_no,
        segment_no: request.segment_no,
        content: makeChineseText(`第${request.chapter_no}章第${request.segment_no}段`, request.segment_target_words)
      }
    };
  }
}
