
/**
 * KonomiTV サーバーが生成する生 MPEG-TS セグメント (録画視聴の HLS セグメント、`video/mp2t`) を解析し、
 * WebCodecs の VideoDecoder / AudioDecoder にそのまま投入できる EncodedVideoChunk / EncodedAudioChunk 相当の
 * サンプル情報を取り出すデマルチプレクサ
 *
 * `client/node_modules/mpegts.js/src/demux/` (Apache-2.0) の設計を参考にしつつ、KonomiTV 自身が吐く TS 構造
 * (単一映像PID (H.264 固定、stream_type 0x1b) + 単一音声PID (AAC 固定、stream_type 0x0F)、
 * 各セグメント先頭に自己完結した PAT/PMT を持つ) に絞った狭い実装にしている
 * (server/app/streams/VideoEncodingTask.py の映像コーデック判定・PID割り当てロジックと対応している)
 *
 * H.264 の NAL ユニットは Annex B (開始コード付き) のまま VideoDecoder に渡す (config.avc.format = 'annexb' を
 * 指定することで、fMP4 のような avcC (length-prefixed) への変換が不要になる)
 */

export interface MpegTsVideoChunk {
    chunk: EncodedVideoChunkInit;
}

export interface MpegTsAudioChunk {
    chunk: EncodedAudioChunkInit;
}

export interface MpegTsDemuxResult {
    /** このセグメントで初めて (あるいは変更されて) 判明した映像デコーダー設定。変更が無ければ null */
    videoConfig: VideoDecoderConfig | null;
    /** このセグメントで初めて (あるいは変更されて) 判明した音声デコーダー設定。変更が無ければ null */
    audioConfig: AudioDecoderConfig | null;
    videoChunks: MpegTsVideoChunk[];
    audioChunks: MpegTsAudioChunk[];
}

const TS_PACKET_LENGTH = 188;
const SYNC_BYTE = 0x47;
const PAT_PID = 0x00;

// PTS/DTS は 90kHz クロックの 33bit 値で、約26.5時間でラップアラウンドする
// ライブ視聴 (continuous モード) はこれより長時間再生されうるため、アンラップして扱う必要がある
const PTS_WRAP_TICKS = 0x200000000;  // 2^33

// AAC の1フレームが持つサンプル数 (KonomiTV サーバーは AAC-LC 固定、SBR 等の特殊設定は使わない前提)
const AAC_SAMPLES_PER_FRAME = 1024;

interface PmtInfo {
    videoPid: number | null;
    videoStreamType: number | null;
    audioPid: number | null;
}

/** PAT セクションから最初の (program_number !== 0 の) PMT PID を取り出す */
function parsePatSection(payload: Uint8Array, sectionStart: number): number | null {
    // section_length: table_id(1byte)の次の2byteの下位12bit
    const sectionLength = ((payload[sectionStart + 1] & 0x0f) << 8) | payload[sectionStart + 2];
    const sectionEnd = sectionStart + 3 + sectionLength;
    // PAT 固有ヘッダー: table_id(1)+section_length(2)+transport_stream_id(2)+flags/version/current_next(1)
    // +section_number(1)+last_section_number(1) = 8byte。CRC32(4byte) は末尾にあるため除外する
    let pos = sectionStart + 8;
    const end = Math.min(sectionEnd - 4, payload.length);
    while (pos + 4 <= end) {
        const programNumber = (payload[pos] << 8) | payload[pos + 1];
        const pid = ((payload[pos + 2] & 0x1f) << 8) | payload[pos + 3];
        if (programNumber !== 0) {
            return pid;
        }
        pos += 4;
    }
    return null;
}

