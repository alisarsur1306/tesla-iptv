import type { IncomingMessage, ServerResponse } from 'node:http';

export declare function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void>;
export declare function getRequiredKey(): string;
export declare function isKeyValid(keyParam: string): boolean;
