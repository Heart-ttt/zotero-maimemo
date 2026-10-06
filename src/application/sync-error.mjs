export function classifySyncError(error) {
  if (error?.status === 401 || error?.code === "common_unauthorized") return "authentication";
  if (error?.status === 429) return "rate-limit";
  if (error?.retryable === true) return "temporary";
  return "permanent";
}

export function safeErrorMessage(error) {
  return (error?.message || "同步未完成，请在设置中重试")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .slice(0, 500);
}
