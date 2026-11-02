/** Shared helpers for the start scripts in scripts/*.mjs. Typed here because they are imported from TypeScript entry points. */
export declare function logPath(runtimeRoot: string, name: string): string;
export declare function writeLog(file: string, chunk: string): void;
export declare function prune(directory: string): void;
export declare function redactLog(value: unknown): string;
export declare function listLogFiles(directory: string): Array<{name:string;file:string;time:number;size:number}>;
export declare function captureProcessOutput(file: string): string;
export declare function pipe(file: string, child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown }, name: string): void;
