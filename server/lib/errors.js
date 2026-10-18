/** The error shape every Terucon and Google-style JSON error uses. */

const API_STATUS = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'INVALID_ARGUMENT',
  415: 'INVALID_ARGUMENT',
  421: 'INVALID_ARGUMENT',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/**
 * @param {number} status HTTP status
 * @param {string} message plain language, shown to people
 * @param {string} [apiStatus] Google-style status name; guessed from the HTTP status when left out
 */
export function errorBody(status, message, apiStatus = API_STATUS[status] ?? 'INVALID_ARGUMENT') {
  return { error: { code: status, status: apiStatus, message } };
}

/** Send a JSON error. API responses are never cached. */
export function sendError(res, status, message, apiStatus) {
  res.status(status).set('Cache-Control', 'no-store').json(errorBody(status, message, apiStatus));
}

/** An error that carries the HTTP answer to give. */
export class HttpError extends Error {
  constructor(status, message, apiStatus) {
    super(message);
    this.status = status;
    this.apiStatus = apiStatus;
  }
}
