
/**
 * fMP4 (Fragmented MP4) のボックス構造を解析し、WebCodecs の VideoDecoder / AudioDecoder に
 * そのまま投入できる EncodedVideoChunk / EncodedAudioChunk 相当のサンプル情報を取り出すパーサー
 *
 * hls.js の Hls.Events.BUFFER_APPENDING で得られるセグメントは、映像・音声が別々の呼び出しで
 * (SourceBuffer ごとに) 渡されるため、1本の moov に複数 track が含まれるケースは基本的に発生しないが、
 * 将来 mpeg2toh264 (映像 track=1・音声 track=2 を同一 moov に含む) 経路でも再利用できるよう、
 * track_ID をキーに複数トラックを扱える設計にしている
 */

export interface Fmp4VideoTrack {
    kind: 'video';
    trackId: number;
    timescale: number;
    config: VideoDecoderConfig;
}

export interface Fmp4AudioTrack {
    kind: 'audio';
    trackId: number;
    timescale: number;
    config: AudioDecoderConfig;
}

export type Fmp4Track = Fmp4VideoTrack | Fmp4AudioTrack;

export interface Fmp4VideoSample {
    kind: 'video';
    trackId: number;
    chunk: EncodedVideoChunkInit;
}

export interface Fmp4AudioSample {
    kind: 'audio';
    trackId: number;
    chunk: EncodedAudioChunkInit;
}

export type Fmp4Sample = Fmp4VideoSample | Fmp4AudioSample;

interface Box {
    type: string;
    start: number;
    body: number;
    end: number;
}

/** 指定範囲内の直下の box を列挙する (再帰はしない) */
function listBoxes(data: Uint8Array, begin: number, end: number): Box[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const result: Box[] = [];
    let start = begin;
    while (start < end) {
        if (start + 8 > end) {
            throw new Error('Fmp4Demuxer: incomplete box header');
        }
        let size = view.getUint32(start);
        let body = start + 8;
        // size === 1 の場合、32bit では表現できない巨大な box で、続く 64bit に実サイズが入る
        if (size === 1) {
            if (start + 16 > end) {
                throw new Error('Fmp4Demuxer: incomplete largesize box header');
            }
            size = Number(view.getBigUint64(start + 8));
            body = start + 16;
        }
        if (size < 8 || start + size > end) {
            throw new Error('Fmp4Demuxer: invalid box size');
        }
        result.push({
            type: String.fromCharCode(...data.subarray(start + 4, start + 8)),
            start,
            body,
            end: start + size,
        });
        start += size;
    }
    return result;
}

/** box 配列から最初に見つかった type の box を返す */
function findBox(boxes: Box[], type: string): Box | undefined {
    return boxes.find((box) => box.type === type);
}

/** 入れ子になった box パスを順番にたどって最後の box を返す (途中で見つからなければ null) */
function descend(data: Uint8Array, root: Box, path: string[]): Box | null {
    let current = root;
    for (const type of path) {
        const child = findBox(listBoxes(data, current.body, current.end), type);
        if (!child) {
            return null;
        }
        current = child;
    }
    return current;
}

/** MPEG-4 ES_Descriptor (esds box) 内から DecoderSpecificInfo (tag 0x05 = AudioSpecificConfig) を取り出す */
function parseAudioSpecificConfigFromEsds(data: Uint8Array, esds: Box): Uint8Array | null {
    // esds box body: version(1) + flags(3) に続き、MPEG-4 descriptor (tag-length-value) が並ぶ
    let position = esds.body + 4;
    while (position < esds.end) {
        const tag = data[position];
        position += 1;
        // tag の長さフィールドは、最上位ビットが継続フラグの可変長 (0x80 以上が続く限り次のバイトも長さに含む)
        let length = 0;
        for (;;) {
            if (position >= esds.end) {
                return null;
            }
            const byte = data[position];
            position += 1;
            length = (length << 7) | (byte & 0x7f);
            if ((byte & 0x80) === 0) {
                break;
            }
        }
        const payloadStart = position;
        const payloadEnd = position + length;
        if (payloadEnd > esds.end) {
            return null;
        }
        if (tag === 0x03) {
            // ES_Descriptor: ES_ID(2) に続き DecoderConfigDescriptor (tag 0x04) が子として入っている
            // 子 descriptor を探すため、同じループをこの payload 範囲に対して再帰的に適用する
            position = payloadStart + 2;
            continue;
        }
        if (tag === 0x04) {
            // DecoderConfigDescriptor: objectTypeIndication(1) + streamType等(1) + bufferSizeDB(3)
            // + maxBitrate(4) + avgBitrate(4) = 固定13byte の後に DecoderSpecificInfo (tag 0x05) が続く
            position = payloadStart + 13;
            continue;
        }
        if (tag === 0x05) {
            // DecoderSpecificInfo = AudioSpecificConfig そのもの
            return data.subarray(payloadStart, payloadEnd);
        }
        // 興味のない descriptor はスキップして次へ
        position = payloadEnd;
    }
    return null;
}

