/**
 * The error reply uses a fixed, high reply index. Together with the deterministic outbound job id
 * (`<messageId>_<index>`) the user gets AT MOST ONE error message per inbound message, no matter how
 * many times the job is retried. (Own file so flows and the AI processor can share it without an
 * import cycle.)
 */
export const AI_ERROR_REPLY_INDEX = 99;
