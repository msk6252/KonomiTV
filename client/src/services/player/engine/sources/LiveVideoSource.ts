
import type { IEngineSource, IEngineSourceCallbacks } from '@/services/player/engine/sources/IEngineSource';

import MpegTsDemuxer from '@/services/player/engine/sources/MpegTsDemuxer';


/** TS パケット長 (demuxer 側の定数と揃える必要があるためここでも定義する) */
const TS_PACKET_LENGTH = 188;
const SYNC_BYTE = 0x47;

/** 188byte 境界を見つけるため、同期バイトが何パケット連続していれば同期成立とみなすか */
const SYNC_CONFIRM_PACKET_COUNT = 3;

/** 同期確立待ちで持ち越すバイト数の上限 (壊れた入力で無制限に溜め込まないための安全弁) */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * KonomiTV のライブ MPEG-TS ストリーム API (`/streams/live/{channel}/{quality}/mpegts`) を、
 * hls.js/mpegts.js を使わず自前で取得・デマルチプレクスするソース
 *
 * サーバーは `video/mp2t` の生 MPEG-TS バイト列を、エンコードタスクが吐いたチャンク単位 (188byte 境界とは
 * 無関係な任意サイズ) で延々と `StreamingResponse` し続ける。`fetch()` の `ReadableStream` でこれを読み取り、
 * 188byte 境界に揃えてから `MpegTsDemuxer` (continuous モード) に投入する
 *
 * 録画視聴 (RecordedVideoSource) との違い:
 * - セグメントという単位が無い連続ストリームなので、シークはできない (seek() は何もしない)
 * - 配信が「自己完結した PAT/PMT 付きセグメント」ではないため、デマルチプレクサは PID 情報を呼び出しをまたいで保持する
 * - 長時間 (26.5時間超) の視聴で 33bit PTS がラップアラウンドしうるため、デマルチプレクサ側でアンラップする
 */
class LiveVideoSource implements IEngineSource {

    private readonly streamUrl: string;
    private readonly callbacks: IEngineSourceCallbacks;
    private readonly demuxer = new MpegTsDemuxer({ continuous: true });

    private abortController: AbortController | null = null;
    /** 直前の読み取りで 188byte に割り切れず残ったバイト列 (次回の読み取り分と結合する) */
    private pendingBytes: Uint8Array = new Uint8Array(0);
    private destroyed = false;
    /** 最初の映像チャンクが届いたときに一度だけ再生準備完了を通知するためのフラグ */
    private hasSignaledReady = false;

    constructor(streamUrl: string, callbacks: IEngineSourceCallbacks) {
        this.streamUrl = streamUrl;
        this.callbacks = callbacks;
    }

    /**
     * ライブ視聴では開始位置という概念が無いため startPositionSeconds は無視する
     * `startStreaming()` は接続が切れるまで戻ってこない無限ループのため、ここでは待たずに
     * バックグラウンドで走らせたまま即座に戻る (呼び出し元を止めないため)
     */
    public async load(_startPositionSeconds: number): Promise<void> {
        // ライブは長さが不定なため、HTMLMediaElement の仕様に合わせて Infinity を報告する
        this.callbacks.onDurationKnown(Infinity);
        void this.startStreaming();
    }

    /** ライブ視聴ではシークできないため何もしない */
    public async seek(_positionSeconds: number): Promise<void> {
        // 何もしない (DPlayer 側も live: true の設定でシーク UI 自体を無効化している)
    }

