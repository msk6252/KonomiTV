
import reportClientError from '@/utils/ClientErrorReporter';


/**
 * エンコード済み映像チャンクを WebCodecs の VideoDecoder でデコードし、
 * 提示待ちの VideoFrame をタイムスタンプ順にキューイングするパイプライン
 *
 * デコード自体はここで完結させ、「いつ画面に出すか」の判断は CanvasRenderer に委ねる
 * (このクラスは AV 同期やスケジューリングには関与しない)
 */
// 自動復旧を試みる回数の上限 (この回数を超えて短時間に繰り返しエラーが発生する場合は、
// 一時的なビットストリーム破損ではなく構造的な問題とみなし、致命的エラーとして上位に伝える)
const MAX_AUTO_RECOVERY_ATTEMPTS = 5;
// この秒数の間エラーが発生しなければ、連続エラー数のカウントをリセットする
const AUTO_RECOVERY_RESET_SECONDS = 10;

class VideoPipeline {

    private decoder: VideoDecoder | null = null;
    private readonly queue: VideoFrame[] = [];

    // configure()/flush() の直後は必ずキーフレームを最初に decode() しなければならない (WebCodecs の仕様)
    // ライブ視聴では「configure() を発火させたキーフレームより前に、同じチャンク内で見つかった旧 GOP の
    // 末尾の delta フレームが先に decode() に渡ってしまう」順序問題が起こりうるため、ここで安全に読み捨てる
    private awaitingKeyFrame = true;

    // キューの最大保持数 (ライブは低遅延優先で短く、録画は安定性優先で長く、JitterBuffer のプロファイルに応じて渡される)
    private maxQueueLength: number;

    // 直前に configure() に渡された config (デコーダーがエラーで closed になった際の自動再構築に使う)
    private lastConfig: VideoDecoderConfig | null = null;
    // 直近の連続エラー発生回数と、カウントをリセットするタイマー
    private consecutiveErrorCount = 0;
    private errorResetTimeoutId: number | null = null;
    // 自動復旧を諦めた場合 (致命的エラー) に呼ばれるコールバック (PlaybackEngine 経由で MediaClock.setError() に繋がる)
    private onFatalError: ((message: string) => void) | null = null;

    constructor(maxQueueLength: number) {
        this.maxQueueLength = maxQueueLength;
    }

    public setMaxQueueLength(length: number): void {
        this.maxQueueLength = length;
    }

    /** 自動復旧を諦めた際に呼ばれるコールバックを登録する */
    public setOnFatalError(callback: (message: string) => void): void {
        this.onFatalError = callback;
    }

    /**
     * 映像デコーダーを (再) 構築する。コーデック・解像度が変わった場合、またはデコーダーがエラーで
     * closed になった際の自動復旧時に呼ぶ
     * デマルチプレクサ側の解析ミス等で不正な config が渡ってきても、デコーダー未構成のまま
     * (= このコーデック変更は無視される) にするだけで、再生全体を落とさない
     */
    public configure(config: VideoDecoderConfig): void {
        this.closeDecoder();
        try {
            const decoder = new VideoDecoder({
                output: (frame) => this.onFrame(frame),
                error: (error) => this.handleDecoderError(error),
            });
            decoder.configure(config);
            this.decoder = decoder;
            this.lastConfig = config;
            this.awaitingKeyFrame = true;
        } catch (error) {
            reportClientError('WebCodecsPlayer/VideoPipeline', error);
        }
    }