/** PMT セクションから映像 (0x1b: H.264, 0x24: H.265) / 音声 (0x0F: AAC) の PID を取り出す */
function parsePmtSection(payload: Uint8Array, sectionStart: number): PmtInfo {
    const sectionLength = ((payload[sectionStart + 1] & 0x0f) << 8) | payload[sectionStart + 2];
    const sectionEnd = sectionStart + 3 + sectionLength;
    // PMT 固有ヘッダー: table_id(1)+section_length(2)+program_number(2)+flags/version/current_next(1)
    // +section_number(1)+last_section_number(1)+PCR_PID(2)+program_info_length(2) = 12byte
    const programInfoLength = ((payload[sectionStart + 10] & 0x0f) << 8) | payload[sectionStart + 11];
    let pos = sectionStart + 12 + programInfoLength;
    const end = Math.min(sectionEnd - 4, payload.length);

    const result: PmtInfo = { videoPid: null, videoStreamType: null, audioPid: null };
    while (pos + 5 <= end) {
        const streamType = payload[pos];
        const pid = ((payload[pos + 1] & 0x1f) << 8) | payload[pos + 2];
        const esInfoLength = ((payload[pos + 3] & 0x0f) << 8) | payload[pos + 4];
        if ((streamType === 0x1b || streamType === 0x24) && result.videoPid === null) {
            result.videoPid = pid;
            result.videoStreamType = streamType;
        } else if (streamType === 0x0f && result.audioPid === null) {
            result.audioPid = pid;
        }
        pos += 5 + esInfoLength;
    }
    return result;
}

interface ParsedPes {
    /** PTS (90kHz ティック) 。取得できなければ null */
    ptsTicks: number | null;
    /** PES ヘッダーを除いた本体 (映像なら Annex B の NAL 列、音声なら ADTS フレームの列) */
    payload: Uint8Array;
}

/** PES パケット (開始コード 00 00 01 から始まる、1つのアクセスユニット分) を解析する */
function parsePesPacket(data: Uint8Array): ParsedPes | null {
    if (data.length < 9 || data[0] !== 0x00 || data[1] !== 0x00 || data[2] !== 0x01) {
        return null;
    }
    const ptsDtsFlags = (data[7] >> 6) & 0x03;
    const pesHeaderDataLength = data[8];
    let ptsTicks: number | null = null;
    if ((ptsDtsFlags & 0x02) !== 0 && data.length >= 14) {
        // PTS 5byte: '0010'(or '0011')+PTS[32:30]+marker / PTS[29:22] / PTS[21:15]+marker / PTS[14:7] / PTS[6:0]+marker
        const base = 9;
        const pts32_30 = (data[base] >> 1) & 0x07;
        const pts29_22 = data[base + 1];
        const pts21_15 = (data[base + 2] >> 1) & 0x7f;
        const pts14_7 = data[base + 3];
        const pts6_0 = (data[base + 4] >> 1) & 0x7f;
        // 33bit に収まる値なので通常の乗算で組み立てても (2^53 を超えないため) 精度上安全
        ptsTicks = (pts32_30 * 0x40000000) + (pts29_22 * 0x400000) + (pts21_15 * 0x8000) + (pts14_7 * 0x80) + pts6_0;
    }
    const payloadStart = 9 + pesHeaderDataLength;
    if (payloadStart > data.length) {
        return null;
    }
    return { ptsTicks, payload: data.subarray(payloadStart) };
}

interface NalUnit {
    type: number;
    start: number;
    end: number;
}

/** Annex B (開始コード付き) の NAL ユニット列を見つける (開始コード自体の直後から次の開始コードの手前まで) */
function findAnnexBNalUnits(data: Uint8Array): NalUnit[] {
    const starts: number[] = [];
    for (let i = 0; i + 3 <= data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            starts.push(i + 3);
        }
    }
    const units: NalUnit[] = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        // 次の開始コードの3byte手前までがこのNALの範囲 (4byte開始コードの場合に混入する余分な0x00はデコーダー側が許容する)
        const end = i + 1 < starts.length ? starts[i + 1] - 3 : data.length;
        if (end > start && start < data.length) {
            units.push({ type: data[start] & 0x1f, start, end });
        }
    }
    return units;
}

