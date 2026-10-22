/** 使用 Chat 的冷历史读取接口，不 resolveAgent，不恢复执行。读取窗口有界。 */
export declare function readDeliveryHistory(host: {
    get(name: string): unknown;
}, sessionId: string, requestId: string, signal: AbortSignal, skipInterimText?: boolean): Promise<{
    turn: number;
    text: string;
    kind: string;
} | undefined>;
