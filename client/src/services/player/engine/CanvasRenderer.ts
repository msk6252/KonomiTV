
import MediaClock from '@/services/player/engine/MediaClock';
import VideoPipeline from '@/services/player/engine/VideoPipeline';


/**
 * requestAnimationFrame ループで MediaClock の現在時刻と VideoPipeline のキューを突き合わせ、
 * 提示すべきフレームを選んで canvas に描画するレンダラー
 *
 * Deinterlacer (@mpeg2toh264/yadif) の rVFC が使えない場合のフォールバック経路 (requestAnimationFrame
 * ベースのドリフト補正) と同じ発想だが、こちらは VideoFrame のタイムスタンプを直接知っているため
 * rVFC のメタデータから推測する必要がなく、実装はよりシンプルになっている
 */
class CanvasRenderer {

    public readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly mediaClock: MediaClock;
    private readonly videoPipeline: VideoPipeline;

    private rafHandle: number | null = null;
    private lastDrawnFrame: VideoFrame | null = null;

    constructor(mediaClock: MediaClock, videoPipeline: VideoPipeline) {
        this.mediaClock = mediaClock;
        this.videoPipeline = videoPipeline;
        this.canvas = document.createElement('canvas');
        const context = this.canvas.getContext('2d');
        if (context === null) {
            throw new Error('CanvasRenderer: failed to acquire 2d rendering context');
        }
        this.context = context;
    }

    /** 描画ループを開始する */
    public start(): void {
        if (this.rafHandle !== null) {
            return;
        }
        const loop = (): void => {
            this.renderFrame();
            this.rafHandle = requestAnimationFrame(loop);
        };
        this.rafHandle = requestAnimationFrame(loop);
    }

    /** 描画ループを停止する (破棄時・一時的に非表示にする際に呼ぶ) */
    public stop(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
    }

    private renderFrame(): void {
        const targetTimeSeconds = this.mediaClock.currentTime;
        const frame = this.videoPipeline.acquireFrameAt(targetTimeSeconds);

        // 該当するフレームが無い場合 (デコード遅延・バッファ枯渇・一時停止中など) は何もしない
        // canvas は自動でクリアされないため、直前に描画した1枚がそのまま表示され続ける (静止画扱い)
        if (frame === null) {
            return;
        }

        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }
        this.mediaClock.setVideoSize(frame.displayWidth, frame.displayHeight);
        this.context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

        this.lastDrawnFrame?.close();
        this.lastDrawnFrame = frame;
    }

    public destroy(): void {
        this.stop();
        this.lastDrawnFrame?.close();
        this.lastDrawnFrame = null;
    }
}

export default CanvasRenderer;
