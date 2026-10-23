
/**
 * ライブ/録画でバッファリング方針 (プロファイル) を分離するための設定値
 * Phase 1 は録画視聴のみのため "Recorded" プロファイルだけが実際に使われる
 * ("Live" は Phase 3 (mpegts.js 経路) 着手時に値を調整する前提の仮値)
 */
export interface JitterBufferProfile {
    /** VideoPipeline が保持する提示待ちフレームの最大枚数 */
    videoQueueFrames: number;
}

const RECORDED_PROFILE: JitterBufferProfile = {
    // 30fps 想定で約6秒分 (1セグメント分程度): 録画は安定性優先で多少の余裕を持たせる
    videoQueueFrames: 180,
};

const LIVE_PROFILE: JitterBufferProfile = {
    // 低遅延優先で短め (Phase 3 着手時に実測のうえ調整する)
    videoQueueFrames: 30,
};

class JitterBuffer {
    public static getProfile(playbackMode: 'Live' | 'Recorded'): JitterBufferProfile {
        return playbackMode === 'Recorded' ? RECORDED_PROFILE : LIVE_PROFILE;
    }
}

export default JitterBuffer;