/** AAC の AudioSpecificConfig (2byte版、GASpecificConfig なし) を ADTS ヘッダーの各フィールドから組み立てる */
function buildAudioSpecificConfigFromAdts(audioObjectType: number, samplingFrequencyIndex: number, channelConfiguration: number): Uint8Array {
    const byte0 = (audioObjectType << 3) | (samplingFrequencyIndex >> 1);
    const byte1 = ((samplingFrequencyIndex & 0x01) << 7) | (channelConfiguration << 3);
    return new Uint8Array([byte0, byte1]);
}

function resolveAacCodecString(audioObjectType: number): string {
    switch (audioObjectType) {
        case 5:  // HE-AAC (SBR)
            return 'mp4a.40.5';
        case 29: // HE-AACv2
            return 'mp4a.40.29';
        default: // AAC-LC (2) を含むその他
            return 'mp4a.40.2';
    }
}

interface AdtsFrame {
    /** フレーム先頭からのサンプルオフセット (そのセグメント内、0-indexed のフレーム番号) */
    frameIndex: number;
    /** ADTS ヘッダーを除いた raw AAC ペイロード */
    payload: Uint8Array;
    audioObjectType: number;
    samplingFrequencyIndex: number;
    channelConfiguration: number;
}

const ADTS_SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** PES ペイロード中に連結された ADTS フレームを分解する (number_of_raw_data_blocks_in_frame !== 0 の場合は未対応として読み飛ばす) */
function findAdtsFrames(data: Uint8Array): AdtsFrame[] {
    const frames: AdtsFrame[] = [];
    let pos = 0;
    let frameIndex = 0;
    while (pos + 7 <= data.length) {
        // シンクワード: 先頭12bitが全て1 (0xFFF)
        if (data[pos] !== 0xff || (data[pos + 1] & 0xf0) !== 0xf0) {
            pos += 1;
            continue;
        }
        const protectionAbsent = data[pos + 1] & 0x01;
        const profile = (data[pos + 2] >> 6) & 0x03;
        const samplingFrequencyIndex = (data[pos + 2] >> 2) & 0x0f;
        const channelConfiguration = ((data[pos + 2] & 0x01) << 2) | ((data[pos + 3] >> 6) & 0x03);
        const frameLength = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] >> 5) & 0x07);
        const numberOfRawDataBlocks = data[pos + 6] & 0x03;
        const headerLength = protectionAbsent === 1 ? 7 : 9;

        if (frameLength < headerLength || pos + frameLength > data.length) {
            // 壊れた/不完全なフレームはこれ以上読めないためここで打ち切る
            break;
        }
        if (numberOfRawDataBlocks !== 0) {
            // 1 ADTS フレームに複数 raw_data_block が詰まっているケースは稀なため、Phase 1 では未対応として読み飛ばす
            console.warn('[MpegTsDemuxer] ADTS frame with multiple raw_data_blocks is not supported. Skipping.');
            pos += frameLength;
            continue;
        }
        frames.push({
            frameIndex,
            payload: data.subarray(pos + headerLength, pos + frameLength),
            audioObjectType: profile + 1,  // ADTS の profile は audioObjectType - 1
            samplingFrequencyIndex,
            channelConfiguration,
        });
        frameIndex += 1;
        pos += frameLength;
    }
    return frames;
}

export interface MpegTsDemuxerOptions {
    /**
     * true の場合、ライブ視聴向けの「継続ストリーム」モードになる
     * - PAT/PMT で判明した PID は (新しい PMT が来るまで) 呼び出しをまたいで保持する (セグメント単位でリセットしない)
     * - タイムスタンプは呼び出し間で永続する基準点 (最初に観測した映像キーフレームの PTS) からのオフセットになり、
     *   33bit PTS のラップアラウンド (約26.5時間ごと) をアンラップしたうえで計算する
     * false (既定、録画視聴向け) の場合は各呼び出しごとに PID・基準点をリセットする (既存の挙動)
     */
    continuous?: boolean;
}

