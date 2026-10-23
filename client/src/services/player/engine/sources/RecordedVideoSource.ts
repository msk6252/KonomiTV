
import type { IEngineSource, IEngineSourceCallbacks } from '@/services/player/engine/sources/IEngineSource';

import MpegTsDemuxer from '@/services/player/engine/sources/MpegTsDemuxer';


/** 再生位置がこの秒数より先のセグメントは、まだ先読みせず待つ (無制限な先読みを防ぐための簡易ジッターバッファ) */
const AHEAD_BUFFER_SECONDS = 20;

const POLL_INTERVAL_MS = 250;

interface PlaylistSegment {
    sequence: number;
    /** プレイリスト上の公称開始時刻 (EXTINF を頭から積算した値) */
    nominalStartSeconds: number;
    durationSeconds: number;
    url: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMasterPlaylist(text: string, baseUrl: string): string {
    const lines = text.split('\n').map((line) => line.trim());
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const uri = lines[i + 1];
            if (uri && !uri.startsWith('#')) {
                return new URL(uri, baseUrl).toString();
            }
        }
    }
    throw new Error('RecordedVideoSource: no #EXT-X-STREAM-INF found in master playlist');
}

function parseMediaPlaylist(text: string, baseUrl: string): PlaylistSegment[] {
    const lines = text.split('\n').map((line) => line.trim());
    const segments: PlaylistSegment[] = [];
    let pendingDuration: number | null = null;
    let cumulativeStartSeconds = 0;
    let sequence = 0;

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            sequence = Number.parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
        }
    }
    for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
            pendingDuration = Number.parseFloat(line.substring('#EXTINF:'.length).split(',')[0]);
        } else if (line.length > 0 && !line.startsWith('#')) {
            if (pendingDuration !== null) {
                segments.push({
                    sequence,
                    nominalStartSeconds: cumulativeStartSeconds,
                    durationSeconds: pendingDuration,
                    url: new URL(line, baseUrl).toString(),
                });
                cumulativeStartSeconds += pendingDuration;
                sequence += 1;
                pendingDuration = null;
            }
        }
    }
    return segments;
}

/**
 * KonomiTV の録画視聴用 HLS (静的 VOD、生 MPEG-TS セグメント) を、hls.js を使わず自前で取得・デマルチプレクスするソース
 *
 * master playlist → media playlist → セグメントの順に `fetch()` で取得し、`MpegTsDemuxer` に投入した結果を
 * コールバック経由で PlaybackEngine に渡す。AV 同期・パイプライン操作は一切行わず、データの取得と解析のみに責務を限定する
 *
 * 既知の制約: `#EXT-X-PLAYLIST-TYPE:VOD`+`#EXT-X-ENDLIST` の静的プレイリストのみ対応。録画進行中 (status='Recording')
 * の追いかけ再生でプレイリストが更新され続けるケースは Phase 1 のスコープ外 (別途課題化する)
 */
class RecordedVideoSource implements IEngineSource {

    private readonly playlistUrl: string;
    private readonly callbacks: IEngineSourceCallbacks;
    private readonly getCurrentTimeSeconds: () => number;
    private readonly demuxer = new MpegTsDemuxer();

    private segments: PlaylistSegment[] = [];
    private destroyed = false;
    /** seek() のたびに増やし、古い fetch ループに「もう自分の仕事ではない」と伝えるための世代番号 */
    private generation = 0;

    /**
     * プレイリスト取得 (load() の前半) が完了するまで seek() を待たせるための Promise
     * 初回ロード中に (再生位置のレジューム等で) ただちに seek() が呼ばれても、`this.segments` が
     * 空のまま参照してクラッシュしないようにするための待ち合わせ
     */
    private playlistReadyPromise: Promise<void>;
    private resolvePlaylistReady: (() => void) | null = null;

    constructor(playlistUrl: string, callbacks: IEngineSourceCallbacks, getCurrentTimeSeconds: () => number) {
        this.playlistUrl = playlistUrl;
        this.callbacks = callbacks;
        this.getCurrentTimeSeconds = getCurrentTimeSeconds;
        this.playlistReadyPromise = new Promise((resolve) => { this.resolvePlaylistReady = resolve; });
    }

