/** An error that maps to an HTTP status. `message` is safe to show to the caller. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code: string = defaultCode(status),
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthenticated";
    case 402:
      return "plan_limit";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 422:
      return "validation_failed";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : "error";
  }
}