class MpegTsDemuxer {

    private readonly continuous: boolean;

    private pmtPid: number | null = null;
    private videoPid: number | null = null;
    private videoStreamType: number | null = null;
    private audioPid: number | null = null;

    private readonly pesAssembly = new Map<number, Uint8Array[]>();
    private finishedPes: { pid: number; bytes: Uint8Array }[] = [];

    private lastVideoCodec: string | null = null;
    private lastAudioCodec: string | null = null;
    private lastAudioSampleRate: number | null = null;
    private lastAudioChannelCount: number | null = null;

    // continuous モード専用: 永続するタイムスタンプ基準点と、33bit ラップアラウンドのアンラップ状態
    private persistentAnchorPtsTicks: number | null = null;
    private videoLastUnwrappedPtsTicks: number | null = null;
    private audioLastUnwrappedPtsTicks: number | null = null;

    constructor(options: MpegTsDemuxerOptions = {}) {
        this.continuous = options.continuous ?? false;
    }

    /** 33bit PTS を、同じストリーム内で直前に観測した値との連続性を見てアンラップする */
    private unwrapPtsTicks(raw: number, lastUnwrappedTicks: number | null): number {
        if (lastUnwrappedTicks === null) {
            return raw;
        }
        // lastUnwrapped と同じ "周" (2^33 の何倍目か) に raw を正規化してから、前後どちらにズレているか判定する
        const wrapBase = Math.floor(lastUnwrappedTicks / PTS_WRAP_TICKS) * PTS_WRAP_TICKS;
        let unwrapped = wrapBase + raw;
        if (unwrapped < lastUnwrappedTicks - PTS_WRAP_TICKS / 2) {
            unwrapped += PTS_WRAP_TICKS;
        } else if (unwrapped > lastUnwrappedTicks + PTS_WRAP_TICKS / 2) {
            unwrapped -= PTS_WRAP_TICKS;
        }
        return unwrapped;
    }

    /**
     * 1セグメント分の生 MPEG-TS バイト列を解析する (録画視聴向け、continuous: false の場合に使う)
     * @param data セグメントのバイト列
     * @param nominalSegmentStartSeconds このセグメントのプレイリスト上の公称開始時刻 (sequence * segment_duration_seconds)
     */
    public demuxSegment(data: Uint8Array, nominalSegmentStartSeconds: number): MpegTsDemuxResult {
        if (this.continuous === false) {
            // 録画視聴: セグメントごとに自己完結した PAT/PMT が送られてくるため、呼び出しごとに PID をリセットする
            this.pmtPid = null;
            this.videoPid = null;
            this.videoStreamType = null;
            this.audioPid = null;
            // セグメントは自己完結しているため、呼び出しをまたいで PES の断片を持ち越す必要が無い
            this.pesAssembly.clear();
        }
        // continuous (ライブ) モードでは、1回の呼び出し (= fetch() で読み取った任意サイズのチャンク) の境界は
        // TS パケットや PES パケットの境界と全く無関係なため、pesAssembly をリセットしてはならない
        // (リセットすると、ちょうどチャンク境界をまたいで分割された PES のデータが毎回破損し、
        // 結果として壊れた SPS 等から不正なコーデック文字列が作られ VideoDecoder.configure() が例外を投げる)
        this.finishedPes = [];

        const packetCount = Math.floor(data.length / TS_PACKET_LENGTH);
        for (let i = 0; i < packetCount; i++) {
            const offset = i * TS_PACKET_LENGTH;
            if (data[offset] !== SYNC_BYTE) {
                // 同期ズレは1byteずつ読み飛ばすような復帰処理は行わず、このパケットだけ無視する
                // (セグメント境界は常に188byte境界に揃っている前提のため、通常ここには来ない)
                continue;
            }
            this.handlePacket(data, offset);
        }
        if (this.continuous === false) {
            // 録画視聴: セグメントは自己完結しているため、末尾で未確定のまま残っている PES
            // (次の PUSI が来る前にセグメントが終わったもの) をここで確定させる
            // continuous (ライブ) モードではこれをやってはならない: まだ完成していない PES を
            // 「完成した」ことにして確定してしまうと、続きのデータが次の呼び出しで届いた時点で
            // 対応するアセンブリが既に無くなっており、新しい PES の先頭と誤認されて破損する
            if (this.videoPid !== null) {
                this.finalizePes(this.videoPid);
            }
            if (this.audioPid !== null) {
                this.finalizePes(this.audioPid);
            }
        }

        return this.buildResult(nominalSegmentStartSeconds);
    }

