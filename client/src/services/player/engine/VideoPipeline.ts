
import reportClientError from '@/utils/ClientErrorReporter';


/**
 * エンコード済み映像チャンクを WebCodecs の VideoDecoder でデコードし、
 * 提示待ちの VideoFrame をタイムスタンプ順にキューイングするパイプライン
 *
 * デコード自体はここで完結させ、「いつ画面に出すか」の判断は CanvasRenderer に委ねる
 * (このクラスは AV 同期やスケジューリングには関与しない)
 */
class VideoPipeline {

    private decoder: VideoDecoder | null = null;
    private readonly queue: VideoFrame[] = [];

    // configure()/flush() の直後は必ずキーフレームを最初に decode() しなければならない (WebCodecs の仕様)
    // ライブ視聴では「configure() を発火させたキーフレームより前に、同じチャンク内で見つかった旧 GOP の
    // 末尾の delta フレームが先に decode() に渡ってしまう」順序問題が起こりうるため、ここで安全に読み捨てる
    private awaitingKeyFrame = true;

    // キューの最大保持数 (ライブは低遅延優先で短く、録画は安定性優先で長く、JitterBuffer のプロファイルに応じて渡される)
    private maxQueueLength: number;

    constructor(maxQueueLength: number) {
        this.maxQueueLength = maxQueueLength;
    }

    public setMaxQueueLength(length: number): void {
        this.maxQueueLength = length;
    }

    /**
     * 映像デコーダーを (再) 構築する。コーデック・解像度が変わった場合に呼ぶ
     * デマルチプレクサ側の解析ミス等で不正な config が渡ってきても、デコーダー未構成のまま
     * (= このコーデック変更は無視される) にするだけで、再生全体を落とさない
     */
    public configure(config: VideoDecoderConfig): void {
        this.closeDecoder();
        try {
            const decoder = new VideoDecoder({
                output: (frame) => this.onFrame(frame),
                error: (error) => reportClientError('WebCodecsPlayer/VideoPipeline/decode', error),
            });
            decoder.configure(config);
            this.decoder = decoder;
            this.awaitingKeyFrame = true;
        } catch (error) {
            reportClientError('WebCodecsPlayer/VideoPipeline', error);
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
