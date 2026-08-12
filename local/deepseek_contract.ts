export const DEEPSEEK_OPERATION = "deepseek.chat.complete@v1" as const;
export const DEEPSEEK_CONNECTION = "deepseek_local" as const;

export const CHAT_ARGUMENTS_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    messages: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      description:
        "One to eight system/user messages; each content is at most 8192 UTF-8 bytes and all content is at most 32768 UTF-8 bytes.",
      "x-cairn-maxTotalUtf8Bytes": 32768,
      items: {
        type: "object",
        properties: {
          role: { enum: ["system", "user"] },
          content: {
            type: "string",
            maxLength: 8192,
            description:
              "At most 8192 UTF-8 bytes; non-ASCII text may reach the byte limit sooner.",
          },
        },
        required: ["role", "content"],
        additionalProperties: false,
      },
    },
    max_output_tokens: { type: "integer", minimum: 1, maximum: 1024 },
  },
  required: ["messages"],
  additionalProperties: false,
});

const RECEIPT_ERROR_SCHEMA = {
  type: "object",
  properties: {
    decision: { const: "error" },
    reason: { const: "custodian_denied" },
    requestUnits: { const: 0 },
  },
  required: ["decision", "reason", "requestUnits"],
  additionalProperties: false,
};

const SUCCESS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { const: "success" },
    assistant_text: { type: "string", maxLength: 32768 },
    finish_category: { enum: ["complete", "length"] },
    usage: {
      type: "object",
      properties: {
        input_tokens: { type: "integer", minimum: 0 },
        output_tokens: { type: "integer", minimum: 0 },
        total_tokens: { type: "integer", minimum: 0 },
      },
      required: ["input_tokens", "output_tokens", "total_tokens"],
      additionalProperties: false,
    },
    receipt: {
      type: "object",
      properties: {
        decision: { const: "allow" },
        reason: { const: "policy_allow" },
        requestUnits: { const: 1 },
      },
      required: ["decision", "reason", "requestUnits"],
      additionalProperties: false,
    },
  },
  required: ["outcome", "assistant_text", "finish_category", "usage", "receipt"],
  additionalProperties: false,
};

export const CHAT_OPERATION_OUTPUT_SCHEMA = Object.freeze({
  oneOf: [
    SUCCESS_OUTPUT_SCHEMA,
    {
      type: "object",
      properties: {
        outcome: {
          enum: [
            "invalid_input",
            "rate_limited",
            "auth_required",
            "provider_unavailable",
            "authority_changed",
          ],
        },
        receipt: RECEIPT_ERROR_SCHEMA,
      },
      required: ["outcome", "receipt"],
      additionalProperties: false,
    },
  ],
});