    /**
     * 継続中のライブ MPEG-TS ストリームから読み取った、188byte 境界に揃えたバイト列を解析する (continuous: true 専用)
     * セグメントという単位が無いため、タイムスタンプは永続する基準点からのオフセットになる (nominalSegmentStartSeconds は常に 0)
     */
    public demuxChunk(data: Uint8Array): MpegTsDemuxResult {
        return this.demuxSegment(data, 0);
    }

    private handlePacket(data: Uint8Array, offset: number): void {
        const b1 = data[offset + 1];
        const b2 = data[offset + 2];
        const b3 = data[offset + 3];
        const pusi = (b1 & 0x40) !== 0;
        const pid = ((b1 & 0x1f) << 8) | b2;
        const adaptationFieldControl = (b3 >> 4) & 0x03;
        const hasAdaptationField = adaptationFieldControl === 2 || adaptationFieldControl === 3;
        const hasPayload = adaptationFieldControl === 1 || adaptationFieldControl === 3;

        let payloadOffset = offset + 4;
        if (hasAdaptationField) {
            const adaptationFieldLength = data[payloadOffset];
            payloadOffset += 1 + adaptationFieldLength;
        }
        if (!hasPayload || payloadOffset >= offset + TS_PACKET_LENGTH) {
            return;
        }
        const payload = data.subarray(payloadOffset, offset + TS_PACKET_LENGTH);

        if (pid === PAT_PID) {
            if (pusi) {
                const pointerField = payload[0];
                this.pmtPid = parsePatSection(payload, 1 + pointerField);
            }
            return;
        }
        if (this.pmtPid !== null && pid === this.pmtPid) {
            if (pusi) {
                const pointerField = payload[0];
                const info = parsePmtSection(payload, 1 + pointerField);
                this.videoPid = info.videoPid;
                this.videoStreamType = info.videoStreamType;
                this.audioPid = info.audioPid;
            }
            return;
        }
        if (pid === this.videoPid || pid === this.audioPid) {
            this.handlePesPacket(pid, payload, pusi);
        }
    }

    private handlePesPacket(pid: number, payload: Uint8Array, pusi: boolean): void {
        if (pusi) {
            this.finalizePes(pid);
            this.pesAssembly.set(pid, [payload]);
        } else {
            const chunks = this.pesAssembly.get(pid);
            // 対応する開始パケットが無い (セグメント先頭で前のセグメントの続きが来た等) 継続パケットは捨てる
            if (chunks) {
                chunks.push(payload);
                // continuous (ライブ) モードで PUSI が来ないまま (壊れたストリーム等で) 延々と続いた場合、
                // 無制限にメモリを溜め込まないための安全弁 (通常の映像/音声フレームはここまで大きくならない)
                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                if (totalLength > 2 * 1024 * 1024) {
                    this.pesAssembly.delete(pid);
                }
            }
        }
    }

    private finalizePes(pid: number): void {
        const chunks = this.pesAssembly.get(pid);
        if (!chunks || chunks.length === 0) {
            return;
        }
        this.pesAssembly.delete(pid);
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        this.finishedPes.push({ pid, bytes });
    }