    /**
     * VideoDecoder がエラーを報告したときの処理
     * WebCodecs の仕様上、error コールバックが発火した時点でデコーダーは自動的に closed 状態になり、
     * それ以降 decode() を呼んでも無視され続ける (= 映像が永久に停止する) ため、ここで同じ config を使って
     * デコーダーを再構築し、次のキーフレームから復旧を試みる
     * (Wi-Fi 環境が不安定な車載ブラウザ等では、ビットストリームの一部破損によるデコードエラーが
     * 一時的に発生することがあり、特にソフトウェアデコード使用時 (Tesla の Drive Mode 対策) はこれに弱い)
     * 短時間に繰り返し発生する場合は構造的な問題と判断し、致命的エラーとして上位に伝えて自動復旧を諦める
     */
    private handleDecoderError(error: Error): void {
        reportClientError('WebCodecsPlayer/VideoPipeline/decode', error);

        if (this.errorResetTimeoutId !== null) {
            window.clearTimeout(this.errorResetTimeoutId);
        }
        this.errorResetTimeoutId = window.setTimeout(() => {
            this.consecutiveErrorCount = 0;
            this.errorResetTimeoutId = null;
        }, AUTO_RECOVERY_RESET_SECONDS * 1000);

        this.consecutiveErrorCount += 1;
        if (this.consecutiveErrorCount > MAX_AUTO_RECOVERY_ATTEMPTS) {
            reportClientError('WebCodecsPlayer/VideoPipeline',
                new Error(`Giving up automatic recovery after ${MAX_AUTO_RECOVERY_ATTEMPTS} consecutive decode errors.`));
            this.onFatalError?.(`映像デコードエラーが連続して発生しました。(${error.message})`);
            return;
        }

        if (this.lastConfig !== null) {
            this.configure(this.lastConfig);
        }
    }

    private onFrame(frame: VideoFrame): void {
        this.queue.push(frame);
        // キューが長すぎる場合は古いフレームから破棄する (デコードがリアルタイムに追いつかない際の破綻防止)
        while (this.queue.length > this.maxQueueLength) {
            this.queue.shift()?.close();
        }
    }

    /** エンコード済み映像チャンクをデコーダーに投入する */
    public decode(chunkInit: EncodedVideoChunkInit): void {
        if (!this.decoder || this.decoder.state !== 'configured') {
            return;
        }
        if (this.awaitingKeyFrame === true) {
            if (chunkInit.type !== 'key') {
                // configure()/flush() 直後にキーフレームが来るまで delta フレームは安全に読み捨てる
                // (WebCodecs は configure() 直後に delta を decode() すると例外を投げるため)
                return;
            }
            this.awaitingKeyFrame = false;
        }
        try {
            this.decoder.decode(new EncodedVideoChunk(chunkInit));
        } catch (error) {
            reportClientError('WebCodecsPlayer/VideoPipeline', error);
        }
    }

    /** デコーダー内部のデコード待ちキューの長さ (バックプレッシャー判定用) */
    public get decodeQueueSize(): number {
        return this.decoder?.decodeQueueSize ?? 0;
    }

    /** 提示待ちキューの先頭フレームのタイムスタンプ (秒) 。キューが空なら null */
    public peekNextTimestampSeconds(): number | null {
        const frame = this.queue[0];
        return frame ? (frame.timestamp ?? 0) / 1e6 : null;
    }

    /**
     * targetTimeSeconds 以前のフレームの中で最も新しいものを取り出す
     * それより古い (= 既に表示機会を逃した) フレームは破棄する
     * 該当するフレームが無ければ null を返す (呼び出し側は直前に表示していたフレームを継続表示すべき)
     * 返したフレームの所有権は呼び出し側に移る (使い終わったら close() すること)
     */
    public acquireFrameAt(targetTimeSeconds: number): VideoFrame | null {
        const targetUs = targetTimeSeconds * 1e6;
        let selected: VideoFrame | null = null;
        while (this.queue.length > 0 && (this.queue[0].timestamp ?? 0) <= targetUs) {
            selected?.close();
            selected = this.queue.shift() ?? null;
        }
        return selected;
    }

    /** デコーダーをフラッシュし、キューをすべて破棄する (シーク時に呼ぶ) */
    public async flush(): Promise<void> {
        if (this.decoder && this.decoder.state === 'configured') {
            try {
                await this.decoder.flush();
            } catch {
                // flush 中の close/configure 変更によるエラーは無視してよい
            }
            // flush() 直後も configure() 直後と同様、次に decode() できるのはキーフレームのみ
            this.awaitingKeyFrame = true;
        }
        this.clearQueue();
    }

    private clearQueue(): void {
        for (const frame of this.queue) {
            frame.close();
        }
        this.queue.length = 0;
    }

    private closeDecoder(): void {
        this.clearQueue();
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = null;
    }

    public destroy(): void {
        this.closeDecoder();
    }
}

export default VideoPipeline;
