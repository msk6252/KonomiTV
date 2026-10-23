
import type { IEngineSource, IEngineSourceCallbacks } from '@/services/player/engine/sources/IEngineSource';

import AudioPipeline from '@/services/player/engine/AudioPipeline';
import CanvasRenderer from '@/services/player/engine/CanvasRenderer';
import JitterBuffer from '@/services/player/engine/JitterBuffer';
import MediaClock, { HAVE_ENOUGH_DATA } from '@/services/player/engine/MediaClock';
import RecordedVideoSource from '@/services/player/engine/sources/RecordedVideoSource';
import VideoPipeline from '@/services/player/engine/VideoPipeline';


/**
 * WebCodecs 自前再生エンジンの一式 (MediaClock + AudioPipeline + VideoPipeline + CanvasRenderer + ソース)
 * を束ねるオーケストレーター
 *
 * PlayerController からはこのクラスのインスタンスを1つ生成し、`mediaClock` / `canvas` を
 * VideoElementShim へ渡すことで、DPlayer からは実質的に「video 要素」として扱われる
 */
class PlaybackEngine {

    public readonly mediaClock: MediaClock;
    private readonly audioContext: AudioContext;
    private readonly audioPipeline: AudioPipeline;
    private readonly videoPipeline: VideoPipeline;
    private readonly canvasRenderer: CanvasRenderer;

    private source: IEngineSource | null = null;
    private destroyed = false;

    constructor() {
        this.audioContext = new AudioContext();
        this.mediaClock = new MediaClock(this.audioContext);
        this.audioPipeline = new AudioPipeline(this.audioContext, this.mediaClock);
        const profile = JitterBuffer.getProfile('Recorded');
        this.videoPipeline = new VideoPipeline(profile.videoQueueFrames);
        this.canvasRenderer = new CanvasRenderer(this.mediaClock, this.videoPipeline);

        // 音量/ミュート操作は MediaClock 側のプロパティを単一の真実源としつつ、実際の音声出力への反映は AudioPipeline に委ねる
        this.mediaClock.addEventListener('volumechange', this.onVolumeChange);
    }

    private readonly onVolumeChange = (): void => {
        this.audioPipeline.applyVolume();
        this.audioPipeline.applyMuted();
    };

    /** 表示に使う canvas 要素 (VideoElementShim がこれを `<video>` の代わりに DOM へ挿入する) */
    public get canvas(): HTMLCanvasElement {
        return this.canvasRenderer.canvas;
    }

    /** 録画視聴用のソースを読み込み、再生準備を行う */
    public async loadRecordedVideo(masterPlaylistUrl: string, startPositionSeconds: number): Promise<void> {
        await this.audioPipeline.initialize();
        this.canvasRenderer.start();

        const callbacks: IEngineSourceCallbacks = {
            onVideoConfig: (config) => this.videoPipeline.configure(config),
            onAudioConfig: (config) => this.audioPipeline.configure(config),
            onVideoChunk: (chunk) => this.videoPipeline.decode(chunk),
            onAudioChunk: (chunk) => this.audioPipeline.decode(chunk),
            onDurationKnown: (durationSeconds) => this.mediaClock.setDuration(durationSeconds),
            onBufferedRangesChanged: (ranges) => this.mediaClock.setBufferedRanges(ranges),
            onSeeked: (positionSeconds) => {
                this.mediaClock.reportSeeked(positionSeconds);
                this.mediaClock.setReadyState(HAVE_ENOUGH_DATA);
            },
            onError: (message) => this.mediaClock.setError(0, message),
            onEnded: () => this.mediaClock.reportEnded(),
        };

        const source = new RecordedVideoSource(masterPlaylistUrl, callbacks, () => this.mediaClock.currentTime);
        this.source = source;
        await source.load(startPositionSeconds);
    }

    /** シークする (DPlayer の `seek()` → VideoElementShim の `currentTime` setter から呼ばれる想定) */
    public async seek(positionSeconds: number): Promise<void> {
        this.mediaClock.currentTime = positionSeconds;
        await this.source?.seek(positionSeconds);
    }

    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.mediaClock.removeEventListener('volumechange', this.onVolumeChange);
        await this.source?.destroy();
        this.canvasRenderer.destroy();
        this.videoPipeline.destroy();
        this.audioPipeline.destroy();
        this.mediaClock.destroy();
        await this.audioContext.close();
    }
}

export default PlaybackEngine;