    private async startStreaming(): Promise<void> {
        this.abortController = new AbortController();
        try {
            const response = await fetch(this.streamUrl, { signal: this.abortController.signal });
            if (!response.ok || response.body === null) {
                throw new Error(`LiveVideoSource: failed to fetch ${this.streamUrl} (${response.status})`);
            }
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                this.processChunk(value);
            }
            if (this.destroyed === false) {
                this.callbacks.onEnded();
            }
        } catch (error) {
            // destroy() による AbortError は正常な終了なのでエラー報告しない
            if (this.destroyed === false) {
                this.callbacks.onError(error instanceof Error ? error.message : String(error));
            }
        }
    }

    /** 新たに読み取ったバイト列を 188byte 境界に揃えたうえでデマルチプレクサに投入する */
    private processChunk(chunk: Uint8Array): void {
        const combined = this.pendingBytes.length > 0 ? concatBytes(this.pendingBytes, chunk) : chunk;

        const syncOffset = findSyncOffset(combined);
        if (syncOffset === null) {
            // このチャンク内に同期を確立できる位置が無かった (入力が極端に短い等) ため、全体を次回に持ち越す
            // ただし壊れた入力が続く場合に無制限に溜め込まないよう、上限を超えたら古い分から捨てる
            this.pendingBytes = combined.length > MAX_PENDING_BYTES ?
                combined.subarray(combined.length - MAX_PENDING_BYTES) : combined;
            return;
        }

        const packetCount = Math.floor((combined.length - syncOffset) / TS_PACKET_LENGTH);
        const usableLength = packetCount * TS_PACKET_LENGTH;
        if (packetCount > 0) {
            const aligned = combined.subarray(syncOffset, syncOffset + usableLength);
            const result = this.demuxer.demuxChunk(aligned);
            this.dispatchResult(result);
        }
        this.pendingBytes = combined.subarray(syncOffset + usableLength);
    }

    private dispatchResult(result: ReturnType<MpegTsDemuxer['demuxChunk']>): void {
        if (result.videoConfig !== null) {
            this.callbacks.onVideoConfig(result.videoConfig);
        }
        if (result.audioConfig !== null) {
            this.callbacks.onAudioConfig(result.audioConfig);
        }
        for (const { chunk } of result.videoChunks) {
            this.callbacks.onVideoChunk(chunk);
        }
        for (const { chunk } of result.audioChunks) {
            this.callbacks.onAudioChunk(chunk);
        }
        // ライブにはシークという概念は無いが、「再生に必要な最初のデータが揃った」タイミングの通知として
        // onSeeked() コールバックを再利用する (録画視聴でのプリロール完了通知と同じ意味合い)
        // 'key' (キーフレーム) を含むチャンクが実際に来るまでは、VideoDecoder がまだ configure() されておらず
        // 描画できる状態になっていないため、delta のみのチャンクでは準備完了を通知しない
        if (this.hasSignaledReady === false && result.videoChunks.some(({ chunk }) => chunk.type === 'key')) {
            this.hasSignaledReady = true;
            this.callbacks.onSeeked(0);
        }
    }

    public async destroy(): Promise<void> {
        this.destroyed = true;
        this.abortController?.abort();
    }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
}

/**
 * 188byte 境界で同期バイト (0x47) が連続する開始位置を探す
 * サーバーからのチャンク境界は TS パケット境界と無関係なため、偶然データ内に 0x47 が現れただけの
 * 誤同期を避けるため、連続する複数パケットの先頭が揃って 0x47 であることを確認する
 */
function findSyncOffset(data: Uint8Array): number | null {
    const confirmSpan = (SYNC_CONFIRM_PACKET_COUNT - 1) * TS_PACKET_LENGTH;
    for (let start = 0; start + confirmSpan < data.length; start++) {
        if (data[start] !== SYNC_BYTE) {
            continue;
        }
        let confirmed = true;
        for (let i = 1; i < SYNC_CONFIRM_PACKET_COUNT; i++) {
            if (data[start + i * TS_PACKET_LENGTH] !== SYNC_BYTE) {
                confirmed = false;
                break;
            }
        }
        if (confirmed) {
            return start;
        }
    }
    // 確認用の長さに足りない (データがまだ短い) 場合は、せめて先頭が同期バイトならそこを返す
    if (data.length > 0 && data[0] === SYNC_BYTE) {
        return 0;
    }
    return null;
}

export default LiveVideoSource;
