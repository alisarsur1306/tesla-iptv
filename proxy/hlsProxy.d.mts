import type { IncomingMessage, ServerResponse } from 'node:http';

export declare function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void>;
export declare function handleXtreamApi(req: IncomingMessage, res: ServerResponse): Promise<void>;
export declare function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void>;
export declare function isManaged(): boolean;
export declare function parseM3u(text: string): { name: string; logo: string; group: string; url: string }[];
export declare function getRequiredKey(): string;
export declare function isKeyValid(keyParam: string): boolean;
