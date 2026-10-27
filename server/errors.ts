/**
 * Error that is safe to render to the desktop client. Anything that is not an
 * AppError is treated as an internal error and is never exposed verbatim.
 */
export class AppError extends Error {

    public readonly status: number;
    public readonly code: string;
    public readonly details: Record<string, unknown>;

    constructor(
        status: number,
        code: string,
        message: string,
        options: { cause?: unknown; details?: Record<string, unknown> } = {}
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = options.details ?? {};
    }

}
