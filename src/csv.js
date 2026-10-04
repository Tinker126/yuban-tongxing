// Prevent spreadsheet formula execution, including leading whitespace/control characters.
export function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function* csvRows(records) {
  yield '\uFEFF' + ['会话ID','开始时间(UTC)','结束时间(UTC)','年级','话题','对话轮次','本轮序号','输入方式','学生转写文本','AI英文回复','表达亮点','改进建议','语音识别置信度','本轮时间(UTC)'].map(cell).join(',') + '\r\n';
  for (const r of records) for (const [index, t] of r.turns.entries()) {
    yield [r.sessionId,r.startTime,r.endTime,r.grade,r.topic,r.rounds,index+1,t.inputMode,t.student,t.reply,t.comment.highlight,t.comment.suggestion,t.confidence,t.time].map(cell).join(',') + '\r\n';
  }
}