    private buildResult(nominalSegmentStartSeconds: number): MpegTsDemuxResult {
        const result: MpegTsDemuxResult = {
            videoConfig: null,
            audioConfig: null,
            videoChunks: [],
            audioChunks: [],
        };

        if (this.videoStreamType === 0x24) {
            // HEVC はコーデック文字列の組み立てが複雑なため Fmp4Demuxer と同様 Phase 1 では未対応とする
            console.warn('[MpegTsDemuxer] HEVC video is not supported yet. Skipping this segment\'s video track.');
        }

        // 1st pass: 各 PES を解析し、PTS と中身を取り出す (この時点ではまだ最終的な timestamp は決めない)
        interface RawVideoSample { ptsTicks: number; payload: Uint8Array; isKeyFrame: boolean; }
        interface RawAudioSample { ptsTicks: number; payload: Uint8Array; audioObjectType: number; samplingFrequencyIndex: number; channelConfiguration: number; }
        const rawVideoSamples: RawVideoSample[] = [];
        const rawAudioSamples: RawAudioSample[] = [];
        let spsBytes: Uint8Array | null = null;

        for (const { pid, bytes } of this.finishedPes) {
            const parsed = parsePesPacket(bytes);
            if (!parsed || parsed.ptsTicks === null) {
                continue;
            }
            if (pid === this.videoPid && this.videoStreamType === 0x1b) {
                const nalUnits = findAnnexBNalUnits(parsed.payload);
                let isKeyFrame = false;
                for (const nal of nalUnits) {
                    if (nal.type === 5) {
                        isKeyFrame = true;
                    } else if (nal.type === 7 && spsBytes === null) {
                        // SPS の RBSP 先頭3byte (profile_idc, constraint_set flags, level_idc) をコーデック文字列用に保持
                        spsBytes = parsed.payload.subarray(nal.start, Math.min(nal.start + 4, nal.end));
                    }
                }
                rawVideoSamples.push({ ptsTicks: parsed.ptsTicks, payload: parsed.payload, isKeyFrame });
            } else if (pid === this.audioPid) {
                for (const frame of findAdtsFrames(parsed.payload)) {
                    // 1つのPESに複数ADTSフレームが連結されている場合、各フレームのPTSは先頭フレームのPESのPTSから
                    // フレーム番号分だけ AAC_SAMPLES_PER_FRAME 分進めた位置になる
                    const frameOffsetTicks = Math.round((frame.frameIndex * AAC_SAMPLES_PER_FRAME * 90000) /
                        (ADTS_SAMPLING_FREQUENCIES[frame.samplingFrequencyIndex] ?? 48000));
                    rawAudioSamples.push({
                        ptsTicks: parsed.ptsTicks + frameOffsetTicks,
                        payload: frame.payload,
                        audioObjectType: frame.audioObjectType,
                        samplingFrequencyIndex: frame.samplingFrequencyIndex,
                        channelConfiguration: frame.channelConfiguration,
                    });
                }
            }
        }

        let anchorPtsTicks: number;
        if (this.continuous === true) {
            // ライブ: 33bit ラップアラウンドをアンラップしたうえで、呼び出しをまたいで永続する基準点を使う
            for (const sample of rawVideoSamples) {
                sample.ptsTicks = this.unwrapPtsTicks(sample.ptsTicks, this.videoLastUnwrappedPtsTicks);
                this.videoLastUnwrappedPtsTicks = sample.ptsTicks;
            }
            for (const sample of rawAudioSamples) {
                sample.ptsTicks = this.unwrapPtsTicks(sample.ptsTicks, this.audioLastUnwrappedPtsTicks);
                this.audioLastUnwrappedPtsTicks = sample.ptsTicks;
            }
            if (this.persistentAnchorPtsTicks === null) {
                if (rawVideoSamples.length === 0) {
                    // まだ基準点となる映像キーフレームを一度も観測していないため、このチャンクは (音声のみでも) 扱えず捨てる
                    return result;
                }
                this.persistentAnchorPtsTicks = rawVideoSamples[0].ptsTicks;
            }
            anchorPtsTicks = this.persistentAnchorPtsTicks;
        } else {
            if (rawVideoSamples.length === 0) {
                // このセグメントに映像が無い場合、音声だけのタイムスタンプ基準を用意する手段が無いため、
                // 音声のみのセグメントは Phase 1 では扱わない (録画は必ず映像ありの前提)
                return result;
            }
            // アンカー: このセグメント内で最初に現れた映像サンプル (セグメントはキーフレーム境界で区切られているため先頭キーフレームのはず) のPTS
            anchorPtsTicks = rawVideoSamples[0].ptsTicks;
        }

        const toTimestampUs = (ptsTicks: number): number => {
            const offsetSeconds = (ptsTicks - anchorPtsTicks) / 90000;
            return Math.round((nominalSegmentStartSeconds + offsetSeconds) * 1e6);
        };

        for (const sample of rawVideoSamples) {
            result.videoChunks.push({
                chunk: {
                    type: sample.isKeyFrame ? 'key' : 'delta',
                    timestamp: toTimestampUs(sample.ptsTicks),
                    data: sample.payload,
                },
            });
        }

        if (spsBytes !== null && spsBytes.length >= 4) {
            // SPS の RBSP 先頭3byte (profile_idc, constraint_set flags, level_idc) をそのまま16進表記すれば
            // avcC の対応バイトと同じ値になるため、'avc1.XXXXXX' 形式のコーデック文字列を直接組み立てられる
            const codec = `avc1.${Array.from(spsBytes.subarray(1, 4)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
            if (codec !== this.lastVideoCodec) {
                this.lastVideoCodec = codec;
                // WebCodecs の仕様上、H.264 は description を省略すると Annex B (開始コード付き) として
                // 解釈される (description を指定した場合は avcC = length-prefixed 形式が要求される)。
                // この TS デマルチプレクサは NAL ユニットを Annex B のまま渡すため、description は意図的に省略する
                result.videoConfig = { codec };
            }
        }

        for (const sample of rawAudioSamples) {
            const sampleRate = ADTS_SAMPLING_FREQUENCIES[sample.samplingFrequencyIndex] ?? 48000;
            result.audioChunks.push({
                chunk: {
                    type: 'key',
                    timestamp: toTimestampUs(sample.ptsTicks),
                    duration: Math.round((AAC_SAMPLES_PER_FRAME * 1e6) / sampleRate),
                    data: sample.payload,
                },
            });
            const codec = resolveAacCodecString(sample.audioObjectType);
            if (codec !== this.lastAudioCodec || sampleRate !== this.lastAudioSampleRate ||
                sample.channelConfiguration !== this.lastAudioChannelCount) {
                this.lastAudioCodec = codec;
                this.lastAudioSampleRate = sampleRate;
                this.lastAudioChannelCount = sample.channelConfiguration;
                result.audioConfig = {
                    codec,
                    sampleRate,
                    numberOfChannels: sample.channelConfiguration,
                    description: buildAudioSpecificConfigFromAdts(sample.audioObjectType, sample.samplingFrequencyIndex, sample.channelConfiguration),
                };
            }
        }

        return result;
    }

    /** 新しい再生位置に切り替える際に呼ぶ (コーデック変更検知のキャッシュをリセットする) */
    public reset(): void {
        this.lastVideoCodec = null;
        this.lastAudioCodec = null;
        this.lastAudioSampleRate = null;
        this.lastAudioChannelCount = null;
        this.persistentAnchorPtsTicks = null;
        this.videoLastUnwrappedPtsTicks = null;
        this.audioLastUnwrappedPtsTicks = null;
    }
}

export default MpegTsDemuxer;
