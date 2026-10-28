
import MpegTsDemuxer from '@/services/player/engine/sources/MpegTsDemuxer';


/** TS パケット長 (LiveVideoSource.ts と同じ定数) */
const TS_PACKET_LENGTH = 188;
const SYNC_BYTE = 0x47;
const SYNC_CONFIRM_PACKET_COUNT = 3;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * Tesla 車載ブラウザ向けの H.264 Baseline Profile ライブストリーム (tesla-480p 画質) を取得し、
 * Broadway.js (WebAssembly 製ソフトウェア H.264 デコーダ) に Annex B の NAL ユニット列をそのまま投入するソース
 *
 * LiveVideoSource.ts (WebCodecs 向け) と同じ fetch()+ReadableStream による継続的なバイト列取得 +
 * MpegTsDemuxer (continuous モード) を再利用するが、以下の点が異なる:
 * - WebCodecs の VideoPipeline ではなく Broadway.js の Player.decode() にチャンクを渡す
 * - tesla-480p 画質は映像のみのストリーム (音声は 'tesla-audio' で別配信) のため、音声チャンクは実質発生しない
 * - MediaClock 等の AV 同期機構を一切使わない (Tesla 向けの簡易実装として、映像の fetch 開始と
 *   別途再生させる <audio> 要素の play() をほぼ同時に始める程度の同期に留める、PlayerController.ts 側の責務)
 */
class BroadwayLiveVideoSource {

    private readonly streamUrl: string;
    private readonly player: BroadwayPlayer;
    private readonly onError: (message: string) => void;
    private readonly demuxer = new MpegTsDemuxer({ continuous: true });

    private abortController: AbortController | null = null;
    private pendingBytes: Uint8Array = new Uint8Array(0);
    private destroyed = false;
    /** Broadway.js の VideoDecoderConfig 相当は不要だが、最初のキーフレームが来るまでは decode() を呼ばない */
    private hasReceivedKeyFrame = false;

    constructor(streamUrl: string, player: BroadwayPlayer, onError: (message: string) => void) {
        this.streamUrl = streamUrl;
        this.player = player;
        this.onError = onError;
    }

    /** 接続が切れるまで戻ってこない無限ループのため、呼び出し元はバックグラウンドで走らせたまま戻ること */
    public async start(): Promise<void> {
        this.abortController = new AbortController();
        // LiveVideoSource.ts と同じ理由の診断ログ (切断原因がこちら側の destroy() か相手側かを切り分ける用)
        console.log(`[BroadwayLiveVideoSource] start() begin at ${new Date().toISOString()}: ${this.streamUrl}`);
        try {
            const response = await fetch(this.streamUrl, { signal: this.abortController.signal });
            if (!response.ok || response.body === null) {
                throw new Error(`BroadwayLiveVideoSource: failed to fetch ${this.streamUrl} (${response.status})`);
            }
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log(`[BroadwayLiveVideoSource] reader.read() returned done=true at ${new Date().toISOString()}. ` +
                        `this.destroyed=${this.destroyed}`);
                    break;
                }
                this.processChunk(value);
            }
        } catch (error) {
            const is_abort_error = error instanceof DOMException && error.name === 'AbortError';
            console.log(`[BroadwayLiveVideoSource] start() caught error at ${new Date().toISOString()}: ` +
                `name=${error instanceof Error ? error.name : typeof error}, isAbortError=${is_abort_error}, ` +
                `this.destroyed=${this.destroyed}`, error);
            // destroy() による AbortError は正常な終了なのでエラー報告しない
            if (this.destroyed === false) {
                this.onError(error instanceof Error ? error.message : String(error));
            }
        }
    }

    private processChunk(chunk: Uint8Array): void {
        const combined = this.pendingBytes.length > 0 ? concatBytes(this.pendingBytes, chunk) : chunk;

        const syncOffset = findSyncOffset(combined);
        if (syncOffset === null) {
            this.pendingBytes = combined.length > MAX_PENDING_BYTES ?
                combined.subarray(combined.length - MAX_PENDING_BYTES) : combined;
            return;
        }

        const packetCount = Math.floor((combined.length - syncOffset) / TS_PACKET_LENGTH);
        const usableLength = packetCount * TS_PACKET_LENGTH;
        if (packetCount > 0) {
            const aligned = combined.subarray(syncOffset, syncOffset + usableLength);
            const result = this.demuxer.demuxChunk(aligned);
            this.decodeVideoChunks(result.videoChunks.map((entry) => entry.chunk));
        }
        this.pendingBytes = combined.subarray(syncOffset + usableLength);
    }

    /**
     * Broadway.js は decode() を呼ぶ前に必ずキーフレーム (IDR) から渡さないと映像が正しく描画されない
     * (WebCodecs VideoDecoder のような明示的な configure() は無いが、デコーダーの内部状態は同様に SPS/PPS と
     * 最初の IDR が揃うまで不定なため、VideoPipeline.ts の awaitingKeyFrame と同じガードをここでも設ける)
     */
    private decodeVideoChunks(chunks: EncodedVideoChunkInit[]): void {
        for (const chunk of chunks) {
            if (this.hasReceivedKeyFrame === false) {
                if (chunk.type !== 'key') {
                    continue;
                }
                this.hasReceivedKeyFrame = true;
            }
            const data = chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data as ArrayBuffer);
            this.player.decode(data);
        }
    }

    public destroy(): void {
        console.log(`[BroadwayLiveVideoSource] destroy() called at ${new Date().toISOString()}: aborting fetch for ${this.streamUrl}`);
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

/** LiveVideoSource.ts の findSyncOffset() と同じロジック (188byte 境界の同期確立) */
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
    if (data.length > 0 && data[0] === SYNC_BYTE) {
        return 0;
    }
    return null;
}

export default BroadwayLiveVideoSource;
