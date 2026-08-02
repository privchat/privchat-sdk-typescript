// 服务端业务错误码的可重试性判定，镜像 Rust `is_retryable_server_code`。
//
// 冻结在 SDK_ARCHITECTURE_SPEC §11.3：**服务端返回的业务错误必须按码分成两类**，
// 而不是「非零即永久失败」或「非零即无限重试」。两个方向的错法都在生产上出过事：
//
//   - Rust 侧曾把一个终局拒绝（附件已被别的消息占用）当成 DatabaseError(7)，
//     而 7 在可重试白名单里 → 客户端每十几秒重试一次，消息卡了好几天不成不败。
//   - TS 侧则相反：任何非零 reason_code 一律 `rejected` 冻结，于是限流、数据库抖动、
//     服务重启窗口这些**会自己好**的错误，也要用户手动重发。
//
// 白名单只放「过一会儿再试可能成功」的码；其余一律终局。新增码默认终局——
// 宁可让用户看见失败并重发，也不要制造一个永远转圈、连失败都不给的状态。
const RETRYABLE_SERVER_CODES = new Set<number>([
  2, // SystemBusy
  3, // ServiceUnavailable
  5, // Timeout
  6, // Maintenance
  7, // DatabaseError
  8, // CacheError
  9, // NetworkError
  10300, // RateLimitExceeded
  10303, // ConcurrentLimitExceeded
]);

/** `true` 表示这个错误值得退避后重试；`false` 表示重试多少次都是同一个结果。 */
export function isRetryableServerCode(code: number): boolean {
  return RETRYABLE_SERVER_CODES.has(code);
}
