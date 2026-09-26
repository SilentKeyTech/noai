export declare const UPSTREAM: string;
export declare const MAX_BODY_BYTES: number;
export declare const MAX_TOKENS: number;
export declare function refuse(body: string): string | null;
export declare function relay(
  request: Request,
  env: Record<string, string | undefined>,
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<Response>,
): Promise<Response>;
export declare function _resetLimits(): void;
