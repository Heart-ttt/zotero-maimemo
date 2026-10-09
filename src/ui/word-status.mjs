export function wordStatusText(record) {
  if (!record) return "确认后加入云词本";
  if (record.status === "synced") {
    return record.inStudyPlan ? "已同步到词本和学习计划" : "已同步到词本";
  }
  if (record.status === "partial") return "词本已写入，学习计划待完成；可在设置中重试";
  if (record.status === "failed") return "同步未完成，记录已保存；可在设置中重试";
  return "已在本地队列，等待同步";
}
