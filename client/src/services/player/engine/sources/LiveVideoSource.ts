
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
    /** これまでに届いた映像チャンクの最新タイムスタンプ (秒) 。onBufferedRangesChanged() の報告に使う */
    private latestVideoTimestampSeconds = 0;

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
        // 切断の原因が「こちら側 (destroy() による意図的な abort)」か「相手側 (サーバー/Cloudflare 等の中継)」かを
        // 切り分けるための診断ログ。切断時刻の前後にこの fetch 自身の destroy() ログがあるかどうかで判別できる
        // (Cloudflare Tunnel 等の「stream canceled」調査用。恒久的な実装ではなく原因特定ができたら削除してよい)
        console.log(`[LiveVideoSource] startStreaming() begin at ${new Date().toISOString()}: ${this.streamUrl}`);
        try {
            const response = await fetch(this.streamUrl, { signal: this.abortController.signal });
            if (!response.ok || response.body === null) {
                throw new Error(`LiveVideoSource: failed to fetch ${this.streamUrl} (${response.status})`);
            }
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    // destroy() を呼んでいないのに自然に done になった場合、サーバー側 (あるいは途中の
                    // プロキシ/Tunnel) がこちらの意図と無関係にストリームを終了させたことを意味する
                    console.log(`[LiveVideoSource] reader.read() returned done=true at ${new Date().toISOString()}. ` +
                        `this.destroyed=${this.destroyed} (false ならこちら側の abort() ではなく相手側が切断した可能性が高い)`);
                    break;
                }
                this.processChunk(value);
            }
            if (this.destroyed === false) {
                this.callbacks.onEnded();
            }
        } catch (error) {
            // AbortError かどうかで、こちら側の destroy() による意図的な中断か、それ以外のネットワークエラーかを判別できる
            const is_abort_error = error instanceof DOMException && error.name === 'AbortError';
            console.log(`[LiveVideoSource] startStreaming() caught error at ${new Date().toISOString()}: ` +
                `name=${error instanceof Error ? error.name : typeof error}, isAbortError=${is_abort_error}, ` +
                `this.destroyed=${this.destroyed}`, error);
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
            // チャンクの timestamp は EncodedVideoChunkInit の仕様通りマイクロ秒なので、秒に変換して保持する
            this.latestVideoTimestampSeconds = Math.max(this.latestVideoTimestampSeconds, chunk.timestamp / 1e6);
        }
        for (const { chunk } of result.audioChunks) {
            this.callbacks.onAudioChunk(chunk);
        }
        // PlayerController.ts の再生バッファ調整ロジック (getPlaybackBufferSeconds()) が
        // player.video.buffered を参照するため、ライブでも最低限のバッファ済み範囲を報告する必要がある
        // (これを報告しないと buffered が常に空のままとなり、再生バッファが一定秒数を超えるまで待つループが
        // 永久に終了せず、ローディング画面が解除されなくなる)
        // ライブは常に先頭 (anchor=0) から現在までを再生可能範囲とみなす
        if (result.videoChunks.length > 0) {
            this.callbacks.onBufferedRangesChanged([{ start: 0, end: this.latestVideoTimestampSeconds }]);
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
        // こちら側が意図的に fetch を中断するタイミングを記録する (切断原因の切り分け用、上記コメント参照)
        console.log(`[LiveVideoSource] destroy() called at ${new Date().toISOString()}: aborting fetch for ${this.streamUrl}`);
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
