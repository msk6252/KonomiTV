
/**
 * PlaybackEngine が各ソース (RecordedVideoSource / 将来の Mpeg2ToH264Source / MpegtsSource) を
 * 統一的に扱うための共通インターフェースとコールバック群
 *
 * ソース側は「エンコード済みチャンクとデコーダー設定を取り出す」ことだけに責務を限定し、
 * AV 同期・バッファリング・提示スケジューリングには一切関与しない (それらは MediaClock/AudioPipeline/
 * VideoPipeline/CanvasRenderer の責務)
 */
export interface IEngineSourceCallbacks {
    onVideoConfig(config: VideoDecoderConfig): void;
    onAudioConfig(config: AudioDecoderConfig): void;
    onVideoChunk(chunk: EncodedVideoChunkInit): void;
    onAudioChunk(chunk: EncodedAudioChunkInit): void;
    /** コンテンツ全体の長さが判明した (あるいは変化した) ときに呼ばれる */
    onDurationKnown(durationSeconds: number): void;
    /** 実際に取得・デマルチプレクスできた範囲が変化したときに呼ばれる (UI のシークバー用) */
    onBufferedRangesChanged(ranges: { start: number; end: number }[]): void;
    /** seek() が要求したプリロールを満たし、新しい再生位置からの提示を始めてよくなったときに呼ばれる */
    onSeeked(positionSeconds: number): void;
    /** 回復不能なエラーが発生したときに呼ばれる */
    onError(message: string): void;
    /** コンテンツの終端に達したときに呼ばれる */
    onEnded(): void;
}

export interface IEngineSource {
    /** ソースの初期化・再生開始準備を行う (プレイリスト取得・最初のセグメント取得等) */
    load(startPositionSeconds: number): Promise<void>;
    /** 指定位置へシークする */
    seek(positionSeconds: number): Promise<void>;
    /** 利用中のリソースを破棄する */
    destroy(): Promise<void>;
}
