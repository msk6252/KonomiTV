
import IPlaybackEngine from '@/services/player/engine/IPlaybackEngine';
import reportClientError from '@/utils/ClientErrorReporter';


/**
 * TimeRanges インターフェースを満たす素朴な実装
 * HTMLMediaElement.buffered 等は読み取り専用の TimeRanges を要求するため、生成用に用意する
 */
class SimpleTimeRanges implements TimeRanges {
    private readonly ranges: { start: number; end: number }[];

    constructor(ranges: { start: number; end: number }[]) {
        this.ranges = ranges;
    }

    public get length(): number {
        return this.ranges.length;
    }

    public start(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
        }
        return range.start;
    }

    public end(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
        }
        return range.end;
    }
}

// HTMLMediaElement.readyState と同じ定数
export const HAVE_NOTHING = 0;
export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;
export const HAVE_FUTURE_DATA = 3;
export const HAVE_ENOUGH_DATA = 4;

// AudioPipeline からの実測報告と、基準点からの計算値のズレがこの閾値を超えた場合のみ基準点を再補正する
// (毎フレーム補正すると音声のピッチ変動や映像のちらつきにつながるため、閾値未満の揺れは無視する)
const DRIFT_RESYNC_THRESHOLD_SECONDS = 0.02;

/**
 * WebCodecs 自前再生エンジンにおける、再生時刻・duration・paused・volume 等の単一の真実源
 *
 * HTMLVideoElement の代わりとして IPlaybackEngine を実装し、DPlayer / KonomiTV 側の既存コードから
 * `this.player.video.currentTime` 等と同じ形でアクセスできるようにする。
 *
 * 基準クロックは AudioContext.currentTime (ハードウェアクロック、単調増加) で、
 * 再生開始・一時停止解除・シーク完了・再生速度変更の4イベントでのみ基準点 (baseMediaTime/baseContextTime)
 * を再設定する。AudioPipeline が実際に消費したサンプル数から算出したコンテンツ時刻を一定間隔で
 * reportAudioAnchor() 経由で報告し、計算値との差が大きい場合のみ基準点を補正することで、
 * 音声のアンダーラン (無音挿入) による時刻のズレを吸収する
 */
class MediaClock extends EventTarget implements IPlaybackEngine {

    public readonly audioContext: AudioContext;

    // 基準点: この2値のペアと rate から currentTime を算出する (video.currentTime を直接読むのと等価な参照点)
    private baseMediaTime = 0;
    private baseContextTime = 0;

    private _paused = true;
    private _rate = 1;
    private _volume = 1;
    private _muted = false;
    private _duration = NaN;
    private _videoWidth = 0;
    private _videoHeight = 0;
    private _readyState: number = HAVE_NOTHING;
    private _error: MediaError | null = null;
    private bufferedRanges: { start: number; end: number }[] = [];

    private timeupdateIntervalId: number | null = null;

    private readonly onVisibilityChange = (): void => {
        // iOS 等、バックグラウンドタブ化で AudioContext が自動的に suspend される環境向けに、
        // 復帰時に明示的に resume() する (既存コードにこの種のハンドラはないため新規実装)
        if (document.visibilityState === 'visible' && this.audioContext.state === 'suspended') {
            void this.audioContext.resume();
        }
    };

