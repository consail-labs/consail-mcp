/** Structured tool error (no stack dumps to the agent). */
export type ToolErrorBody = {
  error: string;
  detail?: string;
  status_code?: number;
};

export class ConsailApiError extends Error {
  readonly statusCode: number;
  readonly detail?: string;

  constructor(statusCode: number, message: string, detail?: string) {
    super(message);
    this.name = "ConsailApiError";
    this.statusCode = statusCode;
    this.detail = detail;
  }

  toBody(): ToolErrorBody {
    return {
      error: this.message,
      detail: this.detail,
      status_code: this.statusCode,
    };
  }
}

export function toolErrorText(err: unknown): string {
  if (err instanceof ConsailApiError) {
    return JSON.stringify(err.toBody());
  }
  if (err instanceof Error) {
    // Never leak stacks; message only.
    return JSON.stringify({ error: err.message } satisfies ToolErrorBody);
  }
  return JSON.stringify({ error: "unexpected error" } satisfies ToolErrorBody);
}

export function isAuthFailure(err: unknown): boolean {
  return err instanceof ConsailApiError && (err.statusCode === 401 || err.statusCode === 403);
}