/** AudioSpecificConfig の先頭 5bit (audioObjectType) から WebCodecs 用のコーデック文字列を決める */
function resolveAacCodecString(audioSpecificConfig: Uint8Array | null): string {
    if (!audioSpecificConfig || audioSpecificConfig.length === 0) {
        // 情報が取れない場合は ARIB 放送で最も一般的な AAC-LC を既定とする
        return 'mp4a.40.2';
    }
    const audioObjectType = audioSpecificConfig[0] >> 3;
    switch (audioObjectType) {
        case 5:  // HE-AAC (SBR)
            return 'mp4a.40.5';
        case 29: // HE-AACv2 (SBR + PS)
            return 'mp4a.40.29';
        default: // AAC-LC (2) を含むその他
            return 'mp4a.40.2';
    }
}

/** moov から video (avc1/avc3/hvc1/hev1) / audio (mp4a) の各 track 定義を抽出する */
function parseMoov(data: Uint8Array, moov: Box): Map<number, Fmp4Track> {
    const tracks = new Map<number, Fmp4Track>();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    for (const trak of listBoxes(data, moov.body, moov.end).filter((box) => box.type === 'trak')) {
        const tkhd = findBox(listBoxes(data, trak.body, trak.end), 'tkhd');
        if (!tkhd) {
            continue;
        }
        // tkhd: version(1)+flags(3) の後、version0 なら creation_time(4)+modification_time(4) を経て track_ID(4)
        // version1 (64bit 時刻) の場合はここが 8byte×2 になるため offset が変わる
        const tkhdVersion = data[tkhd.body];
        const trackIdOffset = tkhdVersion === 1 ? tkhd.body + 4 + 16 : tkhd.body + 4 + 8;
        const trackId = view.getUint32(trackIdOffset);

        const mdhd = descend(data, trak, ['mdia', 'mdhd']);
        if (!mdhd) {
            continue;
        }
        const mdhdVersion = data[mdhd.body];
        // mdhd: version0 は creation_time(4)+modification_time(4)+timescale(4)、version1 はそれぞれ 8byte
        const timescaleOffset = mdhdVersion === 1 ? mdhd.body + 4 + 16 : mdhd.body + 4 + 8;
        const timescale = view.getUint32(timescaleOffset);

        const stsd = descend(data, trak, ['mdia', 'minf', 'stbl', 'stsd']);
        if (!stsd) {
            continue;
        }
        // stsd: version(1)+flags(3)+entry_count(4) の固定 8byte ヘッダーの後にサンプルエントリーが並ぶ
        const entries = listBoxes(data, stsd.body + 8, stsd.end);

        const videoEntry = entries.find((entry) => ['avc1', 'avc3', 'hvc1', 'hev1'].includes(entry.type));
        if (videoEntry) {
            // VisualSampleEntry の固定部分は 78byte で、その直後に avcC/hvcC が続く
            const configBox = findBox(listBoxes(data, videoEntry.body + 78, videoEntry.end),
                videoEntry.type.startsWith('avc') ? 'avcC' : 'hvcC');
            if (configBox) {
                const description = data.slice(configBox.body, configBox.end);
                let codec: string;
                if (videoEntry.type.startsWith('avc')) {
                    // avcC の先頭は configurationVersion(1) に続き profile/profile_compat/level の3byte
                    // この3byteをそのまま16進表記すれば 'avc1.XXXXXX' 形式のコーデック文字列になる
                    const profileBytes = description.subarray(1, 4);
                    codec = `avc1.${Array.from(profileBytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
                } else {
                    // HEVC のコーデック文字列は profile_space/tier/profile_idc/compatibility_flags(ビット順反転)
                    // /level_idc/constraint_flags を組み立てる必要があり avcC ほど単純ではないため、
                    // Phase 1 (hls.js 録画視聴、実質 H.264 のみ) の対象外として明示的に未対応とする
                    console.warn('[Fmp4Demuxer] HEVC codec string construction is not implemented yet. Skipping this video track.');
                    continue;
                }
                tracks.set(trackId, {
                    kind: 'video',
                    trackId,
                    timescale,
                    config: { codec, description },
                });
            }
            continue;
        }

        const audioEntry = entries.find((entry) => entry.type === 'mp4a');
        if (audioEntry) {
            // AudioSampleEntry: SampleEntry 基底(8byte) + reserved[2](8byte) + channelcount(2) + samplesize(2)
            // + pre_defined(2) + reserved(2) + samplerate(4, 16.16 固定小数点) = 固定 28byte の後に esds が続く
            const sampleRateFixedPoint = view.getUint32(audioEntry.body + 8 + 8 + 2 + 2 + 2 + 2);
            const sampleRate = sampleRateFixedPoint >>> 16;
            const channelCount = view.getUint16(audioEntry.body + 8 + 8);
            const esds = findBox(listBoxes(data, audioEntry.body + 28, audioEntry.end), 'esds');
            const audioSpecificConfig = esds ? parseAudioSpecificConfigFromEsds(data, esds) : null;
            tracks.set(trackId, {
                kind: 'audio',
                trackId,
                timescale,
                config: {
                    codec: resolveAacCodecString(audioSpecificConfig),
                    sampleRate,
                    numberOfChannels: channelCount,
                    description: audioSpecificConfig ?? undefined,
                },
            });
        }
    }

    return tracks;
}

// tfhd box の flags ビット
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x000001;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT = 0x000020;

// trun box の flags ビット
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;

/** sample_flags (もしくは first_sample_flags) の is_difference_sample ビットから key / delta を判定する */
function isKeyFrameFromSampleFlags(flags: number): boolean {
    // ISO/IEC 14496-12 の sample_flags: bit 16 (0x00010000) が sample_is_difference_sample
    return (flags & 0x00010000) === 0;
}

/** moof 内の各 traf を解析し、対応する track のサンプル列を取り出す */
function parseMoof(data: Uint8Array, moof: Box, tracks: Map<number, Fmp4Track>): Fmp4Sample[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples: Fmp4Sample[] = [];

    for (const traf of listBoxes(data, moof.body, moof.end).filter((box) => box.type === 'traf')) {
        const children = listBoxes(data, traf.body, traf.end);
        const tfhd = findBox(children, 'tfhd');
        const tfdt = findBox(children, 'tfdt');
        const trun = findBox(children, 'trun');
        if (!tfhd || !tfdt || !trun) {
            continue;
        }

        // tfhd: version(1)+flags(3) の後に track_ID(4)
        const tfhdFlags = view.getUint32(tfhd.body) & 0x00ffffff;
        const trackId = view.getUint32(tfhd.body + 4);
        const track = tracks.get(trackId);
        if (!track) {
            continue;
        }

        let tfhdOffset = tfhd.body + 8;
        let defaultBaseOffset: number | null = null;
        if ((tfhdFlags & TFHD_BASE_DATA_OFFSET_PRESENT) !== 0) {
            defaultBaseOffset = Number(view.getBigUint64(tfhdOffset));
            tfhdOffset += 8;
        }
        if ((tfhdFlags & 0x000002) !== 0) {  // sample_description_index_present
            tfhdOffset += 4;
        }
        let defaultSampleDuration = 0;
        if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION_PRESENT) !== 0) {
            defaultSampleDuration = view.getUint32(tfhdOffset);
            tfhdOffset += 4;
        }
        let defaultSampleSize = 0;
        if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE_PRESENT) !== 0) {
            defaultSampleSize = view.getUint32(tfhdOffset);
            tfhdOffset += 4;
        }
        let defaultSampleFlags = 0;
        if ((tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT) !== 0) {
            defaultSampleFlags = view.getUint32(tfhdOffset);
            tfhdOffset += 4;
        }

        // tfdt: version(1)+flags(3) の後、version0 なら baseMediaDecodeTime が 32bit、version1 なら 64bit
        const isTfdtV1 = data[tfdt.body] === 1;
        let decodeTime = isTfdtV1 ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4);

        // trun: version(1)+flags(3) の後 sample_count(4)
        const trunFlags = view.getUint32(trun.body) & 0x00ffffff;
        const trunVersion = data[trun.body];
        const sampleCount = view.getUint32(trun.body + 4);
        let trunOffset = trun.body + 8;

        // base-data-offset-present が無い場合は moof box の先頭 (= trun.start が属する moof.start) が基準になる
        // (default-base-is-moof は tfhd.flags 側のビットだが、実質的に「base が moof 先頭」という点は同じ)
        let dataOffsetBase = defaultBaseOffset ?? moof.start;
        if ((trunFlags & TRUN_DATA_OFFSET_PRESENT) !== 0) {
            dataOffsetBase += view.getInt32(trunOffset);
            trunOffset += 4;
        }
        let position = dataOffsetBase;

        let firstSampleFlags = defaultSampleFlags;
        if ((trunFlags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT) !== 0) {
            firstSampleFlags = view.getUint32(trunOffset);
            trunOffset += 4;
        }

        for (let index = 0; index < sampleCount; index++) {
            const duration = (trunFlags & TRUN_SAMPLE_DURATION_PRESENT) !== 0
                ? view.getUint32(trunOffset) : defaultSampleDuration;
            if ((trunFlags & TRUN_SAMPLE_DURATION_PRESENT) !== 0) {
                trunOffset += 4;
            }
            const size = (trunFlags & TRUN_SAMPLE_SIZE_PRESENT) !== 0
                ? view.getUint32(trunOffset) : defaultSampleSize;
            if ((trunFlags & TRUN_SAMPLE_SIZE_PRESENT) !== 0) {
                trunOffset += 4;
            }
            const flags = (trunFlags & TRUN_SAMPLE_FLAGS_PRESENT) !== 0
                ? view.getUint32(trunOffset) : (index === 0 ? firstSampleFlags : defaultSampleFlags);
            if ((trunFlags & TRUN_SAMPLE_FLAGS_PRESENT) !== 0) {
                trunOffset += 4;
            }
            let compositionOffset = 0;
            if ((trunFlags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT) !== 0) {
                compositionOffset = trunVersion === 1 ? view.getInt32(trunOffset) : view.getUint32(trunOffset);
                trunOffset += 4;
            }

            if (position < 0 || position + size > data.length) {
                throw new Error('Fmp4Demuxer: sample data outside fragment');
            }

            const timestampUs = Math.round(((decodeTime + compositionOffset) * 1e6) / track.timescale);
            const durationUs = Math.round((duration * 1e6) / track.timescale);
            const sampleData = data.slice(position, position + size);

            if (track.kind === 'video') {
                samples.push({
                    kind: 'video',
                    trackId,
                    chunk: {
                        type: isKeyFrameFromSampleFlags(flags) ? 'key' : 'delta',
                        timestamp: timestampUs,
                        duration: durationUs,
                        data: sampleData,
                    },
                });
            } else {
                samples.push({
                    kind: 'audio',
                    trackId,
                    chunk: {
                        type: 'key',  // AAC は原則すべて独立デコード可能なためキーフレーム扱い
                        timestamp: timestampUs,
                        duration: durationUs,
                        data: sampleData,
                    },
                });
            }

            decodeTime += duration;
            position += size;
        }
    }

    return samples;
}

/**
 * fMP4 の init segment (ftyp+moov) / media segment (moof+mdat) を解析するステートフルなパーサー
 * 1 インスタンスにつき 1 本の MSE SourceBuffer に対応する (hls.js なら video 用・audio 用でそれぞれ 1 個作る)
 */
class Fmp4Demuxer {

    private tracks = new Map<number, Fmp4Track>();

    /**
     * init segment (moov を含む) を解析し、内部に track 定義を保持する
     * @returns 新たに判明した track の一覧
     */
    public parseInitSegment(data: Uint8Array): Fmp4Track[] {
        const moov = findBox(listBoxes(data, 0, data.length), 'moov');
        if (!moov) {
            return [];
        }
        const parsed = parseMoov(data, moov);
        for (const [trackId, track] of parsed) {
            this.tracks.set(trackId, track);
        }
        return Array.from(parsed.values());
    }

    /**
     * media segment (moof+mdat を含む) を解析し、サンプル列を取り出す
     * init segment を先に parseInitSegment() していない track の moof は無視される
     */
    public parseMediaSegment(data: Uint8Array): Fmp4Sample[] {
        const samples: Fmp4Sample[] = [];
        for (const moof of listBoxes(data, 0, data.length).filter((box) => box.type === 'moof')) {
            samples.push(...parseMoof(data, moof, this.tracks));
        }
        return samples;
    }

    /** 現在判明している track 定義の一覧 */
    public getTracks(): Fmp4Track[] {
        return Array.from(this.tracks.values());
    }

    /** track 定義を含め、内部状態をすべて破棄する (シーク・ソース切り替え時に呼ぶ) */
    public reset(): void {
        this.tracks.clear();
    }
}

export default Fmp4Demuxer;
