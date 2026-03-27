/**
 * Web 环境下的轻量 Logger
 * 与 electron/main/logger 中的 serverLog 接口保持兼容
 */
export const serverLog = {
  log: (...args: unknown[]) => console.log("[server]", ...args),
  info: (...args: unknown[]) => console.info("[server]", ...args),
  warn: (...args: unknown[]) => console.warn("[server]", ...args),
  error: (...args: unknown[]) => console.error("[server]", ...args),
};