    constructor(audioContext: AudioContext) {
        super();
        this.audioContext = audioContext;
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    // ***** 再生位置 *****

    public get currentTime(): number {
        if (this._paused) {
            return this.baseMediaTime;
        }
        return this.baseMediaTime + (this.audioContext.currentTime - this.baseContextTime) * this._rate;
    }

    public set currentTime(value: number) {
        // IPlaybackEngine 経由の代入は HTMLVideoElement と同様シークとして扱う
        // 実際のシーク処理 (パイプラインの flush・ソースへのシーク指示) は PlaybackEngine が行い、
        // プリロール完了後に rebaseTo() + reportSeeked() を呼び出す想定のため、ここでは基準点のみ更新する
        this.rebaseTo(value);
        this.dispatchEvent(new Event('seeking'));
    }

    /** 基準点を指定の再生時刻に即座に合わせる (シーク完了時・再生速度変更時に使う) */
    public rebaseTo(mediaTime: number): void {
        this.baseMediaTime = mediaTime;
        this.baseContextTime = this.audioContext.currentTime;
    }

    /** 現在の算出値を基準点として再設定する (再生速度変更時、値を変えずに基準点だけ更新する) */
    private rebaseToCurrent(): void {
        this.rebaseTo(this.currentTime);
    }

    /** PlaybackEngine がシーク完了 (両パイプラインのプリロール充足) を報告する */
    public reportSeeked(mediaTime: number): void {
        this.rebaseTo(mediaTime);
        this.dispatchEvent(new Event('seeked'));
    }

    /**
     * AudioPipeline から約250ms間隔で呼ばれる、実際に消費済みのサンプルに対応するコンテンツ再生時刻の報告
     * 計算値との差が閾値を超えた場合のみ基準点を一括補正する (Deinterlacer のドリフト補正と同じ発想)
     */
    public reportAudioAnchor(contentTimeSeconds: number): void {
        if (this._paused) {
            return;
        }
        const drift = contentTimeSeconds - this.currentTime;
        if (Math.abs(drift) > DRIFT_RESYNC_THRESHOLD_SECONDS) {
            this.rebaseTo(contentTimeSeconds);
        }
    }

    // ***** duration *****

    public get duration(): number {
        return this._duration;
    }

    public setDuration(value: number): void {
        if (this._duration !== value) {
            this._duration = value;
            this.dispatchEvent(new Event('durationchange'));
        }
    }

    // ***** paused / play / pause *****

    public get paused(): boolean {
        return this._paused;
    }

    public async play(): Promise<void> {
        if (this._paused === false) {
            return;
        }
        // 自動再生ポリシーで suspended になっている場合はユーザー操作起点の play() で resume する
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        this.rebaseToCurrent();
        this._paused = false;
        this.startTimeupdateLoop();
        this.dispatchEvent(new Event('play'));
        this.dispatchEvent(new Event('playing'));
    }

    public pause(): void {
        if (this._paused === true) {
            return;
        }
        this.rebaseToCurrent();
        this._paused = true;
        this.stopTimeupdateLoop();
        this.dispatchEvent(new Event('pause'));
    }

    // ***** volume / muted *****

    public get volume(): number {
        return this._volume;
    }

    public set volume(value: number) {
        const clamped = Math.max(0, Math.min(1, value));
        if (this._volume !== clamped) {
            this._volume = clamped;
            this.dispatchEvent(new Event('volumechange'));
        }
    }

    public get muted(): boolean {
        return this._muted;
    }

    public set muted(value: boolean) {
        if (this._muted !== value) {
            this._muted = value;
            this.dispatchEvent(new Event('volumechange'));
        }
    }

    // ***** playbackRate *****

    public get playbackRate(): number {
        return this._rate;
    }

    public set playbackRate(value: number) {
        if (this._rate === value) {
            return;
        }
        // 再生速度変更時は、値を変える前に現在の算出値を基準点として固定する (2-4節の設計)
        this.rebaseToCurrent();
        this._rate = value;
        this.dispatchEvent(new Event('ratechange'));
    }

    // ***** buffered *****

    public get buffered(): TimeRanges {
        return new SimpleTimeRanges(this.bufferedRanges);
    }

    public setBufferedRanges(ranges: { start: number; end: number }[]): void {
        this.bufferedRanges = ranges;
        this.dispatchEvent(new Event('progress'));
    }

    // ***** readyState *****

    public get readyState(): number {
        return this._readyState;
    }

    public setReadyState(value: number): void {
        if (this._readyState === value) {
            return;
        }
        this._readyState = value;
        if (value >= HAVE_FUTURE_DATA) {
            this.dispatchEvent(new Event('canplay'));
            if (value >= HAVE_ENOUGH_DATA) {
                this.dispatchEvent(new Event('canplaythrough'));
            }
        } else if (value <= HAVE_CURRENT_DATA) {
            this.dispatchEvent(new Event('waiting'));
        }
    }

    // ***** 映像サイズ *****

    public get videoWidth(): number {
        return this._videoWidth;
    }

    public get videoHeight(): number {
        return this._videoHeight;
    }

    public setVideoSize(width: number, height: number): void {
        if (this._videoWidth !== width || this._videoHeight !== height) {
            this._videoWidth = width;
            this._videoHeight = height;
            this.dispatchEvent(new Event('resize'));
        }
    }

    // ***** エラー *****

    public get error(): MediaError | null {
        return this._error;
    }

    public setError(code: number, message: string): void {
        // MediaError は仕様上コンストラクタが公開されていないため、同じ形を持つ素のオブジェクトを充てる
        this._error = { code, message } as MediaError;
        // 開発者ツールを開けない環境でもデバッグできるよう、サーバーログにも転送する
        reportClientError('WebCodecsPlayer/MediaClock', new Error(message));
        this.dispatchEvent(new Event('error'));
    }

    // ***** 終端 *****

    public reportEnded(): void {
        this._paused = true;
        this.stopTimeupdateLoop();
        this.dispatchEvent(new Event('ended'));
    }

    // ***** timeupdate *****

    private startTimeupdateLoop(): void {
        this.stopTimeupdateLoop();
        // HTMLMediaElement の timeupdate は仕様上「最低250ms間隔」とされているのに合わせる
        this.timeupdateIntervalId = window.setInterval(() => {
            this.dispatchEvent(new Event('timeupdate'));
        }, 250);
    }

    private stopTimeupdateLoop(): void {
        if (this.timeupdateIntervalId !== null) {
            window.clearInterval(this.timeupdateIntervalId);
            this.timeupdateIntervalId = null;
        }
    }

    // ***** 破棄 *****

    public destroy(): void {
        this.stopTimeupdateLoop();
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
}

export default MediaClock;