    public async load(startPositionSeconds: number): Promise<void> {
        // load() 自身の世代番号は呼び出し開始時点の値で固定する (プレイリスト取得中に seek() が走って
        // this.generation が進んでいた場合、load() 側の再生開始はもう不要になっているとみなして中断するため)
        const generation = this.generation;
        try {
            const masterText = await this.fetchText(this.playlistUrl);
            if (generation !== this.generation || this.destroyed) {
                return;
            }
            const mediaPlaylistUrl = parseMasterPlaylist(masterText, this.playlistUrl);
            const mediaText = await this.fetchText(mediaPlaylistUrl);
            if (generation !== this.generation || this.destroyed) {
                return;
            }
            this.segments = parseMediaPlaylist(mediaText, mediaPlaylistUrl);
            if (this.segments.length === 0) {
                throw new Error('no segments found in media playlist');
            }
            const totalDurationSeconds = this.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
            this.callbacks.onDurationKnown(totalDurationSeconds);
            this.resolvePlaylistReady?.();
            await this.playFrom(startPositionSeconds, generation);
        } catch (error) {
            // プレイリスト取得自体が失敗した場合も、seek() 側を待たせ続けないよう必ず解決する
            this.resolvePlaylistReady?.();
            if (generation === this.generation) {
                this.callbacks.onError(error instanceof Error ? error.message : String(error));
            }
        }
    }

    public async seek(positionSeconds: number): Promise<void> {
        this.generation += 1;
        const generation = this.generation;
        this.demuxer.reset();
        try {
            // 初回ロード (プレイリスト取得) が終わっていない間に seek() が呼ばれた場合、
            // this.segments がまだ空のままアクセスしてしまわないよう取得完了を待つ
            await this.playlistReadyPromise;
            if (generation !== this.generation || this.destroyed) {
                return;
            }
            await this.playFrom(positionSeconds, generation);
        } catch (error) {
            // 自分より新しい seek が既に始まっている場合、このエラーはもう意味を持たないので無視する
            if (generation === this.generation) {
                this.callbacks.onError(error instanceof Error ? error.message : String(error));
            }
        }
    }

    private findSegmentIndexForTime(positionSeconds: number): number {
        for (let i = 0; i < this.segments.length; i++) {
            const segment = this.segments[i];
            if (positionSeconds < segment.nominalStartSeconds + segment.durationSeconds) {
                return i;
            }
        }
        return Math.max(0, this.segments.length - 1);
    }

    private async playFrom(positionSeconds: number, generation: number): Promise<void> {
        const startIndex = this.findSegmentIndexForTime(positionSeconds);
        let reportedSeeked = false;

        for (let i = startIndex; i < this.segments.length; i++) {
            const segment = this.segments[i];

            // 再生位置から大きく先行しすぎないよう、追いつくまで待つ (無制限な先読みの防止)
            while (segment.nominalStartSeconds - this.getCurrentTimeSeconds() > AHEAD_BUFFER_SECONDS) {
                if (generation !== this.generation || this.destroyed) {
                    return;
                }
                await sleep(POLL_INTERVAL_MS);
            }
            if (generation !== this.generation || this.destroyed) {
                return;
            }

            const buffer = await this.fetchArrayBuffer(segment.url);
            if (generation !== this.generation || this.destroyed) {
                return;
            }

            const result = this.demuxer.demuxSegment(new Uint8Array(buffer), segment.nominalStartSeconds);
            if (result.videoConfig) {
                this.callbacks.onVideoConfig(result.videoConfig);
            }
            if (result.audioConfig) {
                this.callbacks.onAudioConfig(result.audioConfig);
            }
            for (const { chunk } of result.videoChunks) {
                this.callbacks.onVideoChunk(chunk);
            }
            for (const { chunk } of result.audioChunks) {
                this.callbacks.onAudioChunk(chunk);
            }
            this.callbacks.onBufferedRangesChanged([
                { start: this.segments[startIndex].nominalStartSeconds, end: segment.nominalStartSeconds + segment.durationSeconds },
            ]);

            // 最初の1セグメントを解析し終えた時点で、シーク先への最小限のプリロールが満たされたとみなす
            if (!reportedSeeked) {
                reportedSeeked = true;
                this.callbacks.onSeeked(segment.nominalStartSeconds);
            }
        }

        if (generation === this.generation && !this.destroyed) {
            this.callbacks.onEnded();
        }
    }

    private async fetchText(url: string): Promise<string> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`RecordedVideoSource: failed to fetch ${url} (${response.status})`);
        }
        return await response.text();
    }

    private async fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`RecordedVideoSource: failed to fetch ${url} (${response.status})`);
        }
        return await response.arrayBuffer();
    }

    public async destroy(): Promise<void> {
        this.destroyed = true;
        this.generation += 1;
    }
}

export default RecordedVideoSource;
